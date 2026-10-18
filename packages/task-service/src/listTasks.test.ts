import { TaskNotFoundError } from '@wadeck-app/task-core';

import { createStatusFilter, listForest, listTasks } from './listTasks.js';
import { createTestContext, type TestContext } from './testHelpers.js';

describe('listTasks', () => {
	let t: TestContext;
	beforeEach(() => {
		t = createTestContext();
	});
	afterEach(() => t.cleanup());

	it('hides terminal statuses unless showAll is set', () => {
		const open = t.ctx.store.create('open', 'backlog');
		const done = t.ctx.store.create('finished', 'done');

		expect(listTasks(t.ctx, {}).map(x => x.id)).toEqual([open.id]);
		expect(
			listTasks(t.ctx, { showAll: true })
				.map(x => x.id)
				.sort()
		).toEqual([open.id, done.id].sort());
	});

	it('lists only the direct children of a parent given by prefix, applying the terminal filter', () => {
		const parent = t.ctx.store.create('parent', 'backlog');
		const child = t.ctx.store.create('child', 'backlog', parent.id);
		t.ctx.store.create('closed child', 'done', parent.id);
		t.ctx.store.create('grandchild', 'backlog', child.id);
		t.ctx.store.create('unrelated', 'backlog');

		expect(listTasks(t.ctx, { parent: parent.id.slice(0, 4) }).map(x => x.id)).toEqual([child.id]);
	});

	it('throws TaskNotFoundError for an unknown parent', () => {
		expect(() => listTasks(t.ctx, { parent: 'zzzz' })).toThrow(TaskNotFoundError);
	});
});

describe('listForest', () => {
	let t: TestContext;
	beforeEach(() => {
		t = createTestContext();
	});
	afterEach(() => t.cleanup());

	it('keeps matching tasks plus the ancestors leading to them', () => {
		const root = t.ctx.store.create('root (done)', 'done');
		const child = t.ctx.store.create('child', 'backlog', root.id);
		t.ctx.store.create('hidden', 'done');

		const forest = listForest(t.ctx, {});

		expect(forest.map(n => n.id)).toEqual([root.id]);
		expect(forest[0]!.children.map(n => n.id)).toEqual([child.id]);
	});

	it('equals store.getForest for the same predicate and parent', () => {
		const root = t.ctx.store.create('root', 'backlog');
		t.ctx.store.create('child', 'backlog', root.id);

		expect(listForest(t.ctx, { showAll: true, parent: root.id })).toEqual(
			t.ctx.store.getForest({ parentId: root.id, predicate: () => true })
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
