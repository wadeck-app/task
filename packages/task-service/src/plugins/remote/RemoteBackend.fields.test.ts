import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

import {
	LOCAL_CAPABILITIES,
	RemoteIncompatibleError,
	TaskClaimedError,
	TaskClosedError,
	TaskConflictError,
	TaskNotClaimedError,
	TaskReleaseRefusedError,
	UnknownPriorityError,
} from '@wadeck-app/task-core';

import { claimTask } from '../../taskClaim.js';
import type { TaskServiceContext } from '../../context.js';
import { setTaskPriority } from '../../taskPriority.js';
import { createTestContext } from '../../testHelpers.js';
import type { TransportInstance } from '../kinds.js';
import { plainHttpPlugin } from '../plain-http/plainHttpPlugin.js';
import { RemoteBackend } from './RemoteBackend.js';
import { startRemoteFixture } from './testHelpers.js';
import type { RemoteFixture, RemoteFixtureOptions } from './testHelpers.js';

// Priority, assignee, claim and release through the remote backend (protocol 2): what travels, who decides the time, what a server
// that only speaks protocol 1 answers, and that the typed errors come back as the classes of a local project.

const open: RemoteFixture[] = [];
const cleanups: Array<() => Promise<void>> = [];

async function remote(options: RemoteFixtureOptions = {}): Promise<RemoteFixture> {
	const started = await startRemoteFixture(options);
	open.push(started);
	return started;
}

