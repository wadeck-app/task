import type { TaskSummary, TaskTreeNode } from '@wadeck-app/task-core';

import { projectEnv, type TaskServiceContext } from './context.js';
import type { TaskEvent } from './events.js';
import type { TaskChangeResult } from './taskFields.js';

function parentChanged(
	ctx: TaskServiceContext,
	taskId: string,
	oldParentId: string | undefined,
	newParentId: string | undefined
): TaskEvent[] {
	return oldParentId === newParentId
		? []
		: [{ name: 'onTaskParentChanged', payload: { taskId, oldParentId, newParentId, ...projectEnv(ctx) } }];
}

/**
 * Attaches a task under a parent (cycles are rejected by the store). `onTaskParentChanged` only when the parent
 * differs from the current one; `oldParentId` is undefined for a root task.
 */
export function setParent(ctx: TaskServiceContext, input: { id: string; parent: string }): TaskChangeResult {
	const before = ctx.store.findByPrefix(input.id);
	const task = ctx.store.setParent(before.id, ctx.store.findByPrefix(input.parent).id);
	return { task, events: parentChanged(ctx, task.id, before.parentId, task.parentId) };
}

/** Detaches a task from its parent: it becomes a root task (a root task is refused by the store, so the event always fires). */
export function removeParent(ctx: TaskServiceContext, input: { id: string }): TaskChangeResult {
	const before = ctx.store.findByPrefix(input.id);
	const task = ctx.store.removeParent(before.id);
	return { task, events: parentChanged(ctx, task.id, before.parentId, task.parentId) };
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
