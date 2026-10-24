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

	it('selects tasks by id prefix and reports unknown prefixes in notFound without failing', () => {
		const a = t.ctx.store.create('a', 'backlog');
		t.ctx.store.create('b', 'backlog');

		const plan = planDelete(t.ctx, { selector: { kind: 'ids', ids: [a.id.slice(0, 5), 'zzzz'] } });

		expect(plan.tasks.map(x => x.id)).toEqual([a.id]);
		expect(plan.notFound).toEqual(['zzzz']);
	});

	it('plans a task once when several selectors (prefixes, repeated ids) resolve to it, keeping first-occurrence order', () => {
		const a = t.ctx.store.create('a', 'backlog');
		const b = t.ctx.store.create('b', 'backlog');

		const plan = planDelete(t.ctx, {
			selector: { kind: 'ids', ids: [a.id.slice(0, 5), b.id, a.id, b.id.slice(0, 6), a.id] },
		});

		expect(plan.tasks.map(x => x.id)).toEqual([a.id, b.id]);
	});

	it('throws AmbiguousDeletePrefixError when a prefix matches several tasks', () => {
		t.ctx.store.create('a', 'backlog');
		t.ctx.store.create('b', 'backlog');

		let caught: unknown;
		try {
			// The empty prefix matches every task.
			planDelete(t.ctx, { selector: { kind: 'ids', ids: [''] } });
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(AmbiguousDeletePrefixError);
		expect((caught as Error).message).toMatch(/^ambiguous prefix ".*" matches: /);
	});

	it('selects everything with kind=all', () => {
		t.ctx.store.create('a', 'backlog');
		t.ctx.store.create('b', 'done');

		expect(planDelete(t.ctx, { selector: { kind: 'all' } }).tasks).toHaveLength(2);
	});

	it('selects by glob filter; a root task never matches a parentId pattern', () => {
		const parent = t.ctx.store.create('fix login', 'backlog');
		t.ctx.store.create('fix logout', 'backlog', parent.id);
		t.ctx.store.create('other', 'done');

		const byTitle = planDelete(t.ctx, { selector: parseDeleteFilter('title=fix*') });
		expect(byTitle.tasks.map(x => x.title).sort()).toEqual(['fix login', 'fix logout']);

		const byParent = planDelete(t.ctx, { selector: parseDeleteFilter('parentId=*') });
		expect(byParent.tasks.map(x => x.title)).toEqual(['fix logout']);

		const byStatus = planDelete(t.ctx, { selector: parseDeleteFilter('status=done,backlog') });
		expect(byStatus.tasks).toHaveLength(3);
	});

	it('returns an empty plan with zero counts when nothing matches', () => {
		const plan = planDelete(t.ctx, { selector: parseDeleteFilter('title=nothing') });
		expect(plan).toEqual({ tasks: [], notFound: [], orphanCount: 0, danglingLinkCount: 0 });
	});

	it('counts children that would become root tasks, and links that would dangle', () => {
		const parent = t.ctx.store.create('parent', 'backlog');
		t.ctx.store.create('child', 'backlog', parent.id);
		const other = t.ctx.store.create('other', 'backlog');
		t.ctx.store.addLink(other.id, 'blockedBy', parent.id);

		const plan = planDelete(t.ctx, { selector: { kind: 'ids', ids: [parent.id] } });

		expect(plan.orphanCount).toBe(1);
		expect(plan.danglingLinkCount).toBe(1);
	});

	it('cascade adds every descendant to the plan and leaves no orphans', () => {
		const root = t.ctx.store.create('root', 'backlog');
		const child = t.ctx.store.create('child', 'backlog', root.id);
		const grandchild = t.ctx.store.create('grandchild', 'backlog', child.id);

		const plan = planDelete(t.ctx, { selector: { kind: 'ids', ids: [root.id] }, cascade: true });

		expect(plan.tasks.map(x => x.id).sort()).toEqual([root.id, child.id, grandchild.id].sort());
		expect(plan.orphanCount).toBe(0);
	});

	it('planning never deletes; executeDelete deletes the planned tasks and returns the count', () => {
		const a = t.ctx.store.create('a', 'backlog');
		t.ctx.store.create('b', 'backlog');

		const plan = planDelete(t.ctx, { selector: { kind: 'ids', ids: [a.id] } });
		expect(t.ctx.store.list()).toHaveLength(2);

		expect(executeDelete(t.ctx, plan).deletedCount).toBe(1);
		expect(t.ctx.store.list().map(x => x.id)).not.toContain(a.id);
		expect(t.ctx.store.list()).toHaveLength(1);
	});
});

