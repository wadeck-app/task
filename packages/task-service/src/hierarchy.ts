import type { TaskRecord, TaskSummary, TaskTreeNode } from '@wadeck-app/task-core';

import type { TaskServiceContext } from './context.js';

/** Attaches a task under a parent (cycles are rejected by the store). */
export function setParent(ctx: TaskServiceContext, input: { id: string; parent: string }): TaskRecord {
	return ctx.store.setParent(ctx.store.findByPrefix(input.id).id, ctx.store.findByPrefix(input.parent).id);
}

/** Detaches a task from its parent: it becomes a root task. */
export function removeParent(ctx: TaskServiceContext, input: { id: string }): TaskRecord {
	return ctx.store.removeParent(ctx.store.findByPrefix(input.id).id);
}

/** Direct children, or the nested subtree (any depth) when `recursive`. */
export function listChildren(
	ctx: TaskServiceContext,
	input: { id: string; recursive?: boolean }
): TaskSummary[] | TaskTreeNode[] {
	const taskId = ctx.store.findByPrefix(input.id).id;
	return input.recursive ? ctx.store.getTree(taskId).children : ctx.store.getChildren(taskId);
}

/** All ancestors, from the direct parent up to the root. */
export function listAncestors(ctx: TaskServiceContext, input: { id: string }): TaskSummary[] {
	return ctx.store.getAncestors(ctx.store.findByPrefix(input.id).id);
}

/** Complete tree containing the task (from its topmost ancestor); the task is flagged `selected`. */
export function getFullTree(ctx: TaskServiceContext, input: { id: string }): TaskTreeNode {
	return ctx.store.getFullTree(ctx.store.findByPrefix(input.id).id);
}
