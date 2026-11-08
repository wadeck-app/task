import * as fs from 'node:fs';

import { describeBlockers, summarizeChildren } from './taskProgress.js';
import { createTestContext, type TestContext } from './testHelpers.js';

describe('summarizeChildren', () => {
	let t: TestContext;
	beforeEach(() => {
		t = createTestContext();
	});
	afterEach(() => t.cleanup());

	async function parentWith(statuses: string[]): Promise<string> {
		const parent = await t.ctx.store.create({ title: 'parent', status: 'backlog' });
		for (const status of statuses) {
			const child = await t.ctx.store.create({ title: `child ${status}`, status: status });
			await t.ctx.store.setParent(child.id, parent.id);
		}
		return parent.id;
	}

	it('counts nothing for a task without children', async () => {
		const id = await parentWith([]);
		expect(await summarizeChildren(t.ctx, { id })).toEqual({ total: 0, terminal: 0, open: 0 });
	});

	it('counts every child as terminal when all are closed', async () => {
		const id = await parentWith(['done', 'done']);
		expect(await summarizeChildren(t.ctx, { id })).toEqual({ total: 2, terminal: 2, open: 0 });
	});

	it('splits closed and open children', async () => {
		const id = await parentWith(['done', 'backlog', 'in-progress']);
		expect(await summarizeChildren(t.ctx, { id })).toEqual({ total: 3, terminal: 1, open: 2 });
	});

	it('takes the terminal statuses from the project config, not from a fixed name', async () => {
		t.cleanup();
		t = createTestContext({ terminalStatuses: ['in-progress'] });
		const id = await parentWith(['done', 'in-progress']);
		expect(await summarizeChildren(t.ctx, { id })).toEqual({ total: 2, terminal: 1, open: 1 });
	});

	it('resolves a prefix and counts direct children only', async () => {
		const id = await parentWith(['backlog']);
		const grandchild = await t.ctx.store.create({ title: 'grandchild', status: 'done' });
		await t.ctx.store.setParent(grandchild.id, (await t.ctx.store.getChildren(id))[0]!.id);
		expect(await summarizeChildren(t.ctx, { id: id.slice(0, 5) })).toEqual({ total: 1, terminal: 0, open: 1 });
	});
});

describe('describeBlockers', () => {
	let t: TestContext;
	beforeEach(() => {
		t = createTestContext();
	});
	afterEach(() => t.cleanup());

	it('reports no blocker for a free task', async () => {
		const task = await t.ctx.store.create({ title: 'free', status: 'backlog' });
		expect(await describeBlockers(t.ctx, { id: task.id })).toEqual({ count: 0, blockers: [] });
	});

	it('lists the open tasks it is blocked by', async () => {
		const blocked = await t.ctx.store.create({ title: 'blocked', status: 'backlog' });
		const blocker = await t.ctx.store.create({ title: 'blocker', status: 'in-progress' });
		await t.ctx.store.addLink(blocked.id, 'blockedBy', blocker.id);
		expect(await describeBlockers(t.ctx, { id: blocked.id })).toEqual({
			count: 1,
			blockers: [{ id: blocker.id, title: 'blocker', status: 'in-progress' }],
		});
	});

	it('does not fail on a dangling link: it only counts the blockers that exist', async () => {
		const blocked = await t.ctx.store.create({ title: 'blocked', status: 'backlog' });
		const gone = await t.ctx.store.create({ title: 'gone', status: 'backlog' });
		const open = await t.ctx.store.create({ title: 'open', status: 'backlog' });
		await t.ctx.store.addLink(blocked.id, 'blockedBy', gone.id);
		await t.ctx.store.addLink(blocked.id, 'blockedBy', open.id);
		const indexPath = `${t.rootDir}/data/task-index.json`;
		const index = JSON.parse(fs.readFileSync(indexPath, 'utf8')) as { tasks: Array<{ id: string }> };
		index.tasks = index.tasks.filter(x => x.id !== gone.id);
		fs.writeFileSync(indexPath, JSON.stringify(index));

		expect((await describeBlockers(t.ctx, { id: blocked.id })).blockers.map(b => b.id)).toEqual([open.id]);
	});

	it('ignores a blocker that is closed', async () => {
		const blocked = await t.ctx.store.create({ title: 'blocked', status: 'backlog' });
		const open = await t.ctx.store.create({ title: 'open', status: 'backlog' });
		const closed = await t.ctx.store.create({ title: 'closed', status: 'done' });
		await t.ctx.store.addLink(blocked.id, 'blockedBy', open.id);
		await t.ctx.store.addLink(blocked.id, 'blockedBy', closed.id);
		const found = await describeBlockers(t.ctx, { id: blocked.id });
		expect(found.count).toBe(1);
		expect(found.blockers.map(b => b.id)).toEqual([open.id]);
	});

	it('is not blocked once every blocker is closed', async () => {
		const blocked = await t.ctx.store.create({ title: 'blocked', status: 'backlog' });
		const closed = await t.ctx.store.create({ title: 'closed', status: 'done' });
		await t.ctx.store.addLink(blocked.id, 'blockedBy', closed.id);
		expect(await describeBlockers(t.ctx, { id: blocked.id })).toEqual({ count: 0, blockers: [] });
	});

	it('does not report the tasks it blocks (the derived inverse)', async () => {
		const blocker = await t.ctx.store.create({ title: 'blocker', status: 'backlog' });
		const blocked = await t.ctx.store.create({ title: 'blocked', status: 'backlog' });
		await t.ctx.store.addLink(blocked.id, 'blockedBy', blocker.id);
		expect(await describeBlockers(t.ctx, { id: blocker.id })).toEqual({ count: 0, blockers: [] });
	});

	it('uses the terminal statuses of the project config', async () => {
		t.cleanup();
		t = createTestContext({ terminalStatuses: ['in-progress'] });
		const blocked = await t.ctx.store.create({ title: 'blocked', status: 'backlog' });
		const blocker = await t.ctx.store.create({ title: 'blocker', status: 'in-progress' });
		await t.ctx.store.addLink(blocked.id, 'blockedBy', blocker.id);
		expect((await describeBlockers(t.ctx, { id: blocked.id })).count).toBe(0);
	});
});