afterEach(async () => {
	for (const f of open.splice(0)) await f.stop();
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

const HOUR = 3_600_000;

/** The use cases of a client over a remote backend, as the CLI builds them. */
function clientContext(f: RemoteFixture): TaskServiceContext {
	return {
		...createTestContext().ctx,
		store: f.backend,
		project: { id: 'b1b1b1b1', name: 'client', path: '/client' },
	};
}

describe("the clock of a claim is the server's", () => {
	it('gives the right lease when the clock of the client is an hour off, in both directions', async () => {
		const serverNow = Date.parse('2026-11-14T10:00:00.000Z');
		const f = await remote({ now: () => new Date(serverNow) });
		const ctx = clientContext(f);

		for (const skew of [HOUR, -HOUR]) {
			const task = await f.backend.create({ title: `skew ${skew}`, status: 'backlog' });
			const claimed = await claimTask(ctx, {
				id: task.id,
				assignee: 'w1',
				leaseMinutes: 30,
				now: new Date(serverNow + skew),
			});

			expect(claimed.task.claimedAt).toBe('2026-11-14T10:00:00.000Z');
			expect(claimed.leaseUntil).toBe('2026-11-14T10:30:00.000Z');
			expect((await f.server.ctx.store.get(task.id)).leaseUntil).toBe('2026-11-14T10:30:00.000Z');
		}
	});

	it('sends the length of the lease and nothing else about time (no now, no leaseUntil on the wire)', async () => {
		const f = await remote();
		const task = await f.backend.create({ title: 'wire', status: 'backlog' });
		const bodies: unknown[] = [];
		const spy: TransportInstance = {
			...f.transport,
			fetch: (path, init) => {
				if (path.endsWith('/claim')) bodies.push(JSON.parse(init?.body ?? 'null'));
				return f.transport.fetch(path, init);
			},
		};
		const backend = new RemoteBackend({ transport: spy });

		await backend.claim(task.id, {
			assignee: ' w1 ',
			now: '2026-01-01T00:00:00.000Z',
			leaseUntil: '2026-01-01T00:45:00.000Z',
			renew: false,
			force: true,
		});

		expect(bodies).toEqual([{ assignee: 'w1', leaseMs: 45 * 60_000, force: true }]);
	});

	it('refuses a request the store would refuse (a lease that does not end after now, a blank name) without a round trip', async () => {
		const f = await remote();
		const task = await f.backend.create({ title: 'local check', status: 'backlog' });
		const sent: string[] = [];
		const spy: TransportInstance = {
			...f.transport,
			fetch: (path, init) => {
				sent.push(path);
				return f.transport.fetch(path, init);
			},
		};
		const backend = new RemoteBackend({ transport: spy });
		const at = '2026-01-01T00:00:00.000Z';

		await expect(backend.claim(task.id, { assignee: 'w', now: at, leaseUntil: at })).rejects.toMatchObject({
			name: 'InvalidTaskFieldError',
			field: 'lease',
		});
		await expect(
			backend.claim(task.id, { assignee: ' ', now: at, leaseUntil: '2026-01-01T01:00:00.000Z' })
		).rejects.toMatchObject({ name: 'InvalidTaskFieldError', field: 'assignee' });
		expect(sent).toEqual([]);
	});
});

describe('which protocol version each request names', () => {
	it('names 1 for every route protocol 1 had and 2 for the ones it added', async () => {
		const f = await remote();
		const task = await f.backend.create({ title: 'versions', status: 'backlog' });
		const seen: Array<[string, string | undefined]> = [];
		const spy: TransportInstance = {
			...f.transport,
			fetch: (path, init) => {
				seen.push([`${init?.method} ${path.split('?')[0]}`, init?.headers?.['X-Task-Protocol']]);
				return f.transport.fetch(path, init);
			},
		};
		const backend = new RemoteBackend({ transport: spy });

		await backend.updateStatus(task.id, 'in-progress');
		await backend.setPriority(task.id, 'high');
		await backend.claim(task.id, {
			assignee: 'w',
			now: '2026-01-01T00:00:00.000Z',
			leaseUntil: '2026-01-01T00:30:00.000Z',
		});

		expect(seen).toEqual([
			[`PUT /v1/tasks/${task.id}/status`, '1'],
			[`PUT /v1/tasks/${task.id}/priority`, '2'],
			[`POST /v1/tasks/${task.id}/claim`, '2'],
		]);
	});
});

describe('a server that only speaks protocol 1', () => {
	interface FakeV1 {
		url: string;
		requests: Array<{ method: string; url: string; version: string | undefined }>;
	}

	/** What the first release of `task serve` did: protocol range 1..1, 426 for any other version, 404 for a route it does not have. */
	async function fakeV1Server(): Promise<FakeV1> {
		const requests: FakeV1['requests'] = [];
		const server = http.createServer((req, res) => {
			const version = req.headers['x-task-protocol'] as string | undefined;
			requests.push({ method: req.method ?? '', url: req.url ?? '', version });
			const answer = (status: number, body: unknown): void => {
				res.writeHead(status, { 'Content-Type': 'application/json', 'X-Task-Protocol': '1' });
				res.end(JSON.stringify(body));
			};
			if (version !== '1') {
				answer(426, {
					error: {
						type: 'incompatible',
						message: `protocol ${version} is not supported (this server speaks 1..1)`,
						hint: 'Update task on the older of the two machines',
						supported: { min: 1, max: 1 },
					},
				});
				return;
			}
			if (req.method === 'GET' && req.url === '/v1/info') {
				answer(200, {
					protocol: { version: 1, min: 1, max: 1 },
					server: { name: 'task-serve', version: 'old' },
					project: { id: 'ab12cd34', name: 'served' },
					capabilities: LOCAL_CAPABILITIES,
					statuses: ['backlog', 'done'],
					terminalStatuses: ['done'],
					types: [],
					events: { enabled: false },
				});
				return;
			}
			if (req.method === 'GET' && req.url === '/v1/tasks') {
				answer(200, {
					items: [{ id: 'abc12345', title: 'old', status: 'backlog', createdAt: '2026-01-01T00:00:00.000Z' }],
				});
				return;
			}
			answer(404, { error: { type: 'unknown-route', message: `no such route: ${req.method} ${req.url}` } });
		});
		await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
		cleanups.push(() => new Promise<void>(resolve => server.close(() => resolve())));
		return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests };
	}

	async function backendFor(url: string): Promise<RemoteBackend> {
		const transport = await plainHttpPlugin.create(
			{ url, tokenEnv: 'TASK_TEST_TOKEN' },
			{ env: { TASK_TEST_TOKEN: 'a-token-of-at-least-sixteen' } }
		);
		cleanups.push(() => transport.dispose());
		return new RemoteBackend({ transport });
	}

	it('still reads and writes everything protocol 1 had', async () => {
		const fake = await fakeV1Server();
		const backend = await backendFor(fake.url);

		expect((await backend.list()).map(task => task.id)).toEqual(['abc12345']);
		expect(fake.requests).toEqual([{ method: 'GET', url: '/v1/tasks', version: '1' }]);
	});

	it.each([
		['setPriority', 'setting a priority', (b: RemoteBackend) => b.setPriority('abc12345', 'high')],
		['clearPriority', 'clearing a priority', (b: RemoteBackend) => b.clearPriority('abc12345')],
		['setAssignee', 'setting an assignee', (b: RemoteBackend) => b.setAssignee('abc12345', 'ann')],
		['clearAssignee', 'clearing an assignee', (b: RemoteBackend) => b.clearAssignee('abc12345')],
		[
			'claim',
			'claiming a task',
			(b: RemoteBackend) =>
				b.claim('abc12345', {
					assignee: 'w',
					now: '2026-01-01T00:00:00.000Z',
					leaseUntil: '2026-01-01T00:30:00.000Z',
				}),
		],
		['release', 'releasing a task', (b: RemoteBackend) => b.release('abc12345')],
	])(
		'%s fails with a RemoteIncompatibleError that names the feature and the machine to update',
		async (_name, feature, run) => {
			const fake = await fakeV1Server();
			const backend = await backendFor(fake.url);

			const error = (await run(backend).catch((e: unknown) => e)) as RemoteIncompatibleError;

			expect(error).toBeInstanceOf(RemoteIncompatibleError);
			expect(error.feature).toBe(feature);
			expect(error.message).toContain(`does not support ${feature}`);
			expect(error.message).toContain(fake.url);
			expect(error.message).toContain('protocol 2');
			expect(error.message).toContain('1..1');
			expect(error.hint).toContain('machine that runs task serve');
			expect(error.hint).toContain('same version');
			expect(error.serverProtocol).toEqual({ min: 1, max: 1 });
		}
	);

	it('reports priority, assignee and claim as unsupported once the server said it speaks only protocol 1, and keeps the rest', async () => {
		const fake = await fakeV1Server();
		const backend = await backendFor(fake.url);
		expect(backend.capabilities).toMatchObject({ priority: true, assignee: true, claim: true });

		await backend.info();

		expect(backend.capabilities).toMatchObject({ priority: false, assignee: false, claim: false });
		expect(backend.capabilities).toMatchObject({ comments: true, writes: 'full', events: 'server' });
		// A protocol 2 server leaves them on.
		const f = await remote();
		await f.backend.info();
		expect(f.backend.capabilities).toMatchObject({ priority: true, assignee: true, claim: true });
	});

	it('learns it from the refusal too: after a feature error the capabilities say unsupported', async () => {
		const fake = await fakeV1Server();
		const backend = await backendFor(fake.url);

		await backend.setPriority('abc12345', 'high').catch(() => undefined);

		expect(backend.capabilities).toMatchObject({ priority: false, assignee: false, claim: false });
	});

	it('names the feature too when the older server answers 404 (a route it does not know) instead of 426', async () => {
		const server = http.createServer((_req, res) => {
			res.writeHead(404, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: { type: 'unknown-route', message: 'no such route' } }));
		});
		await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
		cleanups.push(() => new Promise<void>(resolve => server.close(() => resolve())));
		const backend = await backendFor(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);

		const error = (await backend
			.setAssignee('abc12345', 'ann')
			.catch((e: unknown) => e)) as RemoteIncompatibleError;

		expect(error).toBeInstanceOf(RemoteIncompatibleError);
		expect(error.feature).toBe('setting an assignee');
		expect(error.hint).toContain('machine that runs task serve');
	});
});

