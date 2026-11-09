import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';

import type { TaskBackend } from '@wadeck-app/task-core';
import { PORT_OPERATIONS, ROUTES } from '@wadeck-app/task-core';

import type { TaskServiceContext } from '../context.js';
import { TEST_TOKEN, startServerFixture } from './testHelpers.js';
import type { ServerFixture } from './testHelpers.js';
import { TaskServerStartError, startTaskServer } from './taskServer.js';

const open: ServerFixture[] = [];

async function fixture(options: Parameters<typeof startServerFixture>[0] = {}): Promise<ServerFixture> {
	const started = await startServerFixture(options);
	open.push(started);
	return started;
}

afterEach(async () => {
	for (const f of open.splice(0)) await f.stop();
});

/** A backend whose writes take time and record how many run together: proves the writes of the server never overlap. */
function slowWrites(delayMs: number, probe: { running: number; maxRunning: number; order: string[] }) {
	return (ctx: TaskServiceContext): TaskServiceContext => {
		const real = ctx.store;
		const store = new Proxy(real, {
			get(target, property, receiver) {
				const value = Reflect.get(target, property, receiver) as unknown;
				if (property !== 'addLabel' && property !== 'updateStatus') return value;
				return async (...args: unknown[]) => {
					probe.running++;
					probe.maxRunning = Math.max(probe.maxRunning, probe.running);
					probe.order.push(`start ${String(args[1])}`);
					await new Promise(resolve => setTimeout(resolve, delayMs));
					try {
						return await (value as (...a: unknown[]) => Promise<unknown>).apply(target, args);
					} finally {
						probe.order.push(`end ${String(args[1])}`);
						probe.running--;
					}
				};
			},
		}) as TaskBackend;
		return { ...ctx, store };
	};
}

describe('GET /v1/info', () => {
	it('tells who the server is, what it speaks and what it serves, and nothing about its folders', async () => {
		const f = await fixture({ version: '2026.11.09-001' });

		const { status, headers, body } = await f.call('info');

		expect(status).toBe(200);
		expect(headers.get('x-task-protocol')).toBe('1');
		expect(body.protocol).toEqual({ version: 1, min: 1, max: 1 });
		expect(body.server).toEqual({ name: 'task-serve', version: '2026.11.09-001' });
		expect(body.project).toEqual({ id: 'ab12cd34', name: 'served' });
		expect(body.statuses).toEqual(['backlog', 'in-progress', 'done']);
		expect(body.terminalStatuses).toEqual(['done']);
		expect(body.capabilities.writes).toBe('full');
		expect(body.events).toEqual({ enabled: false });
		expect(JSON.stringify(body)).not.toContain(f.test.rootDir);
	});
});

describe('authentication', () => {
	it('refuses a request without a token, with a wrong token and with a token of another length: always 401, the same body', async () => {
		const f = await fixture();
		const bodies: string[] = [];

		for (const authorization of [undefined, 'Bearer nope', `Bearer ${f.token}x`, `Basic ${f.token}`, `Bearer `]) {
			const result = await f.raw('/v1/info', {
				headers: {
					'X-Task-Protocol': '1',
					...(authorization === undefined ? {} : { Authorization: authorization }),
				},
			});
			expect(result.status, String(authorization)).toBe(401);
			expect(result.headers.get('x-task-protocol')).toBe('1');
			bodies.push(result.text);
		}

		expect(new Set(bodies).size).toBe(1);
		expect(JSON.parse(bodies[0]!).error.type).toBe('unauthorized');
		expect(bodies[0]).not.toContain(f.token);
	});

	it('counts the failures and waits the configured delay before answering one, without locking anybody out', async () => {
		const waits: number[] = [];
		const f = await fixture({
			failedAuthDelayMs: 300,
			sleep: ms => {
				waits.push(ms);
				return Promise.resolve();
			},
		});

		for (let attempt = 0; attempt < 3; attempt++) {
			await f.raw('/v1/info', { headers: { Authorization: 'Bearer wrong', 'X-Task-Protocol': '1' } });
		}
		const good = await f.call('info');

		expect(waits).toEqual([300, 300, 300]);
		expect(f.server.failedAuthCount()).toBe(3);
		expect(good.status).toBe(200);
	});

	it('checks the token before anything else: an unauthenticated request learns nothing about routes or versions', async () => {
		const f = await fixture();

		const unknownRoute = await f.raw('/v1/secret-admin', { headers: { 'X-Task-Protocol': '9' } });
		const badVersion = await f.raw('/v1/info', { headers: { 'X-Task-Protocol': '9' } });

		expect(unknownRoute.status).toBe(401);
		expect(badVersion.status).toBe(401);
	});

	it('never logs the token, even when it is sent to a wrong place', async () => {
		const lines: string[] = [];
		const f = await fixture({ log: (_level, message) => lines.push(message) });

		await f.raw(`/v1/tasks/${f.token}`, { headers: f.headers() });
		await f.raw('/v1/info', { headers: { Authorization: `Bearer ${f.token}x`, 'X-Task-Protocol': '1' } });

		expect(lines.length).toBeGreaterThan(0);
		expect(lines.join('\n')).not.toContain(f.token);
	});
});

