import { resolveTypeValidationStrategy } from '@wadeck-app/task-core';
import type { TaskRecord } from '@wadeck-app/task-core';

import type { TaskServiceContext } from './context.js';
import { InvalidTaskTypeError } from './errors.js';

/** Sets a task's type; validated against the project's configured `types` (any string when none are configured). */
export function setType(ctx: TaskServiceContext, input: { id: string; type: string }): TaskRecord {
	const validation = resolveTypeValidationStrategy(ctx.config.types).validate(input.type);
	if (!validation.valid) {
		throw new InvalidTaskTypeError(input.type, validation.error);
	}
	return ctx.store.setType(ctx.store.findByPrefix(input.id).id, input.type);
}

export function addLabel(ctx: TaskServiceContext, input: { id: string; label: string }): TaskRecord {
	return ctx.store.addLabel(ctx.store.findByPrefix(input.id).id, input.label);
}

export function removeLabel(ctx: TaskServiceContext, input: { id: string; label: string }): TaskRecord {
	return ctx.store.removeLabel(ctx.store.findByPrefix(input.id).id, input.label);
}

export function setMeta(ctx: TaskServiceContext, input: { id: string; key: string; value: string }): TaskRecord {
	return ctx.store.setMeta(ctx.store.findByPrefix(input.id).id, input.key, input.value);
}
