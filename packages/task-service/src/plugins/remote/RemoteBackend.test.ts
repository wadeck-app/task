import {
	BackendRejectedError,
	BackendTimeoutError,
	RemoteIncompatibleError,
	RemoteProjectMismatchError,
	RemoteTimeoutError,
	RemoteUnauthorizedError,
	RemoteUnreachableError,
	StaleRevisionError,
	TaskConflictError,
	TaskNotFoundError,
} from '@wadeck-app/task-core';
import type { TaskBackend } from '@wadeck-app/task-core';

import type { TransportInstance } from '../kinds.js';
import { startRemoteFixture } from './testHelpers.js';
import type { RemoteFixture, RemoteFixtureOptions } from './testHelpers.js';
import { RemoteBackend, serverServes } from './RemoteBackend.js';

const open: RemoteFixture[] = [];

async function remote(options: RemoteFixtureOptions = {}): Promise<RemoteFixture> {
	const started = await startRemoteFixture(options);
	open.push(started);
	return started;
}

afterEach(async () => {
	for (const f of open.splice(0)) await f.stop();
});

/** A transport that answers what the test scripted, to play a server that is not ours. */
function scripted(answer: () => Response): TransportInstance {
	return {
		baseUrl: 'http://nas.lan:7788',
		headers: () => ({}),
		fetch: () => Promise.resolve(answer()),
		describe: () => [],
		dispose: () => Promise.resolve(),
	};
}

describe('what the server tells and the backend turns into the local classes', () => {
	it('a task that is not there is a TaskNotFoundError, a conflict a TaskConflictError', async () => {
		const f = await remote();
		const task = await f.backend.create({ title: 'T', status: 'backlog' });

		await expect(f.backend.get('nope1234')).rejects.toBeInstanceOf(TaskNotFoundError);
		await expect(f.backend.updateStatus(task.id, 'backlog')).rejects.toBeInstanceOf(TaskConflictError);
		await expect(f.backend.setParent(task.id, task.id)).rejects.toBeInstanceOf(TaskConflictError);
	});

	it('a stale revision is refused before anything is written, and the right one is accepted', async () => {
		const f = await remote();
		const task = await f.backend.create({ title: 'T', status: 'backlog' });
		const other = await f.backend.addLabel(task.id, 'by-someone-else');

		const stale = await f.backend
			.addLabel(task.id, 'mine', { expectedRevision: task.revision })
			.catch((e: unknown) => e);
		const fresh = await f.backend.addLabel(task.id, 'mine', { expectedRevision: other.revision });

		expect(stale).toBeInstanceOf(StaleRevisionError);
		expect(stale).toBeInstanceOf(TaskConflictError);
		expect((stale as StaleRevisionError).expectedRevision).toBe(task.revision);
		expect((stale as StaleRevisionError).actualRevision).toBe(other.revision);
		expect(fresh.labels).toEqual(['by-someone-else', 'mine']);
	});

	it('a status the served project does not have is a BackendRejectedError that names the valid ones', async () => {
		const f = await remote();
		const task = await f.backend.create({ title: 'T', status: 'backlog' });

		const error = await f.backend.updateStatus(task.id, 'blocked').catch((e: unknown) => e);

		expect(error).toBeInstanceOf(BackendRejectedError);
		expect((error as BackendRejectedError).message).toContain('backlog, in-progress, done');
		expect((error as BackendRejectedError).hint).toContain('task strategy check');
		expect((await f.backend.get(task.id)).status).toBe('backlog');
	});

	it('labels and meta keys with a slash, a percent, spaces and non-ASCII letters survive the trip', async () => {
		const f = await remote();
		const task = await f.backend.create({ title: 'T', status: 'backlog' });
		const label = `area/ui 100% caf${String.fromCharCode(233)} ${String.fromCharCode(0x4e2d)}`;
		const key = `build key/1 %2F ${String.fromCharCode(233)}`;

		await f.backend.addLabel(task.id, label);
		await f.backend.setMeta(task.id, key, 'v/1 %');
		const withBoth = await f.backend.get(task.id);
		await f.backend.removeLabel(task.id, label);
		const removed = await f.backend.removeMeta(task.id, key);

		expect(withBoth.labels).toEqual([label]);
		expect(withBoth.meta).toEqual({ [key]: 'v/1 %' });
		expect(removed.labels ?? []).toEqual([]);
		expect(removed.meta ?? {}).toEqual({});
	});

	it('a large description goes through, and one over the size limit is refused with the reason', async () => {
		const f = await remote();
		const task = await f.backend.create({ title: 'T', status: 'backlog' });

		const big = await f.backend.setDescription(task.id, 'x'.repeat(300_000));
		const tooBig = await f.backend.setDescription(task.id, 'y'.repeat(1_200_000)).catch((e: unknown) => e);

		expect(big.description).toHaveLength(300_000);
		expect(tooBig).toBeInstanceOf(BackendRejectedError);
		expect((tooBig as BackendRejectedError).message).toContain('larger than');
		expect((await f.backend.get(task.id)).description).toHaveLength(300_000);
	});
});

