// Guards of the move to the async backend port (storage-strategies design, stage 0.3):
//  - save THEN emit: a use case resolves only once its write is saved, and its events are built from the saved record;
//  - sequential deletion: executeDelete never runs two deletions at once, whatever the latency of the backend;
//  - no `revision` (the backend's opaque version) reaches an answer, so JSON and events are the ones of the sync store.
import type { TaskBackend } from '@wadeck-app/task-core';

import { addComment, editComment, removeComment } from './comments.js';
import type { TaskServiceContext } from './context.js';
import { createTask } from './createTask.js';
import { executeDelete, planDelete } from './deleteTasks.js';
import { removeParent, setParent } from './hierarchy.js';
import { linkTasks, readTaskLinks, unlinkTasks } from './links.js';
import { setStatus } from './setStatus.js';
import { setTaskText } from './setTaskText.js';
import { showTask, showTaskWithRelations } from './showTask.js';
import { addLabel, removeLabel, setMeta, setType, unsetMeta, unsetType } from './taskFields.js';
import { createTestContext, type TestContext } from './testHelpers.js';

function sleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * The context's backend with every call resolving later than a tick (a remote backend). `inFlight` is the highest
 * number of calls running at the same time: 1 means the use case awaited each call before starting the next.
 */
function slowContext(
	ctx: TaskServiceContext,
	delayOf: (call: number) => number
): { ctx: TaskServiceContext; stats: { inFlight: number; maxInFlight: number; calls: string[] } } {
	const stats = { inFlight: 0, maxInFlight: 0, calls: [] as string[] };
	let call = 0;
	const store = new Proxy(ctx.store, {
		get(target, prop) {
			const value: unknown = Reflect.get(target, prop);
			if (typeof value !== 'function') return value;
			return async (...args: unknown[]) => {
				stats.calls.push(String(prop));
				stats.inFlight++;
				stats.maxInFlight = Math.max(stats.maxInFlight, stats.inFlight);
				try {
					await sleep(delayOf(call++));
					return await (value as (...a: unknown[]) => unknown).apply(target, args);
				} finally {
					stats.inFlight--;
				}
			};
		},
	}) as TaskBackend;
	return { ctx: { ...ctx, store }, stats };
}

/** True when `revision` is a key anywhere in the value. */
function hasRevisionKey(value: unknown): boolean {
	return /"revision"\s*:/.test(JSON.stringify(value));
}

