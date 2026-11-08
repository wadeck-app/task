import { resolveTypeValidationStrategy } from '@wadeck-app/task-core';
import type { TaskRecord } from '@wadeck-app/task-core';

import { projectEnv, type TaskServiceContext } from './context.js';
import { InvalidTaskTypeError } from './errors.js';
import type { TaskEvent } from './events.js';
import { plain } from './plainRecord.js';

/** The updated task and the events the change produced (none when nothing really changed). */
export interface TaskChangeResult {
	task: TaskRecord;
	events: TaskEvent[];
}

/**
 * Sets a task's type; validated against the project's configured `types` (any string when none are configured).
 * `onTaskTypeChanged` only when the type differs from the current one (the store rewrites the file either way).
 */
export async function setType(ctx: TaskServiceContext, input: { id: string; type: string }): Promise<TaskChangeResult> {
	const validation = resolveTypeValidationStrategy(ctx.config.types).validate(input.type);
	if (!validation.valid) {
		throw new InvalidTaskTypeError(input.type, validation.error);
	}
	const before = await ctx.store.findByPrefix(input.id);
	const oldType = before.type;
	const task = plain(await ctx.store.setType(before.id, input.type));
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
export async function addLabel(
	ctx: TaskServiceContext,
	input: { id: string; label: string }
): Promise<TaskChangeResult> {
	const before = await ctx.store.findByPrefix(input.id);
	const had = (before.labels ?? []).includes(input.label);
	const task = plain(await ctx.store.addLabel(before.id, input.label));
	const events: TaskEvent[] = had
		? []
		: [{ name: 'onTaskLabelAdded', payload: { taskId: task.id, label: input.label, ...projectEnv(ctx) } }];
	return { task, events };
}

/** Removes a label from a task. `onTaskLabelRemoved` only when the task had it (removing an absent label changes nothing). */
export async function removeLabel(
	ctx: TaskServiceContext,
	input: { id: string; label: string }
): Promise<TaskChangeResult> {
	const before = await ctx.store.findByPrefix(input.id);
	const had = (before.labels ?? []).includes(input.label);
	const task = plain(await ctx.store.removeLabel(before.id, input.label));
	const events: TaskEvent[] = had
		? [{ name: 'onTaskLabelRemoved', payload: { taskId: task.id, label: input.label, ...projectEnv(ctx) } }]
		: [];
	return { task, events };
}

/**
 * Sets a metadata key/value on a task (an empty value is valid). `onTaskMetaChanged` only when the key is new or its
 * value differs; `oldValue` is undefined for a new key (an existing empty value is "").
 */
export async function setMeta(
	ctx: TaskServiceContext,
	input: { id: string; key: string; value: string }
): Promise<TaskChangeResult> {
	const before = await ctx.store.findByPrefix(input.id);
	// Own property only: a key such as "constructor" must not read as already set.
	const oldValue = Object.hasOwn(before.meta ?? {}, input.key) ? before.meta![input.key] : undefined;
	const task = plain(await ctx.store.setMeta(before.id, input.key, input.value));
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

/** Removes a metadata key. `onTaskMetaChanged` (`newValue` absent) only when the key existed. */
export async function unsetMeta(
	ctx: TaskServiceContext,
	input: { id: string; key: string }
): Promise<TaskChangeResult> {
	const before = await ctx.store.findByPrefix(input.id);
	if (!Object.hasOwn(before.meta ?? {}, input.key)) {
		return { task: plain(before), events: [] };
	}
	const oldValue = before.meta![input.key];
	const task = plain(await ctx.store.removeMeta(before.id, input.key));
	return {
		task,
		events: [
			{
				name: 'onTaskMetaChanged',
				payload: { taskId: task.id, key: input.key, oldValue, newValue: undefined, ...projectEnv(ctx) },
			},
		],
	};
}

/** Clears the type of a task. `onTaskTypeChanged` (`newType` absent) only when the task had one. */
export async function unsetType(ctx: TaskServiceContext, input: { id: string }): Promise<TaskChangeResult> {
	const before = await ctx.store.findByPrefix(input.id);
	if (before.type === undefined) {
		return { task: plain(before), events: [] };
	}
	const task = plain(await ctx.store.clearType(before.id));
	return {
		task,
		events: [
			{
				name: 'onTaskTypeChanged',
				payload: { taskId: task.id, oldType: before.type, newType: undefined, ...projectEnv(ctx) },
			},
		],
	};
}
