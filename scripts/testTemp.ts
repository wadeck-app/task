// Test-only helper (imported by the vitest setup / globalSetup files of every package and by architecture/testTemp.test.ts;
// never by shipped code). Sits outside every package's `src` on purpose: tsc has rootDir `src`.
//
// Problem it solves: tests create directories in the OS temp dir (mkdtemp with our prefixes) and, before this helper,
// thousands were left behind (aborted runs, forgotten cleanups, detached children recreating a removed dir).
//
// Three layers:
//  1. trackTempDirs(): wraps fs.mkdtempSync / fs.promises.mkdtemp of the CURRENT process; every directory created
//     directly under the OS temp dir with one of OWN_TEMP_PREFIXES is remembered and removed at the end of the test
//     file (afterAll in the setup file) and, as a best effort, when the process exits or gets SIGINT / SIGTERM.
//     A test that cleans up itself is unaffected (removal tolerates an already-removed dir).
//  2. sweepStaleTempDirs(): at the START of a run (globalSetup), removes what an interrupted run left: top-level
//     entries of the OS temp dir named exactly `<own prefix><6 random chars>`, real directories (no symlink is
//     followed), older than MAX_TEMP_AGE_MS. Younger ones may belong to a concurrent run and are never touched.
//  3. removeTree(): bounded retry on the Windows EPERM / EBUSY / ENOTEMPTY timing, then throws (never silent).
import * as fs from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Every prefix a test of this repository passes to mkdtemp (the ONE list; a new creator adds its prefix here, or the
 * architecture test `testTemp.test.ts` fails). The six random characters mkdtemp appends are matched exactly, so
 * `task-service-` never matches `task-service-open-AbC123`, and unrelated tools' dirs are never touched.
 */
export const OWN_TEMP_PREFIXES: readonly string[] = [
	'app-module-task-',
	'app-module-task-real-server-',
	'register-after-update-',
	'task-applying-',
	'task-cli-declare-',
	'task-cli-globalconfig-',
	'task-cli-iso-',
	'task-cli-xdg-',
	'task-config-',
	'task-declare-',
	'task-declare-fake-',
	'task-delete-uninit-',
	'task-devbuild-bundle-',
	'task-env-dir-test-',
	'task-events-config-',
	'task-events-elsewhere-',
	'task-events-registered-',
	'task-events-test-',
	'task-global-cmd-',
	'task-global-shared-',
	'task-hierarchy-test-',
	'task-index-test-',
	'task-links-',
	'task-links-cli-test-',
	'task-manifest-',
	'task-module-',
	'task-module-xdg-',
	'task-project-flag-test-',
	'task-registry-data-',
	'task-release-bundle-',
	'task-rollback-',
	'task-self-check-',
	'task-service-',
	'task-service-open-',
	'task-service-xdg-',
	'task-shared-cli-',
	'task-shared-registry-',
	'task-sink-',
	'task-sink-int-',
	'task-sink-net-',
	'task-staged-log-',
	'task-staged-reg-',
	'task-staging-',
	'task-status-cmd-',
	'task-store-',
	'task-store-errors-',
	'task-type-cmd-',
	'task-type-ctx-',
	'task-unknown-commands-',
	'task-updatelog-',
	'task-variants-',
];

/**
 * A directory younger than this is never swept (it may belong to a concurrent run). Measured: a full `npm test` takes
 * about one minute; 15 minutes leaves a wide margin for a loaded machine.
 */
export const MAX_TEMP_AGE_MS = 15 * 60_000;

const RANDOM_SUFFIX = '[A-Za-z0-9]{6}';

/** True for `<own prefix><6 random chars>` (the exact shape mkdtemp produces). */
export function isOwnTempName(name: string, prefixes: readonly string[] = OWN_TEMP_PREFIXES): boolean {
	return prefixes.some(
		prefix => name.startsWith(prefix) && new RegExp(`^${RANDOM_SUFFIX}$`).test(name.slice(prefix.length))
	);
}

/**
 * Removes a throwaway tree, retrying EPERM / EBUSY / ENOTEMPTY for up to `timeoutMs`, then throws the last error.
 * Same behaviour as `removeTree` of packages/task-cli/src/isolatedCliEnv.ts (that one lives under a tsc rootDir and
 * cannot import this file). An already-missing tree is fine.
 */
export function removeTree(dir: string, timeoutMs = 5_000): void {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		try {
			fs.rmSync(dir, { recursive: true, force: true });
			return;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (!['EPERM', 'EBUSY', 'ENOTEMPTY'].includes(code ?? '') || Date.now() > deadline) {
				throw new Error(
					`cannot remove the test temp dir ${dir} (${code ?? 'unknown'}): ${(error as Error).message}. A process may still hold it (check for a leftover node / app-core-cli process); remove it by hand once released.`,
					{ cause: error }
				);
			}
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
		}
	}
}

export interface SweepOptions {
	/** Directory to scan, top level only. Default: os.tmpdir(). */
	tempDir?: string;
	prefixes?: readonly string[];
	maxAgeMs?: number;
	/** Clock, for tests. */
	now?: number;
}

export interface SweepResult {
	removed: string[];
}

/**
 * Removes the stale leftovers of interrupted runs. Scans the top level of the temp dir only; an entry is removed when
 * it is a real directory (symlinks and files are skipped, never followed), its name is exactly an own prefix plus six
 * random characters, and its mtime is older than `maxAgeMs`. Throws (naming the dir) when one cannot be removed.
 */