describe('summaries, typed errors and events through the backend', () => {
	it('carries priority, assignee and leaseUntil in the list and in a page, and on the record', async () => {
		const f = await remote();
		const task = await f.backend.create({ title: 'carried', status: 'backlog' });
		await f.backend.setPriority(task.id, 'high');
		await f.backend.claim(task.id, {
			assignee: 'w1',
			now: new Date().toISOString(),
			leaseUntil: new Date(Date.now() + HOUR).toISOString(),
		});

		const expected = { id: task.id, priority: 'high', assignee: 'w1', leaseUntil: expect.any(String) };
		expect((await f.backend.list())[0]).toMatchObject(expected);
		expect((await f.backend.listPage({ limit: 5 })).items[0]).toMatchObject(expected);
		expect(await f.backend.get(task.id)).toMatchObject({ ...expected, claimedAt: expect.any(String) });
	});

	it('brings the refusals back as the classes of a local project, with their hints', async () => {
		const f = await remote({ config: { priorities: ['p1', 'p2'] } });
		const task = await f.backend.create({ title: 'errors', status: 'backlog' });
		const lease = { now: '2026-11-14T10:00:00.000Z', leaseUntil: '2026-11-14T10:30:00.000Z' };

		const unknown = await f.backend.setPriority(task.id, 'urgent').catch((e: unknown) => e);
		expect(unknown).toBeInstanceOf(UnknownPriorityError);
		expect((unknown as UnknownPriorityError).validPriorities).toEqual(['p1', 'p2']);

		await expect(f.backend.release(task.id)).rejects.toBeInstanceOf(TaskNotClaimedError);

		// The lease is judged at the server's clock: claim for an hour from the real now, then another worker is refused.
		const now = new Date();
		await f.backend.claim(task.id, {
			assignee: 'w1',
			now: now.toISOString(),
			leaseUntil: new Date(now.getTime() + HOUR).toISOString(),
		});
		const busy = (await f.backend
			.claim(task.id, { assignee: 'w2', ...lease })
			.catch((e: unknown) => e)) as TaskClaimedError;
		expect(busy).toBeInstanceOf(TaskClaimedError);
		expect(busy).toBeInstanceOf(TaskConflictError);
		expect(busy.holder).toBe('w1');
		expect(busy.remainingMs).toBeGreaterThan(HOUR - 60_000);
		expect(busy.hint).toContain('--force');
		await expect(f.backend.release(task.id, { assignee: 'w2' })).rejects.toBeInstanceOf(TaskReleaseRefusedError);
	});

	it('refuses a claim of a closed task with the conflict of the local use case and writes nothing', async () => {
		const f = await remote();
		const ctx = clientContext(f);
		const task = await f.backend.create({ title: 'closed', status: 'backlog' });
		await f.backend.updateStatus(task.id, 'done');

		// Straight to the backend, so that only the server's own check can refuse it.
		const refused = (await f.backend
			.claim(task.id, {
				assignee: 'w',
				now: new Date().toISOString(),
				leaseUntil: new Date(Date.now() + HOUR).toISOString(),
			})
			.catch((e: unknown) => e)) as Error;
		expect(refused).toBeInstanceOf(TaskClosedError);
		expect(refused).toBeInstanceOf(TaskConflictError);
		expect(refused.message).toContain('is closed');
		expect((refused as TaskConflictError & { hint?: string }).hint).toContain('set-status');
		expect((await f.backend.get(task.id)).assignee).toBeUndefined();
		// And the use case on the client refuses it first, as for a local project.
		await expect(claimTask(ctx, { id: task.id, assignee: 'w' })).rejects.toMatchObject({ name: 'TaskClosedError' });
	});

	it('raises the events on the server only, none for a backend opened to suppress them, and relays an event the queue did not take', async () => {
		const f = await remote({ withSink: true });
		const task = await f.backend.create({ title: 'events', status: 'backlog' });
		f.server.sink.delivered.length = 0;
		const ctx = clientContext(f);

		await setTaskPriority(ctx, { id: task.id, priority: 'high' });
		expect(f.server.sink.names()).toEqual(['onTaskPriorityChanged']);

		f.server.sink.outcome = () => ({ delivered: false, status: 'dropped', reason: 'queue is down' });
		await f.backend.setAssignee(task.id, 'ann');
		expect(f.notices.map(notice => notice.text).join('\n')).toMatch(
			/could not deliver the event onTaskAssigneeChanged.*queue is down/
		);

		const quiet = await remote({ withSink: true, backendOptions: { suppressEvents: true } });
		const other = await quiet.backend.create({ title: 'quiet', status: 'backlog' });
		await quiet.backend.setPriority(other.id, 'low');
		await quiet.backend.setAssignee(other.id, 'ann');
		await quiet.backend.release(other.id, { assignee: 'ann' });
		expect(quiet.server.sink.delivered).toEqual([]);
	});

	it('answers setPriority of the use case like a local project: the same event, and a priority outside the list is refused before any request', async () => {
		const f = await remote({ config: { priorities: ['p1', 'p2'] } });
		const task = await f.backend.create({ title: 'use case', status: 'backlog' });
		const ctx = { ...clientContext(f), config: { ...clientContext(f).config, priorities: ['p1', 'p2'] } };

		const result = await setTaskPriority(ctx, { id: task.id, priority: 'p2' });
		expect(result.task.priority).toBe('p2');
		expect(result.events).toHaveLength(1);
		await expect(setTaskPriority(ctx, { id: task.id, priority: 'p9' })).rejects.toBeInstanceOf(
			UnknownPriorityError
		);
	});
});

