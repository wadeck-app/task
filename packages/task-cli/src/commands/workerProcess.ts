// The real launch of the migration worker: the same bundle that is running, started again with the internal subcommand
// `strategy migrate worker`, detached, its output appended to `<data>/migrating/worker.out.log`, with no window on Windows (the
// VBScript host of the task-service launcher). The decisions are in task-service (`launchWorker`); this file only hands it the node
// facilities (spawn, files, temp folder).
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { launchWorker } from '@wadeck-app/task-service';
import type { SpawnedProcess } from '@wadeck-app/task-service';

import type { LaunchRequest } from './MigrateStrategyCommands.js';

export async function launchWorkerProcess(request: LaunchRequest): Promise<{ pid?: number }> {
	const entry = process.argv[1];
	if (entry === undefined) {
		throw new Error(
			'cannot start the background worker: this process has no script path (process.argv[1]) to start again'
		);
	}
	const logFile = path.join(request.dataDir, 'migrating', 'worker.out.log');
	fs.mkdirSync(path.dirname(logFile), { recursive: true });
	return launchWorker(
		{
			command: process.execPath,
			// execArgv carries what this process was started with (a loader, in the development runs); a bundle has none.
			args: [
				...process.execArgv,
				entry,
				...(request.configDir === undefined ? [] : ['--config', request.configDir]),
				'strategy',
				'migrate',
				'worker',
				'-p',
				request.projectId,
			],
			cwd: request.cwd,
			logFile,
			env: process.env,
		},
		{
			platform: process.platform,
			spawn: (command, args, options) => spawn(command, args, options) as unknown as SpawnedProcess,
			writeScript: (file, text) => fs.writeFileSync(file, text, 'utf8'),
			scriptDir: os.tmpdir(),
			openLog: file => {
				const fd = fs.openSync(file, 'a');
				return { fd, close: () => fs.closeSync(fd) };
			},
			now: Date.now,
		}
	);
}
