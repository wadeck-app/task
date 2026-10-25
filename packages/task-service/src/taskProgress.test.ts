import { describeBlockers, summarizeChildren } from './taskProgress.js';
import { createTestContext, type TestContext } from './testHelpers.js';

describe('summarizeChildren', () => {
	let t: TestContext;
	beforeEach(() => {
		t = createTestContext();
	});
	afterEach(() => t.cleanup());

	function parentWith(statuses: string[]): string {
		const parent = t.ctx.store.create('parent', 'backlog');
		for (const status of statuses) {
			const child = t.ctx.store.create(`child ${status}`, status);
			t.ctx.store.setParent(child.id, parent.id);
		}
		return parent.id;
	}

	it('counts nothing for a task without children', () => {
		const id = parentWith([]);
		expect(summarizeChildren(t.ctx, { id })).toEqual({ total: 0, terminal: 0, open: 0 });
	});

	it('counts every child as terminal when all are closed', () => {
		const id = parentWith(['done', 'done']);
		expect(summarizeChildren(t.ctx, { id })).toEqual({ total: 2, terminal: 2, open: 0 });
	});

	it('splits closed and open children', () => {
		const id = parentWith(['done', 'backlog', 'in-progress']);
		expect(summarizeChildren(t.ctx, { id })).toEqual({ total: 3, terminal: 1, open: 2 });
	});

	it('takes the terminal statuses from the project config, not from a fixed name', () => {
		t.cleanup();
		t = createTestContext({ terminalStatuses: ['in-progress'] });
		const id = parentWith(['done', 'in-progress']);
		expect(summarizeChildren(t.ctx, { id })).toEqual({ total: 2, terminal: 1, open: 1 });
	});

	it('resolves a prefix and counts direct children only', () => {
		const id = parentWith(['backlog']);
		const grandchild = t.ctx.store.create('grandchild', 'done');
		t.ctx.store.setParent(grandchild.id, t.ctx.store.getChildren(id)[0]!.id);
		expect(summarizeChildren(t.ctx, { id: id.slice(0, 5) })).toEqual({ total: 1, terminal: 0, open: 1 });
	});
});

describe('describeBlockers', () => {
	let t: TestContext;
	beforeEach(() => {
		t = createTestContext();
	});
	afterEach(() => t.cleanup());

	it('reports no blocker for a free task', () => {
		const task = t.ctx.store.create('free', 'backlog');
		expect(describeBlockers(t.ctx, { id: task.id })).toEqual({ count: 0, blockers: [] });
	});

	it('lists the open tasks it is blocked by', () => {
		const blocked = t.ctx.store.create('blocked', 'backlog');
		const blocker = t.ctx.store.create('blocker', 'in-progress');
		t.ctx.store.addLink(blocked.id, 'blockedBy', blocker.id);
		expect(describeBlockers(t.ctx, { id: blocked.id })).toEqual({
			count: 1,
			blockers: [{ id: blocker.id, title: 'blocker', status: 'in-progress' }],
		});
	});

	it('ignores a blocker that is closed', () => {
		const blocked = t.ctx.store.create('blocked', 'backlog');
		const open = t.ctx.store.create('open', 'backlog');
		const closed = t.ctx.store.create('closed', 'done');
		t.ctx.store.addLink(blocked.id, 'blockedBy', open.id);
		t.ctx.store.addLink(blocked.id, 'blockedBy', closed.id);
		const found = describeBlockers(t.ctx, { id: blocked.id });
		expect(found.count).toBe(1);
		expect(found.blockers.map(b => b.id)).toEqual([open.id]);
	});

	it('is not blocked once every blocker is closed', () => {
		const blocked = t.ctx.store.create('blocked', 'backlog');
		const closed = t.ctx.store.create('closed', 'done');
		t.ctx.store.addLink(blocked.id, 'blockedBy', closed.id);
		expect(describeBlockers(t.ctx, { id: blocked.id })).toEqual({ count: 0, blockers: [] });
	});

	it('does not report the tasks it blocks (the derived inverse)', () => {
		const blocker = t.ctx.store.create('blocker', 'backlog');
		const blocked = t.ctx.store.create('blocked', 'backlog');
		t.ctx.store.addLink(blocked.id, 'blockedBy', blocker.id);
		expect(describeBlockers(t.ctx, { id: blocker.id })).toEqual({ count: 0, blockers: [] });
	});

	it('uses the terminal statuses of the project config', () => {
		t.cleanup();
		t = createTestContext({ terminalStatuses: ['in-progress'] });
		const blocked = t.ctx.store.create('blocked', 'backlog');
		const blocker = t.ctx.store.create('blocker', 'in-progress');
		t.ctx.store.addLink(blocked.id, 'blockedBy', blocker.id);
		expect(describeBlockers(t.ctx, { id: blocked.id }).count).toBe(0);
	});
});
