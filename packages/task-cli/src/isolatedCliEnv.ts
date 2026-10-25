// Test helper (never imported by shipped code): the ONE way a test spawns the task CLI or updater bundle. It builds an
// environment in which the child cannot reach the real machine state (config dir, user npmrc, global npm prefix, real
// registry), and spawnIsolated() refuses to spawn with any other environment.
//
// Incident 2026-10-24/25: a repo-built bundle ran `cli update` against the REAL config dir and the REAL global npm;
// the `npm install -g` was killed halfway and the global CLI vanished.
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** Nothing listens on the discard port: any npm network access fails fast instead of installing. */
export const UNREACHABLE_REGISTRY = 'http://127.0.0.1:9/';

/** Env variable that pins the @wadeck-app scope: only an env variable outranks a project-level .npmrc. */
export const SCOPED_REGISTRY_VAR = 'npm_config_@wadeck-app:registry';

// Variables that steer the updater, the launcher, npm or the home lookup: a leaked one from the parent shell (npm sets
// lowercase npm_config_* under `npm run`; Windows env names are case-insensitive, JS keys are not) must not change a
// test, and the real values must never reach the child.
const STRIPPED =
	/^(UPDATER_|LAUNCHER_|CLI_SELF_CHECK|NPM_CONFIG_|TASK_CONFIG_DIR$|XDG_CONFIG_HOME$|HOME$|USERPROFILE$|APPDATA$|LOCALAPPDATA$)/i;

export interface IsolatedCliEnv {
	/** Root of the throwaway tree (home, config, npm prefix, npm cache). Also the cwd of spawned children. */
	root: string;
	/** What both the updater (TASK_CONFIG_DIR) and ConfigDir.get('task') (XDG_CONFIG_HOME) resolve to. */
	configDir: string;
	npmPrefix: string;
	/** Full env for spawn(): parent env minus the steering variables, plus the isolation overrides and `extra`. */
	env: NodeJS.ProcessEnv;
	/** Removes the whole tree. Call from afterEach / afterAll. */
	cleanup(): void;
}

/**
 * @param opts.registry registry for npm (default: unreachable). Only a loopback address is accepted by assertIsolatedEnv.
 * @param opts.extra    env entries applied last (e.g. UPDATER_FORCE).
 */
export function createIsolatedCliEnv(opts: { registry?: string; extra?: NodeJS.ProcessEnv } = {}): IsolatedCliEnv {
	const registry = opts.registry ?? UNREACHABLE_REGISTRY;
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-cli-iso-'));
	const home = path.join(root, 'home');
	const xdg = path.join(home, '.config');
	const configDir = path.join(xdg, 'task');
	const npmPrefix = path.join(root, 'npm-prefix');
	const npmCache = path.join(root, 'npm-cache');
	const roaming = path.join(home, 'AppData', 'Roaming');
	const local = path.join(home, 'AppData', 'Local');
	for (const dir of [configDir, npmPrefix, npmCache, roaming, local]) fs.mkdirSync(dir, { recursive: true });

	// Own npm config for the user AND the global level (npm refuses one file for both), so the developer's real npmrc
	// (registry, auth token) is never read.
	const npmConfig = [
		`registry=${registry}`,
		`@wadeck-app:registry=${registry}`,
		'fetch-retries=0',
		'fetch-timeout=3000',
		'audit=false',
		'fund=false',
		'update-notifier=false',
		'',
	].join('\n');
	const userConfig = path.join(root, 'npm-user.ini');
	const globalConfig = path.join(root, 'npm-global.ini');
	fs.writeFileSync(userConfig, npmConfig);
	fs.writeFileSync(globalConfig, npmConfig);

	const env: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(process.env)) if (!STRIPPED.test(key)) env[key] = value;
	Object.assign(
		env,
		{
			TASK_CONFIG_DIR: configDir,
			XDG_CONFIG_HOME: xdg,
			HOME: home,
			USERPROFILE: home,
			APPDATA: roaming,
			LOCALAPPDATA: local,
			NPM_CONFIG_PREFIX: npmPrefix,
			NPM_CONFIG_CACHE: npmCache,
			NPM_CONFIG_USERCONFIG: userConfig,
			NPM_CONFIG_GLOBALCONFIG: globalConfig,
			NPM_CONFIG_REGISTRY: registry,
			// A project-level .npmrc naming the @wadeck-app registry outranks the userconfig file above.
			[SCOPED_REGISTRY_VAR]: registry,
			// The queue SDK sends nothing.
			QUEUE_SDK_OFF: '1',
		},
		opts.extra
	);

	return {
		root,
		configDir,
		npmPrefix,
		env,
		cleanup: () => removeTree(root),
	};
}

