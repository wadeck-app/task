// Names and small reads shared by every place that looks at a task data folder (registry or `.task`).
import * as fs from 'node:fs';
import * as path from 'node:path';

export const CONFIG_FILE = 'config.yml';
export const INDEX_FILE = 'task-index.json';

/** The `*.json` file names of a folder; an absent folder holds none. */
export function jsonFilesIn(dir: string): string[] {
	try {
		return fs.readdirSync(dir).filter(name => name.endsWith('.json'));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
		throw error;
	}
}

/** The ids of the task files of a data folder (`tasks/<id>.json`), sorted. */
export function taskIdsIn(dataDir: string): string[] {
	return jsonFilesIn(path.join(dataDir, 'tasks'))
		.map(name => name.slice(0, -'.json'.length))
		.sort();
}
