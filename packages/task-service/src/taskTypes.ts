import { TaskConfigLoader } from '@wadeck-app/task-core';

import type { TaskServiceContext } from './context.js';

/** Valid task types configured for the project (empty: any string is accepted). */
export function listTypes(ctx: TaskServiceContext): string[] {
	return ctx.config.types;
}

/**
 * Adds a valid type to `.task/config.yml` (no-op if already present).
 * `ctx.config` is a snapshot: reload the config to see the change.
 */
export function addType(ctx: TaskServiceContext, input: { name: string }): void {
	TaskConfigLoader.addType(ctx.project.path, input.name);
}

/** Removes a valid type from `.task/config.yml`. `ctx.config` is a snapshot: reload the config to see the change. */
export function removeType(ctx: TaskServiceContext, input: { name: string }): void {
	TaskConfigLoader.removeType(ctx.project.path, input.name);
}
