import * as yaml from 'js-yaml';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Task hook value: simple string "command arg1 arg2" or object for advanced options.
export type TaskHookValue = string | { command: string; debug?: boolean };

export interface TaskGlobalConfig {
	defaults?: {
		priority?: string;
	};
	hooks?: Record<string, TaskHookValue>;
}

export interface TaskProjectConfig {
	statuses?: string[];
	types?: string[];
	fields?: Array<{ name: string; type: string; required?: boolean }>;
	defaults?: {
		priority?: string;
	};
	hooks?: Record<string, TaskHookValue>;
}

export interface TaskResolvedConfig {
	statuses: string[];
	/** Valid task types. Empty array means no validation (any string accepted). */
	types: string[];
	defaults: {
		priority: string;
	};
	globalHooks: Record<string, TaskHookValue>;
	projectHooks: Record<string, TaskHookValue>;
}

const DEFAULT_STATUSES = ['backlog', 'in-progress', 'done'];
const DEFAULT_PRIORITY = 'medium';

function loadYamlFile<T>(filePath: string): T | undefined {
	if (!fs.existsSync(filePath)) return undefined;
	const raw = fs.readFileSync(filePath, 'utf8');
	return yaml.load(raw) as T;
}

export class TaskConfigLoader {
	static expandTilde(p: string): string {
		if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) {
			return path.join(os.homedir(), p.slice(1));
		}
		return p;
	}

	static resolveGlobalConfigDir(configDirOverride?: string): string {
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

		return {
			statuses: projectConfig.statuses ?? DEFAULT_STATUSES,
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
