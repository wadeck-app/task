// The ONE module that knows the `.task` folder: where task data lived before the shared project registry. Used only by the
// unmigrated-project read (`chooseDataLocation`, stage 2b-2 removes it) and `migrate-data`; the architecture test forbids the
// folder name anywhere else, so deleting that read deletes the knowledge with it.
import * as fs from 'node:fs';
import * as path from 'node:path';

import { CONFIG_FILE, INDEX_FILE, jsonFilesIn } from './dataFiles.js';
import type { TaskStorage } from './storage.js';

/** The `.task` folder of a project directory (a registered project's main path). */
export function legacyDirOf(projectDir: string): string {
	return path.join(projectDir, '.task');
}

/** The storage of a directory whose data is in `<dir>/.task` (data, and `config.yml` as the only config file). */
export function legacyStorage(projectDir: string): TaskStorage {
	const dataDir = legacyDirOf(projectDir);
	return { kind: 'legacy', dataDir, configFiles: [path.join(dataDir, CONFIG_FILE)] };
}

export interface LegacyData {
	/** Task files in `tasks/`. */
	tasks: number;
	index: boolean;
	config: boolean;
}

/** What a `.task` folder holds (what `task cli migrate-data` copies). */
export function describeLegacyData(taskDir: string): LegacyData {
	return {
		tasks: jsonFilesIn(path.join(taskDir, 'tasks')).length,
		index: fs.existsSync(path.join(taskDir, INDEX_FILE)),
		config: fs.existsSync(path.join(taskDir, CONFIG_FILE)),
	};
}
