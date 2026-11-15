// The commands of a person on a migration that need no side opened (status, pause, resume, log), as the object the plugin offers through
// the seam. `input` points them at the project's data folder with the real files, clock and process table of this machine.
import * as path from 'node:path';

import type { MigrationControlApi } from './migrationApi.js';
import {
	pauseMigration,
	readMigrationLog,
	readMigrationStatus,
	resumeMigration,
	waitForWorker,
} from './migrationControl.js';
import { nodeProcessFacts, nodeWorkerFiles } from './nodeWorkerFiles.js';

export const migrationControlApi: MigrationControlApi = {
	input(dataDir, writeFile) {
		const facts = nodeProcessFacts();
		return {
			dir: path.join(dataDir, 'migrating'),
			files: nodeWorkerFiles(writeFile),
			now: facts.now,
			isAlive: facts.isAlive,
			host: facts.host,
		};
	},
	status: readMigrationStatus,
	pause: pauseMigration,
	resume: resumeMigration,
	log: readMigrationLog,
	waitForWorker,
};
