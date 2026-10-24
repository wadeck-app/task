import { resolveTypeValidationStrategy } from '@wadeck-app/task-core';
import type { TaskRecord } from '@wadeck-app/task-core';

import { projectEnv, type TaskServiceContext } from './context.js';
import { InvalidTaskTypeError } from './errors.js';
import type { TaskEvent } from './events.js';

/** The updated task and the events the change produced (none when nothing really changed). */
export interface TaskChangeResult {
	task: TaskRecord;
	events: TaskEvent[];
}

/**
 * Sets a task's type; validated against the project's configured `types` (any string when none are configured).
 * `onTaskTypeChanged` only when the type differs from the current one (the store rewrites the file either way).
 */
export function setType(ctx: TaskServiceContext, input: { id: string; type: string }): TaskChangeResult {
	const validation = resolveTypeValidationStrategy(ctx.config.types).validate(input.type);
	if (!validation.valid) {
		throw new InvalidTaskTypeError(input.type, validation.error);
	}
	const before = ctx.store.findByPrefix(input.id);
	const oldType = before.type;
	const task = ctx.store.setType(before.id, input.type);
	const events: TaskEvent[] =
		oldType === input.type
			? []
			: [
					{
						name: 'onTaskTypeChanged',
						payload: { taskId: task.id, oldType, newType: input.type, ...projectEnv(ctx) },
					},
				];
	return { task, events };
}

/** Adds a label to a task. `onTaskLabelAdded` only when the task did not have it (the store ignores a duplicate). */
export function addLabel(ctx: TaskServiceContext, input: { id: string; label: string }): TaskChangeResult {
	const before = ctx.store.findByPrefix(input.id);
	const had = (before.labels ?? []).includes(input.label);
	const task = ctx.store.addLabel(before.id, input.label);
	const events: TaskEvent[] = had
		? []
		: [{ name: 'onTaskLabelAdded', payload: { taskId: task.id, label: input.label, ...projectEnv(ctx) } }];
	return { task, events };
}

/** Removes a label from a task. `onTaskLabelRemoved` only when the task had it (removing an absent label changes nothing). */
export function removeLabel(ctx: TaskServiceContext, input: { id: string; label: string }): TaskChangeResult {
	const before = ctx.store.findByPrefix(input.id);
	const had = (before.labels ?? []).includes(input.label);
	const task = ctx.store.removeLabel(before.id, input.label);
	const events: TaskEvent[] = had
		? [{ name: 'onTaskLabelRemoved', payload: { taskId: task.id, label: input.label, ...projectEnv(ctx) } }]
		: [];
	return { task, events };
}

/**
 * Sets a metadata key/value on a task (an empty value is valid). `onTaskMetaChanged` only when the key is new or its
 * value differs; `oldValue` is undefined for a new key (an existing empty value is "").
 */
export function setMeta(ctx: TaskServiceContext, input: { id: string; key: string; value: string }): TaskChangeResult {
	const before = ctx.store.findByPrefix(input.id);
	// Own property only: a key such as "constructor" must not read as already set.
	const oldValue = Object.hasOwn(before.meta ?? {}, input.key) ? before.meta![input.key] : undefined;
	const task = ctx.store.setMeta(before.id, input.key, input.value);
	const events: TaskEvent[] =
		oldValue === input.value
			? []
			: [
					{
						name: 'onTaskMetaChanged',
						payload: {
							taskId: task.id,
							key: input.key,
							oldValue,
							newValue: input.value,
							...projectEnv(ctx),
						},
					},
				];
	return { task, events };
}