describe('the protocol header', () => {
	it('answers 426 with the supported range when the version is missing or unknown', async () => {
		const f = await fixture();

		const missing = await f.raw('/v1/info', { headers: { Authorization: `Bearer ${f.token}` } });
		const future = await f.raw('/v1/info', {
			headers: { Authorization: `Bearer ${f.token}`, 'X-Task-Protocol': '9' },
		});
		const junk = await f.raw('/v1/info', {
			headers: { Authorization: `Bearer ${f.token}`, 'X-Task-Protocol': 'x' },
		});

		for (const result of [missing, future, junk]) {
			expect(result.status).toBe(426);
			expect(result.headers.get('x-task-protocol')).toBe('1');
			expect(JSON.parse(result.text).error).toMatchObject({
				type: 'incompatible',
				supported: { min: 1, max: 1 },
			});
		}
	});
});

describe('routes and methods', () => {
	it('answers 404 for an unknown route and 405 with Allow for a known path and a wrong method; no CORS headers anywhere', async () => {
		const f = await fixture();

		const unknown = await f.raw('/v1/nothing', { headers: f.headers() });
		const wrongMethod = await f.raw('/v1/tasks/abc', { method: 'PATCH', headers: f.headers() });
		const preflight = await f.raw('/v1/tasks', {
			method: 'OPTIONS',
			headers: { Origin: 'http://evil.example', 'Access-Control-Request-Method': 'POST' },
		});

		expect(unknown.status).toBe(404);
		expect(JSON.parse(unknown.text).error.type).toBe('unknown-route');
		expect(wrongMethod.status).toBe(405);
		expect(wrongMethod.headers.get('allow')).toBe('DELETE, GET');
		for (const result of [unknown, wrongMethod, preflight]) {
			expect(result.headers.get('access-control-allow-origin')).toBeNull();
		}
	});

	it('rejects a malformed percent sequence in the path as a bad request', async () => {
		const f = await fixture();

		const result = await f.raw('/v1/tasks/%E0%A4%A', { headers: f.headers() });

		expect(result.status).toBe(400);
	});
});

