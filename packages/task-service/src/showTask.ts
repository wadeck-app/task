import type { TaskRecord } from '@wadeck-app/task-core';

import type { TaskServiceContext } from './context.js';
import { DanglingParentError } from './errors.js';
import { plain } from './plainRecord.js';
import { withDescription } from './taskText.js';

export interface ShowTaskInput {
	/** Task id or unambiguous prefix. */
	id: string;
	/** Add a `parent` summary (null for a root task). */
	withParent?: boolean;
	/** Add a `children` array of summaries. */
	withChildren?: boolean;
}

/** Full task record plus `childrenIds`, and optionally `parent` / `children` summaries. */
export async function showTask(ctx: TaskServiceContext, input: ShowTaskInput): Promise<Record<string, unknown>> {
	const task = plain(await ctx.store.findByPrefix(input.id));
	const children = await ctx.store.getChildren(task.id);
	// `description` is always present (the resolved text), whatever is stored.
	const detail: Record<string, unknown> = {
		...withDescription(task),
		childrenIds: children.map(c => c.id),
		commentCount: task.comments?.length ?? 0,
	};
	if (input.withParent) {
		const parent = task.parentId === undefined ? null : (await ctx.store.list()).find(t => t.id === task.parentId);
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

export interface TaskWithRelations {
	/** The task record with `childrenIds`, `parent` (null for a root task or a dangling parent) and `children`. */
	detail: Record<string, unknown>;
	/** Data problems found while reading, each with its fix; empty when the data is consistent. */
	warnings: string[];
}

/**
 * The detail of a task with its parent and children. A task must stay reachable to be repaired: when its parent no
 * longer exists the task is returned without parent and the corruption is reported as a warning (with the fix).
 */
export async function showTaskWithRelations(
	ctx: TaskServiceContext,
	input: { id: string }
): Promise<TaskWithRelations> {
	try {
		return { detail: await showTask(ctx, { id: input.id, withParent: true, withChildren: true }), warnings: [] };
	} catch (error) {
		if (!(error instanceof DanglingParentError)) throw error;
		return {
			detail: { ...(await showTask(ctx, { id: input.id, withChildren: true })), parent: null },
			warnings: [`${error.message}. ${error.hint}`],
		};
	}
}

export interface TaskHistory {
	/** Full id of the resolved task. */
	id: string;
	history: TaskRecord['history'];
}

/** Status-change history of a task. */
export async function getTaskHistory(ctx: TaskServiceContext, input: { id: string }): Promise<TaskHistory> {
	const task = await ctx.store.findByPrefix(input.id);
	return { id: task.id, history: task.history };
}
