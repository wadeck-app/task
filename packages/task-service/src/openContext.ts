import { writeFileAtomic } from '@wadeck-app/project-sdk';

import type { TaskServiceContext } from './context.js';
import { createLazyBackend } from './lazyBackend.js';
import { createInstance } from './plugin-host/index.js';
import type { TaskPluginRegistry } from './plugins/kinds.js';
import { loadProjectSetup } from './projectConfig.js';
import type { ResolvedProject } from './resolveProject.js';
import { tasksDirOf } from './storage.js';
import type { TaskStorage } from './storage.js';

export interface OpenTaskContextInput {
	/** Storage of a project of the shared registry (from `resolveProject` / `listKnownProjects`): its data folder and config layers. */
	storage: TaskStorage;
	/** Global config directory (global hooks and defaults). Default: the config loader's own default. */
	globalConfigDir?: string;
	/**
	 * Identity: `id` is the id in the shared project registry, `path` its main path (leave it out for a virtual project).
	 * `name` is required.
	 */
	project: { id?: string; name: string; path?: string };
	/** The plugin registry the strategy is looked up in. Default: the built-ins (tests inject their own). */
	registry?: TaskPluginRegistry;
	/** The environment plugins read tokens from. Default: `process.env`. */
	env?: NodeJS.ProcessEnv;
}

/** Task files are written whole or not at all (temp file, fsync, rename): a crash never leaves half a task. */
function writeAtomically(file: string, content: string): void {
	writeFileAtomic(file, content);
}

/**
 * Builds the context of a project: its resolved config, its strategy and its task backend (`ctx.store`), and its identity.
 * The strategy comes from the project's own `strategy` section (the local file backend when there is none, silently); the
 * backend is created by its plugin at its first call, so construction is synchronous and cheap (nothing is read or created).
 * An invalid config file, a strategy section the plugin refuses, or a declared type with no plugin throws a ConfigSchemaError
 * naming the file and the key, never defaults and never the local backend.
 */
export function openTaskContext(input: OpenTaskContextInput): TaskServiceContext {
	const { storage } = input;
	const { id, name, path: projectPath } = input.project;
	const { config, strategy } = loadProjectSetup(storage, {
		globalConfigDir: input.globalConfigDir,
		registry: input.registry,
	});
	const project = {
		...(id === undefined ? {} : { id }),
		name,
		...(projectPath === undefined ? {} : { path: projectPath }),
	};
	const lazy = createLazyBackend(strategy.plugin, () =>
		createInstance(strategy, {
			project,
			tasksDir: tasksDirOf(storage),
			dataDir: storage.dataDir,
			writeFile: writeAtomically,
			env: input.env ?? process.env,
			fidelity: strategy.fidelity,
			fills: strategy.fills,
		})
	);
	return { store: lazy.backend, config, storage, project, strategy, dispose: lazy.dispose };
}

/** Opens the context of a project found by `resolveProject` (its storage, id, name and path). */
export function openResolvedProject(resolved: ResolvedProject, globalConfigDir?: string): TaskServiceContext {
	return openTaskContext({
		storage: resolved.storage,
		globalConfigDir,
		project: { id: resolved.id, name: resolved.name, path: resolved.path },
	});
}
