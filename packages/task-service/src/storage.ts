// Where the data and the config of a task project live: the shared project registry, nowhere else.
import * as fs from 'node:fs';
import * as path from 'node:path';

import { getConfigLayers, mainPath, projectToolDir } from '@wadeck-app/project-sdk';
import type { Project, Registry } from '@wadeck-app/project-sdk';

import { CONFIG_FILE, INDEX_FILE, jsonFilesIn } from './dataFiles.js';

export interface TaskStorage {
	/** The folder holding `tasks/` and `task-index.json`, in the shared project registry. */
	dataDir: string;
	/** Config files, root ancestor first, the project's own last (the one `task type add` writes). */
	configFiles: string[];
	/** The main path of the project (absent for a virtual project): where `task cli migrate-data` looks for an old data folder. */
	mainDir?: string;
}

/**
 * The storage of a project of the shared registry: `projectToolDir(..., 'task', 'data')` for the data and the `config` folders
 * of the project chain for the config. Pure: nothing is created (the store creates the data folder at the first write).
 * Throws the SDK's errors for a broken parent chain.
 */
export function registryStorage(registry: Registry, registryDir: string, project: Project): TaskStorage {
	const main = mainPath(project);
	return {
		dataDir: projectToolDir(registryDir, project.id, 'task', 'data'),
		configFiles: getConfigLayers(registry, registryDir, project, 'task').map(layer =>
			path.join(layer.dir, CONFIG_FILE)
		),
		...(main === undefined ? {} : { mainDir: path.resolve(main) }),
	};
}

/** The folder of the task files: the `tasksDir` handed to the `TaskStore` (its index is then `<dataDir>/task-index.json`). */
export function tasksDirOf(storage: TaskStorage): string {
	return path.join(storage.dataDir, 'tasks');
}

/** The project's own config file: where `task type add|remove` writes. */
export function ownConfigFile(storage: TaskStorage): string {
	return storage.configFiles[storage.configFiles.length - 1]!;
}

/** True when the folder holds task data: a task file in `tasks/`, or `task-index.json`. An absent folder holds none. */
export function hasTaskData(dataDir: string): boolean {
	return jsonFilesIn(path.join(dataDir, 'tasks')).length > 0 || fs.existsSync(path.join(dataDir, INDEX_FILE));
}
