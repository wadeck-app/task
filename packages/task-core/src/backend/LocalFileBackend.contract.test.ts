import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { runBackendContract } from '../contract/backendContract';
import { TaskStore } from '../TaskStore';
import { LOCAL_CAPABILITIES } from './capabilities';
import { LocalFileBackend } from './LocalFileBackend';

// The reference behaviour: every other backend must pass the same suite with its own declared capabilities.
runBackendContract(
	'LocalFileBackend',
	() => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-backend-contract-'));
		const tasksDir = path.join(root, 'data', 'tasks');
		fs.mkdirSync(tasksDir, { recursive: true });
		return {
			backend: new LocalFileBackend(new TaskStore(tasksDir)),
			dispose: () => fs.rmSync(root, { recursive: true, force: true }),
		};
	},
	LOCAL_CAPABILITIES
);
