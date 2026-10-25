import * as fs from 'node:fs';

import { TaskNotFoundError } from '@wadeck-app/task-core';

import { DanglingParentError } from './errors.js';
import { getTaskHistory, showTask, showTaskWithRelations } from './showTask.js';
import { createTestContext, type TestContext } from './testHelpers.js';

/** A parent and its child, with the parent removed from the index only: the child's parentId dangles. */
function createDanglingChild(t: TestContext): { parentId: string; childId: string } {
	const parent = t.ctx.store.create('parent', 'backlog');
	const child = t.ctx.store.create('child', 'backlog', parent.id);
	const indexPath = `${t.rootDir}/data/task-index.json`;
	const index = JSON.parse(fs.readFileSync(indexPath, 'utf8')) as { tasks: Array<{ id: string }> };
	index.tasks = index.tasks.filter(x => x.id !== parent.id);
	fs.writeFileSync(indexPath, JSON.stringify(index));
	return { parentId: parent.id, childId: child.id };
}

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
		const { parentId, childId } = createDanglingChild(t);

		let caught: unknown;
		try {
			showTask(t.ctx, { id: childId, withParent: true });
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(DanglingParentError);
		expect((caught as DanglingParentError).message).toBe(
			`parent "${parentId}" of task "${childId}" does not exist`
		);
		expect((caught as DanglingParentError).hint).toBe(`Fix with: task remove-parent ${childId}`);
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

describe('showTaskWithRelations', () => {
	let t: TestContext;
	beforeEach(() => {
		t = createTestContext();
	});
	afterEach(() => t.cleanup());

	it('returns the record with its parent and children summaries and no warning', () => {
		const parent = t.ctx.store.create('parent', 'backlog');
		const child = t.ctx.store.create('child', 'backlog', parent.id);

		const { detail, warnings } = showTaskWithRelations(t.ctx, { id: child.id });

		expect(detail['id']).toBe(child.id);
		expect(detail['parent']).toEqual(t.ctx.store.list().find(x => x.id === parent.id));
		expect(detail['children']).toEqual([]);
		expect(warnings).toEqual([]);
	});

	it('keeps a task with a dangling parent reachable: parent null plus a warning carrying the fix', () => {
		const { parentId, childId } = createDanglingChild(t);

		const { detail, warnings } = showTaskWithRelations(t.ctx, { id: childId });

		expect(detail['id']).toBe(childId);
		expect(detail['parent']).toBeNull();
		expect(detail['children']).toEqual([]);
		expect(warnings).toEqual([
			`parent "${parentId}" of task "${childId}" does not exist. Fix with: task remove-parent ${childId}`,
		]);
	});

	it('still throws TaskNotFoundError for an unknown id', () => {
		expect(() => showTaskWithRelations(t.ctx, { id: 'zzzz' })).toThrow(TaskNotFoundError);
	});
});
