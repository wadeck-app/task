// Where the data and the config of a task project live: the shared project registry, or (an unmigrated project, stage 2b-2 removes it)
// the old data folder of its main path.
import * as fs from 'node:fs';
import * as path from 'node:path';

import { getConfigLayers, mainPath, projectToolDir } from '@wadeck-app/project-sdk';
import type { Project, Registry } from '@wadeck-app/project-sdk';

import { CONFIG_FILE, INDEX_FILE, jsonFilesIn, taskIdsIn } from './dataFiles.js';
import { ProjectDataSplitError } from './errors.js';
import { describeLegacyData, legacyDirOf, legacyStorage } from './legacyData.js';

export interface TaskStorage {
	/** `registry`: the data folder of the shared project registry. `legacy`: the old data folder of the main path of a project not migrated yet. */
	kind: 'registry' | 'legacy';
	/** The folder holding `tasks/` and `task-index.json`. */
	dataDir: string;
	/** Config files, root ancestor first, the project's own last (the one `task type add` writes). Legacy: only the old folder's `config.yml`. */
	configFiles: string[];
	/** Registry projects with a path: the old data folder of the main path, where the data lived before the registry (used to refuse a split). */
	legacyDir?: string;
}

/**
 * The storage of a project of the shared registry: `projectToolDir(..., 'task', 'data')` for the data and the `config` folders
 * of the project chain for the config. Pure: nothing is created (the store creates the data folder at the first write).
 * Throws the SDK's errors for a broken parent chain.
 */
export function registryStorage(registry: Registry, registryDir: string, project: Project): TaskStorage {
	const main = mainPath(project);
	return {
		kind: 'registry',
		dataDir: projectToolDir(registryDir, project.id, 'task', 'data'),
		configFiles: getConfigLayers(registry, registryDir, project, 'task').map(layer =>
			path.join(layer.dir, CONFIG_FILE)
		),
		...(main === undefined ? {} : { legacyDir: legacyDirOf(path.resolve(main)) }),
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

/** The command that copies the old data folder of a project into the shared registry. */
export function migrateCommand(projectName: string): string {
	return `task cli migrate-data -p ${projectName}`;
}

export interface ChosenStorage {
	storage: TaskStorage;
	/** One line the caller shows on stderr (CLI) or writes to the log (module); absent when nothing is worth saying. */
	notice?: string;
}

/**
 * Where the data of a registry project really is. Never refuses an unmigrated project (live tools read its `.task` directly):
 * - registry has no task data and the `.task` of the main path holds data (or a config the registry lacks): UNMIGRATED, the `.task`
 *   is read and written exactly like stage 1 (legacy storage, same identity) and `notice` is the deprecation line with the command;
 * - both hold task data with the same task ids (the state right after `task cli migrate-data`): the registry is used, `notice` says the old copy can be deleted;
 * - both hold task data and the ids differ: a REAL split, {@link ProjectDataSplitError} (nothing is read);
 * - otherwise (fresh project, or registry data only): the registry, silently. No-op for the legacy storage.
 */
export function chooseDataLocation(storage: TaskStorage, projectName: string): ChosenStorage {
	if (storage.kind !== 'registry' || storage.legacyDir === undefined) return { storage };
	const legacyDir = storage.legacyDir;
	const legacy = describeLegacyData(legacyDir);
	const legacyHasData = legacy.tasks > 0 || legacy.index;
	const registryHasData = hasTaskData(storage.dataDir);
	if (registryHasData && legacyHasData) {
		const [mine, old] = [taskIdsIn(storage.dataDir), taskIdsIn(legacyDir)];
		if (mine.length === old.length && mine.every((id, index) => id === old[index])) {
			return { storage, notice: `old copy still in ${legacyDir}: delete it by hand once checked` };
		}
		throw new ProjectDataSplitError(
			projectName,
			legacyDir,
			storage.dataDir,
			`Keep one of them: to keep the registry data, delete ${legacyDir} by hand; to keep the .task data, move ${storage.dataDir} away by hand (then run: ${migrateCommand(projectName)}).`
		);
	}
	const registryHasConfig = fs.existsSync(ownConfigFile(storage));
	if (!registryHasData && (legacyHasData || (legacy.config && !registryHasConfig))) {
		return {
			storage: legacyStorage(path.dirname(legacyDir)),
			notice: `Deprecated: project ${projectName} still keeps its task data in ${legacyDir}; copy it with: ${migrateCommand(projectName)} (then delete .task by hand)`,
		};
	}
	return { storage };
}
