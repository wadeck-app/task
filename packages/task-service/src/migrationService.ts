// The entry of the background migration for the adapters (the CLI): what the start of a migration and its worker work on, and what the
// commands that need no backend (status, pause, resume, log) work on. The machinery is in `plugins/migrating/` and reaches this file
// through the seam (`StrategyInstance.migration`, `StrategyPlugin.migrationControl`); nothing here imports a plugin folder.
import { writeFileAtomic } from '@wadeck-app/project-sdk';
import { BackendRejectedError } from '@wadeck-app/task-core';

import type { TaskServiceContext } from './context.js';
import { createBuiltinRegistry } from './plugins/builtinPlugins.js';
import type { ControlInput, MigrationApi, MigrationControlApi, TaskPluginRegistry } from './plugins/kinds.js';
import type { TaskStorage } from './storage.js';

const SECTION_HINT =
	'Write the strategy section of the project config (config.yml) as: strategy: { type: migrating, options: { current: { type: <where the tasks are> }, new: { type: <where they go>, options: { ... } }, budget: { requestsPerMinute: 30 } } }. Check it with: task strategy show (see docs/claude/storage-strategy.md, "Storage strategy: migrating"). Nothing was changed.';

/** What the start of a migration and its worker work on; refuses a project whose strategy is not the migrating one. */
export async function openMigration(ctx: TaskServiceContext): Promise<MigrationApi> {
	if (ctx.openStrategyInstance === undefined) {
		throw new Error(
			'this context cannot open its strategy instance: it was not built by openTaskContext (this is a bug of the caller)'
		);
	}
	const instance = await ctx.openStrategyInstance();
	if (instance.migration === undefined) {
		throw new BackendRejectedError(
			'migrating',
			'migrate',
			`the strategy of this project is "${ctx.strategy?.type ?? 'unknown'}", not "migrating": there is nothing to move tasks between`,
			SECTION_HINT
		);
	}
	return instance.migration;
}

/**
 * The commands of a person that need no side opened (status, pause, resume, log) and their input for this project: its migrating
 * folder with the real files, clock and process table of this machine. The migrating plugin is looked up in the registry.
 */
export function openMigrationControl(
	storage: TaskStorage,
	registry: TaskPluginRegistry = createBuiltinRegistry()
): { control: MigrationControlApi; input: ControlInput } {
	const plugin = registry.lookup('migrating', 'strategy');
	if (plugin.migrationControl === undefined) {
		throw new Error('the migrating strategy offers no migration control: this is a bug of the plugin registry');
	}
	return { control: plugin.migrationControl, input: plugin.migrationControl.input(storage.dataDir, writeFileAtomic) };
}
