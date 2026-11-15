// The file system under the migration state and the worker lock: the node implementation of WorkerFiles. The journal's operations are
// the ones of nodeWalFiles (appends flushed to the disk, whole-file replacements through the host's atomic writer).
import * as fs from 'node:fs';
import * as os from 'node:os';

import { nodeWalFiles } from './nodeWalFiles.js';
import type { WorkerFiles } from './workerFiles.js';

export function nodeWorkerFiles(writeAtomic: (file: string, content: string) => void): WorkerFiles {
	return {
		...nodeWalFiles(writeAtomic),
		createExclusive(file, text) {
			try {
				fs.writeFileSync(file, text, { flag: 'wx' });
				return true;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
				throw error;
			}
		},
		remove(file) {
			fs.rmSync(file, { force: true });
		},
	};
}

/** What the worker and the commands ask of the process table and the clock, on this machine. */
export function nodeProcessFacts(): {
	host: string;
	pid: number;
	now: () => number;
	isAlive: (pid: number) => boolean;
} {
	return {
		host: os.hostname(),
		pid: process.pid,
		now: Date.now,
		isAlive(pid) {
			try {
				process.kill(pid, 0);
				return true;
			} catch (error) {
				// EPERM: the process exists but belongs to someone else. Anything but ESRCH is not proof of death.
				return (error as NodeJS.ErrnoException).code !== 'ESRCH';
			}
		},
	};
}