/**
 * Removes a throwaway tree, retrying EPERM / EBUSY / ENOTEMPTY for up to `timeoutMs`, then throws the last error.
 * Windows can keep a directory locked for a moment after a child that had it as cwd is gone; Node 24's rmSync ignores
 * its maxRetries option on Windows (measured: no retry, error returned at once), hence the explicit loop.
 */
export function removeTree(dir: string, timeoutMs = 5_000): void {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		try {
			fs.rmSync(dir, { recursive: true, force: true });
			return;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (!['EPERM', 'EBUSY', 'ENOTEMPTY'].includes(code ?? '') || Date.now() > deadline) throw error;
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
		}
	}
}

/**
 * Waits until process `pid` is gone. A detached child spawned by a CLI under test inherits the cwd (the throwaway
 * root); on Windows a live process holding its cwd makes the removal of that tree fail with EPERM, so a test that
 * lets a child outlive the CLI must call this before cleanup(). Throws (never gives up silently) after `timeoutMs`.
 */
export async function waitForProcessExit(pid: number, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		try {
			// Signal 0 only probes: ESRCH = gone, EPERM = alive but not ours.
			process.kill(pid, 0);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
		}
		if (Date.now() > deadline) {
			throw new Error(
				`process ${pid} still running after ${timeoutMs} ms: it may hold the test's temp dir as its cwd`
			);
		}
		await new Promise(resolve => setTimeout(resolve, 50));
	}
}

function isUnderTmp(value: string): boolean {
	const roots = [os.tmpdir(), fs.realpathSync(os.tmpdir())].map(r => path.resolve(r));
	const resolved = path.resolve(value);
	return roots.some(root => {
		const rel = path.relative(root, resolved);
		return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
	});
}

const LOOPBACK = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])[:/]/;

/**
 * Throws, naming every offending variable, unless `env` cannot reach the real config dir, the real global npm or a
 * real registry. Called by spawnIsolated() before every spawn.
 */
export function assertIsolatedEnv(env: NodeJS.ProcessEnv): void {
	const problems: string[] = [];
	for (const key of Object.keys(env)) {
		if (/^npm_config_/i.test(key) && !/^NPM_CONFIG_/.test(key) && key !== SCOPED_REGISTRY_VAR) {
			problems.push(`${key} is a lowercase npm variant that can override the isolated NPM_CONFIG_*`);
		}
	}
	for (const key of [
		'TASK_CONFIG_DIR',
		'XDG_CONFIG_HOME',
		'HOME',
		'USERPROFILE',
		'NPM_CONFIG_PREFIX',
		'NPM_CONFIG_USERCONFIG',
		'NPM_CONFIG_GLOBALCONFIG',
	]) {
		const value = env[key];
		if (value === undefined || value === '') problems.push(`${key} is not set`);
		else if (!isUnderTmp(value)) problems.push(`${key}=${value} is outside the temp dir (${os.tmpdir()})`);
	}
	for (const key of ['NPM_CONFIG_REGISTRY', SCOPED_REGISTRY_VAR]) {
		const value = env[key];
		if (value === undefined || value === '') problems.push(`${key} is not set`);
		else if (!LOOPBACK.test(value)) problems.push(`${key}=${value} is not a loopback address`);
	}
	if (problems.length > 0) {
		throw new Error(
			`Refusing to spawn a CLI with a non-isolated environment (it could touch the real global npm or config):\n- ${problems.join('\n- ')}\n` +
				'Build the env with createIsolatedCliEnv() and spawn through spawnIsolated().'
		);
	}
}

/**
 * spawnSync of a node script inside the isolated tree (env AND cwd: a project-level .npmrc next to the repo is never
 * read). Throws first if the env is not isolated.
 */
export function spawnIsolated(
	script: string,
	args: string[],
	iso: IsolatedCliEnv,
	opts: { timeout?: number } = {}
): SpawnSyncReturns<string> {
	assertIsolatedEnv(iso.env);
	return spawnSync(process.execPath, [script, ...args], {
		env: iso.env,
		cwd: iso.root,
		timeout: opts.timeout ?? 30_000,
		encoding: 'utf-8',
	});
}