describe('use cases over a slow backend', () => {
	let t: TestContext;
	let slow: ReturnType<typeof slowContext>;
	let a: string;
	let b: string;
	beforeEach(async () => {
		t = createTestContext({ negativeStatuses: [] });
		a = (await t.ctx.store.create({ title: 'task a', status: 'backlog' })).id;
		b = (await t.ctx.store.create({ title: 'task b', status: 'backlog' })).id;
		slow = slowContext(t.ctx, () => 4);
	});
	afterEach(() => t.cleanup());

	// Each case: the use case runs on the slow backend; once it has resolved, the FAST backend (same files) must already
	// hold the change, and the events must describe it. A forgotten `await` on a write resolves too early and fails here.
	const cases: Array<{
		name: string;
		run: (ctx: TaskServiceContext) => Promise<{ events: unknown[] }>;
		saved: (ctx: TaskServiceContext) => Promise<unknown>;
		expected: unknown;
	}> = [
		{
			name: 'setStatus',
			run: ctx => setStatus(ctx, { id: a, status: 'in-progress' }),
			saved: async ctx => (await ctx.store.get(a)).status,
			expected: 'in-progress',
		},
		{
			name: 'setType',
			run: ctx => setType(ctx, { id: a, type: 'bug' }),
			saved: async ctx => (await ctx.store.get(a)).type,
			expected: 'bug',
		},
		{
			name: 'addLabel',
			run: ctx => addLabel(ctx, { id: a, label: 'x' }),
			saved: async ctx => (await ctx.store.get(a)).labels,
			expected: ['x'],
		},
		{
			name: 'setMeta',
			run: ctx => setMeta(ctx, { id: a, key: 'k', value: 'v' }),
			saved: async ctx => (await ctx.store.get(a)).meta,
			expected: { k: 'v' },
		},
		{
			name: 'setTaskText',
			run: ctx => setTaskText(ctx, { id: a, title: 'renamed' }),
			saved: async ctx => (await ctx.store.get(a)).title,
			expected: 'renamed',
		},
		{
			name: 'addComment',
			run: ctx => addComment(ctx, { id: a, text: 'hello' }),
			saved: async ctx => (await ctx.store.get(a)).comments?.map(c => c.text),
			expected: ['hello'],
		},
	];

	it.each(cases)(
		'$name resolves only once the change is saved, with the event of that change',
		async ({ run, saved, expected }) => {
			const result = await run(slow.ctx);

			expect(await saved(t.ctx)).toEqual(expected);
			expect(result.events.length).toBeGreaterThan(0);
		}
	);

	it('setParent and linkTasks save the parent and the stored link before they resolve', async () => {
		const parentResult = await setParent(slow.ctx, { id: a, parent: b });
		expect((await t.ctx.store.get(a)).parentId).toBe(b);
		expect(parentResult.events).toHaveLength(1);

		const linkResult = await linkTasks(slow.ctx, { id: a, type: 'blockedBy', target: b });
		expect((await t.ctx.store.get(a)).links).toEqual([{ type: 'blockedBy', target: b }]);
		expect(linkResult.events).toHaveLength(1);
	});

	it('unset / remove variants are saved before they resolve', async () => {
		await setType(t.ctx, { id: a, type: 'bug' });
		await addLabel(t.ctx, { id: a, label: 'x' });
		await setMeta(t.ctx, { id: a, key: 'k', value: 'v' });
		await setParent(t.ctx, { id: a, parent: b });
		await linkTasks(t.ctx, { id: a, type: 'blockedBy', target: b });

		await unsetType(slow.ctx, { id: a });
		expect((await t.ctx.store.get(a)).type).toBeUndefined();
		await removeLabel(slow.ctx, { id: a, label: 'x' });
		expect((await t.ctx.store.get(a)).labels ?? []).toEqual([]);
		await unsetMeta(slow.ctx, { id: a, key: 'k' });
		expect((await t.ctx.store.get(a)).meta ?? {}).toEqual({});
		await removeParent(slow.ctx, { id: a });
		expect((await t.ctx.store.get(a)).parentId).toBeUndefined();
		await unlinkTasks(slow.ctx, { id: a, type: 'blockedBy', target: b });
		expect((await t.ctx.store.get(a)).links ?? []).toEqual([]);
	});

	it('createTask resolves with the saved task (it exists in the backend when the promise settles)', async () => {
		const result = await createTask(slow.ctx, { title: 'created slowly', parent: a });

		expect((await t.ctx.store.get(result.task.id)).title).toBe('created slowly');
		expect(result.events[0]!.payload).toMatchObject({ taskId: result.task.id, parentId: a });
	});

	it('comment edits and removals are saved before they resolve', async () => {
		const added = await addComment(slow.ctx, { id: a, text: 'one' });
		const commentId = added.comment.id;

		await editComment(slow.ctx, { id: a, commentId, text: 'two' });
		expect((await t.ctx.store.get(a)).comments?.[0]?.text).toBe('two');
		await removeComment(slow.ctx, { id: a, commentId });
		expect((await t.ctx.store.get(a)).comments ?? []).toEqual([]);
	});
});

