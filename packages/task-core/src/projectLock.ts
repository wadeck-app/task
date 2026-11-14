// The write lock of a local project: one file `<data dir>/.write-lock`, created atomically (`wx`), held around the whole
// read-compare-write of a mutation (task file AND index), so two task processes never interleave on the same data.
// Contention waits with a bounded backoff, then fails loudly naming the holder. A lock whose process is dead (same host
// only) is taken over WITH a warning. Synchronous on purpose: the local store is synchronous.
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { formatDuration } from './formatDuration.js';

/** What the lock file tells about its holder. */
export interface LockHolder {
	pid: number;
	host: string;
	/** ISO instant the lock was taken. */
	at: string;
}

// `token` identifies the holder instance, so a release never removes somebody else's lock.
interface LockFileContent extends LockHolder {
	token: string;
}

export interface WriteLockOptions {
	/** How long to wait for another holder before failing. Default 10000. */
	timeoutMs?: number;
	/** First pause between two attempts; it doubles up to 200 ms. Default 10. */
	pollMs?: number;
	/** The clock in ms (tests). Default `Date.now`. */
	now?: () => number;
	/** Pauses the whole thread (tests). Default: `Atomics.wait`, which sleeps without using the CPU. */
	sleep?: (ms: number) => void;
	/** Whether a process exists (same host only). Default: `process.kill(pid, 0)`, EPERM counts as alive. */
	isProcessAlive?: (pid: number) => boolean;
	pid?: number;
	hostname?: string;
	/** Told about anything unusual (a lock taken over from a dead process, a lock that is no longer ours). Default: `process.emitWarning`. */
	onWarning?: (message: string) => void;
	/** Test hook: called after a lock was judged dead and before the takeover starts (to simulate another contender). */
	afterStaleRead?: () => void;
}

/** The lock could not be taken in time. `holder` is absent when the lock file cannot be read. */
export class WriteLockTimeoutError extends Error {
	constructor(
		message: string,
		readonly hint: string,
		readonly lockPath: string,
		readonly holder?: LockHolder
	) {
		super(message);
		this.name = 'WriteLockTimeoutError';
	}
}

const MAX_POLL_MS = 200;
// A takeover lasts microseconds; a guard older than this was abandoned by a crash.
const GUARD_STALE_MS = 5000;

function defaultSleep(ms: number): void {
	// Blocks this thread without busy-waiting.
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function defaultIsProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM: the process exists but belongs to someone else. Anything but ESRCH is not proof of death.
		return (error as NodeJS.ErrnoException).code !== 'ESRCH';
	}
}

function defaultWarning(message: string): void {
	process.emitWarning(message, { code: 'TASK_WRITE_LOCK' });
}

function parseLockFile(text: string): LockFileContent | undefined {
	try {
		const value = JSON.parse(text) as Partial<LockFileContent> | null;
		if (
			value !== null &&
			typeof value === 'object' &&
			typeof value.pid === 'number' &&
			typeof value.host === 'string' &&
			typeof value.at === 'string' &&
			typeof value.token === 'string'
		) {
			return { pid: value.pid, host: value.host, at: value.at, token: value.token };
		}
	} catch {
		// Unreadable content: the caller treats it as "being written or damaged".
	}
	return undefined;
}

export class ProjectWriteLock {
	private depth = 0;
	private readonly timeoutMs: number;
	private readonly pollMs: number;
	private readonly now: () => number;
	private readonly sleep: (ms: number) => void;
	private readonly isProcessAlive: (pid: number) => boolean;
	private readonly pid: number;
	private readonly hostname: string;
	private readonly warn: (message: string) => void;
	private readonly afterStaleRead: (() => void) | undefined;
	private readonly guardToken = crypto.randomUUID();

	constructor(
		private readonly lockPath: string,
		options: WriteLockOptions = {}
	) {
		this.timeoutMs = options.timeoutMs ?? 10_000;
		this.pollMs = options.pollMs ?? 10;
		this.now = options.now ?? Date.now;
		this.sleep = options.sleep ?? defaultSleep;
		this.isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive;
		this.pid = options.pid ?? process.pid;
		this.hostname = options.hostname ?? os.hostname();
		this.warn = options.onWarning ?? defaultWarning;
		this.afterStaleRead = options.afterStaleRead;
	}

	/** Runs `operation` holding the lock. Reentrant: a nested call on the same instance runs inside the lock already held. */
	run<T>(operation: () => T): T {
		if (this.depth > 0) {
			this.depth++;
			try {
				return operation();
			} finally {
				this.depth--;
			}
		}
		const token = this.acquire();
		this.depth = 1;
		try {
			return operation();
		} finally {
			this.depth = 0;
			this.release(token);
		}
	}

