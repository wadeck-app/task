import { WriteLockTimeoutError } from '@wadeck-app/task-core';
import type { TaskBackend } from '@wadeck-app/task-core';

import type { TaskServiceContext } from '../context.js';
import { startServerFixture } from './testHelpers.js';
import type { ServerFixture } from './testHelpers.js';

// Protocol 2: priority, assignee, claim and release through the task server. The server validates like every other route, runs the
// store's own operations in the write queue, raises the events a local project raises, and is the ONE authority on time.

const open: ServerFixture[] = [];

async function fixture(options: Parameters<typeof startServerFixture>[0] = {}): Promise<ServerFixture> {
	const started = await startServerFixture(options);
	open.push(started);
	return started;
}

afterEach(async () => {
	for (const f of open.splice(0)) await f.stop();
});

const NOW = Date.parse('2026-11-14T10:00:00.000Z');
const MINUTE = 60_000;

async function newTask(f: ServerFixture, title = 'A task'): Promise<string> {
	return (await f.ctx.store.create({ title, status: 'backlog' })).id;
}

describe('the version a route needs', () => {
	it('serves a route of protocol 2 to a request that names 2 and answers 426 (with the supported range) to one that names 1', async () => {
		const f = await fixture();
		const id = await newTask(f);

		const ok = await f.call('setPriority', { id }, { priority: 'high' });
		expect(ok.status).toBe(200);
		expect(ok.headers.get('x-task-protocol')).toBe('2');

		const old = await f.call('setPriority', { id }, { priority: 'low' }, { headers: { 'X-Task-Protocol': '1' } });
		expect(old.status).toBe(426);
		expect(old.body.error).toMatchObject({ type: 'incompatible', supported: { min: 1, max: 2 } });
		expect(old.body.error.message).toContain('needs protocol 2');
		expect(old.body.error.hint).toContain('X-Task-Protocol: 2');
		expect((await f.ctx.store.get(id)).priority).toBe('high');
	});

	it('keeps serving a v1 client unchanged: a request that names 1 gets 1 back, a request that names 2 gets 2, for the same old route', async () => {
		const f = await fixture();
		const id = await newTask(f);

		const v1 = await f.call('updateStatus', { id }, { status: 'in-progress' });
		expect(v1.status).toBe(200);
		expect(v1.headers.get('x-task-protocol')).toBe('1');

		const v2 = await f.call('updateStatus', { id }, { status: 'backlog' }, { headers: { 'X-Task-Protocol': '2' } });
		expect(v2.status).toBe(200);
		expect(v2.headers.get('x-task-protocol')).toBe('2');
	});
});

