// The config of a task project: the layers of the shared registry (project chain).
import * as path from 'node:path';

import { ConfigSchemaError, mergeLayers, validateLayer } from '@wadeck-app/project-sdk';
import type { ConfigSchema, NamedLayer } from '@wadeck-app/project-sdk';
import { statusOutcomeProblem, TaskConfigLoader } from '@wadeck-app/task-core';
import type { TaskProjectConfig, TaskResolvedConfig } from '@wadeck-app/task-core';

import { createBuiltinRegistry } from './plugins/builtinPlugins.js';
import type { TaskPluginRegistry } from './plugins/kinds.js';
import { parseStrategySection, StrategyConfigError } from './strategyConfig.js';
import type { StrategySection } from './strategyConfig.js';
import { resolveStrategy } from './strategyResolve.js';
import type { ResolvedStrategy } from './strategyResolve.js';
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
		strategy: { scope: 'local' },
		defaults: { scope: 'inherit', merge: 'deep' },
	},
};

/** An `outcome` on a non-terminal status, or another value than positive / negative, is a schema error naming the file. */
function checkStatusOutcomes(layer: NamedLayer): void {
	const statuses = (layer.values as TaskProjectConfig).statuses;
	if (!Array.isArray(statuses)) return;
	for (const entry of statuses) {
		const problem = statusOutcomeProblem(entry);
		if (problem !== undefined) {
			const name = typeof entry === 'string' ? '?' : entry.name;
			throw new ConfigSchemaError(`${layer.name}: ${problem}.`, {
				layer: layer.name,
				key: 'statuses',
				path: `statuses.${name}.outcome`,
			});
		}
	}
}

/** The global config may not hold a strategy: a repo or a server belongs to one project. Names the global file. */
function checkGlobalHasNoStrategy(globalConfigDir: string | undefined): void {
	const global = TaskConfigLoader.loadGlobal(globalConfigDir) as Record<string, unknown>;
	if (global['strategy'] !== undefined) {
		throw new StrategyConfigError(
			path.join(TaskConfigLoader.resolveGlobalConfigDir(globalConfigDir), 'config.yml'),
			'strategy',
			'not allowed in the global config (it holds defaults and hooks only)',
			'A strategy belongs to one project: write it in the config.yml of the project (the registry folder of the project, task/config/config.yml), and remove it here.'
		);
	}
}

/** Reads, validates and merges the layers of a project; the config is the result, `strategy` the merged section of the own layer. */
function readSetup(
	storage: TaskStorage,
	globalConfigDir: string | undefined
): { config: TaskResolvedConfig; strategy: StrategySection | undefined } {
	const layers: NamedLayer[] = storage.configFiles.map(file => ({
		name: file,
		values: TaskConfigLoader.readConfigFile(file) ?? {},
	}));
	for (const layer of layers) {
		validateLayer(TASK_CONFIG_SCHEMA, layer.name, layer.values, 'project');
		checkStatusOutcomes(layer);
		// Every layer is checked for structure (a parent's section is valid in its own file); only the own layer is resolved.
		parseStrategySection(layer.name, layer.values['strategy']);
	}
	checkGlobalHasNoStrategy(globalConfigDir);
	const merged = mergeLayers(TASK_CONFIG_SCHEMA, layers);
	const config = TaskConfigLoader.resolve({
		global: TaskConfigLoader.loadGlobal(globalConfigDir),
		project: merged.values as TaskProjectConfig,
		source: ownConfigFile(storage),
	});
	return { config, strategy: parseStrategySection(ownConfigFile(storage), merged.values['strategy']) };
}

/**
 * Resolves the config of a project: every layer file (root ancestor first, the project's own last) is read,
 * checked against {@link TASK_CONFIG_SCHEMA} (an unknown or misplaced key throws a `ConfigSchemaError` naming the FILE and the
 * key; the `strategy` section is checked down to its fills and secrets), then merged; the status rules (at least one, one default
 * at most) apply to the merged value.
 * `globalConfigDir` is the task global config dir (default: the loader's own).
 */
export function loadTaskConfig(storage: TaskStorage, globalConfigDir?: string): TaskResolvedConfig {
	return readSetup(storage, globalConfigDir).config;
}

/**
 * The config of a project and the strategy it selects: {@link loadTaskConfig} plus the resolution of the project's own
 * `strategy` section against the plugin registry (default registry: the built-ins). A project without the section is `local`,
 * strict, with no fill, and nothing is said about it.
 */
export function loadProjectSetup(
	storage: TaskStorage,
	options: { globalConfigDir?: string; registry?: TaskPluginRegistry } = {}
): { config: TaskResolvedConfig; strategy: ResolvedStrategy } {
	const { config, strategy } = readSetup(storage, options.globalConfigDir);
	return {
		config,
		strategy: resolveStrategy(strategy, ownConfigFile(storage), options.registry ?? createBuiltinRegistry()),
	};
}
