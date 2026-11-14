import { normalizeAssignee } from '@wadeck-app/task-core';

import { projectEnv, type TaskServiceContext } from './context.js';
import type { TaskEvent } from './events.js';
import { plain } from './plainRecord.js';
import { requireTaskField } from './taskFieldSupport.js';
import type { TaskChangeResult } from './taskFields.js';

function assigneeEvent(
	ctx: TaskServiceContext,
	taskId: string,
	oldAssignee: string | undefined,
	newAssignee: string | undefined
): TaskEvent {
	return { name: 'onTaskAssigneeChanged', payload: { taskId, oldAssignee, newAssignee, ...projectEnv(ctx) } };
}

/**
 * Gives a task to a name by hand (free text, trimmed, at most 100 characters, one line). Changing the assignee drops the lease of a
 * previous claim; the same name changes nothing. `onTaskAssigneeChanged` (no `outcome`) only when the assignee differs.
 * A storage that does not carry assignees answers UnsupportedByBackendError.
 */
export async function setTaskAssignee(
	ctx: TaskServiceContext,
	input: { id: string; assignee: string }
): Promise<TaskChangeResult> {
	await requireTaskField(ctx, 'assignee', 'setAssignee');
	const assignee = normalizeAssignee(input.assignee);
	const found = await ctx.store.resolve(input.id);
	const oldAssignee = found.assignee;
	const task = plain(await ctx.store.setAssignee!(found.id, assignee));
	return {
		task,
		events: oldAssignee === assignee ? [] : [assigneeEvent(ctx, task.id, oldAssignee, assignee)],
	};
}

/** Removes the assignee and the lease of a task. `onTaskAssigneeChanged` (no `newAssignee`, no `outcome`) only when it had an assignee. */
export async function clearTaskAssignee(ctx: TaskServiceContext, input: { id: string }): Promise<TaskChangeResult> {
	await requireTaskField(ctx, 'assignee', 'clearAssignee');
	const found = await ctx.store.resolve(input.id);
	const oldAssignee = found.assignee;
	const task = plain(await ctx.store.clearAssignee!(found.id));
	return {
		task,
		events: oldAssignee === undefined ? [] : [assigneeEvent(ctx, task.id, oldAssignee, undefined)],
	};
}
