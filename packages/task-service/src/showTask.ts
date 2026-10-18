import type { TaskRecord } from '@wadeck-app/task-core';

import type { TaskServiceContext } from './context.js';
import { DanglingParentError } from './errors.js';

export interface ShowTaskInput {
	/** Task id or unambiguous prefix. */
	id: string;
	/** Add a `parent` summary (null for a root task). */
	withParent?: boolean;
	/** Add a `children` array of summaries. */
	withChildren?: boolean;
}

/** Full task record plus `childrenIds`, and optionally `parent` / `children` summaries. */
export function showTask(ctx: TaskServiceContext, input: ShowTaskInput): Record<string, unknown> {
	const task = ctx.store.findByPrefix(input.id);
	const children = ctx.store.getChildren(task.id);
	const detail: Record<string, unknown> = { ...task, childrenIds: children.map(c => c.id) };
	if (input.withParent) {
		const parent = task.parentId === undefined ? null : ctx.store.list().find(t => t.id === task.parentId);
		if (parent === undefined) {
			throw new DanglingParentError(task.id, task.parentId!);
		}
		detail['parent'] = parent;
	}
	if (input.withChildren) {
		detail['children'] = children;
	}
	return detail;
}

export interface TaskHistory {
	/** Full id of the resolved task. */
	id: string;
	history: TaskRecord['history'];
}

/** Status-change history of a task. */
export function getTaskHistory(ctx: TaskServiceContext, input: { id: string }): TaskHistory {
	const task = ctx.store.findByPrefix(input.id);
	return { id: task.id, history: task.history };
}
