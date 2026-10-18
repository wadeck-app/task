import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { ProjectsRegistryError } from './errors.js';

export interface RegistryLockOptions {
	/** Give up (loudly) after waiting this long for another process to release the lock. Default 10 000. */
	timeoutMs?: number;
	/** A lock file nobody touched for this long belongs to a crashed process and is taken over. Default 30 000. */
	staleMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_STALE_MS = 30_000;
const MIN_WAIT_MS = 5;
const MAX_WAIT_MS = 50;

// A file another process is deleting or has just created answers one of these on Windows, where ENOENT or EEXIST is expected.
const TRANSIENT_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);

/** Lock file guarding the read-modify-write of `<configDir>/projects.json`. */
export function registryLockPath(configDir: string): string {
	return path.join(configDir, 'projects.json.lock');
}

function errorCode(error: unknown): string {
	return (error as NodeJS.ErrnoException).code ?? '';
}

function sleep(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Creates the lock file exclusively. True when we own it, false when it exists or is momentarily unavailable. */
function tryCreate(lock: string, token: string): boolean {
	try {
		fs.writeFileSync(lock, token, { flag: 'wx' });
		return true;
	} catch (error) {
		const code = errorCode(error);
		if (code === 'EEXIST' || TRANSIENT_CODES.has(code)) return false;
		throw error;
	}
}

/** Removes the lock file when its owner crashed: untouched for `staleMs`. Best effort, a failure is retried by the caller's loop. */
function removeIfStale(lock: string, staleMs: number): void {
	try {
		if (Date.now() - fs.statSync(lock).mtimeMs > staleMs) fs.rmSync(lock, { force: true });
	} catch {
		// Released, or being deleted, by its owner meanwhile: the next attempt sees it.
	}
}

function release(lock: string, token: string): void {
	try {
		// Never delete a lock another process took over after ours went stale.
		if (fs.readFileSync(lock, 'utf8') === token) fs.rmSync(lock, { force: true });
	} catch {
		// Already gone: nothing to release.
	}
}

/**
 * Cross-process mutual exclusion for the registry's read-modify-write: a lock file created exclusively (`wx`).
 * Waiters retry with a short jittered pause until `timeoutMs`, then fail with the lock path and how to clear it.
 * The critical section is a few milliseconds, so a lock older than `staleMs` can only be a crashed holder's and is taken over
 * (two waiters taking over the same stale lock at the same instant can still both proceed: acceptable after a crash).
 * Also creates the config dir, turning an unwritable one into an error with the fix.
 */
export function withRegistryLock<T>(configDir: string, run: () => T, options: RegistryLockOptions = {}): T {
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
	const lock = registryLockPath(configDir);
	try {
		fs.mkdirSync(configDir, { recursive: true });
	} catch (error) {
		throw new ProjectsRegistryError(
			`cannot create ${configDir}: ${(error as Error).message}`,
			`Check that ${configDir} is writable.`
		);
	}
	const token = `${process.pid}:${crypto.randomUUID()}`;
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		let created: boolean;
		try {
			created = tryCreate(lock, token);
		} catch (error) {
			throw new ProjectsRegistryError(
				`cannot create the lock file ${lock}: ${(error as Error).message}`,
				`Check that ${configDir} is writable.`
			);
		}
		if (created) break;
		removeIfStale(lock, staleMs);
		if (Date.now() >= deadline) {
			throw new ProjectsRegistryError(
				`projects registry is locked: ${lock} was not released within ${timeoutMs} ms`,
				`Another \`task\` process is writing the registry. If none is running, delete ${lock} and retry.`
			);
		}
		sleep(MIN_WAIT_MS + Math.floor(Math.random() * (MAX_WAIT_MS - MIN_WAIT_MS)));
	}
	try {
		return run();
	} finally {
		release(lock, token);
	}
}