describe('the reads that cannot travel (predicates) give what the store gives', () => {
	async function seeded() {
		const f = await remote();
		const root = await f.backend.create({ title: 'Root', status: 'backlog' });
		const a = await f.backend.create({ title: 'A', status: 'backlog', parentId: root.id });
		const b = await f.backend.create({ title: 'B', status: 'backlog', parentId: root.id });
		const c = await f.backend.create({ title: 'C', status: 'backlog', parentId: a.id });
		const lone = await f.backend.create({ title: 'Lone', status: 'backlog' });
		await f.backend.addLink(b.id, 'blockedBy', a.id);
		await f.backend.addLink(b.id, 'blockedBy', c.id);
		await f.backend.updateStatus(a.id, 'done');
		return { f, ids: { root, a, b, c, lone } };
	}
	const isDone = (status: string): boolean => status === 'done';
	const local = (f: RemoteFixture): TaskBackend => f.server.ctx.store;

	it("getOpenBlockers and getUnblockedBy equal the local store's", async () => {
		const { f, ids } = await seeded();
		await f.backend.updateStatus(ids.c.id, 'done');

		for (const id of [ids.b.id, ids.a.id, ids.lone.id]) {
			expect(await f.backend.getOpenBlockers(id, isDone), `open blockers of ${id}`).toEqual(
				await local(f).getOpenBlockers(id, isDone)
			);
			expect(await f.backend.getUnblockedBy(id, isDone), `unblocked by ${id}`).toEqual(
				await local(f).getUnblockedBy(id, isDone)
			);
		}
		expect((await f.backend.getUnblockedBy(ids.c.id, isDone)).map(t => t.id)).toEqual([ids.b.id]);
		await expect(f.backend.getUnblockedBy('nope1234', isDone)).rejects.toBeInstanceOf(TaskNotFoundError);
	});

	it('getForest with a predicate keeps a node that matches or has a descendant that does, like the store', async () => {
		const { f, ids } = await seeded();

		for (const predicate of [
			(task: { status: string }) => task.status === 'done',
			(task: { status: string }) => task.status === 'backlog',
			() => false,
			(task: { title: string }) => task.title === 'C',
		]) {
			expect(await f.backend.getForest({ predicate })).toEqual(await local(f).getForest({ predicate }));
			expect(await f.backend.getForest({ parentId: ids.root.id, predicate })).toEqual(
				await local(f).getForest({ parentId: ids.root.id, predicate })
			);
		}
		expect(await f.backend.getForest()).toEqual(await local(f).getForest());
	});
});

