import type { TaskSummary, TaskTreeNode } from '@wadeck-app/task-core';

import { projectEnv, type TaskServiceContext } from './context.js';
import type { TaskEvent } from './events.js';
import { plain } from './plainRecord.js';
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
export async function setParent(
	ctx: TaskServiceContext,
	input: { id: string; parent: string }
): Promise<TaskChangeResult> {
	const before = await ctx.store.resolve(input.id);
	const parentId = (await ctx.store.resolve(input.parent)).id;
	const task = plain(await ctx.store.setParent(before.id, parentId));
	return { task, events: parentChanged(ctx, task.id, before.parentId, task.parentId) };
}

/** Detaches a task from its parent: it becomes a root task (a root task is refused by the store, so the event always fires). */
export async function removeParent(ctx: TaskServiceContext, input: { id: string }): Promise<TaskChangeResult> {
	const before = await ctx.store.resolve(input.id);
	const task = plain(await ctx.store.removeParent(before.id));
	return { task, events: parentChanged(ctx, task.id, before.parentId, task.parentId) };
}

/** Direct children, or the nested subtree (any depth) when `recursive`. */
export async function listChildren(
	ctx: TaskServiceContext,
	input: { id: string; recursive?: boolean }
): Promise<TaskSummary[] | TaskTreeNode[]> {
	const taskId = (await ctx.store.resolve(input.id)).id;
	return input.recursive ? (await ctx.store.getTree(taskId)).children : await ctx.store.getChildren(taskId);
}

/** All ancestors, from the direct parent up to the root. */
export async function listAncestors(ctx: TaskServiceContext, input: { id: string }): Promise<TaskSummary[]> {
	return ctx.store.getAncestors((await ctx.store.resolve(input.id)).id);
}

/** Complete tree containing the task (from its topmost ancestor); the task is flagged `selected`. */
export async function getFullTree(ctx: TaskServiceContext, input: { id: string }): Promise<TaskTreeNode> {
	return ctx.store.getFullTree((await ctx.store.resolve(input.id)).id);
}
