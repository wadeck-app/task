// task cli <subcommand> -- meta-commands for managing the task CLI itself.
import { ConfigDir, HookDispatcher } from '@wadeck-app/shared-cli';
import { cliLogsCommand, cliRollbackCommand, cliUpdateCommand, cliVersionCommand, warnUnknownArgs } from '@wadeck-app/shared-cli/CliMetaCommands';
import { readChannelFromConfig } from '@wadeck-app/shared-cli/ChannelConfig';
import * as yaml from 'js-yaml';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { TaskConfigLoader } from '../../task/TaskConfigLoader.js';
import { TaskStore } from '../../task/TaskStore.js';

// Injected by esbuild at bundle time via define; falls back to package.json in dev mode (tsx).
declare const __TASK_CLI_VERSION__: string;

const PKG_NAME = '@wadeck-app/task-cli';

// Migrate legacy config dir on first load (runs once when this module is imported).
ConfigDir.migrateIfNeeded('task');

export function getCurrentTaskVersion(): string {
	try {
		return __TASK_CLI_VERSION__;
	} catch {
		const require = createRequire(import.meta.url);
		return (require('../../../package.json') as { version: string }).version;
	}
}

function getUpdaterPath(): string | null {
	const bundlePath = process.env['LAUNCHER_BUNDLE_OVERRIDE'] ?? fileURLToPath(import.meta.url);
	const dir = path.dirname(bundlePath);
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
	const channel = readChannelFromConfig(ConfigDir.get('task'));
	await cliVersionCommand(PKG_NAME, current, channel);
}

export async function runTaskCliUpdate(opts: { check?: boolean; log?: boolean; rawArgs?: string[] }): Promise<void> {
	warnUnknownArgs(
		(opts.rawArgs ?? []).filter(a => a.startsWith('-')),
		['--check', '--log'],
		'task cli update',
	);
	if (opts.log) {
		const logFile = path.join(ConfigDir.get('task'), 'update-log.txt');
		if (fs.existsSync(logFile)) {
			process.stdout.write(fs.readFileSync(logFile, 'utf-8'));
		} else {
			process.stdout.write('No update log found.\n');
		}
		return;
	}
	if (opts.check) {
		const current = getCurrentTaskVersion();
		const channel = readChannelFromConfig(ConfigDir.get('task'));
		await cliVersionCommand(PKG_NAME, current, channel);
		return;
	}
	const updaterPath = getUpdaterPath();
	if (!updaterPath) {
		process.stderr.write('Updater bundle not found (dev mode or missing build).\n');
		process.exit(1);
		return;
	}
	await cliUpdateCommand(updaterPath, PKG_NAME);
}

export async function runTaskCliRollback(): Promise<void> {
	await cliRollbackCommand(PKG_NAME, ConfigDir.get('task'));
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
			'  logs [--follow]      Print today\'s log from ~/.config/task/logs/',
		].join('\n') + '\n'
	);
}

export async function runTaskCliLogs(opts: { follow?: boolean }): Promise<void> {
	await cliLogsCommand(ConfigDir.get('task'), { follow: opts.follow ?? false });
}

export class TaskCliCommand {
	static getCurrentVersion = getCurrentTaskVersion;
	static runVersion = runTaskCliVersion;
	static runUpdate = runTaskCliUpdate;
	static runRollback = runTaskCliRollback;
	static runSelfCheck = runTaskCliSelfCheck;
	static runLogs = runTaskCliLogs;
	static printHelp = printTaskCliHelp;
}
