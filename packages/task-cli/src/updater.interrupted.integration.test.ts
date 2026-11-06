// An `npm install -g` killed halfway, end to end: real bundles (task.cjs, task-updater.cjs), the real npm of this node, a
// fake registry (fakeNpmRegistry.ts) whose tarball hangs, everything inside the throwaway tree of createIsolatedCliEnv
// (own npm prefix, config dir, HOME, loopback registry, APP_CORE_PORT on a closed port). Nothing here can reach the real
// global npm, config dir, registry or app-core.
//
// Measured on Windows (node 24, npm 11) while writing this: killing the updater with process.kill() (TerminateProcess, no
// handler runs) also ends the npm it started, so the "orphan npm still running" branch of shared-updater's repair is NOT
// exercised here. What IS exercised is the state the kill leaves: the old package moved aside (`.task-cli-XXXX`) and the
// real one missing (no-body) or truncated (half-body).
import { build } from 'esbuild';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { type FakeNpmRegistry, startFakeNpmRegistry, type TarballHang } from './fakeNpmRegistry.js';
import {
	createIsolatedCliEnv,
	type IsolatedCliEnv,
	type IsolatedRunResult,
	runIsolated,
	startIsolated,
} from './isolatedCliEnv.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, '..');
const PKG = '@wadeck-app/task-cli';
// Unpadded like what npm publishes for the CalVer scheme (a leading zero is not valid semver).
const OLD = '2026.10.1-001-aaaaaaaa';
const NEW = '2026.11.1-002-bbbbbbbb';
const NPM_CLI = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
const INTERRUPTED = 'was interrupted: the installer process is gone';

let bundleDir: string;
// task.cjs alone: with a task-updater.cjs next to it every command would start a background updater.
let cliAloneDir: string;
let updaterDir: string;
// task.cjs and task-updater.cjs together, like the real install.
let installDir: string;

async function bundle(entry: string, outfile: string, version: string): Promise<void> {
	await build({
		entryPoints: [path.join(packageRoot, 'src', entry)],
		bundle: true,
		platform: 'node',
		target: 'node22',
		format: 'cjs',
		outfile,
		external: [],
		supported: { 'top-level-await': false },
		define: { 'import.meta.url': '__importMetaUrl', __TASK_CLI_VERSION__: JSON.stringify(version) },
		banner: { js: `const __importMetaUrl = require('node:url').pathToFileURL(__filename).href;` },
		logLevel: 'warning',
	});
}

beforeAll(async () => {
	bundleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-interrupted-bundle-'));
	cliAloneDir = path.join(bundleDir, 'cli');
	updaterDir = path.join(bundleDir, 'updater');
	installDir = path.join(bundleDir, 'install');
	await Promise.all([
		bundle('TaskIndex.ts', path.join(cliAloneDir, 'task.cjs'), OLD),
		bundle('task-updater-entry.ts', path.join(updaterDir, 'task-updater.cjs'), OLD),
	]);
	fs.mkdirSync(installDir);
	fs.copyFileSync(path.join(cliAloneDir, 'task.cjs'), path.join(installDir, 'task.cjs'));
	fs.copyFileSync(path.join(updaterDir, 'task-updater.cjs'), path.join(installDir, 'task-updater.cjs'));
}, 120000);

afterAll(() => {
	fs.rmSync(bundleDir, { recursive: true, force: true });
});

let iso: IsolatedCliEnv | undefined;
let registry: FakeNpmRegistry | undefined;
afterEach(async () => {
	await registry?.close();
	registry = undefined;
	iso?.cleanup();
	iso = undefined;
});

function fakeCli(version: string): Record<string, string> {
	return { 'task.cjs': `process.stdout.write('fake task ${version}\\n');` };
}

interface Journal {
	status: string;
	pid: number;
	npmPid?: number;
	error?: string;
}
function readJournal(configDir: string): Journal | undefined {
	try {
		return JSON.parse(fs.readFileSync(path.join(configDir, 'update-state.json'), 'utf8')) as Journal;
	} catch {
		return undefined;
	}
}

