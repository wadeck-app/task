import { TaskNotFoundError } from '@wadeck-app/task-core';

import { createStatusFilter, listForest, listTasks } from './listTasks.js';
import { createTestContext, type TestContext } from './testHelpers.js';

describe('listTasks', () => {
	let t: TestContext;
	beforeEach(() => {
		t = createTestContext();
	});
	afterEach(() => t.cleanup());

	it('hides terminal statuses unless showAll is set', async () => {
		const open = await t.ctx.store.create({ title: 'open', status: 'backlog' });
		const done = await t.ctx.store.create({ title: 'finished', status: 'done' });

		expect((await listTasks(t.ctx, {})).map(x => x.id)).toEqual([open.id]);
		expect((await listTasks(t.ctx, { showAll: true })).map(x => x.id).sort()).toEqual([open.id, done.id].sort());
	});

	it('lists only the direct children of a parent given by prefix, applying the terminal filter', async () => {
		const parent = await t.ctx.store.create({ title: 'parent', status: 'backlog' });
		const child = await t.ctx.store.create({ title: 'child', status: 'backlog', parentId: parent.id });
		await t.ctx.store.create({ title: 'closed child', status: 'done', parentId: parent.id });
		await t.ctx.store.create({ title: 'grandchild', status: 'backlog', parentId: child.id });
		await t.ctx.store.create({ title: 'unrelated', status: 'backlog' });

		expect((await listTasks(t.ctx, { parent: parent.id.slice(0, 4) })).map(x => x.id)).toEqual([child.id]);
	});

	it('throws TaskNotFoundError for an unknown parent', async () => {
		await expect(listTasks(t.ctx, { parent: 'zzzz' })).rejects.toThrow(TaskNotFoundError);
	});
});

describe('listForest', () => {
	let t: TestContext;
	beforeEach(() => {
		t = createTestContext();
	});
	afterEach(() => t.cleanup());

	it('keeps matching tasks plus the ancestors leading to them', async () => {
		const root = await t.ctx.store.create({ title: 'root (done)', status: 'done' });
		const child = await t.ctx.store.create({ title: 'child', status: 'backlog', parentId: root.id });
		await t.ctx.store.create({ title: 'hidden', status: 'done' });

		const forest = await listForest(t.ctx, {});

		expect(forest.map(n => n.id)).toEqual([root.id]);
		expect(forest[0]!.children.map(n => n.id)).toEqual([child.id]);
	});

	it('equals store.getForest for the same predicate and parent', async () => {
		const root = await t.ctx.store.create({ title: 'root', status: 'backlog' });
		await t.ctx.store.create({ title: 'child', status: 'backlog', parentId: root.id });

		expect(await listForest(t.ctx, { showAll: true, parent: root.id })).toEqual(
			await t.ctx.store.getForest({ parentId: root.id, predicate: () => true })
		);
	});
});

describe('createStatusFilter', () => {
	it('passes everything when showAll, and only non-terminal tasks otherwise', () => {
		const config = createTestContext().ctx.config;
		const task = { id: 'a', title: 't', status: 'done', createdAt: 'x' };
		expect(createStatusFilter(config, true)(task)).toBe(true);
		expect(createStatusFilter(config, false)(task)).toBe(false);
		expect(createStatusFilter(config, false)({ ...task, status: 'backlog' })).toBe(true);
	});
});
