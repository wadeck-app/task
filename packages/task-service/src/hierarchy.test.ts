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

		const updated = setParent(t.ctx, { id: loose.slice(0, 4), parent: root.slice(0, 4) });

		expect(updated.parentId).toBe(root);
	});

	it('setParent propagates the store error on a cycle, and TaskNotFoundError on unknown ids', () => {
		expect(() => setParent(t.ctx, { id: root, parent: grandchild })).toThrow(/cycle|descendant/i);
		expect(() => setParent(t.ctx, { id: root, parent: 'zzzz' })).toThrow(TaskNotFoundError);
		expect(() => setParent(t.ctx, { id: 'zzzz', parent: root })).toThrow(TaskNotFoundError);
	});

	it('removeParent detaches the task', () => {
		expect(removeParent(t.ctx, { id: child }).parentId).toBeUndefined();
		expect(() => removeParent(t.ctx, { id: 'zzzz' })).toThrow(TaskNotFoundError);
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