function logText(configDir: string): string {
	const dir = path.join(configDir, 'logs');
	if (!fs.existsSync(dir)) return '(no logs dir)';
	return fs
		.readdirSync(dir)
		.map(f => fs.readFileSync(path.join(dir, f), 'utf8'))
		.join('\n');
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === 'EPERM';
	}
}

async function waitFor(what: string, condition: () => boolean, timeoutMs = 30000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error(`timeout (${timeoutMs} ms) waiting for ${what}`);
		await new Promise(resolve => setTimeout(resolve, 100));
	}
}

function globalPackageDir(e: IsolatedCliEnv): string {
	return path.join(e.npmPrefix, 'node_modules', ...PKG.split('/'));
}

/** Names npm moves a package aside to while it replaces it (`.task-cli-XXXXXXXX`). */
function retiredDirs(e: IsolatedCliEnv): string[] {
	const scope = path.dirname(globalPackageDir(e));
	return fs.existsSync(scope) ? fs.readdirSync(scope).filter(n => n.startsWith('.task-cli-')) : [];
}

function installedVersion(e: IsolatedCliEnv): string | undefined {
	try {
		return (
			JSON.parse(fs.readFileSync(path.join(globalPackageDir(e), 'package.json'), 'utf8')) as { version: string }
		).version;
	} catch {
		return undefined;
	}
}

function explicitUpdateEnv(e: IsolatedCliEnv): IsolatedCliEnv {
	return { ...e, env: { ...e.env, UPDATER_FORCE: '1', UPDATER_MANUAL: '1' } };
}

const out = (r: IsolatedRunResult): string => `${r.stdout}${r.stderr}`;

/** OLD installed globally, NEW published as latest with a tarball that hangs; the updater is inside `npm install -g`. */
async function startUpdateStuckInNpm(mode: TarballHang) {
	registry = await startFakeNpmRegistry();
	registry.publish(PKG, OLD, fakeCli(OLD));
	registry.setLatest(PKG, OLD);
	iso = createIsolatedCliEnv({ registry: registry.url, extra: { APP_CORE_PORT: '9' } });
	const first = await runIsolated(NPM_CLI, ['install', '-g', `${PKG}@${OLD}`], iso);
	expect(first.status, out(first)).toBe(0);
	expect(installedVersion(iso)).toBe(OLD);

	registry.publish(PKG, NEW, fakeCli(NEW));
	registry.setLatest(PKG, NEW);
	registry.hangTarball(PKG, NEW, mode);
	const updater = startIsolated(path.join(updaterDir, 'task-updater.cjs'), [], iso, { timeout: 120000 });
	await registry.tarballRequested(PKG, NEW);
	const configDir = iso.configDir;
	await waitFor('the npm pid in update-state.json', () => readJournal(configDir)?.npmPid !== undefined);
	// npm moves the old package aside before it fetches the new one: wait for the move.
	await waitFor('npm to move the old package aside', () => retiredDirs(iso!).length > 0);
	return { updater, e: iso, reg: registry };
}

