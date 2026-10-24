import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { addProject as addSharedProject, defaultRegistryDir } from '@wadeck-app/project-sdk';
import type { Project } from '@wadeck-app/project-sdk';
import { TaskStore } from '@wadeck-app/task-core';
import type { TaskResolvedConfig } from '@wadeck-app/task-core';

import type { TaskServiceContext } from './context.js';

export interface TestContext {
	ctx: TaskServiceContext;
	rootDir: string;
	cleanup: () => void;
}

const DEFAULT_TEST_CONFIG: TaskResolvedConfig = {
	statuses: ['backlog', 'in-progress', 'done'],
	defaultStatus: 'backlog',
	terminalStatuses: ['done'],
	types: [],
	defaults: { priority: 'medium' },
	globalHooks: {},
	projectHooks: {},
};

/** Builds a context over a disposable `<tmp>/.task/tasks` store (index lives next to it, inside the tmp root). */
export function createTestContext(configOverrides: Partial<TaskResolvedConfig> = {}): TestContext {
	const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-service-'));
	const tasksDir = path.join(rootDir, '.task', 'tasks');
	fs.mkdirSync(tasksDir, { recursive: true });
	return {
		ctx: {
			store: new TaskStore(tasksDir),
			config: { ...DEFAULT_TEST_CONFIG, ...configOverrides },
			project: { name: 'proj', path: rootDir },
		},
		rootDir,
		cleanup: () => fs.rmSync(rootDir, { recursive: true, force: true }),
	};
}

export interface SharedRegistrySandbox {
	/** Temp root holding the registry and the project directories. */
	root: string;
	/** An environment that points the shared project registry at the sandbox (XDG_CONFIG_HOME): pass it as `env`. */
	env: NodeJS.ProcessEnv;
	/** The registry directory the SDK derives from `env`. */
	registryDir: string;
	/** Creates (once) a project directory under the root; with `task: true` it holds a `.task/tasks` folder. */
	dir: (name: string, options?: { task?: boolean }) => string;
	/** Registers a project with the SDK's own mutation (never the real registry: the sandbox registry only). */
	register: (name: string, dir: string | undefined, options?: { aliases?: string[] }) => Promise<Project>;
	cleanup: () => void;
}

/** A disposable shared project registry plus project directories. Fixtures use the SDK's mutations, the code under test only reads. */
export function createSharedRegistrySandbox(): SharedRegistrySandbox {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-shared-registry-'));
	const env: NodeJS.ProcessEnv = { XDG_CONFIG_HOME: path.join(root, 'xdg') };
	const registryDir = defaultRegistryDir(env);
	return {
		root,
		env,
		registryDir,
		dir: (name, options = {}) => {
			const dir = path.join(root, 'work', name);
			fs.mkdirSync(options.task === true ? path.join(dir, '.task', 'tasks') : dir, { recursive: true });
			return dir;
		},
		register: (name, dir, options = {}) =>
			addSharedProject(registryDir, {
				name,
				...(dir === undefined ? {} : { path: dir }),
				aliases: options.aliases,
			}),
		cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
	};
}