describe('one lease rule for every backend', () => {
	it('refuses a 500 ms lease with the same error locally and remotely, and the remote one before any round trip', async () => {
		const f = await remote();
		const task = await f.backend.create({ title: 'short lease', status: 'backlog' });
		const local = createTestContext();
		const localTask = await local.ctx.store.create({ title: 'short lease', status: 'backlog' });
		const sent: string[] = [];
		const spy: TransportInstance = {
			...f.transport,
			fetch: (path, init) => {
				sent.push(path);
				return f.transport.fetch(path, init);
			},
		};
		const backend = new RemoteBackend({ transport: spy });
		const now = '2026-01-01T00:00:00.000Z';
		const input = { assignee: 'w', now, leaseUntil: '2026-01-01T00:00:00.500Z' };

		const remoteError = (await backend.claim(task.id, input).catch((e: unknown) => e)) as Error;
		const localError = (await local.ctx.store.claim!(localTask.id, input).catch((e: unknown) => e)) as Error;
		local.cleanup();

		expect(remoteError.name).toBe('InvalidTaskFieldError');
		expect(remoteError.message).toBe(localError.message);
		expect((remoteError as Error & { hint: string }).hint).toBe((localError as Error & { hint: string }).hint);
		expect(sent).toEqual([]);
	});
});
