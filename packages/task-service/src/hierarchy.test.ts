import { TaskNotFoundError } from '@wadeck-app/task-core';

import { getFullTree, listAncestors, listChildren, removeParent, setParent } from './hierarchy.js';
import { createTestContext, type TestContext } from './testHelpers.js';

describe('hierarchy operations', () => {
	let t: TestContext;
	let root: string;
	let child: string;
	let grandchild: string;
	beforeEach(async () => {
		t = createTestContext();
		root = (await t.ctx.store.create({ title: 'root', status: 'backlog' })).id;
		child = (await t.ctx.store.create({ title: 'child', status: 'backlog', parentId: root })).id;
		grandchild = (await t.ctx.store.create({ title: 'grandchild', status: 'backlog', parentId: child })).id;
	});
	afterEach(() => t.cleanup());

	it('setParent attaches under a parent given by prefix and returns the updated task', async () => {
		const loose = (await t.ctx.store.create({ title: 'loose', status: 'backlog' })).id;

		const updated = (await setParent(t.ctx, { id: loose.slice(0, 4), parent: root.slice(0, 4) })).task;

		expect(updated.parentId).toBe(root);
	});

	it('setParent propagates the store error on a cycle, and TaskNotFoundError on unknown ids', async () => {
		await expect(setParent(t.ctx, { id: root, parent: grandchild })).rejects.toThrow(/cycle|descendant/i);
		await expect(setParent(t.ctx, { id: root, parent: 'zzzz' })).rejects.toThrow(TaskNotFoundError);
		await expect(setParent(t.ctx, { id: 'zzzz', parent: root })).rejects.toThrow(TaskNotFoundError);
	});

	it('removeParent detaches the task', async () => {
		expect((await removeParent(t.ctx, { id: child })).task.parentId).toBeUndefined();
		await expect(removeParent(t.ctx, { id: 'zzzz' })).rejects.toThrow(TaskNotFoundError);
	});

	it('setParent produces onTaskParentChanged, oldParentId absent for a root task', async () => {
		const loose = (await t.ctx.store.create({ title: 'loose', status: 'backlog' })).id;

		const result = await setParent(t.ctx, { id: loose.slice(0, 4), parent: root.slice(0, 4) });

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

	it('setParent moving a task carries both parents; the same parent again produces no event', async () => {
		const other = (await t.ctx.store.create({ title: 'other', status: 'backlog' })).id;

		const moved = await setParent(t.ctx, { id: child, parent: other });
		expect(moved.events[0]!.payload).toMatchObject({ taskId: child, oldParentId: root, newParentId: other });

		const again = await setParent(t.ctx, { id: child, parent: other.slice(0, 4) });
		expect(again.events).toEqual([]);
		expect(again.task.parentId).toBe(other);
	});

	it('a refused setParent (cycle, unknown id) produces no event', async () => {
		await expect(setParent(t.ctx, { id: root, parent: grandchild })).rejects.toThrow(/cycle/i);
	});

	it('removeParent produces onTaskParentChanged with oldParentId and no newParentId', async () => {
		const result = await removeParent(t.ctx, { id: child.slice(0, 4) });

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

	it('listChildren returns direct children by default and the nested subtree when recursive', async () => {
		expect((await listChildren(t.ctx, { id: root })).map(x => x.id)).toEqual([child]);

		const nested = await listChildren(t.ctx, { id: root, recursive: true });
		expect(nested.map(x => x.id)).toEqual([child]);
		expect((nested as Array<{ children: Array<{ id: string }> }>)[0]!.children.map(x => x.id)).toEqual([
			grandchild,
		]);
	});

	it('listAncestors goes from the direct parent up to the root', async () => {
		expect((await listAncestors(t.ctx, { id: grandchild })).map(x => x.id)).toEqual([child, root]);
		expect(await listAncestors(t.ctx, { id: root })).toEqual([]);
	});

	it('getFullTree returns the tree from the topmost ancestor with the task flagged selected', async () => {
		const tree = await getFullTree(t.ctx, { id: grandchild.slice(0, 4) });

		expect(tree.id).toBe(root);
		expect(tree.children[0]!.children[0]).toMatchObject({ id: grandchild, selected: true });
	});

	it('queries throw TaskNotFoundError for an unknown id', async () => {
		await expect(listChildren(t.ctx, { id: 'zzzz' })).rejects.toThrow(TaskNotFoundError);
		await expect(listAncestors(t.ctx, { id: 'zzzz' })).rejects.toThrow(TaskNotFoundError);
		await expect(getFullTree(t.ctx, { id: 'zzzz' })).rejects.toThrow(TaskNotFoundError);
	});
});