describe('failures of the link', () => {
	it('a wrong token is a RemoteUnauthorizedError that names the url and says what to compare', async () => {
		const f = await remote({ clientToken: 'a-different-token-0123456789' });

		const error = await f.backend.list().catch((e: unknown) => e);

		expect(error).toBeInstanceOf(RemoteUnauthorizedError);
		expect((error as RemoteUnauthorizedError).reason).toBe('unauthenticated');
		expect((error as RemoteUnauthorizedError).message).toContain(f.server.server.url);
		expect((error as RemoteUnauthorizedError).hint).toContain('task serve was started with');
		expect((error as Error).message).not.toContain('a-different-token');
	});

	it('a server that is gone is a RemoteUnreachableError naming the address', async () => {
		const f = await remote();
		await f.backend.list();
		await f.server.server.close();

		const error = await f.backend.list().catch((e: unknown) => e);

		expect(error).toBeInstanceOf(RemoteUnreachableError);
		expect((error as RemoteUnreachableError).message).toContain(new URL(f.server.server.url).host);
		expect((error as RemoteUnreachableError).hint).toContain('task serve');
	});

	it('a slow server is a RemoteTimeoutError; a write that timed out may still have been applied, as the hint says', async () => {
		const f = await remote({
			transportOptions: { timeoutSeconds: 0.1 },
			wrap: ctx => ({
				...ctx,
				store: new Proxy(ctx.store, {
					get(target, property, receiver) {
						const value = Reflect.get(target, property, receiver) as unknown;
						if (property !== 'addLabel' && property !== 'list') return value;
						return async (...args: unknown[]) => {
							await new Promise(resolve => setTimeout(resolve, 400));
							return (value as (...a: unknown[]) => Promise<unknown>).apply(target, args);
						};
					},
				}),
			}),
		});
		const task = await f.backend.create({ title: 'T', status: 'backlog' });

		const read = await f.backend.list().catch((e: unknown) => e);
		const write = await f.backend.addLabel(task.id, 'late').catch((e: unknown) => e);
		await new Promise(resolve => setTimeout(resolve, 600));

		expect(read).toBeInstanceOf(RemoteTimeoutError);
		expect(read).toBeInstanceOf(BackendTimeoutError);
		expect(write).toBeInstanceOf(RemoteTimeoutError);
		expect((write as RemoteTimeoutError).hint).toMatch(/may have been applied/);
		expect((await f.server.ctx.store.get(task.id)).labels).toEqual(['late']);
	});

	it('another protocol is a RemoteIncompatibleError with both versions, and so is a server that does not know our routes', async () => {
		const upgraded = new RemoteBackend({
			transport: scripted(
				() =>
					new Response(
						JSON.stringify({
							error: {
								type: 'incompatible',
								message: 'protocol 1 is not supported',
								supported: { min: 2, max: 3 },
							},
						}),
						{ status: 426, headers: { 'X-Task-Protocol': '3' } }
					)
			),
		});
		const dialect = new RemoteBackend({
			transport: scripted(
				() =>
					new Response(JSON.stringify({ error: { type: 'unknown-route', message: 'no such route' } }), {
						status: 404,
					})
			),
		});

		const first = await upgraded.list().catch((e: unknown) => e);
		const second = await dialect.list().catch((e: unknown) => e);

		expect(first).toBeInstanceOf(RemoteIncompatibleError);
		expect((first as RemoteIncompatibleError).serverProtocol).toEqual({ min: 2, max: 3 });
		expect((first as RemoteIncompatibleError).hint).toMatch(/update task on this machine/i);
		expect(second).toBeInstanceOf(RemoteIncompatibleError);
	});

	it('an answer from something that is not a task server is reported as such, never taken for data', async () => {
		const html = new RemoteBackend({
			transport: scripted(() => new Response('<html>It works!</html>', { status: 200 })),
		});
		const proxy = new RemoteBackend({
			transport: scripted(() => new Response('<html>Bad Gateway</html>', { status: 502 })),
		});

		const noHeader = await html.list().catch((e: unknown) => e);
		const badGateway = await proxy.list().catch((e: unknown) => e);

		expect(noHeader).toBeInstanceOf(RemoteUnreachableError);
		expect((noHeader as Error).message).toContain('not a task server');
		expect(badGateway).toBeInstanceOf(RemoteUnreachableError);
		expect((badGateway as Error).message).toContain('502');
	});
});