describe('request bodies', () => {
	const post = (f: ServerFixture, body: string, contentType = 'application/json') =>
		f.raw('/v1/tasks', {
			method: 'POST',
			headers: f.headers({ 'Content-Type': contentType }),
			body,
		});

	it('refuses malformed JSON, a body that is not an object, an unknown key, a missing key and a wrong type, each with its field', async () => {
		const f = await fixture();

		const malformed = await post(f, '{"title": ');
		const notObject = await post(f, '[1,2]');
		const unknownKey = await post(f, JSON.stringify({ title: 'x', status: 'backlog', prority: 'high' }));
		const missing = await post(f, JSON.stringify({ status: 'backlog' }));
		const wrongType = await post(f, JSON.stringify({ title: 42, status: 'backlog' }));

		for (const result of [malformed, notObject, unknownKey, missing, wrongType]) {
			expect(result.status).toBe(400);
			expect(JSON.parse(result.text).error.type).toBe('invalid-request');
		}
		expect(JSON.parse(malformed.text).error.message).toContain('not valid JSON');
		expect(JSON.parse(unknownKey.text).error.message).toContain('prority');
		expect(JSON.parse(missing.text).error.message).toContain('"title" is required');
		expect(JSON.parse(wrongType.text).error.message).toContain('"title" must be a string');
	});

	it('answers 415 when the body is not declared as JSON', async () => {
		const f = await fixture();

		const result = await post(f, '{"title":"x","status":"backlog"}', 'text/plain');

		expect(result.status).toBe(415);
	});

	it('answers 413 for a body over the limit, declared or streamed, and keeps serving afterwards', async () => {
		const f = await fixture({ maxBodyBytes: 200 });
		const big = JSON.stringify({ title: 'x'.repeat(500), status: 'backlog' });

		const declared = await post(f, big);
		// Chunked: no Content-Length, the size is only known by counting.
		const streamed = await f.raw('/v1/tasks', {
			method: 'POST',
			headers: f.headers({ 'Content-Type': 'application/json' }),
			body: new ReadableStream({
				start(controller) {
					controller.enqueue(new TextEncoder().encode(big));
					controller.close();
				},
			}),
			duplex: 'half',
		} as RequestInit);
		const after = await f.call('info');

		expect(declared.status).toBe(413);
		expect(streamed.status).toBe(413);
		expect(JSON.parse(declared.text).error.type).toBe('too-large');
		expect(after.status).toBe(200);
		expect(await f.ctx.store.list()).toEqual([]);
	});

	it('a client that goes away in the middle of a body is a warning, not an error of the server, and nothing is written', async () => {
		const levels: string[] = [];
		const f = await fixture({ log: level => levels.push(level) });

		await new Promise<void>(resolve => {
			const socket = net.connect(f.server.port, '127.0.0.1', () => {
				socket.write(
					`POST /v1/tasks HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer ${f.token}\r\nX-Task-Protocol: 1\r\nContent-Type: application/json\r\nContent-Length: 500\r\n\r\n{"title":"half`
				);
				setTimeout(() => {
					socket.destroy();
					resolve();
				}, 30);
			});
		});
		await new Promise(resolve => setTimeout(resolve, 60));
		const after = await f.call('info');

		expect(levels).not.toContain('error');
		expect(after.status).toBe(200);
		expect(await f.ctx.store.list()).toEqual([]);
	});

	it('a connection that is reset (a command that ended with its keep-alive socket open) is not a warning: it is how clients leave', async () => {
		const levels: string[] = [];
		const f = await fixture({ log: level => levels.push(level) });

		await new Promise<void>(resolve => {
			const socket = net.connect(f.server.port, '127.0.0.1', () => {
				socket.write('GET /v1/info HTTP/1.1\r\nHost: x\r\n');
				setTimeout(() => {
					socket.resetAndDestroy();
					resolve();
				}, 30);
			});
		});
		await new Promise(resolve => setTimeout(resolve, 60));

		expect(levels.filter(level => level !== 'info')).toEqual([]);
		expect((await f.call('info')).status).toBe(200);
	});

	it('drops a connection that sends garbage instead of HTTP and keeps serving', async () => {
		const f = await fixture();

		const answer = await new Promise<string>((resolve, reject) => {
			const socket = net.connect(f.server.port, '127.0.0.1', () => socket.write('NOT HTTP AT ALL\r\n\r\n'));
			let received = '';
			socket.on('data', chunk => (received += String(chunk)));
			socket.on('close', () => resolve(received));
			socket.on('error', reject);
		});
		const after = await f.call('info');

		expect(answer).toContain('400');
		expect(after.status).toBe(200);
	});
});

describe('validation of the input', () => {
	it('refuses an id that is a path, in the URL and in a body, and reads no file outside the data folder', async () => {
		const f = await fixture();
		const secret = path.join(f.test.rootDir, 'data', 'secret.json');
		fs.writeFileSync(secret, JSON.stringify({ id: 'secret', title: 'leaked', status: 'backlog' }));

		for (const id of ['..%2Fsecret', '..%5Csecret', '%2E%2E%2Fsecret', 'a%2Fb', 'C%3A%5Cx', '.hidden', 'a.json']) {
			const result = await f.raw(`/v1/tasks/${id}`, { headers: f.headers() });
			expect(result.status, id).toBe(400);
			expect(result.text).not.toContain('leaked');
		}
		const parent = await f.call('create', {}, { title: 'x', status: 'backlog', parentId: '../secret' });
		const link = await f.call('addLink', { id: 'abc' }, { type: 'blockedBy', targetId: '../secret' });

		expect(parent.status).toBe(400);
		expect(link.status).toBe(400);
		expect(await f.ctx.store.list()).toEqual([]);
	});

	it('checks statuses, types and link types against the config of the SERVED project, naming the valid values', async () => {
		const f = await fixture({ config: { types: ['bug', 'feature'] } });
		const task = (await f.call('create', {}, { title: 'A', status: 'backlog' })).body.result;

		const status = await f.call('updateStatus', { id: task.id }, { status: 'blocked' });
		const created = await f.call('create', {}, { title: 'B', status: 'weird' });
		const type = await f.call('setType', { id: task.id }, { type: 'epic' });
		const linkType = await f.call('addLink', { id: task.id }, { type: 'relatesTo', targetId: task.id });

		expect(status.status).toBe(400);
		expect(status.body.error.message).toContain('valid: backlog, in-progress, done');
		expect(created.status).toBe(400);
		expect(type.status).toBe(400);
		expect(type.body.error.message).toContain('bug, feature');
		expect(linkType.status).toBe(400);
		expect(linkType.body.error.hint).toContain('blockedBy, duplicateOf, causedBy');
		expect((await f.ctx.store.get(task.id)).status).toBe('backlog');
	});
});

