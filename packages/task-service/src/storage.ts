// Where the data and the config of a task project live: the shared project registry, nowhere else.
import * as path from 'node:path';

import { getConfigLayers, projectToolDir } from '@wadeck-app/project-sdk';
import type { Project, Registry } from '@wadeck-app/project-sdk';

const CONFIG_FILE = 'config.yml';

export interface TaskStorage {
	/** The folder holding `tasks/` and `task-index.json`, in the shared project registry. */
	dataDir: string;
	/** Config files, root ancestor first, the project's own last (the one `task type add` writes). */
	configFiles: string[];
}

/**
 * The storage of a project of the shared registry: `projectToolDir(..., 'task', 'data')` for the data and the `config` folders
 * of the project chain for the config. Pure: nothing is created (the store creates the data folder at the first write).
 * Throws the SDK's errors for a broken parent chain.
 */
export function registryStorage(registry: Registry, registryDir: string, project: Project): TaskStorage {
	return {
		dataDir: projectToolDir(registryDir, project.id, 'task', 'data'),
		configFiles: getConfigLayers(registry, registryDir, project, 'task').map(layer =>
			path.join(layer.dir, CONFIG_FILE)
		),
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
