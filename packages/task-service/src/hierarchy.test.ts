import { TaskNotFoundError } from '@wadeck-app/task-core';

import { getFullTree, listAncestors, listChildren, removeParent, setParent } from './hierarchy.js';
import { createTestContext, type TestContext } from './testHelpers.js';

describe('hierarchy operations', () => {
	let t: TestContext;
	let root: string;
	let child: string;
	let grandchild: string;
	beforeEach(() => {
		t = createTestContext();
		root = t.ctx.store.create('root', 'backlog').id;
		child = t.ctx.store.create('child', 'backlog', root).id;
		grandchild = t.ctx.store.create('grandchild', 'backlog', child).id;
	});
	afterEach(() => t.cleanup());

	it('setParent attaches under a parent given by prefix and returns the updated task', () => {
		const loose = t.ctx.store.create('loose', 'backlog').id;

		const updated = setParent(t.ctx, { id: loose.slice(0, 4), parent: root.slice(0, 4) }).task;

		expect(updated.parentId).toBe(root);
	});

	it('setParent propagates the store error on a cycle, and TaskNotFoundError on unknown ids', () => {
		expect(() => setParent(t.ctx, { id: root, parent: grandchild })).toThrow(/cycle|descendant/i);
		expect(() => setParent(t.ctx, { id: root, parent: 'zzzz' })).toThrow(TaskNotFoundError);
		expect(() => setParent(t.ctx, { id: 'zzzz', parent: root })).toThrow(TaskNotFoundError);
	});

	it('removeParent detaches the task', () => {
		expect(removeParent(t.ctx, { id: child }).task.parentId).toBeUndefined();
		expect(() => removeParent(t.ctx, { id: 'zzzz' })).toThrow(TaskNotFoundError);
	});

	it('setParent produces onTaskParentChanged, oldParentId absent for a root task', () => {
		const loose = t.ctx.store.create('loose', 'backlog').id;

		const result = setParent(t.ctx, { id: loose.slice(0, 4), parent: root.slice(0, 4) });

		expect(result.events).toEqual([
			{
				name: 'onTaskParentChanged',
				payload: {
					taskId: loose,
					oldParentId: undefined,
					newParentId: root,
					taskProjectName: 'proj',
					taskProjectPath: t.rootDir,
				},
			},
		]);
		expect(JSON.parse(JSON.stringify(result.events[0]!.payload))).not.toHaveProperty('oldParentId');
	});

	it('setParent moving a task carries both parents; the same parent again produces no event', () => {
		const other = t.ctx.store.create('other', 'backlog').id;

		const moved = setParent(t.ctx, { id: child, parent: other });
		expect(moved.events[0]!.payload).toMatchObject({ taskId: child, oldParentId: root, newParentId: other });

		const again = setParent(t.ctx, { id: child, parent: other.slice(0, 4) });
		expect(again.events).toEqual([]);
		expect(again.task.parentId).toBe(other);
	});

	it('a refused setParent (cycle, unknown id) produces no event', () => {
		expect(() => setParent(t.ctx, { id: root, parent: grandchild })).toThrow(/cycle/i);
	});

	it('removeParent produces onTaskParentChanged with oldParentId and no newParentId', () => {
		const result = removeParent(t.ctx, { id: child.slice(0, 4) });

		expect(result.events).toEqual([
			{
				name: 'onTaskParentChanged',
				payload: {
					taskId: child,
					oldParentId: root,
					newParentId: undefined,
					taskProjectName: 'proj',
					taskProjectPath: t.rootDir,
				},
			},
		]);
		expect(JSON.parse(JSON.stringify(result.events[0]!.payload))).not.toHaveProperty('newParentId');
	});

	it('listChildren returns direct children by default and the nested subtree when recursive', () => {
		expect(listChildren(t.ctx, { id: root }).map(x => x.id)).toEqual([child]);

		const nested = listChildren(t.ctx, { id: root, recursive: true });
		expect(nested.map(x => x.id)).toEqual([child]);
		expect((nested as Array<{ children: Array<{ id: string }> }>)[0]!.children.map(x => x.id)).toEqual([
			grandchild,
		]);
	});

	it('listAncestors goes from the direct parent up to the root', () => {
		expect(listAncestors(t.ctx, { id: grandchild }).map(x => x.id)).toEqual([child, root]);
		expect(listAncestors(t.ctx, { id: root })).toEqual([]);
	});

	it('getFullTree returns the tree from the topmost ancestor with the task flagged selected', () => {
		const tree = getFullTree(t.ctx, { id: grandchild.slice(0, 4) });

		expect(tree.id).toBe(root);
		expect(tree.children[0]!.children[0]).toMatchObject({ id: grandchild, selected: true });
	});

	it('queries throw TaskNotFoundError for an unknown id', () => {
		expect(() => listChildren(t.ctx, { id: 'zzzz' })).toThrow(TaskNotFoundError);
		expect(() => listAncestors(t.ctx, { id: 'zzzz' })).toThrow(TaskNotFoundError);
		expect(() => getFullTree(t.ctx, { id: 'zzzz' })).toThrow(TaskNotFoundError);
	});
});