describe('executeDelete over a slow, jittery backend', () => {
	let t: TestContext;
	afterEach(() => t.cleanup());

	it('deletes one task at a time, deepest first, and reports the events in that order', async () => {
		t = createTestContext();
		const root = (await t.ctx.store.create({ title: 'root', status: 'backlog' })).id;
		const mid = (await t.ctx.store.create({ title: 'mid', status: 'backlog', parentId: root })).id;
		const leaf = (await t.ctx.store.create({ title: 'leaf', status: 'backlog', parentId: mid })).id;
		const other = (await t.ctx.store.create({ title: 'other', status: 'backlog' })).id;
		// Latencies that would reorder parallel calls: the first call is the slowest.
		const slow = slowContext(t.ctx, call => (call % 3 === 0 ? 12 : 1));

		const plan = await planDelete(slow.ctx, { selector: { kind: 'ids', ids: [root, other] }, cascade: true });
		const result = await executeDelete(slow.ctx, plan);

		expect(result.deletedCount).toBe(4);
		expect(result.events.map(event => event.payload.taskId)).toEqual([leaf, mid, root, other]);
		expect(slow.stats.maxInFlight).toBe(1);
		expect(await t.ctx.store.list()).toEqual([]);
	});

	it('a failure partway reports the events of the tasks already deleted, which are really gone', async () => {
		t = createTestContext();
		const ids = [];
		for (const title of ['a', 'b', 'c']) {
			ids.push((await t.ctx.store.create({ title, status: 'backlog' })).id);
		}
		let deletions = 0;
		const failing = new Proxy(t.ctx.store, {
			get(target, prop) {
				if (prop !== 'deleteTask') {
					const value: unknown = Reflect.get(target, prop);
					return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
				}
				return async (id: string) => {
					await sleep(3);
					if (++deletions === 2) throw new Error('EPERM: operation not permitted');
					return target.deleteTask(id);
				};
			},
		}) as TaskBackend;
		const ctx = { ...t.ctx, store: failing };

		const plan = await planDelete(ctx, { selector: { kind: 'ids', ids } });
		const error = await executeDelete(ctx, plan).catch((caught: unknown) => caught);

		expect(error).toMatchObject({ deletedCount: 1, plannedCount: 3, failedTaskId: ids[1] });
		expect((error as { events: Array<{ payload: { taskId: string } }> }).events.map(e => e.payload.taskId)).toEqual(
			[ids[0]]
		);
		expect((await t.ctx.store.list()).map(task => task.id)).toEqual([ids[1], ids[2]]);
	});
});

describe('no backend revision reaches an answer', () => {
	let t: TestContext;
	beforeEach(() => {
		t = createTestContext();
	});
	afterEach(() => t.cleanup());

	it('the backend does hand out a revision (the guard below is not vacuous)', async () => {
		const record = await t.ctx.store.create({ title: 'x', status: 'backlog' });

		expect(hasRevisionKey(record)).toBe(true);
	});

	it('every use case that returns a record or builds on one answers and emits without `revision`', async () => {
		const a = (await t.ctx.store.create({ title: 'task a', status: 'backlog' })).id;
		const b = (await t.ctx.store.create({ title: 'task b', status: 'backlog', parentId: a })).id;
		const answers: unknown[] = [
			await createTask(t.ctx, { title: 'created' }),
			await setStatus(t.ctx, { id: a, status: 'in-progress' }),
			await setType(t.ctx, { id: a, type: 'bug' }),
			await unsetType(t.ctx, { id: a }),
			await unsetType(t.ctx, { id: a }),
			await addLabel(t.ctx, { id: a, label: 'x' }),
			await removeLabel(t.ctx, { id: a, label: 'x' }),
			await setMeta(t.ctx, { id: a, key: 'k', value: 'v' }),
			await unsetMeta(t.ctx, { id: a, key: 'k' }),
			await unsetMeta(t.ctx, { id: a, key: 'absent' }),
			await setTaskText(t.ctx, { id: a, title: 'renamed', description: 'body' }),
			await setTaskText(t.ctx, { id: a, title: 'renamed' }),
			await linkTasks(t.ctx, { id: a, type: 'blockedBy', target: b }),
			await readTaskLinks(t.ctx, { id: a }),
			await unlinkTasks(t.ctx, { id: a, type: 'blockedBy', target: b }),
			await removeParent(t.ctx, { id: b }),
			await setParent(t.ctx, { id: b, parent: a }),
			await addComment(t.ctx, { id: a, text: 'hi', author: 'me' }),
			await showTask(t.ctx, { id: a, withParent: true, withChildren: true }),
			await showTask(t.ctx, { id: b, withParent: true, withChildren: true }),
			await showTaskWithRelations(t.ctx, { id: b }),
		];
		const added = await addComment(t.ctx, { id: b, text: 'edit me' });
		answers.push(await editComment(t.ctx, { id: b, commentId: added.comment.id, text: 'edited' }));
		answers.push(await removeComment(t.ctx, { id: b, commentId: added.comment.id }));

		answers.forEach((answer, index) => {
			expect(hasRevisionKey(answer), `answer #${index}: ${JSON.stringify(answer).slice(0, 200)}`).toBe(false);
		});
	});
});