export function sweepStaleTempDirs(options: SweepOptions = {}): SweepResult {
	const tempDir = options.tempDir ?? os.tmpdir();
	const prefixes = options.prefixes ?? OWN_TEMP_PREFIXES;
	const maxAgeMs = options.maxAgeMs ?? MAX_TEMP_AGE_MS;
	const now = options.now ?? Date.now();
	const removed: string[] = [];
	for (const entry of fs.readdirSync(tempDir, { withFileTypes: true })) {
		// Dirent comes from the directory listing without following links: a symlink is not isDirectory().
		if (!entry.isDirectory() || !isOwnTempName(entry.name, prefixes)) continue;
		const full = path.join(tempDir, entry.name);
		let mtimeMs: number;
		try {
			mtimeMs = fs.lstatSync(full).mtimeMs;
		} catch (error) {
			// Removed by a concurrent sweep between the listing and now: nothing left to do.
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
			throw error;
		}
		if (now - mtimeMs <= maxAgeMs) continue;
		removeTree(full);
		removed.push(full);
	}
	return { removed };
}

/** The sweep as the globalSetup of every package runs it: one line on stdout when something was removed. */
export function sweepAndReport(options: SweepOptions = {}): SweepResult {
	const result = sweepStaleTempDirs(options);
	if (result.removed.length > 0) {
		const tempDir = options.tempDir ?? os.tmpdir();
		console.log(
			`[test temp sweep] removed ${result.removed.length} stale test dir(s) older than ${Math.round((options.maxAgeMs ?? MAX_TEMP_AGE_MS) / 60_000)} min from ${tempDir} (leftovers of an interrupted run)`
		);
	}
	return result;
}

export interface TempTracker {
	/** Directories created and still to remove. */
	pending(): string[];
	/** Removes every pending directory (loud on failure) and forgets them. */
	release(): void;
	/** Restores the original mkdtemp functions and detaches the process hooks. */
	uninstall(): void;
}

export interface TrackOptions {
	/** Directory whose direct children are tracked. Default: os.tmpdir(). */
	tempDir?: string;
	prefixes?: readonly string[];
	/** Process hooks (exit, SIGINT, SIGTERM). Default true. */
	processHooks?: boolean;
}

/**
 * Tracks the own-prefixed directories this process creates in the temp dir (see the header). Call once per process,
 * BEFORE the first mkdtemp (the setup file does, at its top). The functions are patched on the CommonJS `fs` object and
 * the ES namespace is re-synchronised, so `import * as fs from 'node:fs'` and `import fs from 'node:fs'` both see it.
 */
export function trackTempDirs(options: TrackOptions = {}): TempTracker {
	const tempDir = options.tempDir ?? os.tmpdir();
	const prefixes = options.prefixes ?? OWN_TEMP_PREFIXES;
	const sameDir = (a: string, b: string): boolean => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
	const created = new Set<string>();
	const remember = (result: unknown): void => {
		if (typeof result !== 'string') return;
		if (sameDir(path.dirname(result), tempDir) && isOwnTempName(path.basename(result), prefixes))
			created.add(result);
	};

	const cjsFs = createRequire(import.meta.url)('node:fs') as typeof fs;
	const originalSync = cjsFs.mkdtempSync;
	const originalPromise = cjsFs.promises.mkdtemp;
	cjsFs.mkdtempSync = ((...args: Parameters<typeof fs.mkdtempSync>) => {
		const result = (originalSync as (...a: unknown[]) => unknown)(...args);
		remember(result);
		return result;
	}) as typeof fs.mkdtempSync;
	cjsFs.promises.mkdtemp = (async (...args: Parameters<typeof fs.promises.mkdtemp>) => {
		const result = await (originalPromise as (...a: unknown[]) => Promise<unknown>)(...args);
		remember(result);
		return result;
	}) as typeof fs.promises.mkdtemp;
	syncBuiltinESMExports();

	const release = (): void => {
		const failures: string[] = [];
		for (const dir of [...created]) {
			try {
				removeTree(dir);
				created.delete(dir);
			} catch (error) {
				failures.push((error as Error).message);
			}
		}
		if (failures.length > 0) throw new Error(failures.join('\n'));
	};

	// Best effort when the process dies: exit handlers must be synchronous, which removeTree is. A hard kill
	// (TerminateProcess on Windows) runs nothing: the sweep of the next run covers it.
	const onExit = (): void => {
		try {
			release();
		} catch (error) {
			console.error(`[test temp] ${(error as Error).message}`);
		}
	};
	const onSignal = (signal: NodeJS.Signals): void => {
		onExit();
		// Re-raise with the default disposition (a worker's process.exit is intercepted by vitest).
		process.removeAllListeners(signal);
		process.kill(process.pid, signal);
	};
	const onSigint = (): void => onSignal('SIGINT');
	const onSigterm = (): void => onSignal('SIGTERM');
	const hooks = options.processHooks ?? true;
	if (hooks) {
		process.on('exit', onExit);
		process.on('SIGINT', onSigint);
		process.on('SIGTERM', onSigterm);
	}

	return {
		pending: () => [...created],
		release,
		uninstall() {
			cjsFs.mkdtempSync = originalSync;
			cjsFs.promises.mkdtemp = originalPromise;
			syncBuiltinESMExports();
			if (hooks) {
				process.off('exit', onExit);
				process.off('SIGINT', onSigint);
				process.off('SIGTERM', onSigterm);
			}
		},
	};
}
