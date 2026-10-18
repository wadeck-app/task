import * as fs from 'node:fs';

import { TaskNotFoundError } from '@wadeck-app/task-core';

import { DanglingParentError } from './errors.js';
import { getTaskHistory, showTask } from './showTask.js';
import { createTestContext, type TestContext } from './testHelpers.js';

describe('showTask', () => {
	let t: TestContext;
	beforeEach(() => {
		t = createTestContext();
	});
	afterEach(() => t.cleanup());

	it('returns the full record plus childrenIds', () => {
		const parent = t.ctx.store.create('parent', 'backlog');
		const child = t.ctx.store.create('child', 'backlog', parent.id);

		const detail = showTask(t.ctx, { id: parent.id.slice(0, 4) });

		expect(detail).toEqual({ ...parent, childrenIds: [child.id] });
		expect('parent' in detail).toBe(false);
		expect('children' in detail).toBe(false);
	});

	it('adds the parent summary with withParent, and null for a root task', () => {
		const parent = t.ctx.store.create('parent', 'backlog');
		const child = t.ctx.store.create('child', 'backlog', parent.id);

		expect(showTask(t.ctx, { id: child.id, withParent: true })['parent']).toEqual(
			t.ctx.store.list().find(x => x.id === parent.id)
		);
		expect(showTask(t.ctx, { id: parent.id, withParent: true })['parent']).toBeNull();
	});

	it('adds the children summaries with withChildren', () => {
		const parent = t.ctx.store.create('parent', 'backlog');
		t.ctx.store.create('child', 'backlog', parent.id);

		expect(showTask(t.ctx, { id: parent.id, withChildren: true })['children']).toEqual(
			t.ctx.store.getChildren(parent.id)
		);
	});

	it('throws DanglingParentError (with an actionable hint) when the parent no longer exists', () => {
		const parent = t.ctx.store.create('parent', 'backlog');
		const child = t.ctx.store.create('child', 'backlog', parent.id);
		// Corrupt the hierarchy on purpose: remove the parent from the index only.
		const indexPath = `${t.rootDir}/.task/task-index.json`;
		const index = JSON.parse(fs.readFileSync(indexPath, 'utf8')) as { tasks: Array<{ id: string }> };
		index.tasks = index.tasks.filter(x => x.id !== parent.id);
		fs.writeFileSync(indexPath, JSON.stringify(index));

		let caught: unknown;
		try {
			showTask(t.ctx, { id: child.id, withParent: true });
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(DanglingParentError);
		expect((caught as DanglingParentError).message).toBe(
			`parent "${parent.id}" of task "${child.id}" does not exist`
		);
		expect((caught as DanglingParentError).hint).toBe(`Fix with: task remove-parent ${child.id}`);
	});

	it('throws TaskNotFoundError for an unknown id', () => {
		expect(() => showTask(t.ctx, { id: 'zzzz' })).toThrow(TaskNotFoundError);
	});
});

describe('getTaskHistory', () => {
	let t: TestContext;
	beforeEach(() => {
		t = createTestContext();
	});
	afterEach(() => t.cleanup());

	it('returns the resolved task id and its status history', () => {
		const task = t.ctx.store.create('a', 'backlog');
		t.ctx.store.updateStatus(task.id, 'done');

		const result = getTaskHistory(t.ctx, { id: task.id.slice(0, 3) });

		expect(result.id).toBe(task.id);
		expect(result.history.map(h => h.status)).toEqual(['backlog', 'done']);
	});

	it('throws TaskNotFoundError for an unknown id', () => {
		expect(() => getTaskHistory(t.ctx, { id: 'zzzz' })).toThrow(TaskNotFoundError);
	});
});
