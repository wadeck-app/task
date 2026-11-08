import { AmbiguousDeletePrefixError, InvalidDeleteFilterError, PartialDeleteError } from './errors.js';
import { describeError } from './describeError.js';
import type { TaskServiceContext } from './context.js';
import { DELETE_FILTER_FIELDS, executeDelete, parseDeleteFilter, planDelete } from './deleteTasks.js';
import { createTestContext, type TestContext } from './testHelpers.js';

describe('parseDeleteFilter', () => {
	it('splits field=value and comma-separated values, dropping empty ones', () => {
		expect(parseDeleteFilter('status=done,backlog,')).toEqual({
			kind: 'filter',
			field: 'status',
			values: ['done', 'backlog'],
		});
		expect(parseDeleteFilter('title=fix*=x')).toEqual({ kind: 'filter', field: 'title', values: ['fix*=x'] });
	});

	it('throws InvalidDeleteFilterError when "=" is missing', () => {
		let caught: unknown;
		try {
			parseDeleteFilter('status');
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(InvalidDeleteFilterError);
		expect((caught as Error).message).toBe('invalid filter: "status" (expected field=value)');
		expect((caught as InvalidDeleteFilterError).hint).toBe(`Valid fields: ${DELETE_FILTER_FIELDS.join(', ')}`);
	});

	it('throws InvalidDeleteFilterError for an unknown field', () => {
		expect(() => parseDeleteFilter('color=red')).toThrow('unknown filter field: "color"');
		expect(DELETE_FILTER_FIELDS).toEqual(['id', 'title', 'status', 'parentId']);
	});
});

describe('planDelete / executeDelete', () => {
	let t: TestContext;
	beforeEach(() => {
		t = createTestContext();
	});
	afterEach(() => t.cleanup());

	it('selects tasks by id prefix and reports unknown prefixes in notFound without failing', async () => {
		const a = await t.ctx.store.create({ title: 'a', status: 'backlog' });
		await t.ctx.store.create({ title: 'b', status: 'backlog' });

		const plan = await planDelete(t.ctx, { selector: { kind: 'ids', ids: [a.id.slice(0, 5), 'zzzz'] } });

		expect(plan.tasks.map(x => x.id)).toEqual([a.id]);
		expect(plan.notFound).toEqual(['zzzz']);
	});

	it('plans a task once when several selectors (prefixes, repeated ids) resolve to it, keeping first-occurrence order', async () => {
		const a = await t.ctx.store.create({ title: 'a', status: 'backlog' });
		const b = await t.ctx.store.create({ title: 'b', status: 'backlog' });

		const plan = await planDelete(t.ctx, {
			selector: { kind: 'ids', ids: [a.id.slice(0, 5), b.id, a.id, b.id.slice(0, 6), a.id] },
		});

		expect(plan.tasks.map(x => x.id)).toEqual([a.id, b.id]);
	});

	it('throws AmbiguousDeletePrefixError when a prefix matches several tasks', async () => {
		await t.ctx.store.create({ title: 'a', status: 'backlog' });
		await t.ctx.store.create({ title: 'b', status: 'backlog' });

		let caught: unknown;
		try {
			// The empty prefix matches every task.
			await planDelete(t.ctx, { selector: { kind: 'ids', ids: [''] } });
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(AmbiguousDeletePrefixError);
		expect((caught as Error).message).toMatch(/^ambiguous prefix ".*" matches: /);
	});

	it('selects everything with kind=all', async () => {
		await t.ctx.store.create({ title: 'a', status: 'backlog' });
		await t.ctx.store.create({ title: 'b', status: 'done' });

		expect((await planDelete(t.ctx, { selector: { kind: 'all' } })).tasks).toHaveLength(2);
	});

	it('selects by glob filter; a root task never matches a parentId pattern', async () => {
		const parent = await t.ctx.store.create({ title: 'fix login', status: 'backlog' });
		await t.ctx.store.create({ title: 'fix logout', status: 'backlog', parentId: parent.id });
		await t.ctx.store.create({ title: 'other', status: 'done' });

		const byTitle = await planDelete(t.ctx, { selector: parseDeleteFilter('title=fix*') });
		expect(byTitle.tasks.map(x => x.title).sort()).toEqual(['fix login', 'fix logout']);

		const byParent = await planDelete(t.ctx, { selector: parseDeleteFilter('parentId=*') });
		expect(byParent.tasks.map(x => x.title)).toEqual(['fix logout']);

		const byStatus = await planDelete(t.ctx, { selector: parseDeleteFilter('status=done,backlog') });
		expect(byStatus.tasks).toHaveLength(3);
	});

	it('returns an empty plan with zero counts when nothing matches', async () => {
		const plan = await planDelete(t.ctx, { selector: parseDeleteFilter('title=nothing') });
		expect(plan).toEqual({ tasks: [], notFound: [], orphanCount: 0, danglingLinkCount: 0 });
	});

	it('counts children that would become root tasks, and links that would dangle', async () => {
		const parent = await t.ctx.store.create({ title: 'parent', status: 'backlog' });
		await t.ctx.store.create({ title: 'child', status: 'backlog', parentId: parent.id });
		const other = await t.ctx.store.create({ title: 'other', status: 'backlog' });
		await t.ctx.store.addLink(other.id, 'blockedBy', parent.id);

		const plan = await planDelete(t.ctx, { selector: { kind: 'ids', ids: [parent.id] } });

		expect(plan.orphanCount).toBe(1);
		expect(plan.danglingLinkCount).toBe(1);
	});

	it('cascade adds every descendant to the plan and leaves no orphans', async () => {
		const root = await t.ctx.store.create({ title: 'root', status: 'backlog' });
		const child = await t.ctx.store.create({ title: 'child', status: 'backlog', parentId: root.id });
		const grandchild = await t.ctx.store.create({ title: 'grandchild', status: 'backlog', parentId: child.id });

		const plan = await planDelete(t.ctx, { selector: { kind: 'ids', ids: [root.id] }, cascade: true });

		expect(plan.tasks.map(x => x.id).sort()).toEqual([root.id, child.id, grandchild.id].sort());
		expect(plan.orphanCount).toBe(0);
	});

	it('planning never deletes; executeDelete deletes the planned tasks and returns the count', async () => {
		const a = await t.ctx.store.create({ title: 'a', status: 'backlog' });
		await t.ctx.store.create({ title: 'b', status: 'backlog' });

		const plan = await planDelete(t.ctx, { selector: { kind: 'ids', ids: [a.id] } });
		expect(await t.ctx.store.list()).toHaveLength(2);

		expect((await executeDelete(t.ctx, plan)).deletedCount).toBe(1);
		expect((await t.ctx.store.list()).map(x => x.id)).not.toContain(a.id);
		expect(await t.ctx.store.list()).toHaveLength(1);
	});
});

describe('executeDelete events (onTaskDeleted)', () => {
	let t: TestContext;
	beforeEach(() => {
		t = createTestContext();
	});
	afterEach(() => t.cleanup());

	const ids = (...selected: string[]) => ({ kind: 'ids' as const, ids: selected });

	it('produces one onTaskDeleted per deleted task with what the task was, and nothing for the plan', async () => {
		const a = await t.ctx.store.create({ title: 'write docs', status: 'in-progress' });
		await t.ctx.store.create({ title: 'b', status: 'backlog' });

		const plan = await planDelete(t.ctx, { selector: ids(a.id) });
		expect(plan).not.toHaveProperty('events');

		const result = await executeDelete(t.ctx, plan);

		expect(result.deletedCount).toBe(1);
		expect(result.events).toEqual([
			{
				name: 'onTaskDeleted',
				payload: {
					taskId: a.id,
					description: 'write docs',
					status: 'in-progress',
					parentId: undefined,
					orphanedChildIds: [],
					removedLinkCount: 0,
					taskProjectName: 'proj',
					taskProjectPath: t.rootDir,
				},
			},
		]);
		expect(JSON.parse(JSON.stringify(result.events[0]!.payload))).not.toHaveProperty('parentId');
	});

	it('carries the parent of the deleted task', async () => {
		const parent = await t.ctx.store.create({ title: 'parent', status: 'backlog' });
		const child = await t.ctx.store.create({ title: 'child', status: 'backlog', parentId: parent.id });

		const result = await executeDelete(t.ctx, await planDelete(t.ctx, { selector: ids(child.id) }));

		expect(result.events[0]!.payload).toMatchObject({ taskId: child.id, parentId: parent.id });
	});

	it('reports the children that became root tasks and the links that were removed with the task', async () => {
		const parent = await t.ctx.store.create({ title: 'parent', status: 'backlog' });
		const c1 = await t.ctx.store.create({ title: 'c1', status: 'backlog', parentId: parent.id });
		const c2 = await t.ctx.store.create({ title: 'c2', status: 'backlog', parentId: parent.id });
		const x = await t.ctx.store.create({ title: 'x', status: 'backlog' });
		const y = await t.ctx.store.create({ title: 'y', status: 'backlog' });
		await t.ctx.store.addLink(x.id, 'blockedBy', parent.id);
		await t.ctx.store.addLink(y.id, 'causedBy', parent.id);

		const result = await executeDelete(t.ctx, await planDelete(t.ctx, { selector: ids(parent.id) }));

		expect(result.events).toHaveLength(1);
		const payload = result.events[0]!.payload as { orphanedChildIds: string[]; removedLinkCount: number };
		expect([...payload.orphanedChildIds].sort()).toEqual([c1.id, c2.id].sort());
		expect(payload.removedLinkCount).toBe(2);
		// The real effects match what the plan announced.
		expect((await t.ctx.store.get(c1.id)).parentId).toBeUndefined();
	});

	it('cascade: one event per descendant, leaves before parents, each with its parent intact and no orphan', async () => {
		const root = await t.ctx.store.create({ title: 'root', status: 'backlog' });
		const child = await t.ctx.store.create({ title: 'child', status: 'backlog', parentId: root.id });
		const grandchild = await t.ctx.store.create({ title: 'grandchild', status: 'backlog', parentId: child.id });

		const result = await executeDelete(t.ctx, await planDelete(t.ctx, { selector: ids(root.id), cascade: true }));

		expect(result.deletedCount).toBe(3);
		expect(result.events.map(event => event.payload.taskId)).toEqual([grandchild.id, child.id, root.id]);
		expect(result.events.map(event => (event.payload as { parentId?: string }).parentId)).toEqual([
			child.id,
			root.id,
			undefined,
		]);
		for (const event of result.events) {
			expect(event.payload).toMatchObject({ orphanedChildIds: [], removedLinkCount: 0 });
		}
	});

	it('keeps the order of the plan between tasks of the same depth, deepest first overall', async () => {
		const a = await t.ctx.store.create({ title: 'a', status: 'backlog' });
		const b = await t.ctx.store.create({ title: 'b', status: 'backlog' });
		const childOfB = await t.ctx.store.create({ title: 'child of b', status: 'backlog', parentId: b.id });

		const result = await executeDelete(t.ctx, await planDelete(t.ctx, { selector: ids(a.id, b.id, childOfB.id) }));

		expect(result.events.map(event => event.payload.taskId)).toEqual([childOfB.id, a.id, b.id]);
	});

	it('deleting a parent and its child together reports no orphan (the child is gone with it)', async () => {
		const parent = await t.ctx.store.create({ title: 'parent', status: 'backlog' });
		const child = await t.ctx.store.create({ title: 'child', status: 'backlog', parentId: parent.id });

		const result = await executeDelete(t.ctx, await planDelete(t.ctx, { selector: { kind: 'all' } }));

		expect(result.events.map(event => event.payload.taskId)).toEqual([child.id, parent.id]);
		for (const event of result.events) {
			expect(event.payload).toMatchObject({ orphanedChildIds: [] });
		}
	});

	it('counts the links of the tasks still present when the task is deleted (a holder deleted later counts)', async () => {
		const a = await t.ctx.store.create({ title: 'a', status: 'backlog' });
		const b = await t.ctx.store.create({ title: 'b', status: 'backlog' });
		await t.ctx.store.addLink(b.id, 'blockedBy', a.id);

		const result = await executeDelete(t.ctx, await planDelete(t.ctx, { selector: ids(a.id, b.id) }));

		expect(result.events.map(event => (event.payload as { removedLinkCount: number }).removedLinkCount)).toEqual([
			1, 0,
		]);
	});

	it('produces no event for a task that vanished between the plan and the execution', async () => {
		const a = await t.ctx.store.create({ title: 'a', status: 'backlog' });
		const b = await t.ctx.store.create({ title: 'b', status: 'backlog' });
		const plan = await planDelete(t.ctx, { selector: ids(a.id, b.id) });
		await t.ctx.store.deleteTask(a.id);

		const result = await executeDelete(t.ctx, plan);

		expect(result.deletedCount).toBe(1);
		expect(result.events.map(event => event.payload.taskId)).toEqual([b.id]);
	});

	it('an empty plan produces no event', async () => {
		expect(await executeDelete(t.ctx, { tasks: [], notFound: [], orphanCount: 0, danglingLinkCount: 0 })).toEqual({
			deletedCount: 0,
			events: [],
		});
	});
});

/** The context's store, but `deleteTask` throws on its `failOn`th call (1-based): an fs error partway through a plan. */
function failingOnNthDelete(ctx: TaskServiceContext, failOn: number): TaskServiceContext {
	let calls = 0;
	const store = new Proxy(ctx.store, {
		get(target, prop) {
			if (prop === 'deleteTask') {
				return async (id: string): Promise<boolean> => {
					calls++;
					if (calls === failOn) throw new Error('EPERM: operation not permitted');
					return target.deleteTask(id);
				};
			}
			const value: unknown = Reflect.get(target, prop);
			return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
		},
	});
	return { ...ctx, store };
}

describe('executeDelete when the store fails partway through the plan', () => {
	const ids = (...selected: string[]) => ({ kind: 'ids' as const, ids: selected });
	let t: TestContext;
	beforeEach(() => {
		t = createTestContext();
	});
	afterEach(() => t.cleanup());

	async function failureOf(run: () => Promise<unknown>): Promise<PartialDeleteError> {
		try {
			await run();
		} catch (error) {
			expect(error).toBeInstanceOf(PartialDeleteError);
			return error as PartialDeleteError;
		}
		throw new Error('executeDelete did not throw');
	}

	it('throws a PartialDeleteError carrying the events of the tasks already deleted, and what failed', async () => {
		const tasks = await Promise.all(
			['a', 'b', 'c', 'd', 'e'].map(title => t.ctx.store.create({ title: title, status: 'backlog' }))
		);
		const plan = await planDelete(t.ctx, { selector: ids(...tasks.map(task => task.id)) });

		const error = await failureOf(() => executeDelete(failingOnNthDelete(t.ctx, 3), plan));

		expect(error.deletedCount).toBe(2);
		expect(error.plannedCount).toBe(5);
		expect(error.failedTaskId).toBe(tasks[2]!.id);
		expect(error.events.map(event => event.payload.taskId)).toEqual([tasks[0]!.id, tasks[1]!.id]);
		expect(error.events.every(event => event.name === 'onTaskDeleted')).toBe(true);
		expect((error.cause as Error).message).toContain('EPERM');
		// The two first tasks really are gone, the others are still there.
		expect((await t.ctx.store.list()).map(task => task.id).sort()).toEqual(
			[tasks[2]!.id, tasks[3]!.id, tasks[4]!.id].sort()
		);
	});

	it('names how many tasks were deleted, the cause and the way to finish, never claiming nothing happened', async () => {
		const tasks = await Promise.all(
			['a', 'b', 'c'].map(title => t.ctx.store.create({ title: title, status: 'backlog' }))
		);
		const plan = await planDelete(t.ctx, { selector: ids(...tasks.map(task => task.id)) });

		const error = await failureOf(() => executeDelete(failingOnNthDelete(t.ctx, 2), plan));

		expect(error.message).toContain('deleted 1 of 3 task(s)');
		expect(error.message).toContain(tasks[1]!.id);
		expect(error.message).toContain('EPERM');
		expect(error.hint).toContain('cannot be restored');
		expect(error.hint).toContain('task delete');
		expect(describeError(error).kind).toBe('internal');
	});

	it('keeps the original error when nothing was deleted yet (nothing to report)', async () => {
		const a = await t.ctx.store.create({ title: 'a', status: 'backlog' });
		const plan = await planDelete(t.ctx, { selector: ids(a.id) });

		await expect(executeDelete(failingOnNthDelete(t.ctx, 1), plan)).rejects.toThrow('EPERM');
		await expect(executeDelete(failingOnNthDelete(t.ctx, 1), plan)).rejects.not.toThrow(PartialDeleteError);
	});
});

describe('executeDelete events: commentCount', () => {
	let t: TestContext;
	beforeEach(() => {
		t = createTestContext();
	});
	afterEach(() => t.cleanup());

	it('onTaskDeleted carries commentCount only for a task that had comments (they go with the file)', async () => {
		const withComments = await t.ctx.store.create({ title: 'talked about', status: 'backlog' });
		await t.ctx.store.addComment(withComments.id, 'one');
		await t.ctx.store.addComment(withComments.id, 'two');
		const plain = await t.ctx.store.create({ title: 'quiet', status: 'backlog' });

		const result = await executeDelete(
			t.ctx,
			await planDelete(t.ctx, { selector: { kind: 'ids', ids: [withComments.id, plain.id] } })
		);

		const payloads = result.events.map(
			event => JSON.parse(JSON.stringify(event.payload)) as Record<string, unknown>
		);
		expect(payloads.find(p => p['taskId'] === withComments.id)?.['commentCount']).toBe(2);
		expect(payloads.find(p => p['taskId'] === plain.id)).not.toHaveProperty('commentCount');
	});
});
