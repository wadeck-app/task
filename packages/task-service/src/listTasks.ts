import type { TaskResolvedConfig, TaskSummary, TaskTreeNode } from '@wadeck-app/task-core';

import type { TaskServiceContext } from './context.js';

export interface ListTasksInput {
	/** Include tasks in a terminal status (hidden by default). */
	showAll?: boolean;
	/** Restrict to this task's direct children (id or unambiguous prefix). */
	parent?: string;
}

/** Predicate hiding terminal-status tasks unless `showAll` is set. */
export function createStatusFilter(config: TaskResolvedConfig, showAll: boolean): (task: TaskSummary) => boolean {
	return task => showAll || !config.terminalStatuses.includes(task.status);
}

/** Flat task list, optionally limited to the direct children of a parent. */
export async function listTasks(ctx: TaskServiceContext, input: ListTasksInput): Promise<TaskSummary[]> {
	const passesFilter = createStatusFilter(ctx.config, input.showAll ?? false);
	const parentId = input.parent === undefined ? undefined : (await ctx.store.resolve(input.parent)).id;
	return (parentId === undefined ? await ctx.store.list() : await ctx.store.getChildren(parentId)).filter(
		passesFilter
	);
}

/** Nested forest of the matching tasks plus the ancestors leading to them. */
export async function listForest(ctx: TaskServiceContext, input: ListTasksInput): Promise<TaskTreeNode[]> {
	const parentId = input.parent === undefined ? undefined : (await ctx.store.resolve(input.parent)).id;
	return ctx.store.getForest({ parentId, predicate: createStatusFilter(ctx.config, input.showAll ?? false) });
}