describe('priority and assignee', () => {
	it('sets and clears both, answers the record with its revision and raises the events of a local project, once per real change', async () => {
		const f = await fixture({ withSink: true });
		const id = await newTask(f);

		const set = await f.call('setPriority', { id }, { priority: ' high ' });
		expect(set.body.result).toMatchObject({ id, priority: 'high', revision: expect.any(String) });
		expect(set.body.events).toMatchObject({ delivered: 1 });
		await f.call('setPriority', { id }, { priority: 'high' });
		await f.call('setPriority', { id }, { priority: 'low' });
		await f.call('clearPriority', { id });
		await f.call('clearPriority', { id });

		await f.call('setAssignee', { id }, { assignee: ' ann ' });
		await f.call('setAssignee', { id }, { assignee: 'ann' });
		await f.call('clearAssignee', { id });
		await f.call('clearAssignee', { id });

		expect(f.sink.delivered.map(event => [event.name, { ...event.payload }])).toEqual([
			[
				'onTaskPriorityChanged',
				expect.objectContaining({ taskId: id, oldPriority: undefined, newPriority: 'high' }),
			],
			['onTaskPriorityChanged', expect.objectContaining({ taskId: id, oldPriority: 'high', newPriority: 'low' })],
			[
				'onTaskPriorityChanged',
				expect.objectContaining({ taskId: id, oldPriority: 'low', newPriority: undefined }),
			],
			[
				'onTaskAssigneeChanged',
				expect.objectContaining({ taskId: id, oldAssignee: undefined, newAssignee: 'ann' }),
			],
			[
				'onTaskAssigneeChanged',
				expect.objectContaining({ taskId: id, oldAssignee: 'ann', newAssignee: undefined }),
			],
		]);
		for (const event of f.sink.delivered) {
			expect(event.payload).toMatchObject({ taskProjectId: 'ab12cd34', taskProjectName: 'served' });
		}
	});

	it('checks the priority against the list of the SERVED project and names the valid ones (400, unknown-priority)', async () => {
		const f = await fixture({ config: { priorities: ['p1', 'p2'] } });
		const id = await newTask(f);

		const refused = await f.call('setPriority', { id }, { priority: 'urgent' });
		expect(refused.status).toBe(400);
		expect(refused.body.error).toMatchObject({
			type: 'unknown-priority',
			priority: 'urgent',
			validPriorities: ['p1', 'p2'],
		});
		expect(refused.body.error.hint).toContain('p1, p2');
		expect((await f.ctx.store.get(id)).priority).toBeUndefined();
	});

	it('refuses a blank or multi-line value as an invalid field (400) and an assignee that is not a string as a malformed request', async () => {
		const f = await fixture();
		const id = await newTask(f);

		const blank = await f.call('setAssignee', { id }, { assignee: '   ' });
		expect([blank.status, blank.body.error.type, blank.body.error.field]).toEqual([
			400,
			'invalid-field',
			'assignee',
		]);
		const lines = await f.call('setAssignee', { id }, { assignee: 'a\nb' });
		expect(lines.body.error.type).toBe('invalid-field');
		const blankPriority = await f.call('setPriority', { id }, { priority: ' ' });
		expect(blankPriority.body.error).toMatchObject({ type: 'invalid-field', field: 'priority' });
		const wrongType = await f.call('setAssignee', { id }, { assignee: 7 });
		expect([wrongType.status, wrongType.body.error.type]).toEqual([400, 'invalid-request']);
		const extra = await f.call('setAssignee', { id }, { assignee: 'ann', now: 'x' });
		expect(extra.body.error.type).toBe('invalid-request');
		expect(extra.body.error.message).toContain('unknown key "now"');
		const noBody = await f.call('setPriority', { id });
		expect(noBody.body.error.type).toBe('invalid-request');
		expect((await f.ctx.store.get(id)).assignee).toBeUndefined();
	});

	it('answers 404 for an unknown task and 412 when If-Match is not the current revision, and writes nothing', async () => {
		const f = await fixture();
		const id = await newTask(f);

		const missing = await f.call('setPriority', { id: 'nope' }, { priority: 'high' });
		expect([missing.status, missing.body.error.type]).toEqual([404, 'not-found']);

		const stale = await f.call('setAssignee', { id }, { assignee: 'ann' }, { headers: { 'If-Match': '"old"' } });
		expect([stale.status, stale.body.error.type]).toEqual([412, 'stale']);
		expect((await f.ctx.store.get(id)).assignee).toBeUndefined();
	});

	it('raises no event for a write sent with X-Task-Events: suppress (a migration)', async () => {
		const f = await fixture({ withSink: true });
		const id = await newTask(f);

		const result = await f.call(
			'setPriority',
			{ id },
			{ priority: 'high' },
			{ headers: { 'X-Task-Events': 'suppress' } }
		);
		expect(result.body.events).toEqual({ enabled: true, delivered: 0, undelivered: [] });
		expect(f.sink.delivered).toEqual([]);
	});
});

