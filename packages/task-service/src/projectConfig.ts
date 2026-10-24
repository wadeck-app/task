// The config of a task project: the layers of the shared registry (project chain), or the config file of an unmigrated project.
import { mergeLayers, validateLayer } from '@wadeck-app/project-sdk';
import type { ConfigSchema, NamedLayer } from '@wadeck-app/project-sdk';
import { TaskConfigLoader } from '@wadeck-app/task-core';
import type { TaskProjectConfig, TaskResolvedConfig } from '@wadeck-app/task-core';

import { ownConfigFile } from './storage.js';
import type { TaskStorage } from './storage.js';

/**
 * Which keys of a `config.yml` mean what in a project chain. `statuses`, `types`, `fields` and `hooks` belong to the project
 * alone (a parent's values are valid there and never reach the child); `defaults` is inherited, the child's keys win.
 * The task GLOBAL config (`~/.task/config.yml`: defaults and hooks) is task's own file, merged separately, as before.
 */
export const TASK_CONFIG_SCHEMA: ConfigSchema = {
	sections: {
		statuses: { scope: 'local' },
		types: { scope: 'local' },
		fields: { scope: 'local' },
		hooks: { scope: 'local' },
		defaults: { scope: 'inherit', merge: 'deep' },
	},
};

/**
 * Resolves the config of a project. Registry storage: every layer file (root ancestor first, the project's own last) is read,
 * checked against {@link TASK_CONFIG_SCHEMA} (an unknown or misplaced key throws a `ConfigSchemaError` naming the FILE and the
 * key), then merged; the status rules (at least one, one default at most) apply to the merged value. Legacy storage (unmigrated project): the
 * pre-registry loader, unchanged. `globalConfigDir` is the task global config dir (default: the loader's own).
 */
export function loadTaskConfig(storage: TaskStorage, globalConfigDir?: string): TaskResolvedConfig {
	if (storage.kind === 'legacy') {
		// An unmigrated project: its old folder holds the only config file (unknown keys ignored, as before).
		return TaskConfigLoader.load({ configDir: globalConfigDir, projectConfigFile: ownConfigFile(storage) });
	}
	const layers: NamedLayer[] = storage.configFiles.map(file => ({
		name: file,
		values: TaskConfigLoader.readConfigFile(file) ?? {},
	}));
	for (const layer of layers) {
		validateLayer(TASK_CONFIG_SCHEMA, layer.name, layer.values, 'project');
	}
	const merged = mergeLayers(TASK_CONFIG_SCHEMA, layers);
	return TaskConfigLoader.resolve({
		global: TaskConfigLoader.loadGlobal(globalConfigDir),
		project: merged.values as TaskProjectConfig,
		source: ownConfigFile(storage),
	});
}
