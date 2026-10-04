// task-updater entry point -- bundled separately as task-updater.cjs.
// Must NOT import any task runtime modules.
import { ConfigDir } from '@wadeck-app/shared-cli/ConfigDir';
import {
	cacheFilePath,
	execNpm,
	readCache,
	readState,
	readUpdateConfig,
	runUpdater,
	stateFilePath,
} from '@wadeck-app/shared-updater';
import { cpSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import { join } from 'node:path';

declare const __TASK_CLI_VERSION__: string;

const PKG_NAME = '@wadeck-app/task-cli';
const baseConfigDir = process.env['TASK_CONFIG_DIR'] ?? ConfigDir.get('task');

// When UPDATER_MANUAL=1 (explicit `task cli update`), bypass autoUpdate:false by
// running the updater against a temp config copy with the flag removed.
const configDir = (() => {
	if (!process.env['UPDATER_MANUAL']) return baseConfigDir;
	try {
		const configFile = join(baseConfigDir, 'config.yml');
		const content = readFileSync(configFile, 'utf8');
		if (!/^autoUpdate:\s*false/m.test(content)) return baseConfigDir;
		const tempDir = join(os.tmpdir(), `task-update-manual-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
		cpSync(baseConfigDir, tempDir, { recursive: true });
		writeFileSync(join(tempDir, 'config.yml'), content.replace(/^autoUpdate:\s*false/m, 'autoUpdate: true'));
		return tempDir;
	} catch {
		return baseConfigDir;
	}
})();

const currentVersion = typeof __TASK_CLI_VERSION__ !== 'undefined' ? __TASK_CLI_VERSION__ : '0.0.0-dev';

try {
	const npmRoot = execNpm(['root', '-g'], { timeout: 10_000 }).trim();
	const selfCheckCmd = `${process.execPath} ${join(npmRoot, PKG_NAME, 'task.cjs')} cli self-check`;
	if (!process.env['UPDATER_SELF_CHECK_CMD']) {
		process.env['UPDATER_SELF_CHECK_CMD'] = selfCheckCmd;
	}
} catch {
	// Skip self-check if npm root unavailable.
}

// UPDATER_FORCE=1 means the user asked for this explicitly (`task cli update`), so the run
// must never be silent. shared-updater reports every outcome to its NDJSON log file only, so
// we mirror the entries this run produced onto stdout/stderr instead of duplicating its
// decision logic here. New updater messages surface automatically.
const force = process.env['UPDATER_FORCE'] === '1';

/** Path of the shared-updater NDJSON log for today (mirrors shared-updater's appendLog). */
function updaterLogPath(): string {
	return join(configDir, 'logs', `${new Date().toISOString().slice(0, 10)}.ndjson`);
}

function logSize(file: string): number {
	return existsSync(file) ? statSync(file).size : 0;
}

interface LogEntry {
	level: string;
	msg: string;
}

/**
 * Echo every log entry appended during this run and return them so reportOutcome can fall back
 * on raw log signal for the handful of paths that touch neither the cache nor the state file
 * (fetch failure, lock contention).
 */
function echoUpdaterLog(startPath: string, startSize: number): LogEntry[] {
	const endPath = updaterLogPath();
	// A run straddling midnight rolls over to a new file, which must be read from the start.
	const offset = endPath === startPath ? startSize : 0;
	if (!existsSync(endPath)) return [];
	const appended = readFileSync(endPath, 'utf8').slice(offset);
	const entries: LogEntry[] = [];
	for (const line of appended.split('\n')) {
		if (line.trim() === '') continue;
		let level = 'info';
		let msg = line;
		try {
			const entry = JSON.parse(line) as { level?: string; msg?: string };
			if (typeof entry.msg === 'string') msg = entry.msg;
			if (typeof entry.level === 'string') level = entry.level;
		} catch {
			// Not valid NDJSON: still surface the raw line rather than hiding it.
		}
		const stream = level === 'warn' || level === 'error' ? process.stderr : process.stdout;
		stream.write(`[task-updater] ${msg}\n`);
		entries.push({ level, msg });
	}
	return entries;
}

/**
 * Always prints current/latest/status. Cache + state files are shared-updater's authoritative
 * record of this run's outcome (readState/readCache -- see @wadeck-app/shared-updater); the log
 * is only consulted as a fallback for the paths that write neither (version fetch failed, lock
 * held by a concurrent run). Never prints the old vague "unexpected" message -- an outcome that
 * truly cannot be determined says so explicitly, with the paths that were checked.
 */
function reportOutcome(startedAt: number, logEntries: LogEntry[]): void {
	const cache = readCache(cacheFilePath(configDir));
	const state = readState(stateFilePath(configDir));
	const latest = cache?.latestVersion ?? 'unknown (no cache file)';

	let status: string;
	if (readUpdateConfig(configDir).disabled) {
		status =
			`skipped -- autoUpdate is disabled in ${join(configDir, 'config.yml')}. ` +
			'Run `task cli update` to update anyway, or set `autoUpdate: true` in that file.';
	} else if (state && state.timestamp >= startedAt) {
		// This run wrote a terminal state -- it is authoritative over any older state file left
		// over from a previous run.
		switch (state.status) {
			case 'success':
				status = `updated to ${state.targetVersion}`;
				break;
			case 'deferred': {
				const retryInMinutes = Math.round(((state.retryAt ?? state.timestamp) - state.timestamp) / 60_000);
				status = `deferred -- a flow execution is active on the daemon; will retry automatically in ${retryInMinutes} minute${retryInMinutes === 1 ? '' : 's'}`;
				break;
			}
			case 'failed':
				status = `update failed -- ${state.error}`;
				break;
			case 'rolled-back':
				status = `update rolled back to ${state.previousVersion} -- new version failed its self-check`;
				break;
			default:
				// 'update-available' exists on UpdateState but is only written by the
				// 'with-daemon' strategy -- this entry point always uses 'without-daemon'.
				throw new Error(`[task-updater] unrecognized state status: ${state.status}`);
		}
	} else if (cache && cache.lastCheckedAt >= startedAt) {
		// Cache was refreshed this run but no state was written: the only code path that does
		// that is "latest version is not newer than current".
		status = 'up to date';
	} else {
		const fetchFailed = logEntries.find(e => e.msg.includes('version fetch failed'));
		const alreadyRunning = logEntries.find(e => e.msg.includes('already running'));
		if (fetchFailed) {
			status = `update check failed -- ${fetchFailed.msg}`;
		} else if (alreadyRunning) {
			status = 'skipped -- another update check is already running';
		} else {
			status =
				`unknown -- no cache or state file found at ${cacheFilePath(configDir)} or ${stateFilePath(configDir)}, ` +
				'and no matching log entry for this run';
		}
	}

	process.stdout.write(`[task-updater] current: ${currentVersion}\n`);
	process.stdout.write(`[task-updater] latest:  ${latest}\n`);
	process.stdout.write(`[task-updater] status:  ${status}\n`);
}

const logPathBeforeRun = updaterLogPath();
const logSizeBeforeRun = logSize(logPathBeforeRun);
const startedAt = Date.now();

runUpdater({
	pkgName: PKG_NAME,
	configDir,
	currentVersion,
	strategy: 'without-daemon',
	onUpdateAvailable: async (_newVersion: string) => 'apply-now' as const,
})
	.then(() => {
		if (!force) return;
		reportOutcome(startedAt, echoUpdaterLog(logPathBeforeRun, logSizeBeforeRun));
	})
	.catch(err => {
		// Surface whatever the updater managed to log before failing, then the failure itself.
		if (force) reportOutcome(startedAt, echoUpdaterLog(logPathBeforeRun, logSizeBeforeRun));
		process.stderr.write(`[task-updater] fatal: ${err}\n`);
		process.exit(1);
	});