describe('every operation of the port, through the protocol', () => {
	it('has a case here for each route of the table (nothing was added to the protocol without a test)', () => {
		expect(ROUTES.map(route => route.op).sort()).toEqual(['info', ...PORT_OPERATIONS].sort());
	});

	it('reads and writes a whole scenario, and the data lands in the served project', async () => {
		const f = await fixture();
		const call = f.call.bind(f);

		const a = (await call('create', {}, { title: 'Parent', status: 'backlog', description: 'Parent body' })).body
			.result;
		const created = await call('create', {}, { title: 'Child', status: 'backlog', parentId: a.id });
		expect(created.status).toBe(201);
		const b = created.body.result;
		expect(created.body.events).toEqual({ enabled: false, delivered: 0, undelivered: [] });

		const expectOk = async (promise: ReturnType<typeof call>) => {
			const result = await promise;
			expect(result.status, JSON.stringify(result.body)).toBe(200);
			return result.body;
		};

		expect((await expectOk(call('get', { id: a.id }))).title).toBe('Parent');
		expect((await expectOk(call('list'))).items.map((t: { id: string }) => t.id)).toEqual([a.id, b.id]);
		expect(
			(await expectOk(call('listPage', {}, { parentId: null, limit: 1 }))).items.map((t: { id: string }) => t.id)
		).toEqual([a.id]);
		expect((await expectOk(call('listPage'))).items).toHaveLength(2);
		expect(
			(await expectOk(call('getMany', {}, { ids: [b.id, a.id] }))).items.map((t: { id: string }) => t.id)
		).toEqual([b.id, a.id]);
		expect((await expectOk(call('findByPrefix', { prefix: a.id.slice(0, 5) }))).id).toBe(a.id);
		expect((await expectOk(call('getChildren', { id: a.id }))).items.map((t: { id: string }) => t.id)).toEqual([
			b.id,
		]);
		expect((await expectOk(call('getTree', { id: a.id }))).children).toHaveLength(1);
		expect((await expectOk(call('getFullTree', { id: b.id }))).id).toBe(a.id);
		expect((await expectOk(call('getDescendants', { id: a.id }))).items).toHaveLength(1);
		expect((await expectOk(call('getAncestors', { id: b.id }))).items.map((t: { id: string }) => t.id)).toEqual([
			a.id,
		]);
		expect((await expectOk(call('getForest'))).items).toHaveLength(1);
		expect((await expectOk(call('getForest', {}, undefined, { query: { parentId: a.id } }))).items).toHaveLength(1);

		const status = await expectOk(call('updateStatus', { id: b.id }, { status: 'in-progress' }));
		expect(status.result.status).toBe('in-progress');
		await expectOk(call('setTitle', { id: b.id }, { title: 'Child renamed' }));
		await expectOk(call('setDescription', { id: b.id }, { description: 'with a body' }));
		await expectOk(call('setType', { id: b.id }, { type: 'bug' }));
		await expectOk(call('addLabel', { id: b.id }, { label: 'area/ui 100%' }));
		await expectOk(call('setMeta', { id: b.id, key: 'build key/1' }, { value: 'v1' }));
		const labels = await expectOk(call('listLabels'));
		expect(labels.items).toEqual([{ label: 'area/ui 100%', count: 1 }]);

		await expectOk(call('addLink', { id: b.id }, { type: 'blockedBy', targetId: a.id }));
		expect((await expectOk(call('getLinks', { id: b.id }))).blockedBy.map((t: { id: string }) => t.id)).toEqual([
			a.id,
		]);
		expect(
			(await expectOk(call('getLinksLenient', { id: a.id }))).links.blocks.map((t: { id: string }) => t.id)
		).toEqual([b.id]);
		await expectOk(call('removeLink', { id: b.id, type: 'blockedBy', target: a.id }));

		const commented = await expectOk(call('addComment', { id: b.id }, { text: 'hello', author: 'ann' }));
		const commentId = commented.result.comment.id as string;
		expect(commented.result.comment.author).toBe('ann');
		const edited = await expectOk(call('editComment', { id: b.id, commentId }, { text: 'hello again' }));
		expect(edited.result).toMatchObject({ oldText: 'hello', changed: true });
		await expectOk(call('removeComment', { id: b.id, commentId }));

		await expectOk(call('removeMeta', { id: b.id, key: 'build key/1' }));
		await expectOk(call('removeLabel', { id: b.id, label: 'area/ui 100%' }));
		await expectOk(call('clearType', { id: b.id }));
		await expectOk(call('removeParent', { id: b.id }));
		await expectOk(call('setParent', { id: b.id }, { parentId: a.id }));

		expect((await expectOk(call('deleteTask', { id: b.id }))).result).toEqual({ deleted: true });
		expect((await expectOk(call('deleteTask', { id: b.id }))).result).toEqual({ deleted: false });
		expect((await f.ctx.store.list()).map(t => t.id)).toEqual([a.id]);
		const onDisk = JSON.parse(fs.readFileSync(path.join(f.test.rootDir, 'data', 'tasks', `${a.id}.json`), 'utf8'));
		expect(onDisk.title).toBe('Parent');
	});
});

