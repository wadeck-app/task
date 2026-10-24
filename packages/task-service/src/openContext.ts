import * as path from 'node:path';

import { writeFileAtomic } from '@wadeck-app/project-sdk';
import { TaskStore } from '@wadeck-app/task-core';

import type { TaskServiceContext } from './context.js';
import { loadTaskConfig } from './projectConfig.js';
import type { ResolvedProject } from './resolveProject.js';
import { chooseDataLocation, legacyStorage, tasksDirOf } from './storage.js';
import type { TaskStorage } from './storage.js';

export interface OpenTaskContextInput {
	/**
	 * Storage of a project of the shared registry (from `resolveProject` / `listKnownProjects`): its data folder and config layers.
	 * Takes precedence over `projectDir`.
	 */
	storage?: TaskStorage;
	/** Legacy: absolute directory of an initialized task project (it holds `.task/`). Needed when there is no `storage`. */
	projectDir?: string;
	/** Global config directory (global hooks and defaults). Default: the config loader's own default. */
	globalConfigDir?: string;
	/**
	 * Identity. `id` is the id in the shared project registry; without it the project is named after its directory.
	 * `path` of a registered project is its main path; leave it out for a virtual project.
	 */
	project?: { id?: string; name?: string; path?: string };
}

/** Task files are written whole or not at all (temp file, fsync, rename): a crash never leaves half a task. */
function writeAtomically(file: string, content: string): void {
	writeFileAtomic(file, content);
}

/**
 * Builds the context of a project: its task store, its resolved config and its identity. A registry project whose data is still in
 * the `.task` of its main path keeps working on it (`notices` carries the deprecation line); a real split of the data is refused
 * (`ProjectDataSplitError`, see {@link chooseDataLocation}). The caller
 * checks that a legacy project is initialized first (the message for a missing `.task` depends on the caller);
 * an invalid config file throws the loader's error, never defaults.
 */
export function openTaskContext(input: OpenTaskContextInput): TaskServiceContext {
	let storage = input.storage;
	if (storage === undefined) {
		if (input.projectDir === undefined) {
			throw new Error(
				'openTaskContext needs a storage (shared registry project) or a projectDir (legacy project)'
			);
		}
		storage = legacyStorage(input.projectDir);
	}
	const name = input.project?.name ?? (input.projectDir === undefined ? undefined : path.basename(input.projectDir));
	if (name === undefined) throw new Error('openTaskContext needs the project name when it is given a storage');
	const chosen = chooseDataLocation(storage, name);
	storage = chosen.storage;
	const projectPath = input.project?.path ?? input.projectDir;
	return {
		store: new TaskStore(tasksDirOf(storage), { writeFile: writeAtomically }),
		config: loadTaskConfig(storage, input.globalConfigDir),
		storage,
		notices: chosen.notice === undefined ? [] : [chosen.notice],
		project: {
			...(input.project?.id === undefined ? {} : { id: input.project.id }),
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
