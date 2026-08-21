// task cli <subcommand> -- meta-commands for managing the task CLI itself.
import * as yaml from 'js-yaml';
import { execFile, execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { ConfigDir, HookDispatcher, VersionValidation } from 'shared-cli/index';
import { TaskConfigLoader } from '../../task/TaskConfigLoader.js';
import { TaskStore } from '../../task/TaskStore.js';

// Injected by esbuild at bundle time via define; falls back to package.json in dev mode (tsx).
declare const __TASK_CLI_VERSION__: string;

const execFileAsync = promisify(execFile);
const PKG_NAME = '@wadeck/task-cli';

function readChannelFromConfig(): string {
	try {
		const configFile = path.join(ConfigDir.get(), 'config.yml');
		if (!fs.existsSync(configFile)) return 'edge';
		const raw = fs.readFileSync(configFile, 'utf-8');
		const match = /^\s*channel:\s*['"]?(\S+?)['"]?\s*$/m.exec(raw);
		return match?.[1] ?? 'edge';
	} catch {
		return 'edge';
	}
}

export function getCurrentTaskVersion(): string {
	try {
		return __TASK_CLI_VERSION__;
	} catch {
		const require = createRequire(import.meta.url);
		return (require('../../../package.json') as { version: string }).version;
	}
}

async function fetchLatestVersion(channel: string): Promise<string> {
	const { stdout } = await execFileAsync('npm', ['view', PKG_NAME, `dist-tags.${channel}`], { timeout: 15000 });
	return stdout.trim();
}

function getUpdaterPath(): string | null {
	const bundlePath = process.env['LAUNCHER_BUNDLE_OVERRIDE'] ?? fileURLToPath(import.meta.url);
	const dir = path.dirname(bundlePath);
	// Prefer task-updater.cjs; fall back to flow-updater.cjs (shared bundle via UPDATER_PKG_NAME).
	const candidates = [path.join(dir, 'task-updater.cjs'), path.join(dir, 'flow-updater.cjs')];
	for (const candidate of candidates) {
		if (fs.existsSync(candidate)) return candidate;
	}
	return null;
}

// ---- Self-check ----

interface CheckResult {
	name: string;
	passed: boolean;
	error?: string;
}

async function runSelfChecks(): Promise<CheckResult[]> {
	const results: CheckResult[] = [];

	// Check 1: Bundle integrity -- verify TaskStore is accessible (task CLI core module)
	{
		const name = 'Bundle integrity';
		try {
			if (typeof TaskStore !== 'function') {
				throw new Error('TaskStore is not a constructor');
			}
			results.push({ name, passed: true });
		} catch (err) {
			results.push({ name, passed: false, error: String(err) });
		}
	}

	// Check 2: Config loading -- load task config from a temp directory (no config file present, falls back to defaults)
	{
		const name = 'Config loading';
		try {
			const config = TaskConfigLoader.load({ configDir: os.tmpdir(), projectDir: os.tmpdir() });
			if (!Array.isArray(config.statuses) || config.statuses.length === 0) {
				throw new Error('statuses default is missing or empty');
			}
			results.push({ name, passed: true });
		} catch (err) {
			results.push({ name, passed: false, error: String(err) });
		}
	}

	// Check 3: YAML flow parsing -- parse a minimal inline YAML definition string
	{
		const name = 'YAML parsing';
		try {
			const input = ['id: self-check-test', 'steps:', '  - id: step1'].join('\n');
			const parsed = yaml.load(input) as { id?: string; steps?: unknown[] };
			if (parsed?.id !== 'self-check-test') {
				throw new Error(`Expected id 'self-check-test', got '${String(parsed?.id)}'`);
			}
			results.push({ name, passed: true });
		} catch (err) {
			results.push({ name, passed: false, error: String(err) });
		}
	}

	// Check 4: TaskStore (temp dir) -- create, read, and delete a task in an isolated temp directory
	{
		const name = 'TaskStore (temp)';
		let tmpDir: string | undefined;
		try {
			tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-self-check-'));
			const store = new TaskStore(tmpDir);
			const task = store.create('test task');
			const found = store.findByPrefix(task.id.slice(0, 4));
			if (found.id !== task.id) {
				throw new Error(`findByPrefix returned wrong task: expected ${task.id}, got ${found.id}`);
			}
			results.push({ name, passed: true });
		} catch (err) {
			results.push({ name, passed: false, error: String(err) });
		} finally {
			if (tmpDir !== undefined) {
				try {
					fs.rmSync(tmpDir, { recursive: true, force: true });
				} catch {
					// ignore cleanup errors
				}
			}
		}
	}

	// Check 5: HookDispatcher -- instantiate with empty config and dispatch a no-op event
	{
		const name = 'HookDispatcher';
		try {
			const dispatcher = new HookDispatcher({});
			await dispatcher.dispatch('onTaskCreated', { taskId: 'test' }, () => {});
			results.push({ name, passed: true });
		} catch (err) {
			results.push({ name, passed: false, error: String(err) });
		}
	}

	// Check 6: Task config schema -- verify default statuses and priority are present
	{
		const name = 'Task config schema';
		try {
			const config = TaskConfigLoader.load({ configDir: os.tmpdir(), projectDir: os.tmpdir() });
			if (typeof config.defaults.priority !== 'string' || config.defaults.priority.length === 0) {
				throw new Error(`defaults.priority is not a non-empty string: ${config.defaults.priority}`);
			}
			if (!Array.isArray(config.statuses) || config.statuses.length === 0) {
				throw new Error(`statuses default is missing or empty`);
			}
			results.push({ name, passed: true });
		} catch (err) {
			results.push({ name, passed: false, error: String(err) });
		}
	}

	return results;
}

function printSelfCheckResults(results: CheckResult[], quiet: boolean, version: string): void {
	if (!quiet) {
		for (const result of results) {
			if (result.passed) {
				process.stdout.write(`[ok] ${result.name}\n`);
			} else {
				process.stdout.write(
					`[FAIL] ${result.name}${result.error !== undefined ? ` -- ${result.error}` : ''}\n`
				);
			}
		}
	}
	const failedCount = results.filter(r => !r.passed).length;
	if (failedCount === 0) {
		if (!quiet) {
			process.stdout.write(`All checks passed. task v${version}\n`);
		}
	} else {
		if (!quiet) {
			process.stdout.write(
				`Self-check failed (${failedCount}/${results.length} checks failed). Run: task cli update --log\n`
			);
		}
		process.exit(1);
	}
}

// ---- Exported functions (called by TaskIndex.ts switch/case routing) ----

export async function runTaskCliVersion(): Promise<void> {
	const current = getCurrentTaskVersion();
	const channel = readChannelFromConfig();
	process.stdout.write(`task v${current} (installed)\n`);
	try {
		const latest = await fetchLatestVersion(channel);
		process.stdout.write(`Latest (${channel}): v${latest}\n`);
		if (current === latest) {
			process.stdout.write('Up to date.\n');
		}
	} catch (err) {
		process.stderr.write(`Could not fetch latest version: ${String(err)}\n`);
	}
}

export async function runTaskCliUpdate(opts: { check?: boolean; log?: boolean }): Promise<void> {
	if (opts.log) {
		const logFile = path.join(ConfigDir.get(), 'update-log.txt');
		if (fs.existsSync(logFile)) {
			process.stdout.write(fs.readFileSync(logFile, 'utf-8'));
		} else {
			process.stdout.write('No update log found.\n');
		}
		return;
	}
	if (opts.check) {
		const channel = readChannelFromConfig();
		try {
			const latest = await fetchLatestVersion(channel);
			process.stdout.write(`Available (${channel}): v${latest}\n`);
		} catch (err) {
			process.stderr.write(`Could not check for updates: ${String(err)}\n`);
			process.exit(1);
		}
		return;
	}
	// Default: run the updater synchronously with UPDATER_FORCE=1 to bypass the cache check
	const updaterPath = getUpdaterPath();
	if (!updaterPath) {
		process.stderr.write('Updater bundle not found (dev mode or missing build).\n');
		process.exit(1);
		return;
	}
	execFileSync(process.execPath, [updaterPath], {
		stdio: 'inherit',
		env: { ...process.env, UPDATER_FORCE: '1', UPDATER_PKG_NAME: PKG_NAME },
	});
}

export function runTaskCliRollback(): void {
	const configDir = ConfigDir.get();
	const stateFile = path.join(configDir, 'update-state.json');
	if (!fs.existsSync(stateFile)) {
		process.stderr.write('No update state found. Nothing to roll back.\n');
		process.exit(1);
		return;
	}
	let previousVersion: string | undefined;
	try {
		const state = JSON.parse(fs.readFileSync(stateFile, 'utf-8')) as { previousVersion?: string };
		previousVersion = state.previousVersion;
	} catch (err) {
		process.stderr.write(`Failed to read update state: ${String(err)}\n`);
		process.exit(1);
		return;
	}
	if (previousVersion === undefined || !VersionValidation.VERSION_RE.test(previousVersion)) {
		process.stderr.write('Invalid or missing previousVersion in update state.\n');
		process.exit(1);
		return;
	}
	execFileSync('npm', ['install', '-g', `${PKG_NAME}@${previousVersion}`], { stdio: 'inherit' });
	process.stdout.write(`Rolled back to v${previousVersion}\n`);
	try {
		fs.unlinkSync(stateFile);
	} catch {
		// ignore
	}
}

export async function runTaskCliSelfCheck(): Promise<void> {
	const quiet = process.env['CLI_SELF_CHECK_QUIET'] === '1';
	const version = getCurrentTaskVersion();
	const results = await runSelfChecks();
	printSelfCheckResults(results, quiet, version);
}

export function printTaskCliHelp(): void {
	process.stdout.write(
		[
			'Usage: task cli <subcommand>',
			'',
			'Subcommands:',
			'  version              Show installed and available version',
			'  update               Force synchronous update (bypass cache)',
			'  update --check       Show available version, do not apply',
			'  update --log         Print the update log',
			'  rollback             Restore the previously installed version',
			'  self-check           Run health checks to verify the CLI bundle is functional',
		].join('\n') + '\n'
	);
}

export class TaskCliCommand {
	static getCurrentVersion = getCurrentTaskVersion;
	static runVersion = runTaskCliVersion;
	static runUpdate = runTaskCliUpdate;
	static runRollback = runTaskCliRollback;
	static runSelfCheck = runTaskCliSelfCheck;
	static printHelp = printTaskCliHelp;
}