describe('typed errors through HTTP', () => {
	it('maps not found, ambiguous prefix, conflicts and comment errors to their status and type', async () => {
		const f = await fixture();
		const one = (await f.call('create', {}, { title: 'One', status: 'backlog' })).body.result;
		const two = (await f.call('create', {}, { title: 'Two', status: 'backlog' })).body.result;

		const missing = await f.call('get', { id: 'nope1234' });
		const sameStatus = await f.call('updateStatus', { id: one.id }, { status: 'backlog' });
		const selfParent = await f.call('setParent', { id: one.id }, { parentId: one.id });
		const noComment = await f.call('removeComment', { id: one.id, commentId: 'zzz' });
		const blank = await f.call('addComment', { id: one.id }, { text: '   ' });
		// Two ids that share their first character: the prefix of length one is ambiguous (unless the ids differ, then the test is vacuous).
		const shared = one.id[0] === two.id[0] ? one.id[0] : undefined;
		const ambiguous = shared === undefined ? undefined : await f.call('findByPrefix', { prefix: shared });

		expect([missing.status, missing.body.error.type, missing.body.error.taskId]).toEqual([
			404,
			'not-found',
			'nope1234',
		]);
		expect([sameStatus.status, sameStatus.body.error.type]).toEqual([409, 'conflict']);
		expect([selfParent.status, selfParent.body.error.type]).toEqual([409, 'conflict']);
		expect([noComment.status, noComment.body.error.type]).toEqual([404, 'comment-not-found']);
		expect(noComment.body.error.validIds).toEqual([]);
		expect([blank.status, blank.body.error.type]).toEqual([400, 'invalid-comment']);
		if (ambiguous !== undefined) {
			expect([ambiguous.status, ambiguous.body.error.type]).toEqual([409, 'ambiguous']);
			expect(ambiguous.body.error.matches.sort()).toEqual([one.id, two.id].sort());
		}
	});

	it('answers 412 stale when If-Match is not the current revision, writes nothing, and succeeds with the current one', async () => {
		const f = await fixture();
		const task = (await f.call('create', {}, { title: 'T', status: 'backlog' })).body.result;

		const stale = await f.call(
			'addLabel',
			{ id: task.id },
			{ label: 'x' },
			{ headers: { 'If-Match': '"0000000000000000"' } }
		);
		const fresh = await f.call(
			'addLabel',
			{ id: task.id },
			{ label: 'x' },
			{ headers: { 'If-Match': `"${task.revision}"` } }
		);
		const again = await f.call(
			'addLabel',
			{ id: task.id },
			{ label: 'y' },
			{ headers: { 'If-Match': `"${task.revision}"` } }
		);

		expect(stale.status).toBe(412);
		expect(stale.body.error).toMatchObject({
			type: 'stale',
			taskId: task.id,
			expectedRevision: '0000000000000000',
		});
		expect(fresh.status).toBe(200);
		expect(fresh.body.result.labels).toEqual(['x']);
		// The revision moved with the first write: the same If-Match is stale now.
		expect(again.status).toBe(412);
		expect((await f.ctx.store.get(task.id)).labels).toEqual(['x']);
	});

	it('does not leak the data folder or the token through an internal error', async () => {
		const f = await fixture({
			wrap: ctx => ({
				...ctx,
				store: new Proxy(ctx.store, {
					get(target, property, receiver) {
						if (property === 'list') {
							return () =>
								Promise.reject(
									new Error(
										`EPERM: cannot open '${ctx.storage.dataDir}/task-index.json' with ${TEST_TOKEN}`
									)
								);
						}
						return Reflect.get(target, property, receiver) as unknown;
					},
				}),
			}),
		});

		const result = await f.call('list');

		expect(result.status).toBe(500);
		expect(result.body.error.type).toBe('internal');
		expect(JSON.stringify(result.body)).not.toContain(f.test.rootDir);
		expect(JSON.stringify(result.body)).not.toContain(TEST_TOKEN);
		expect(JSON.stringify(result.body)).not.toContain('stack');
	});
});

