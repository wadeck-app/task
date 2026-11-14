// The config of a task project: the layers of the shared registry (project chain).
import * as path from 'node:path';

import { ConfigSchemaError, mergeLayers, validateLayer } from '@wadeck-app/project-sdk';
import type { ConfigSchema, NamedLayer } from '@wadeck-app/project-sdk';
import { MAX_LEASE_MINUTES, normalizePriority, statusOutcomeProblem, TaskConfigLoader } from '@wadeck-app/task-core';
import type { TaskProjectConfig, TaskResolvedConfig } from '@wadeck-app/task-core';

import { createBuiltinRegistry } from './plugins/builtinPlugins.js';
import type { ProjectFacts, TaskPluginRegistry } from './plugins/kinds.js';
import { assertNoHooks } from './removedConfigKey.js';
import { parseStrategySection, StrategyConfigError } from './strategyConfig.js';
import type { StrategySection } from './strategyConfig.js';
import { resolveStrategy } from './strategyResolve.js';
import type { ResolvedStrategy } from './strategyResolve.js';
import { ownConfigFile } from './storage.js';
import type { TaskStorage } from './storage.js';

/**
 * Which keys of a `config.yml` mean what in a project chain. `statuses`, `types`, `fields` and `strategy` belong to the project
 * alone (a parent's values are valid there and never reach the child); `defaults` is inherited, the child's keys win.
 * The task GLOBAL config (`~/.task/config.yml`: defaults) is task's own file, merged separately, as before.
 * `hooks` is no longer a key: it is a `RemovedConfigKeyError` in the global file and in every layer.
 */
export const TASK_CONFIG_SCHEMA: ConfigSchema = {
	sections: {
		statuses: { scope: 'local' },
		types: { scope: 'local' },
		priorities: { scope: 'local' },
		fields: { scope: 'local' },
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

function priorityProblem(layer: string, path: string, problem: string): ConfigSchemaError {
	return new ConfigSchemaError(`${layer}: ${path}: ${problem}.`, { layer, key: 'priorities', path });
}

/**
 * `priorities` is a non-empty list of distinct priorities (the rules of a priority: one line of text, at most 50 characters),
 * highest first. A problem names the file and the entry.
 */
function checkPriorities(layer: NamedLayer): void {
	const priorities = (layer.values as TaskProjectConfig).priorities as unknown;
	if (priorities === undefined) return;
	if (!Array.isArray(priorities) || priorities.length === 0) {
		throw priorityProblem(
			layer.name,
			'priorities',
			'must be a list of at least one priority, highest first (for example [urgent, high, medium, low])'
		);
	}
	const seen = new Set<string>();
	priorities.forEach((entry: unknown, index) => {
		const path = `priorities[${index}]`;
		if (typeof entry !== 'string') {
			throw priorityProblem(layer.name, path, `must be text, found ${JSON.stringify(entry)}`);
		}
		// A blank entry is reported by normalizePriority below.
		if (entry.trim() !== '' && entry !== entry.trim()) {
			throw priorityProblem(
				layer.name,
				path,
				`"${entry}" has a space at its start or end; write "${entry.trim()}"`
			);
		}
		let normalized: string;
		try {
			normalized = normalizePriority(entry);
		} catch (error) {
			throw priorityProblem(layer.name, path, error instanceof Error ? error.message : String(error));
		}
		if (seen.has(normalized)) {
			throw priorityProblem(layer.name, path, `"${normalized}" is listed twice`);
		}
		seen.add(normalized);
	});
}

/** `defaults.leaseMinutes`: an integer of 1 to 10080 (one week), in any layer. */
function checkLeaseMinutes(layerName: string, defaults: { leaseMinutes?: unknown } | undefined): void {
	const minutes = defaults?.leaseMinutes;
	if (minutes === undefined) return;
	if (typeof minutes !== 'number' || !Number.isInteger(minutes) || minutes < 1 || minutes > MAX_LEASE_MINUTES) {
		throw new ConfigSchemaError(
			`${layerName}: defaults.leaseMinutes: must be a whole number of minutes, 1 to ${MAX_LEASE_MINUTES} (found ${JSON.stringify(minutes)}).`,
			{ layer: layerName, key: 'defaults', path: 'defaults.leaseMinutes' }
		);
	}
}

/**
 * A `defaults.priority` written by a PROJECT layer must be one of the project's priorities; the error names the nearest layer
 * that writes it. The global config is never checked here: when no project layer writes the default, the config resolves it
 * (the global value if listed, else `medium` if listed, else the last priority), so a global value outside the list is ignored.
 */
function checkDefaultPriority(config: TaskResolvedConfig, layers: readonly NamedLayer[]): void {
	const writer = [...layers]
		.reverse()
		.find(layer => (layer.values as TaskProjectConfig).defaults?.priority !== undefined);
	if (writer === undefined || config.priorities.includes(config.defaults.priority)) return;
	throw new ConfigSchemaError(
		`${writer.name}: defaults.priority: "${config.defaults.priority}" is not one of the priorities of this project (${config.priorities.join(', ')}). Set defaults.priority to one of them, or add it to priorities.`,
		{ layer: writer.name, key: 'defaults', path: 'defaults.priority' }
	);
}

/** The global config may not hold a strategy (a repo or a server belongs to one project) nor hooks. Names the global file. */
function checkGlobalConfig(globalConfigDir: string | undefined): void {
	const global = TaskConfigLoader.loadGlobal(globalConfigDir) as Record<string, unknown>;
	const file = path.join(TaskConfigLoader.resolveGlobalConfigDir(globalConfigDir), 'config.yml');
	assertNoHooks(file, global);
	checkLeaseMinutes(file, global['defaults'] as { leaseMinutes?: unknown } | undefined);
	if (global['strategy'] !== undefined) {
		throw new StrategyConfigError(
			file,
			'strategy',
			'not allowed in the global config (it holds defaults only)',
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
		// Before the schema check: its generic "unknown key" message would not say what replaces hooks.
		assertNoHooks(layer.name, layer.values);
		validateLayer(TASK_CONFIG_SCHEMA, layer.name, layer.values, 'project');
		checkStatusOutcomes(layer);
		checkPriorities(layer);
		checkLeaseMinutes(layer.name, (layer.values as TaskProjectConfig).defaults);
		// Every layer is checked for structure (a parent's section is valid in its own file); only the own layer is resolved.
		parseStrategySection(layer.name, layer.values['strategy']);
	}
	checkGlobalConfig(globalConfigDir);
	const merged = mergeLayers(TASK_CONFIG_SCHEMA, layers);
	const config = TaskConfigLoader.resolve({
		global: TaskConfigLoader.loadGlobal(globalConfigDir),
		project: merged.values as TaskProjectConfig,
		source: ownConfigFile(storage),
	});
	checkDefaultPriority(config, layers);
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
		strategy: resolveStrategy(
			strategy,
			ownConfigFile(storage),
			options.registry ?? createBuiltinRegistry(),
			projectFactsOf(config)
		),
	};
}

/** The statuses (config order, with their terminal / default / outcome) and types a strategy has to agree with. */
export function projectFactsOf(config: TaskResolvedConfig): ProjectFacts {
	return {
		statuses: config.statuses.map(name => ({
			name,
			terminal: config.terminalStatuses.includes(name),
			default: name === config.defaultStatus,
			outcome: !config.terminalStatuses.includes(name)
				? undefined
				: config.negativeStatuses.includes(name)
					? 'negative'
					: 'positive',
		})),
		types: config.types,
		priorities: config.priorities,
	};
}
