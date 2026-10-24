import { writeFileAtomic } from '@wadeck-app/project-sdk';
import { TaskConfigLoader } from '@wadeck-app/task-core';

import type { TaskServiceContext } from './context.js';
import { ownConfigFile } from './storage.js';

/** Valid task types configured for the project (empty: any string is accepted). */
export function listTypes(ctx: TaskServiceContext): string[] {
	return ctx.config.types;
}

/**
 * Adds a valid type to the project's OWN config file (created when missing: `<config dir>/config.yml` of a registry project,
 * `.task/config.yml` of a legacy one); no-op if already present. Types belong to the project alone, never to an ancestor layer.
 * `ctx.config` is a snapshot: reload the config to see the change.
 */
export function addType(ctx: TaskServiceContext, input: { name: string }): void {
	TaskConfigLoader.updateTypes(
		ownConfigFile(ctx.storage),
		types => (types.includes(input.name) ? types : [...types, input.name]),
		writeFileAtomic,
		{ createDirectory: ctx.storage.kind === 'registry' }
	);
}

/** Removes a valid type from the project's own config file. `ctx.config` is a snapshot: reload the config to see the change. */
export function removeType(ctx: TaskServiceContext, input: { name: string }): void {
	TaskConfigLoader.updateTypes(
		ownConfigFile(ctx.storage),
		types => types.filter(t => t !== input.name),
		writeFileAtomic,
		{
			createDirectory: ctx.storage.kind === 'registry',
		}
	);
}
