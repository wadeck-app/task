import * as yaml from 'js-yaml';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Task hook value: simple string "command arg1 arg2" or object for advanced options.
export type TaskHookValue = string | { command: string; debug?: boolean };

/**
 * A status entry in .task/config.yml: either a bare name, or an object carrying
 * `terminal` (hidden from `task list` by default, e.g. "done") and/or `default`
 * (the status assigned to newly created tasks).
 */
export type TaskStatusEntry = string | { name: string; terminal?: boolean; default?: boolean };

export interface TaskGlobalConfig {
	defaults?: {
		priority?: string;
	};
	hooks?: Record<string, TaskHookValue>;
}

export interface TaskProjectConfig {
	statuses?: TaskStatusEntry[];
	types?: string[];
	fields?: Array<{ name: string; type: string; required?: boolean }>;
	defaults?: {
		priority?: string;
	};
	hooks?: Record<string, TaskHookValue>;
}

export interface TaskResolvedConfig {
	statuses: string[];
	/** Status assigned to newly created tasks (explicit `default: true` entry, else the first status). */
	defaultStatus: string;
	/** Statuses hidden from `task list` unless `--all` is passed (e.g. "done"). */
	terminalStatuses: string[];
	/** Valid task types. Empty array means no validation (any string accepted). */
	types: string[];
	defaults: {
		priority: string;
	};
	globalHooks: Record<string, TaskHookValue>;
	projectHooks: Record<string, TaskHookValue>;
}

const DEFAULT_STATUSES: TaskStatusEntry[] = ['backlog', 'in-progress', 'done'];
const DEFAULT_PRIORITY = 'medium';

function loadYamlFile<T>(filePath: string): T | undefined {
	if (!fs.existsSync(filePath)) return undefined;
	const raw = fs.readFileSync(filePath, 'utf8');
	return yaml.load(raw) as T;
}

/**
 * Resolves the raw `statuses` entries from config.yml into plain names plus the
 * derived default/terminal statuses. At most one entry may be marked `default: true`;
 * when none is, the first entry in the list is the implicit default.
 */
function resolveStatuses(entries: TaskStatusEntry[]): {
	statuses: string[];
	defaultStatus: string;
	terminalStatuses: string[];
} {
	if (entries.length === 0) {
		throw new Error('"statuses" in .task/config.yml must list at least one status.');
	}

	const normalized = entries.map(entry =>
		typeof entry === 'string'
			? { name: entry, terminal: false, default: false }
			: { name: entry.name, terminal: entry.terminal ?? false, default: entry.default ?? false }
	);

	const defaultEntries = normalized.filter(e => e.default);
	if (defaultEntries.length > 1) {
		throw new Error(
			`Multiple statuses marked "default: true" in .task/config.yml: ${defaultEntries.map(e => e.name).join(', ')}. Only one status can be the default.`
		);
	}

	return {
		statuses: normalized.map(e => e.name),
		defaultStatus: defaultEntries[0]?.name ?? normalized[0]!.name,
		terminalStatuses: normalized.filter(e => e.terminal).map(e => e.name),
	};
}

export class TaskConfigLoader {
	static expandTilde(p: string): string {
		if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) {
			// violations-suppress: shared/no-out-of-repo-path expanding a user-written "~" prefix requires the home directory by definition; this resolves user-level CLI config, not a build artefact path
			return path.join(os.homedir(), p.slice(1));
		}
		return p;
	}

	static resolveGlobalConfigDir(configDirOverride?: string): string {
		// violations-suppress: shared/no-out-of-repo-path the default global config dir is "~/.task" by design (overridable via configDirOverride or the TASK_CONFIG env var); user-level config lives under the home directory, it is not a build artefact path
		const raw = configDirOverride ?? process.env['TASK_CONFIG'] ?? path.join(os.homedir(), '.task');
		return TaskConfigLoader.expandTilde(raw);
	}

	static isInitialized(projectDir?: string): boolean {
		const dir = projectDir ?? process.cwd();
		return fs.existsSync(path.join(dir, '.task'));
	}

	static load(options?: { configDir?: string; projectDir?: string }): TaskResolvedConfig {
		const globalConfigDir = TaskConfigLoader.resolveGlobalConfigDir(options?.configDir);
		const projectDir = options?.projectDir ?? process.cwd();

		const globalConfig = loadYamlFile<TaskGlobalConfig>(path.join(globalConfigDir, 'config.yml')) ?? {};
		const projectConfig = loadYamlFile<TaskProjectConfig>(path.join(projectDir, '.task', 'config.yml')) ?? {};

		const { statuses, defaultStatus, terminalStatuses } = resolveStatuses(projectConfig.statuses ?? DEFAULT_STATUSES);

		return {
			statuses,
			defaultStatus,
			terminalStatuses,
			types: projectConfig.types ?? [],
			defaults: {
				priority: projectConfig.defaults?.priority ?? globalConfig.defaults?.priority ?? DEFAULT_PRIORITY,
			},
			globalHooks: globalConfig.hooks ?? {},
			projectHooks: projectConfig.hooks ?? {},
		};
	}

	static addType(projectDir: string, typeName: string): void {
		const configPath = path.join(projectDir, '.task', 'config.yml');
		const projectConfig = loadYamlFile<TaskProjectConfig>(configPath) ?? {};
		const types = projectConfig.types ?? [];
		if (!types.includes(typeName)) {
			types.push(typeName);
		}
		projectConfig.types = types;
		fs.writeFileSync(configPath, yaml.dump(projectConfig), 'utf8');
	}

	static removeType(projectDir: string, typeName: string): void {
		const configPath = path.join(projectDir, '.task', 'config.yml');
		const projectConfig = loadYamlFile<TaskProjectConfig>(configPath) ?? {};
		const types = projectConfig.types ?? [];
		projectConfig.types = types.filter(t => t !== typeName);
		fs.writeFileSync(configPath, yaml.dump(projectConfig), 'utf8');
	}
}
