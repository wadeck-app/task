import { normalizePriority } from '@wadeck-app/task-core';

import { projectEnv, type TaskServiceContext } from './context.js';
import type { TaskEvent } from './events.js';
import { plain } from './plainRecord.js';
import { requireTaskField } from './taskFieldSupport.js';
import type { TaskChangeResult } from './taskFields.js';

function priorityEvent(
	ctx: TaskServiceContext,
	taskId: string,
	oldPriority: string | undefined,
	newPriority: string | undefined
): TaskEvent {
	return { name: 'onTaskPriorityChanged', payload: { taskId, oldPriority, newPriority, ...projectEnv(ctx) } };
}

/**
 * Sets the priority of a task; it must be one of the project's `priorities` (config order, highest first), compared after trimming.
 * `onTaskPriorityChanged` only when it differs from the one the task had (`oldPriority` absent when it had none: the project default
 * applied). A storage that does not carry priorities answers UnsupportedByBackendError.
 */
export async function setTaskPriority(
	ctx: TaskServiceContext,
	input: { id: string; priority: string }
): Promise<TaskChangeResult> {
	await requireTaskField(ctx, 'priority', 'setPriority');
	const priority = normalizePriority(input.priority, ctx.config.priorities);
	const found = await ctx.store.resolve(input.id);
	const oldPriority = found.priority;
	const task = plain(await ctx.store.setPriority!(found.id, priority));
	return {
		task,
		events: oldPriority === priority ? [] : [priorityEvent(ctx, task.id, oldPriority, priority)],
	};
}

/** Removes the priority of a task (the project default applies again). `onTaskPriorityChanged` (no `newPriority`) only when it had one. */
export async function clearTaskPriority(ctx: TaskServiceContext, input: { id: string }): Promise<TaskChangeResult> {
	await requireTaskField(ctx, 'priority', 'clearPriority');
	const found = await ctx.store.resolve(input.id);
	const oldPriority = found.priority;
	const task = plain(await ctx.store.clearPriority!(found.id));
	return {
		task,
		events: oldPriority === undefined ? [] : [priorityEvent(ctx, task.id, oldPriority, undefined)],
	};
}