describe('npm install -g killed halfway (real npm, fake registry, isolated tree)', () => {
	describe.each(['no-body', 'half-body'] as const)('updater killed hard during the install (tarball: %s)', mode => {
		it('leaves a broken global package and an applying journal; version/rollback say so once; the next updater run repairs', async () => {
			const { updater, e } = await startUpdateStuckInNpm(mode);
			const before = readJournal(e.configDir)!;
			expect(before.status).toBe('applying');

			// No handler runs: nothing can clean up.
			process.kill(updater.pid);
			await updater.done;
			expect(isAlive(updater.pid)).toBe(false);

			// Half-installed prefix: the old package is aside, the real one is missing or truncated.
			expect(retiredDirs(e)).toHaveLength(1);
			expect(installedVersion(e), 'the global package must not be intact after the kill').toBeUndefined();
			// The journal is exactly what the dead updater wrote.
			expect(readJournal(e.configDir)).toEqual(before);

			// `task cli version`: the interruption is reported, once, with the way out.
			const version = await runIsolated(path.join(cliAloneDir, 'task.cjs'), ['cli', 'version'], e);
			expect(version.status, out(version)).toBe(0);
			expect(version.stderr.split(INTERRUPTED).length - 1, version.stderr).toBe(1);
			expect(version.stderr).toContain('task cli update');

			// `task cli rollback` refuses and points to the repair, in readable sentences.
			const rollback = await runIsolated(path.join(cliAloneDir, 'task.cjs'), ['cli', 'rollback'], e);
			expect(rollback.status, out(rollback)).toBe(1);
			expect(rollback.stderr).toContain('Rollback refused');
			expect(rollback.stderr).toContain('task cli update');
			expect(rollback.stderr, 'two sentences glued together').not.toMatch(/task cli update Run:/);
			expect(rollback.stderr.split(INTERRUPTED).length - 1, rollback.stderr).toBe(1);
			// Refusing changed nothing.
			expect(readJournal(e.configDir)).toEqual(before);
			expect(installedVersion(e)).toBeUndefined();

			// Repair, as `task cli update` runs it. The registry still has NEW as latest and no longer hangs.
			registry!.hangTarball(PKG, NEW, undefined);
			const repair = await runIsolated(path.join(updaterDir, 'task-updater.cjs'), [], explicitUpdateEnv(e), {
				timeout: 120000,
			});
			expect(repair.status, out(repair)).toBe(0);
			expect(installedVersion(e)).toBe(OLD);
			expect(retiredDirs(e)).toEqual([]);
			const after = readJournal(e.configDir)!;
			expect(after.status).toBe('rolled-back');
			expect(after.error).toContain('interrupted install repaired');
			const log = logText(e.configDir);
			expect(log).toContain('was interrupted (updater pid');
			expect(log).toContain(`repaired: ${OLD} is installed again`);
			// The user ran the update explicitly: the outcome is printed, and it is not the self-check story.
			expect(repair.stdout).toContain('[task-updater] status:');
			expect(repair.stdout, 'a repaired interruption is not a failed self-check').not.toContain('self-check');
			expect(repair.stdout).toContain('interrupted install repaired');
			// Every echoed log entry is a readable message: the log holds a multi-byte arrow ("a → b") from the first run, and
			// a byte offset applied to a decoded string once cut the first echoed line into `ts":"...","level":...`.
			expect(repair.stdout, 'a raw NDJSON fragment was echoed').not.toContain('"level":');
		}, 240000);

		it('any task command starts a background updater that repairs it by itself', async () => {
			const { updater, e, reg } = await startUpdateStuckInNpm(mode);
			process.kill(updater.pid);
			await updater.done;
			reg.hangTarball(PKG, NEW, undefined);
			expect(installedVersion(e)).toBeUndefined();

			// task-updater.cjs sits next to task.cjs: `task cli version` schedules it, detached.
			const version = await runIsolated(path.join(installDir, 'task.cjs'), ['cli', 'version'], e);
			expect(version.status, out(version)).toBe(0);

			await waitFor(
				'the background updater to repair the install',
				() => readJournal(e.configDir)?.status !== 'applying'
			);
			// The journal is final before the updater exits: wait for it to release its lock (and so its cwd).
			await waitFor('the background updater to end', () => !fs.existsSync(path.join(e.configDir, 'update.lock')));
			expect(installedVersion(e)).toBe(OLD);
			expect(readJournal(e.configDir)?.status).toBe('rolled-back');
			expect(retiredDirs(e)).toEqual([]);
		}, 240000);
	});

	it('only npm killed (the updater survives): it restores the previous version and records the failure', async () => {
		const { updater, e } = await startUpdateStuckInNpm('half-body');
		const npmPid = readJournal(e.configDir)!.npmPid!;
		process.kill(npmPid);
		const result = await updater.done;
		expect(result.status, out(result)).toBe(0);

		expect(installedVersion(e)).toBe(OLD);
		expect(retiredDirs(e)).toEqual([]);
		const journal = readJournal(e.configDir)!;
		expect(journal.status).toBe('failed');
		expect(journal.error).toContain(`install of ${NEW} failed`);
		expect(journal.npmPid).toBeUndefined();
		expect(logText(e.configDir)).toContain(`${OLD} is installed again`);
	}, 240000);
});
