// task-updater entry point -- bundled separately as task-updater.cjs.
// Must NOT import any task runtime modules.
import { ConfigDir } from '@wadeck-app/shared-cli/ConfigDir';
import { execNpm, readUpdateConfig, runUpdater } from '@wadeck-app/shared-updater';
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

/**
 * Echo every log entry appended during this run. Returns the number of entries echoed so the
 * caller can report an explicit reason when the updater produced nothing at all.
 */
function echoUpdaterLog(startPath: string, startSize: number): number {
	const endPath = updaterLogPath();
	// A run straddling midnight rolls over to a new file, which must be read from the start.
	const offset = endPath === startPath ? startSize : 0;
	if (!existsSync(endPath)) return 0;
	const appended = readFileSync(endPath, 'utf8').slice(offset);
	let count = 0;
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
		count += 1;
	}
	return count;
}

/**
 * Explains the one outcome shared-updater exits on without logging anything: autoUpdate is
 * disabled in config.yml and UPDATER_MANUAL was not set to bypass it.
 */
function reportSilentOutcome(): void {
	if (readUpdateConfig(configDir).disabled) {
		process.stderr.write(
			`[task-updater] Update skipped: autoUpdate is disabled in ${join(configDir, 'config.yml')}.\n` +
				`[task-updater] Run \`task cli update\` to update anyway, or set \`autoUpdate: true\` in that file.\n`
		);
		return;
	}
	process.stderr.write(
		`[task-updater] Update check produced no result and no log entry. This is unexpected.\n` +
			`[task-updater] Inspect ${updaterLogPath()} and report it.\n`
	);
}

const logPathBeforeRun = updaterLogPath();
const logSizeBeforeRun = logSize(logPathBeforeRun);

runUpdater({
	pkgName: PKG_NAME,
	configDir,
	currentVersion,
	strategy: 'without-daemon',
	onUpdateAvailable: async (_newVersion: string) => 'apply-now' as const,
})
	.then(() => {
		if (!force) return;
		if (echoUpdaterLog(logPathBeforeRun, logSizeBeforeRun) === 0) reportSilentOutcome();
	})
	.catch(err => {
		// Surface whatever the updater managed to log before failing, then the failure itself.
		if (force) echoUpdaterLog(logPathBeforeRun, logSizeBeforeRun);
		process.stderr.write(`[task-updater] fatal: ${err}\n`);
		process.exit(1);
	});