	private acquire(): string {
		fs.mkdirSync(path.dirname(this.lockPath), { recursive: true });
		const token = crypto.randomUUID();
		const startedAt = this.now();
		let pause = this.pollMs;
		for (;;) {
			const content: LockFileContent = {
				pid: this.pid,
				host: this.hostname,
				at: new Date(this.now()).toISOString(),
				token,
			};
			try {
				fs.writeFileSync(this.lockPath, JSON.stringify(content), { flag: 'wx' });
				return token;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
					throw new Error(
						`Cannot create the write lock ${this.lockPath}: ${(error as Error).message}. Check that the data folder exists and is writable.`,
						{ cause: error }
					);
				}
			}
			const holder = this.readHolder();
			if (holder !== undefined && this.takeOverIfDead(holder)) {
				continue;
			}
			const waited = this.now() - startedAt;
			if (waited >= this.timeoutMs) {
				throw this.timeoutError(holder, waited);
			}
			this.sleep(Math.min(pause, this.timeoutMs - waited));
			pause = Math.min(pause * 2, MAX_POLL_MS);
		}
	}

	private readHolder(): LockFileContent | undefined {
		try {
			return parseLockFile(fs.readFileSync(this.lockPath, 'utf8'));
		} catch {
			// Gone between the failed create and the read (the holder just released): the next attempt takes it.
			return undefined;
		}
	}

	/** True when the lock belonged to a dead process of this host and was removed (a warning says so). */
	private takeOverIfDead(holder: LockFileContent): boolean {
		if (holder.host !== this.hostname || this.isProcessAlive(holder.pid)) {
			return false;
		}
		this.afterStaleRead?.();
		// Takeover protocol: takeovers are serialized by an exclusive guard file (`<lock>.takeover`, created with `wx`).
		// Under the guard the lock is read AGAIN and removed only when it is still the dead holder's (same token). The
		// file can only be replaced by a live lock after it has been removed, and only takeovers remove it, so a live lock
		// created by someone else is never removed. The new lock is then created with `wx` by the normal path, so two
		// contenders cannot both win. A guard abandoned by a crash is replaced after `GUARD_STALE_MS` (or at once when its
		// holder is a dead process of this host); that replacement is the one remaining, microseconds wide, window.
		if (!this.acquireGuard()) {
			return false;
		}
		try {
			const current = this.readHolder();
			if (current?.token !== holder.token) {
				// Gone or replaced meanwhile: the caller tries again from the start.
				return false;
			}
			try {
				fs.rmSync(this.lockPath);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
					return false;
				}
			}
		} finally {
			this.releaseGuard();
		}
		this.warn(
			`Took over the write lock ${this.lockPath} left by pid ${holder.pid} on ${holder.host} (taken ${holder.at}): that process is not running (crashed or killed).`
		);
		return true;
	}

	private get guardPath(): string {
		return `${this.lockPath}.takeover`;
	}

	private acquireGuard(): boolean {
		for (let attempt = 0; attempt < 2; attempt++) {
			const content: LockFileContent = {
				pid: this.pid,
				host: this.hostname,
				at: new Date(this.now()).toISOString(),
				token: this.guardToken,
			};
			try {
				fs.writeFileSync(this.guardPath, JSON.stringify(content), { flag: 'wx' });
				return true;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
					return false;
				}
			}
			const guard = parseLockFile(this.readText(this.guardPath));
			const age = guard === undefined ? 0 : this.now() - Date.parse(guard.at);
			const abandoned =
				guard !== undefined &&
				(age > GUARD_STALE_MS || (guard.host === this.hostname && !this.isProcessAlive(guard.pid)));
			if (!abandoned) {
				return false;
			}
			// Remove it only if it is still the one judged abandoned.
			if (parseLockFile(this.readText(this.guardPath))?.token === guard.token) {
				fs.rmSync(this.guardPath, { force: true });
			}
		}
		return false;
	}

	private releaseGuard(): void {
		if (parseLockFile(this.readText(this.guardPath))?.token === this.guardToken) {
			fs.rmSync(this.guardPath, { force: true });
		}
	}

	private readText(file: string): string {
		try {
			return fs.readFileSync(file, 'utf8');
		} catch {
			return '';
		}
	}

	private release(token: string): void {
		try {
			const content = parseLockFile(fs.readFileSync(this.lockPath, 'utf8'));
			if (content?.token !== token) {
				this.warn(
					`The write lock ${this.lockPath} is no longer the one this task process took (now ${
						content === undefined ? 'unreadable' : `held by pid ${content.pid} on ${content.host}`
					}); it was left in place. The change itself was written.`
				);
				return;
			}
			fs.rmSync(this.lockPath);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
				this.warn(
					`The write lock ${this.lockPath} vanished while the change was being written (deleted by hand or by a cleanup?). Another process may have written at the same time: check the task with "task show".`
				);
				return;
			}
			this.warn(
				`Could not remove the write lock ${this.lockPath}: ${(error as Error).message}. Delete the file by hand, other task processes wait for it.`
			);
		}
	}

	private timeoutError(holder: LockFileContent | undefined, waited: number): WriteLockTimeoutError {
		const lockPath = this.lockPath;
		const limits = `waited ${formatDuration(waited)}, limit ${formatDuration(this.timeoutMs)}`;
		if (holder === undefined) {
			return new WriteLockTimeoutError(
				`The write lock of this project (${lockPath}) is unreadable (${limits}). Nothing was written.`,
				`If another task command is running, wait for it and retry. If none is, the lock file is damaged: delete ${lockPath} and retry.`,
				lockPath
			);
		}
		const heldFor = this.now() - Date.parse(holder.at);
		const sameHost = holder.host === this.hostname;
		return new WriteLockTimeoutError(
			`Another task process holds the write lock of this project: pid ${holder.pid} on ${holder.host}, for ${
				Number.isNaN(heldFor) ? 'an unknown time' : formatDuration(heldFor)
			} (since ${holder.at}); ${limits}. Nothing was written.`,
			sameHost
				? `Retry in a moment. If pid ${holder.pid} is stuck, stop it: the lock is released when it ends. The lock is the file ${lockPath}; delete it only when you are sure no task process is writing.`
				: `The holder runs on another host (${holder.host}), so task cannot tell whether it is alive. Retry in a moment; if that process is gone, delete the file ${lockPath} (shared folder) and retry.`,
			lockPath,
			{ pid: holder.pid, host: holder.host, at: holder.at }
		);
	}
}
