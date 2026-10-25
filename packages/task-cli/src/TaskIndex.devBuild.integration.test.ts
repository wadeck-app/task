// Dev build guard, end to end on real bundles: a repo-built bundle (version not CalVer, e.g. 0.0.0-local) must never
// touch the global install, neither through `task cli update` nor through the updater scheduled after commands.
//
// The bundles are built into a temp dir with esbuild (same entry points and defines as ci/scripts/bundle.ts, minus the
// app-module) so this file never races the other integration test on dist-bundle/. The processes run inside the
// throwaway tree of createIsolatedCliEnv: unreachable registry, own npm prefix, own config dir.
import { build } from 'esbuild';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { createIsolatedCliEnv, type IsolatedCliEnv, spawnIsolated, waitForProcessExit } from './isolatedCliEnv.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, '..');
const DEV_VERSION = '0.0.0-local';
// Wording is the cross-CLI contract of @wadeck-app/shared-cli/ReleaseVersion (devBuildRefusalMessage('task', version)).
const REFUSAL = `dev build ${DEV_VERSION}: refusing to update the global install of task;`;
const RELEASE_VERSION = '2026.10.25-042-50a5bcb8';

let bundleDir: string;
let releaseBundleDir: string;

async function bundle(entry: string, outfile: string, version = DEV_VERSION): Promise<void> {
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
	bundleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-devbuild-bundle-'));
	releaseBundleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-release-bundle-'));
	await Promise.all([
		bundle('TaskIndex.ts', path.join(releaseBundleDir, 'task.cjs'), RELEASE_VERSION),
		bundle('TaskIndex.ts', path.join(bundleDir, 'task.cjs')),
		bundle('task-updater-entry.ts', path.join(bundleDir, 'task-updater.cjs')),
	]);
}, 120000);

afterAll(() => {
	fs.rmSync(bundleDir, { recursive: true, force: true });
	fs.rmSync(releaseBundleDir, { recursive: true, force: true });
});

let iso: IsolatedCliEnv | undefined;
afterEach(() => {
	iso?.cleanup();
	iso = undefined;
});

function run(script: string, args: string[], extra: NodeJS.ProcessEnv = {}, dir = bundleDir) {
	iso = createIsolatedCliEnv({ extra: { UPDATER_PKG_NAME: '@wadeck-app/task-cli', ...extra } });
	const result = spawnIsolated(path.join(dir, script), args, iso);
	return { ...result, combined: (result.stdout ?? '') + (result.stderr ?? ''), iso };
}

function logText(configDir: string): string {
	const dir = path.join(configDir, 'logs');
	if (!fs.existsSync(dir)) return '';
	return fs
		.readdirSync(dir)
		.map(f => fs.readFileSync(path.join(dir, f), 'utf8'))
		.join('\n');
}

describe('dev build guard (real bundles, version 0.0.0-local)', () => {
	it('task-updater.cjs run in the background does nothing but log one line and exits 0', () => {
		const r = run('task-updater.cjs', []);
		expect(r.status, r.combined).toBe(0);
		expect(logText(r.iso.configDir).split(REFUSAL).length - 1).toBe(1);
		// Nothing else happened: no check, no cache, no state, no npm touched.
		expect(fs.existsSync(path.join(r.iso.configDir, 'update-cache.json'))).toBe(false);
		expect(fs.existsSync(path.join(r.iso.configDir, 'update-state.json'))).toBe(false);
		expect(fs.readdirSync(r.iso.npmPrefix)).toEqual([]);
	});

	it('task-updater.cjs run for `task cli update` (UPDATER_FORCE/UPDATER_MANUAL) prints the line and exits non-zero', () => {
		const r = run('task-updater.cjs', [], { UPDATER_FORCE: '1', UPDATER_MANUAL: '1' });
		expect(r.status, r.combined).not.toBe(0);
		expect(r.combined).toContain(REFUSAL);
		expect(r.combined).not.toContain('status:');
		expect(fs.existsSync(path.join(r.iso.configDir, 'update-state.json'))).toBe(false);
		expect(fs.readdirSync(r.iso.npmPrefix)).toEqual([]);
	});

	it('`task cli update` from the dev task.cjs refuses with the explanation and a non-zero exit', () => {
		fs.copyFileSync(path.join(bundleDir, 'task-updater.cjs'), path.join(bundleDir, 'flow-updater.cjs'));
		const r = run('task.cjs', ['cli', 'update']);
		expect(r.status, r.combined).not.toBe(0);
		expect(r.combined).toContain(REFUSAL);
		// The updater was never started (it would have printed its own banner).
		expect(r.combined).not.toContain('Running updater');
	});

	// A stand-in updater that only proves it was started (the marker holds its pid): the real one would reach for npm.
	// `lingerMs` keeps it alive after the write, like a real updater still running.
	function installMarkerUpdater(dir: string, marker: string, lingerMs = 0): void {
		fs.writeFileSync(
			path.join(dir, 'task-updater.cjs'),
			`require('node:fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid)); setTimeout(() => {}, ${lingerMs});`
		);
	}

	it('a normal command from the dev task.cjs spawns no updater (scheduleBackgroundUpdate gets the version)', async () => {
		const marker = path.join(bundleDir, 'updater-started.txt');
		installMarkerUpdater(bundleDir, marker);
		const r = run('task.cjs', ['--version']);
		expect(r.status, r.combined).toBe(0);
		// A spawned updater would write the marker within a moment.
		await new Promise(resolve => setTimeout(resolve, 2000));
		expect(fs.existsSync(marker)).toBe(false);
	});

	it('a normal command from a CalVer task.cjs does spawn the updater (control for the test above)', async () => {
		const marker = path.join(releaseBundleDir, 'updater-started.txt');
		installMarkerUpdater(releaseBundleDir, marker);
		const r = run('task.cjs', ['--version'], {}, releaseBundleDir);
		expect(r.status, r.combined).toBe(0);
		const deadline = Date.now() + 10000;
		while (!fs.existsSync(marker) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
		expect(fs.existsSync(marker), 'the release bundle never started its updater').toBe(true);
		// The detached updater inherited the temp root as its cwd: on Windows removing it while alive fails with EPERM.
		await waitForProcessExit(Number(fs.readFileSync(marker, 'utf8')));
	});

	it('cleanup succeeds only after the detached updater is gone (EPERM on Windows while it holds its cwd)', async () => {
		const marker = path.join(releaseBundleDir, 'updater-lingering.txt');
		installMarkerUpdater(releaseBundleDir, marker, 1500);
		const r = run('task.cjs', ['--version'], {}, releaseBundleDir);
		expect(r.status, r.combined).toBe(0);
		const deadline = Date.now() + 10000;
		while (!fs.existsSync(marker) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
		await waitForProcessExit(Number(fs.readFileSync(marker, 'utf8')));
		expect(() => r.iso.cleanup()).not.toThrow();
		expect(fs.existsSync(r.iso.root)).toBe(false);
	});
});
