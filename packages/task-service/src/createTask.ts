import type { TaskRecord } from '@wadeck-app/task-core';

import { projectEnv, type TaskServiceContext } from './context.js';
import type { TaskEvent } from './events.js';

export interface CreateTaskInput {
	description: string;
	/** Parent task id or unambiguous prefix. */
	parent?: string;
}

export interface CreateTaskResult {
	task: TaskRecord;
	events: TaskEvent[];
}

/** Creates a task in the configured default status, optionally under a parent. */
export function createTask(ctx: TaskServiceContext, input: CreateTaskInput): CreateTaskResult {
	const parentId = input.parent === undefined ? undefined : ctx.store.findByPrefix(input.parent).id;
	const task = ctx.store.create(input.description, ctx.config.defaultStatus, parentId);
	return {
		task,
		events: [
			{
				name: 'onTaskCreated',
				payload: {
					taskId: task.id,
					status: task.status,
					description: task.description,
					parentId: task.parentId,
					type: task.type,
					labels: task.labels ?? [],
					...projectEnv(ctx),
				},
			},
		],
	};
}
