// The lock that lets ONE background worker run per project: `<data dir>/migrating/worker.lock`, created exclusively, holding the pid,
// the host and the start of the worker. A second worker refuses and names the first. A lock whose process is gone (same host only) is
// taken over, and the caller is told so; a lock of another host is never judged (a shared folder), nor is one that cannot be read.
import * as path from 'node:path';

import { BackendRejectedError } from '@wadeck-app/task-core';

import type { WorkerFiles } from './workerFiles.js';

export interface LockHolder {
	pid: number;
	host: string;
	startedAt: string;
	/** Identifies the lock instance, so a release never removes somebody else's lock. */
	token: string;
}

export interface WorkerLockInput {
	file: string;
	files: WorkerFiles;
	pid: number;
	host: string;
	/** The clock in milliseconds. */
	now: () => number;
	/** Whether a process of this host exists. */
	isAlive: (pid: number) => boolean;
	/** Tests: the token of this instance. */
	token?: string;
}

function parseHolder(text: string): LockHolder | undefined {
	try {
		const value = JSON.parse(text) as Partial<LockHolder> | null;
		if (
			value !== null &&
			typeof value === 'object' &&
			typeof value.pid === 'number' &&
			typeof value.host === 'string' &&
			typeof value.startedAt === 'string' &&
			typeof value.token === 'string'
		) {
			return { pid: value.pid, host: value.host, startedAt: value.startedAt, token: value.token };
		}
	} catch {
		// Not a lock this code wrote.
	}
	return undefined;
}

export class WorkerLock {
	private readonly token: string;

	constructor(private readonly input: WorkerLockInput) {
		this.token = input.token ?? `${input.pid}-${input.now()}-${Math.random().toString(36).slice(2, 10)}`;
	}

	/**
	 * Takes the lock. Throws a BackendRejectedError naming the holder (and the command that shows what it does) when another worker has it.
	 * Returns `{ tookOver }` with the dead holder when it replaced the lock of a process that is gone.
	 */
	acquire(): { tookOver?: LockHolder } {
		const { file, files } = this.input;
		files.ensureDir(path.dirname(file));
		const mine = this.text();
		if (files.createExclusive(file, mine)) return {};

		const text = files.read(file);
		const holder = text === undefined ? undefined : parseHolder(text);
		if (holder === undefined) {
			if (text === undefined) {
				// Released between the two calls: one more try, then the plain refusal of a lost race.
				if (files.createExclusive(file, mine)) return {};
				throw this.refusal('another worker took the lock a moment ago', 'Run the command again.');
			}
			throw new BackendRejectedError(
				'migrating',
				'worker lock',
				`${file}: the worker lock cannot be read, so task cannot tell whether a worker is running`,
				`If no worker is running (task strategy migrate status), move ${file} aside and run the command again. Otherwise wait for the worker to end.`
			);
		}
		if (holder.host !== this.input.host) {
			throw new BackendRejectedError(
				'migrating',
				'worker lock',
				`a worker holds the lock of this project on another computer (${holder.host}, pid ${holder.pid}, since ${holder.startedAt}); task cannot tell whether it is alive`,
				`If it is gone, delete ${file} (shared folder) and run the command again; otherwise wait for it or stop it there.`
			);
		}
		if (this.input.isAlive(holder.pid)) {
			throw new BackendRejectedError(
				'migrating',
				'worker lock',
				`a worker is already running for this project: pid ${holder.pid} since ${holder.startedAt}`,
				'See what it does with: task strategy migrate status. To stop it: task strategy migrate pause.'
			);
		}
		// Dead: remove its lock, then create ours exclusively (two contenders cannot both win).
		files.remove(file);
		if (!files.createExclusive(file, mine)) {
			throw this.refusal('another worker took over the lock of the dead one first', 'Run the command again.');
		}
		return { tookOver: holder };
	}

	/** Removes the lock when it is still ours. */
	release(): void {
		const text = this.input.files.read(this.input.file);
		const holder = text === undefined ? undefined : parseHolder(text);
		if (holder?.token === this.token) this.input.files.remove(this.input.file);
	}

	/** Who holds the lock now, `undefined` when nobody (or the file is not a lock). */
	holder(): LockHolder | undefined {
		const text = this.input.files.read(this.input.file);
		return text === undefined ? undefined : parseHolder(text);
	}

	private text(): string {
		const holder: LockHolder = {
			pid: this.input.pid,
			host: this.input.host,
			startedAt: new Date(this.input.now()).toISOString(),
			token: this.token,
		};
		return `${JSON.stringify(holder)}\n`;
	}

	private refusal(message: string, hint: string): BackendRejectedError {
		return new BackendRejectedError('migrating', 'worker lock', message, hint);
	}
}
