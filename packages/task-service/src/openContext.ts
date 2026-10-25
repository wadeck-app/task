import { writeFileAtomic } from '@wadeck-app/project-sdk';
import { TaskStore } from '@wadeck-app/task-core';

import type { TaskServiceContext } from './context.js';
import { loadTaskConfig } from './projectConfig.js';
import type { ResolvedProject } from './resolveProject.js';
import { assertDataMigrated } from './migrateData.js';
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
}

/** Task files are written whole or not at all (temp file, fsync, rename): a crash never leaves half a task. */
function writeAtomically(file: string, content: string): void {
	writeFileAtomic(file, content);
}

/**
 * Builds the context of a project: its task store, its resolved config and its identity. A project whose data is still in the old
 * `.task` folder of its main path is refused (`UnmigratedDataError`, with the `migrate-data` command), and so is a real split of the data
 * (`ProjectDataSplitError`), see {@link assertDataMigrated}. An invalid config file throws the loader's error, never defaults.
 */
export function openTaskContext(input: OpenTaskContextInput): TaskServiceContext {
	assertDataMigrated(input.storage, input.project.name);
	const { storage } = input;
	const { id, name, path: projectPath } = input.project;
	return {
		store: new TaskStore(tasksDirOf(storage), { writeFile: writeAtomically }),
		config: loadTaskConfig(storage, input.globalConfigDir),
		storage,
		project: {
			...(id === undefined ? {} : { id }),
			name,
			...(projectPath === undefined ? {} : { path: projectPath }),
		},
	};
}

/** Opens the context of a project found by `resolveProject` (its storage, id, name and path). Same refusals as {@link openTaskContext}. */
export function openResolvedProject(resolved: ResolvedProject, globalConfigDir?: string): TaskServiceContext {
	return openTaskContext({
		storage: resolved.storage,
		globalConfigDir,
		project: { id: resolved.id, name: resolved.name, path: resolved.path },
	});
}