describe('the project the config expects', () => {
	it('matches the id, a unique id prefix of 4 or more characters and the name, case-insensitively', () => {
		const served = { id: 'ab12cd34', name: 'Shop' };

		expect(serverServes('ab12cd34', served)).toBe(true);
		expect(serverServes('ab12', served)).toBe(true);
		expect(serverServes('AB12CD', served)).toBe(true);
		expect(serverServes('shop', served)).toBe(true);
		expect(serverServes('ab1', served)).toBe(false);
		expect(serverServes('other', served)).toBe(false);
	});

	it('is checked before the first operation: a server that serves another project is refused and nothing is written', async () => {
		const f = await remote({ backendOptions: { expectedProject: 'warehouse' } });

		const error = await f.backend.create({ title: 'Oops', status: 'backlog' }).catch((e: unknown) => e);

		expect(error).toBeInstanceOf(RemoteProjectMismatchError);
		expect(error).toBeInstanceOf(BackendRejectedError);
		expect((error as Error).message).toContain('serves project "served" (ab12cd34), not "warehouse"');
		expect((error as RemoteProjectMismatchError).hint).toContain('strategy.options.project');
		expect(await f.server.ctx.store.list()).toEqual([]);
	});

	it('accepts the right project and asks the server only once', async () => {
		const f = await remote({ backendOptions: { expectedProject: 'served' } });
		const seen: string[] = [];
		const real = f.transport.fetch.bind(f.transport);
		f.transport.fetch = (path, init) => {
			seen.push(path);
			return real(path, init);
		};

		await f.backend.list();
		await f.backend.list();

		expect(seen).toEqual(['/v1/info', '/v1/tasks', '/v1/tasks']);
	});
});

describe('queue events: the server raises them', () => {
	it('reports an event the server could not deliver as a notice, naming the event and the reason, once', async () => {
		const f = await remote({ withSink: true });
		f.server.sink.outcome = () => ({ delivered: false, reason: 'queue daemon not running', status: 'dropped' });

		const task = await f.backend.create({ title: 'T', status: 'backlog' });
		await f.backend.addLabel(task.id, 'x');

		expect(f.notices.map(notice => notice.kind)).toEqual(['events', 'events']);
		expect(f.notices[0]!.text).toContain('onTaskCreated');
		expect(f.notices[0]!.text).toContain('queue daemon not running');
		expect(f.notices[0]!.text).toContain('was not recorded');
		expect(f.notices[0]!.text).toContain('the change is saved');
	});

	it('says an event may have been recorded when the outcome is unknown', async () => {
		const f = await remote({ withSink: true });
		f.server.sink.outcome = () => ({ delivered: false, reason: 'timed out', status: 'unknown' });

		await f.backend.create({ title: 'T', status: 'backlog' });

		expect(f.notices[0]!.text).toContain('MAY have been recorded');
	});

	it('raises nothing when the backend was opened to suppress them, and nothing for the reads', async () => {
		const f = await remote({ withSink: true, backendOptions: { suppressEvents: true } });

		const task = await f.backend.create({ title: 'T', status: 'backlog' });
		await f.backend.setType(task.id, 'bug');
		await f.backend.get(task.id);
		await f.backend.list();

		expect(f.server.sink.names()).toEqual([]);
	});

	it("raises the events of the served project with the SERVER's identity, whoever wrote", async () => {
		const f = await remote({ withSink: true });

		const task = await f.backend.create({ title: 'T', status: 'backlog' });
		await f.backend.updateStatus(task.id, 'done');

		expect(f.server.sink.names()).toEqual(['onTaskCreated', 'onStatusChange']);
		expect(f.server.sink.delivered[1]!.payload).toMatchObject({
			taskProjectId: 'ab12cd34',
			taskProjectName: 'served',
			taskProjectPath: f.server.test.rootDir,
		});
	});
});

describe('several writers, one server', () => {
	it('keeps every change of concurrent clients (no lost update)', async () => {
		const f = await remote();
		const second = new RemoteBackend({ transport: f.transport });
		const task = await f.backend.create({ title: 'T', status: 'backlog' });

		await Promise.all(
			Array.from({ length: 10 }, (_unused, index) => [
				f.backend.addLabel(task.id, `a${index}`),
				second.addLabel(task.id, `b${index}`),
			]).flat()
		);

		const labels = (await f.backend.get(task.id)).labels ?? [];
		expect(labels).toHaveLength(20);
		expect(new Set(labels).size).toBe(20);
	});
});

describe('after the connection was released', () => {
	it('a call is refused with a message that says so', async () => {
		const f = await remote();
		await f.transport.dispose();

		const error = await f.backend.list().catch((e: unknown) => e);

		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toContain('closed');
	});
});