describe('the single writer', () => {
	it('runs concurrent writes one at a time, in the order they arrived', async () => {
		const probe = { running: 0, maxRunning: 0, order: [] as string[] };
		const f = await fixture({ wrap: slowWrites(15, probe) });
		const task = (await f.call('create', {}, { title: 'T', status: 'backlog' })).body.result;

		const answers = await Promise.all(
			Array.from({ length: 12 }, (_unused, index) => f.call('addLabel', { id: task.id }, { label: `l${index}` }))
		);

		expect(answers.every(answer => answer.status === 200)).toBe(true);
		expect(probe.maxRunning).toBe(1);
		// Every start is followed by its own end before the next start.
		for (let index = 0; index < probe.order.length; index += 2) {
			expect(probe.order[index]!.startsWith('start')).toBe(true);
			expect(probe.order[index + 1]).toBe(probe.order[index]!.replace('start', 'end'));
		}
		const labels = (await f.ctx.store.get(task.id)).labels ?? [];
		expect(labels.sort()).toEqual(Array.from({ length: 12 }, (_unused, index) => `l${index}`).sort());
	});

	it('does not stay blocked behind a write that failed', async () => {
		const f = await fixture();
		const task = (await f.call('create', {}, { title: 'T', status: 'backlog' })).body.result;

		const [bad, good] = await Promise.all([
			f.call('updateStatus', { id: task.id }, { status: 'backlog' }),
			f.call('addLabel', { id: task.id }, { label: 'ok' }),
		]);

		expect(bad.status).toBe(409);
		expect(good.status).toBe(200);
	});

	it('keeps serving reads while a write is slow', async () => {
		const probe = { running: 0, maxRunning: 0, order: [] as string[] };
		const f = await fixture({ wrap: slowWrites(150, probe) });
		const task = (await f.call('create', {}, { title: 'T', status: 'backlog' })).body.result;

		const write = f.call('addLabel', { id: task.id }, { label: 'slow' });
		await new Promise(resolve => setTimeout(resolve, 30));
		const startedAt = Date.now();
		const read = await f.call('get', { id: task.id });

		expect(read.status).toBe(200);
		expect(Date.now() - startedAt).toBeLessThan(120);
		expect((await write).status).toBe(200);
	});
});

