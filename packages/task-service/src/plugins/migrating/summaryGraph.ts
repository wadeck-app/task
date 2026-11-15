// The hierarchy queries of the port answered from a list of summaries (public ids, authoritative copies), with the same rules and the
// same errors as the local store, which answers them from its index. Used when the tasks are in both sides: no side holds the whole
// tree, the merged list does.
import { TaskNotFoundError } from '@wadeck-app/task-core';
import type { TaskSummary, TaskTreeNode } from '@wadeck-app/task-core';

function corrupted(what: string, id: string): Error {
	return new Error(`Task index is corrupted: ${what} at "${id}"`);
}

export function childrenOf(tasks: readonly TaskSummary[], id: string): TaskSummary[] {
	return tasks.filter(task => task.parentId === id);
}

export function treeOf(tasks: readonly TaskSummary[], id: string): TaskTreeNode {
	const root = tasks.find(task => task.id === id);
	if (!root) throw new TaskNotFoundError(id);
	const childrenByParent = new Map<string, TaskSummary[]>();
	for (const task of tasks) {
		if (task.parentId !== undefined) {
			const siblings = childrenByParent.get(task.parentId) ?? [];
			siblings.push(task);
			childrenByParent.set(task.parentId, siblings);
		}
	}
	const rootNode: TaskTreeNode = { ...root, children: [] };
	const pending: TaskTreeNode[] = [rootNode];
	const visited = new Set<string>([id]);
	while (pending.length > 0) {
		const node = pending.pop()!;
		for (const child of childrenByParent.get(node.id) ?? []) {
			if (visited.has(child.id)) throw corrupted('cycle detected', child.id);
			visited.add(child.id);
			const childNode: TaskTreeNode = { ...child, children: [] };
			node.children.push(childNode);
			pending.push(childNode);
		}
	}
	return rootNode;
}

export function forestOf(
	tasks: readonly TaskSummary[],
	options: { parentId?: string; predicate?: (task: TaskSummary) => boolean } = {}
): TaskTreeNode[] {
	const { parentId, predicate } = options;
	if (parentId !== undefined && !tasks.some(task => task.id === parentId)) throw new TaskNotFoundError(parentId);
	const childrenByParent = new Map<string | undefined, TaskSummary[]>();
	for (const task of tasks) {
		const siblings = childrenByParent.get(task.parentId) ?? [];
		siblings.push(task);
		childrenByParent.set(task.parentId, siblings);
	}
	const roots: TaskTreeNode[] = (childrenByParent.get(parentId) ?? []).map(task => ({ ...task, children: [] }));
	const preorder: TaskTreeNode[] = [];
	const visited = new Set<string>();
	const pending = [...roots].reverse();
	while (pending.length > 0) {
		const node = pending.pop()!;
		if (visited.has(node.id)) throw corrupted('cycle detected', node.id);
		visited.add(node.id);
		preorder.push(node);
		node.children = (childrenByParent.get(node.id) ?? []).map(task => ({ ...task, children: [] }));
		pending.push(...[...node.children].reverse());
	}
	if (!predicate) return roots;
	const keep = new Set<string>();
	for (const node of [...preorder].reverse()) {
		node.children = node.children.filter(child => keep.has(child.id));
		if (node.children.length > 0 || predicate(node)) keep.add(node.id);
	}
	return roots.filter(root => keep.has(root.id));
}

export function descendantsOf(tasks: readonly TaskSummary[], id: string): TaskSummary[] {
	const descendants: TaskSummary[] = [];
	const pending: TaskTreeNode[] = [...treeOf(tasks, id).children].reverse();
	while (pending.length > 0) {
		const { children, ...summary } = pending.pop()!;
		descendants.push(summary);
		pending.push(...[...children].reverse());
	}
	return descendants;
}

function ancestorIds(tasks: readonly TaskSummary[], id: string): string[] {
	const parentOf = new Map(tasks.map(task => [task.id, task.parentId]));
	const ancestors: string[] = [];
	const visited = new Set<string>([id]);
	let current = parentOf.get(id);
	while (current !== undefined) {
		if (visited.has(current)) throw corrupted('parent cycle detected', current);
		visited.add(current);
		ancestors.push(current);
		current = parentOf.get(current);
	}
	return ancestors;
}

/** Ancestors from the direct parent up to the root; an unknown task has none (the local store answers the same). */
export function ancestorsOf(tasks: readonly TaskSummary[], id: string): TaskSummary[] {
	const byId = new Map(tasks.map(task => [task.id, task]));
	return ancestorIds(tasks, id).map(ancestorId => {
		const found = byId.get(ancestorId);
		if (found === undefined) throw new TaskNotFoundError(ancestorId);
		return found;
	});
}

export function fullTreeOf(tasks: readonly TaskSummary[], id: string): TaskTreeNode {
	if (!tasks.some(task => task.id === id)) throw new TaskNotFoundError(id);
	const ancestors = ancestorIds(tasks, id);
	const tree = treeOf(tasks, ancestors[ancestors.length - 1] ?? id);
	const pending: TaskTreeNode[] = [tree];
	while (pending.length > 0) {
		const node = pending.pop()!;
		if (node.id === id) {
			node.selected = true;
			break;
		}
		pending.push(...node.children);
	}
	return tree;
}
