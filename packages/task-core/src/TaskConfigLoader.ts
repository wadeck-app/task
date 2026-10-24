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

/** Parses a config file: absent or empty is undefined; invalid YAML and a top level that is not a mapping throw, naming the file. */
function loadYamlFile<T>(filePath: string): T | undefined {
	if (!fs.existsSync(filePath)) return undefined;
	const raw = fs.readFileSync(filePath, 'utf8');
	let parsed: unknown;
	try {
		parsed = yaml.load(raw);
	} catch (error) {
		throw new Error(
			`config file ${filePath} is not valid YAML: ${error instanceof Error ? error.message : String(error)}`
		);
	}
	if (parsed === undefined || parsed === null) return undefined;
	if (typeof parsed !== 'object' || Array.isArray(parsed)) {
		throw new Error(
			`config file ${filePath} must hold a mapping of keys (statuses, types, ...), found ${Array.isArray(parsed) ? 'a list' : typeof parsed}`
		);
	}
	return parsed as T;
}

/**
 * Resolves the raw `statuses` entries from config.yml into plain names plus the
 * derived default/terminal statuses. At most one entry may be marked `default: true`;
 * when none is, the first entry in the list is the implicit default.
 */
function resolveStatuses(
	entries: TaskStatusEntry[],
	source: string
): {
	statuses: string[];
	defaultStatus: string;
	terminalStatuses: string[];
} {
	if (entries.length === 0) {
		throw new Error(`"statuses" in ${source} must list at least one status.`);
	}

	const normalized = entries.map(entry =>
		typeof entry === 'string'
			? { name: entry, terminal: false, default: false }
			: { name: entry.name, terminal: entry.terminal ?? false, default: entry.default ?? false }
	);

	const defaultEntries = normalized.filter(e => e.default);
	if (defaultEntries.length > 1) {
		throw new Error(
			`Multiple statuses marked "default: true" in ${source}: ${defaultEntries.map(e => e.name).join(', ')}. Only one status can be the default.`
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

	/** Parses one config file (absent or empty: undefined). Invalid YAML or a top level that is not a mapping throws, naming the file. */
	static readConfigFile<T = Record<string, unknown>>(filePath: string): T | undefined {
		return loadYamlFile<T>(filePath);
	}

	/** The global config (`config.yml` of the global config dir): defaults and hooks; empty when absent. */
	static loadGlobal(configDirOverride?: string): TaskGlobalConfig {
		const dir = TaskConfigLoader.resolveGlobalConfigDir(configDirOverride);
		return loadYamlFile<TaskGlobalConfig>(path.join(dir, 'config.yml')) ?? {};
	}

	/**
	 * Builds the resolved config from the global config and the project config, both already read (and, for a project of the
	 * shared registry, already merged along its parent chain by task-service). `source` names the file of the project config
	 * in the status errors.
	 */
	static resolve(input: {
		global: TaskGlobalConfig;
		project: TaskProjectConfig;
		source: string;
	}): TaskResolvedConfig {
		const { global: globalConfig, project: projectConfig } = input;
		const { statuses, defaultStatus, terminalStatuses } = resolveStatuses(
			projectConfig.statuses ?? DEFAULT_STATUSES,
			input.source
		);

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

	/**
	 * The global config plus ONE project config file (unknown keys ignored); without `projectConfigFile`, the defaults of the global config only.
	 * The caller says where the file is (this class knows no project layout).
	 */
	static load(options?: { configDir?: string; projectConfigFile?: string }): TaskResolvedConfig {
		const file = options?.projectConfigFile;
		return TaskConfigLoader.resolve({
			global: TaskConfigLoader.loadGlobal(options?.configDir),
			project: file === undefined ? {} : (loadYamlFile<TaskProjectConfig>(file) ?? {}),
			source: file ?? 'the default statuses',
		});
	}

	/**
	 * Rewrites the `types` list of one config file (created when missing); the other keys are kept. The directory is created only
	 * with `createDirectory` (a config layer of the shared registry may not exist yet; a vanished `.task` must stay an error).
	 * `writeFile` defaults to a plain write; task-service injects an atomic one.
	 */
	static updateTypes(
		configPath: string,
		change: (types: string[]) => string[],
		writeFile: (file: string, content: string) => void = (file, content) => fs.writeFileSync(file, content, 'utf8'),
		options: { createDirectory?: boolean } = {}
	): void {
		const projectConfig = loadYamlFile<TaskProjectConfig>(configPath) ?? {};
		projectConfig.types = change(projectConfig.types ?? []);
		if (options.createDirectory === true) fs.mkdirSync(path.dirname(configPath), { recursive: true });
		writeFile(configPath, yaml.dump(projectConfig));
	}
}