describe('queue events: raised by the server', () => {
	it('delivers the events a local project would raise, with the SERVED project in the payload, in order', async () => {
		const f = await fixture({ withSink: true });
		const blocker = (await f.call('create', {}, { title: 'Blocker', status: 'backlog' })).body.result;
		const blocked = (await f.call('create', {}, { title: 'Blocked', status: 'backlog' })).body.result;
		await f.call('addLink', { id: blocked.id }, { type: 'blockedBy', targetId: blocker.id });
		f.sink.delivered.length = 0;

		const done = await f.call('updateStatus', { id: blocker.id }, { status: 'done' });

		expect(done.body.events).toEqual({ enabled: true, delivered: 2, undelivered: [] });
		expect(f.sink.names()).toEqual(['onStatusChange', 'onTaskUnblocked']);
		expect(f.sink.delivered[0]!.payload).toMatchObject({
			taskId: blocker.id,
			oldStatus: 'backlog',
			newStatus: 'done',
			status: 'done',
			taskProjectId: 'ab12cd34',
			taskProjectName: 'served',
			taskProjectPath: f.test.rootDir,
		});
		expect(f.sink.delivered[1]!.payload).toMatchObject({ taskId: blocked.id, blockerId: blocker.id });
	});

	it('raises nothing for a write that changed nothing, and nothing for a read', async () => {
		const f = await fixture({ withSink: true });
		const task = (await f.call('create', {}, { title: 'T', status: 'backlog' })).body.result;
		await f.call('addLabel', { id: task.id }, { label: 'x' });
		f.sink.delivered.length = 0;

		await f.call('addLabel', { id: task.id }, { label: 'x' });
		await f.call('removeLabel', { id: task.id, label: 'absent' });
		await f.call('get', { id: task.id });
		await f.call('list');

		expect(f.sink.names()).toEqual([]);
	});

	it('raises none for a write sent with X-Task-Events: suppress (a migration), and says so', async () => {
		const f = await fixture({ withSink: true });

		const created = await f.call(
			'create',
			{},
			{ title: 'T', status: 'backlog' },
			{ headers: { 'X-Task-Events': 'suppress' } }
		);
		const bad = await f.call(
			'create',
			{},
			{ title: 'U', status: 'backlog' },
			{ headers: { 'X-Task-Events': 'maybe' } }
		);

		expect(created.status).toBe(201);
		expect(created.body.events).toEqual({ enabled: true, delivered: 0, undelivered: [] });
		expect(f.sink.names()).toEqual([]);
		expect(bad.status).toBe(400);
	});

	it('saves the change and reports an event the queue did not take, with the reason and whether it may be recorded', async () => {
		const f = await fixture({ withSink: true });
		f.sink.outcome = () => ({ delivered: false, reason: 'queue daemon not running', status: 'dropped' });

		const created = await f.call('create', {}, { title: 'T', status: 'backlog' });

		expect(created.status).toBe(201);
		expect(created.body.events).toEqual({
			enabled: true,
			delivered: 0,
			undelivered: [{ event: 'onTaskCreated', reason: 'queue daemon not running', status: 'dropped' }],
		});
		expect(await f.ctx.store.list()).toHaveLength(1);
	});

	it('reports an unknown outcome when the sink itself throws, and still answers', async () => {
		const f = await fixture({ withSink: true });
		f.sink.outcome = () => {
			throw new Error('sink exploded');
		};

		const created = await f.call('create', {}, { title: 'T', status: 'backlog' });

		expect(created.status).toBe(201);
		expect(created.body.events.undelivered[0]).toMatchObject({ event: 'onTaskCreated', status: 'unknown' });
		expect(created.body.events.undelivered[0].reason).toContain('sink exploded');
	});

	it('delivers the events of concurrent writes in the order the writes were made', async () => {
		const probe = { running: 0, maxRunning: 0, order: [] as string[] };
		const f = await fixture({ withSink: true, wrap: slowWrites(5, probe) });
		const task = (await f.call('create', {}, { title: 'T', status: 'backlog' })).body.result;
		f.sink.delivered.length = 0;
		// The first event is slow to deliver: the later ones must still wait for it.
		let first = true;
		f.sink.outcome = async () => {
			if (first) {
				first = false;
				await new Promise(resolve => setTimeout(resolve, 60));
			}
			return { delivered: true };
		};

		await Promise.all(['a', 'b', 'c', 'd'].map(label => f.call('addLabel', { id: task.id }, { label })));

		expect(f.sink.delivered.map(event => (event.payload as { label: string }).label)).toEqual(
			probe.order.filter(entry => entry.startsWith('start')).map(entry => entry.slice(6))
		);
	});

	it('flushes the sink when it closes', async () => {
		const f = await fixture({ withSink: true });

		await f.server.close();

		expect(f.sink.flushes).toBe(1);
	});
});