describe('executeDelete events (onTaskDeleted)', () => {
	let t: TestContext;
	beforeEach(() => {
		t = createTestContext();
	});
	afterEach(() => t.cleanup());

	const ids = (...selected: string[]) => ({ kind: 'ids' as const, ids: selected });

	it('produces one onTaskDeleted per deleted task with what the task was, and nothing for the plan', () => {
		const a = t.ctx.store.create('write docs', 'in-progress');
		t.ctx.store.create('b', 'backlog');

		const plan = planDelete(t.ctx, { selector: ids(a.id) });
		expect(plan).not.toHaveProperty('events');

		const result = executeDelete(t.ctx, plan);

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

	it('carries the parent of the deleted task', () => {
		const parent = t.ctx.store.create('parent', 'backlog');
		const child = t.ctx.store.create('child', 'backlog', parent.id);

		const result = executeDelete(t.ctx, planDelete(t.ctx, { selector: ids(child.id) }));

		expect(result.events[0]!.payload).toMatchObject({ taskId: child.id, parentId: parent.id });
	});

	it('reports the children that became root tasks and the links that were removed with the task', () => {
		const parent = t.ctx.store.create('parent', 'backlog');
		const c1 = t.ctx.store.create('c1', 'backlog', parent.id);
		const c2 = t.ctx.store.create('c2', 'backlog', parent.id);
		const x = t.ctx.store.create('x', 'backlog');
		const y = t.ctx.store.create('y', 'backlog');
		t.ctx.store.addLink(x.id, 'blockedBy', parent.id);
		t.ctx.store.addLink(y.id, 'causedBy', parent.id);

		const result = executeDelete(t.ctx, planDelete(t.ctx, { selector: ids(parent.id) }));

		expect(result.events).toHaveLength(1);
		const payload = result.events[0]!.payload as { orphanedChildIds: string[]; removedLinkCount: number };
		expect([...payload.orphanedChildIds].sort()).toEqual([c1.id, c2.id].sort());
		expect(payload.removedLinkCount).toBe(2);
		// The real effects match what the plan announced.
		expect(t.ctx.store.get(c1.id).parentId).toBeUndefined();
	});

	it('cascade: one event per descendant, leaves before parents, each with its parent intact and no orphan', () => {
		const root = t.ctx.store.create('root', 'backlog');
		const child = t.ctx.store.create('child', 'backlog', root.id);
		const grandchild = t.ctx.store.create('grandchild', 'backlog', child.id);

		const result = executeDelete(t.ctx, planDelete(t.ctx, { selector: ids(root.id), cascade: true }));

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

	it('keeps the order of the plan between tasks of the same depth, deepest first overall', () => {
		const a = t.ctx.store.create('a', 'backlog');
		const b = t.ctx.store.create('b', 'backlog');
		const childOfB = t.ctx.store.create('child of b', 'backlog', b.id);

		const result = executeDelete(t.ctx, planDelete(t.ctx, { selector: ids(a.id, b.id, childOfB.id) }));

		expect(result.events.map(event => event.payload.taskId)).toEqual([childOfB.id, a.id, b.id]);
	});

	it('deleting a parent and its child together reports no orphan (the child is gone with it)', () => {
		const parent = t.ctx.store.create('parent', 'backlog');
		const child = t.ctx.store.create('child', 'backlog', parent.id);

		const result = executeDelete(t.ctx, planDelete(t.ctx, { selector: { kind: 'all' } }));

		expect(result.events.map(event => event.payload.taskId)).toEqual([child.id, parent.id]);
		for (const event of result.events) {
			expect(event.payload).toMatchObject({ orphanedChildIds: [] });
		}
	});

	it('counts the links of the tasks still present when the task is deleted (a holder deleted later counts)', () => {
		const a = t.ctx.store.create('a', 'backlog');
		const b = t.ctx.store.create('b', 'backlog');
		t.ctx.store.addLink(b.id, 'blockedBy', a.id);

		const result = executeDelete(t.ctx, planDelete(t.ctx, { selector: ids(a.id, b.id) }));

		expect(result.events.map(event => (event.payload as { removedLinkCount: number }).removedLinkCount)).toEqual([
			1, 0,
		]);
	});

	it('produces no event for a task that vanished between the plan and the execution', () => {
		const a = t.ctx.store.create('a', 'backlog');
		const b = t.ctx.store.create('b', 'backlog');
		const plan = planDelete(t.ctx, { selector: ids(a.id, b.id) });
		t.ctx.store.deleteTask(a.id);

		const result = executeDelete(t.ctx, plan);

		expect(result.deletedCount).toBe(1);
		expect(result.events.map(event => event.payload.taskId)).toEqual([b.id]);
	});

	it('an empty plan produces no event', () => {
		expect(executeDelete(t.ctx, { tasks: [], notFound: [], orphanCount: 0, danglingLinkCount: 0 })).toEqual({
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
				return (id: string): boolean => {
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

	function failureOf(run: () => unknown): PartialDeleteError {
		try {
			run();
		} catch (error) {
			expect(error).toBeInstanceOf(PartialDeleteError);
			return error as PartialDeleteError;
		}
		throw new Error('executeDelete did not throw');
	}

	it('throws a PartialDeleteError carrying the events of the tasks already deleted, and what failed', () => {
		const tasks = ['a', 'b', 'c', 'd', 'e'].map(title => t.ctx.store.create(title, 'backlog'));
		const plan = planDelete(t.ctx, { selector: ids(...tasks.map(task => task.id)) });

		const error = failureOf(() => executeDelete(failingOnNthDelete(t.ctx, 3), plan));

		expect(error.deletedCount).toBe(2);
		expect(error.plannedCount).toBe(5);
		expect(error.failedTaskId).toBe(tasks[2]!.id);
		expect(error.events.map(event => event.payload.taskId)).toEqual([tasks[0]!.id, tasks[1]!.id]);
		expect(error.events.every(event => event.name === 'onTaskDeleted')).toBe(true);
		expect((error.cause as Error).message).toContain('EPERM');
		// The two first tasks really are gone, the others are still there.
		expect(
			t.ctx.store
				.list()
				.map(task => task.id)
				.sort()
		).toEqual([tasks[2]!.id, tasks[3]!.id, tasks[4]!.id].sort());
	});

	it('names how many tasks were deleted, the cause and the way to finish, never claiming nothing happened', () => {
		const tasks = ['a', 'b', 'c'].map(title => t.ctx.store.create(title, 'backlog'));
		const plan = planDelete(t.ctx, { selector: ids(...tasks.map(task => task.id)) });

		const error = failureOf(() => executeDelete(failingOnNthDelete(t.ctx, 2), plan));

		expect(error.message).toContain('deleted 1 of 3 task(s)');
		expect(error.message).toContain(tasks[1]!.id);
		expect(error.message).toContain('EPERM');
		expect(error.hint).toContain('cannot be restored');
		expect(error.hint).toContain('task delete');
		expect(describeError(error).kind).toBe('internal');
	});

	it('keeps the original error when nothing was deleted yet (nothing to report)', () => {
		const a = t.ctx.store.create('a', 'backlog');
		const plan = planDelete(t.ctx, { selector: ids(a.id) });

		expect(() => executeDelete(failingOnNthDelete(t.ctx, 1), plan)).toThrow('EPERM');
		expect(() => executeDelete(failingOnNthDelete(t.ctx, 1), plan)).not.toThrow(PartialDeleteError);
	});
});