describe('claim and release: the server decides the time', () => {
	it('starts the claim at ITS clock and ends the lease leaseMs later: the client sends a duration, never an instant', async () => {
		const f = await fixture({ now: () => new Date(NOW) });
		const id = await newTask(f);

		const claimed = await f.call('claim', { id }, { assignee: ' w1 ', leaseMs: 30 * MINUTE });
		expect(claimed.status).toBe(200);
		expect(claimed.body.result.outcome).toBe('claimed');
		expect(claimed.body.result.task).toMatchObject({
			assignee: 'w1',
			claimedAt: '2026-11-14T10:00:00.000Z',
			leaseUntil: '2026-11-14T10:30:00.000Z',
		});
		expect((await f.ctx.store.get(id)).leaseUntil).toBe('2026-11-14T10:30:00.000Z');
		expect((await f.ctx.store.list())[0]).toMatchObject({ assignee: 'w1', leaseUntil: '2026-11-14T10:30:00.000Z' });

		// Any instant a client might send is refused: the clock of the client has no say.
		for (const key of ['now', 'leaseUntil', 'claimedAt']) {
			const refused = await f.call(
				'claim',
				{ id },
				{ assignee: 'w2', leaseMs: MINUTE, [key]: '2030-01-01T00:00:00.000Z' }
			);
			expect(refused.body.error.type, key).toBe('invalid-request');
			expect(refused.body.error.message).toContain(`unknown key "${key}"`);
		}
		expect((await f.ctx.store.get(id)).assignee).toBe('w1');
	});

	it("judges a second claim against the same server clock: the time left is the server's, and the holder renews, then another takes over after the lease", async () => {
		let now = NOW;
		const f = await fixture({ now: () => new Date(now) });
		const id = await newTask(f);
		await f.call('claim', { id }, { assignee: 'w1', leaseMs: 30 * MINUTE });

		now = NOW + 15 * MINUTE;
		const busy = await f.call('claim', { id }, { assignee: 'w2', leaseMs: 30 * MINUTE });
		expect(busy.status).toBe(409);
		expect(busy.body.error).toMatchObject({
			type: 'claimed',
			taskId: id,
			holder: 'w1',
			leaseUntil: '2026-11-14T10:30:00.000Z',
			remainingMs: 15 * MINUTE,
			ownLease: false,
		});
		expect(busy.body.error.hint).toContain('--force');

		const own = await f.call('claim', { id }, { assignee: 'w1', leaseMs: 30 * MINUTE });
		expect(own.body.error).toMatchObject({ type: 'claimed', ownLease: true });
		const renewed = await f.call('claim', { id }, { assignee: 'w1', leaseMs: 30 * MINUTE, renew: true });
		expect(renewed.body.result).toMatchObject({ outcome: 'renewed' });
		expect(renewed.body.result.task).toMatchObject({
			claimedAt: '2026-11-14T10:00:00.000Z',
			leaseUntil: '2026-11-14T10:45:00.000Z',
		});

		now = NOW + 60 * MINUTE;
		const takeover = await f.call('claim', { id }, { assignee: 'w2', leaseMs: MINUTE });
		expect(takeover.body.result).toMatchObject({ outcome: 'takeover', previousAssignee: 'w1' });
	});

	it('raises onTaskAssigneeChanged with the outcome of each claim and release, like the local use cases', async () => {
		const now = NOW;
		const f = await fixture({ withSink: true, now: () => new Date(now) });
		const id = await newTask(f);

		await f.call('claim', { id }, { assignee: 'w1', leaseMs: 30 * MINUTE });
		await f.call('claim', { id }, { assignee: 'w1', leaseMs: 30 * MINUTE, renew: true });
		await f.call('claim', { id }, { assignee: 'w2', leaseMs: 30 * MINUTE, force: true });
		const released = await f.call('release', { id }, { assignee: 'w2' });
		expect(released.body.result).toMatchObject({ previousAssignee: 'w2', task: { id } });
		expect(released.body.result.task.assignee).toBeUndefined();

		expect(f.sink.delivered.map(event => event.name)).toEqual(Array(4).fill('onTaskAssigneeChanged'));
		expect(f.sink.delivered.map(event => ({ ...event.payload }))).toEqual([
			expect.objectContaining({ oldAssignee: undefined, newAssignee: 'w1', outcome: 'claimed' }),
			expect.objectContaining({ oldAssignee: 'w1', newAssignee: 'w1', outcome: 'renewed' }),
			expect.objectContaining({ oldAssignee: 'w1', newAssignee: 'w2', outcome: 'takeover' }),
			expect.objectContaining({ oldAssignee: 'w2', newAssignee: undefined, outcome: 'released' }),
		]);
	});

	it('refuses a task in a terminal status (even with force) before writing, with no event', async () => {
		const f = await fixture({ withSink: true });
		const id = await newTask(f);
		await f.ctx.store.updateStatus(id, 'done');

		const refused = await f.call('claim', { id }, { assignee: 'w1', leaseMs: MINUTE, force: true });
		expect([refused.status, refused.body.error.type]).toEqual([409, 'closed']);
		expect(refused.body.error.message).toContain('is closed');
		expect(refused.body.error.hint).toContain('set-status');
		expect((await f.ctx.store.get(id)).assignee).toBeUndefined();
		expect(f.sink.delivered).toEqual([]);
	});

	it('maps a release of a free task and a release for another holder to 409 with their own types', async () => {
		const f = await fixture();
		const id = await newTask(f);

		const free = await f.call('release', { id });
		expect([free.status, free.body.error.type, free.body.error.taskId]).toEqual([409, 'not-claimed', id]);

		await f.call('claim', { id }, { assignee: 'w1', leaseMs: MINUTE });
		const other = await f.call('release', { id }, { assignee: 'w2' });
		expect(other.status).toBe(409);
		expect(other.body.error).toMatchObject({ type: 'release-refused', holder: 'w1', requestedBy: 'w2' });
		expect((await f.ctx.store.get(id)).assignee).toBe('w1');

		const forced = await f.call('release', { id }, { assignee: 'w2', force: true });
		expect(forced.body.result.previousAssignee).toBe('w1');
	});

	it('bounds the lease: a second to 7 days, a whole number of milliseconds, flags that are booleans', async () => {
		const f = await fixture();
		const id = await newTask(f);
		const claim = (body: Record<string, unknown>) => f.call('claim', { id }, { assignee: 'w1', ...body });

		for (const leaseMs of [0, 999, 7 * 24 * 60 * MINUTE + 1, -5]) {
			const refused = await claim({ leaseMs });
			expect([refused.status, refused.body.error.type, refused.body.error.field], String(leaseMs)).toEqual([
				400,
				'invalid-field',
				'lease',
			]);
		}
		for (const leaseMs of ['30', 1500.5, null, undefined]) {
			const refused = await claim({ leaseMs });
			expect([refused.status, refused.body.error.type], String(leaseMs)).toEqual([400, 'invalid-request']);
		}
		for (const flag of ['force', 'renew']) {
			const refused = await claim({ leaseMs: MINUTE, [flag]: 'true' });
			expect(refused.body.error.type).toBe('invalid-request');
			expect(refused.body.error.message).toContain(`"${flag}" must be true or false`);
		}
		expect((await f.ctx.store.get(id)).assignee).toBeUndefined();

		expect((await claim({ leaseMs: 1000 })).status).toBe(200);
		await f.call('release', { id });
		expect((await claim({ leaseMs: 7 * 24 * 60 * MINUTE })).status).toBe(200);
	});

	it('answers 412 stale for a claim whose If-Match is not the current revision, and writes nothing', async () => {
		const f = await fixture();
		const id = await newTask(f);

		const stale = await f.call(
			'claim',
			{ id },
			{ assignee: 'w1', leaseMs: MINUTE },
			{ headers: { 'If-Match': '"old"' } }
		);
		expect([stale.status, stale.body.error.type]).toEqual([412, 'stale']);
		expect((await f.ctx.store.get(id)).assignee).toBeUndefined();
	});

	it("answers 503 lock-timeout, naming the holder and not the server's folder, when the project write lock stays taken", async () => {
		const f = await fixture({
			wrap: (ctx: TaskServiceContext): TaskServiceContext => {
				const store = new Proxy(ctx.store, {
					get(target, property, receiver) {
						if (property !== 'claim') return Reflect.get(target, property, receiver) as unknown;
						return () =>
							Promise.reject(
								new WriteLockTimeoutError(
									`Another task process holds the write lock of this project: pid 42 on box (${ctx.storage.dataDir}/.write-lock). Nothing was written.`,
									`Retry in a moment. The lock is the file ${ctx.storage.dataDir}/.write-lock`,
									`${ctx.storage.dataDir}/.write-lock`,
									{ pid: 42, host: 'box', at: '2026-11-14T10:00:00.000Z' }
								)
							);
					},
				}) as TaskBackend;
				return { ...ctx, store };
			},
		});
		const id = await newTask(f);

		const refused = await f.call('claim', { id }, { assignee: 'w1', leaseMs: MINUTE });
		expect(refused.status).toBe(503);
		expect(refused.body.error).toMatchObject({ type: 'lock-timeout', holder: { pid: 42, host: 'box' } });
		expect(JSON.stringify(refused.body)).not.toContain(f.test.rootDir);
		expect(refused.body.error.hint).toContain('Retry');
	});
});