describe('robustness', () => {
	it('survives a backend that rejects asynchronously: a 500, no unhandled rejection, the next request works', async () => {
		const seen: unknown[] = [];
		const onRejection = (reason: unknown): number => seen.push(reason);
		process.on('unhandledRejection', onRejection);
		try {
			let fail = true;
			const f = await fixture({
				wrap: ctx => ({
					...ctx,
					store: new Proxy(ctx.store, {
						get(target, property, receiver) {
							if (property === 'list' && fail) {
								return async () => {
									await new Promise(resolve => setTimeout(resolve, 5));
									throw new Error('disk on fire');
								};
							}
							return Reflect.get(target, property, receiver) as unknown;
						},
					}),
				}),
			});

			const broken = await f.call('list');
			fail = false;
			const fine = await f.call('list');
			await new Promise(resolve => setTimeout(resolve, 20));

			expect(broken.status).toBe(500);
			expect(broken.body.error.message).toBe('disk on fire');
			expect(fine.status).toBe(200);
			expect(seen).toEqual([]);
		} finally {
			process.off('unhandledRejection', onRejection);
		}
	});

	it('finishes the write in flight when it is asked to close, then stops listening', async () => {
		const probe = { running: 0, maxRunning: 0, order: [] as string[] };
		const f = await fixture({ wrap: slowWrites(120, probe) });
		const task = (await f.call('create', {}, { title: 'T', status: 'backlog' })).body.result;

		const write = f.call('addLabel', { id: task.id }, { label: 'last' });
		await new Promise(resolve => setTimeout(resolve, 30));
		const closing = f.server.close();
		const answer = await write;
		await closing;
		await f.server.close();

		expect(answer.status).toBe(200);
		expect((await f.ctx.store.get(task.id)).labels).toEqual(['last']);
		await expect(fetch(`${f.server.url}/v1/info`, { headers: f.headers() })).rejects.toThrow();
	});

	it('cuts the connections after the grace period when a request will not finish', async () => {
		const probe = { running: 0, maxRunning: 0, order: [] as string[] };
		const warnings: string[] = [];
		const f = await fixture({
			wrap: slowWrites(2_000, probe),
			shutdownGraceMs: 50,
			log: (level, message) => {
				if (level === 'warn') warnings.push(message);
			},
		});
		const task = (await f.call('create', {}, { title: 'T', status: 'backlog' })).body.result;

		const write = f.call('addLabel', { id: task.id }, { label: 'slow' }).catch((error: unknown) => error);
		await new Promise(resolve => setTimeout(resolve, 30));
		const startedAt = Date.now();
		await f.server.close();

		expect(Date.now() - startedAt).toBeLessThan(1_500);
		expect(warnings.join('\n')).toContain('still running');
		await write;
	});
});

describe('starting', () => {
	it('refuses a token that is too short, saying how to make a good one', async () => {
		const f = await fixture();

		const error = await startTaskServer({ ctx: f.ctx, token: 'short' }).catch((e: unknown) => e);

		expect(error).toBeInstanceOf(TaskServerStartError);
		expect((error as TaskServerStartError).message).toContain('too short');
		expect((error as TaskServerStartError).hint).toContain('randomBytes');
	});

	it('refuses to serve a project whose own strategy is not local', async () => {
		const f = await fixture();
		const forge = {
			...f.ctx,
			store: new Proxy(f.ctx.store, { get: (t, p, r) => (p === 'kind' ? 'github' : Reflect.get(t, p, r)) }),
		};

		const error = await startTaskServer({ ctx: forge as TaskServiceContext, token: TEST_TOKEN }).catch(
			(e: unknown) => e
		);

		expect(error).toBeInstanceOf(TaskServerStartError);
		expect((error as TaskServerStartError).message).toContain('github strategy');
		expect((error as TaskServerStartError).hint).toContain('Chaining');
	});

	it('says that the port is taken, and what to do', async () => {
		const f = await fixture();

		const error = await startTaskServer({ ctx: f.ctx, token: TEST_TOKEN, port: f.server.port }).catch(
			(e: unknown) => e
		);

		expect(error).toBeInstanceOf(TaskServerStartError);
		expect((error as TaskServerStartError).message).toContain('already in use');
		expect((error as TaskServerStartError).hint).toContain('--port');
	});

	it('listens on loopback by default', async () => {
		const f = await fixture();

		expect(f.server.host).toBe('127.0.0.1');
		expect(f.server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
	});
});
