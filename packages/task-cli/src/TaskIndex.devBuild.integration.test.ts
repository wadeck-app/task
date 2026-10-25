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

import { createIsolatedCliEnv, type IsolatedCliEnv, spawnIsolated } from './isolatedCliEnv.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, '..');
const DEV_VERSION = '0.0.0-local';
const REFUSAL = `dev build ${DEV_VERSION}: not updating the global task-cli`;

let bundleDir: string;

async function bundle(entry: string, outfile: string): Promise<void> {
	await build({
		entryPoints: [path.join(packageRoot, 'src', entry)],
		bundle: true,
		platform: 'node',
		target: 'node22',
		format: 'cjs',
		outfile,
		external: [],
		supported: { 'top-level-await': false },
		define: { 'import.meta.url': '__importMetaUrl', __TASK_CLI_VERSION__: JSON.stringify(DEV_VERSION) },
		banner: { js: `const __importMetaUrl = require('node:url').pathToFileURL(__filename).href;` },
		logLevel: 'warning',
	});
}

beforeAll(async () => {
	bundleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-devbuild-bundle-'));
	await Promise.all([
		bundle('TaskIndex.ts', path.join(bundleDir, 'task.cjs')),
		bundle('task-updater-entry.ts', path.join(bundleDir, 'task-updater.cjs')),
	]);
}, 120000);

afterAll(() => {
	fs.rmSync(bundleDir, { recursive: true, force: true });
});

let iso: IsolatedCliEnv | undefined;
afterEach(() => {
	iso?.cleanup();
	iso = undefined;
});

function run(script: string, args: string[], extra: NodeJS.ProcessEnv = {}) {
	iso = createIsolatedCliEnv({ extra: { UPDATER_PKG_NAME: '@wadeck-app/task-cli', ...extra } });
	const result = spawnIsolated(path.join(bundleDir, script), args, iso);
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

	it('a normal command from the dev task.cjs schedules no updater: it logs the refusal once instead', async () => {
		const r = run('task.cjs', ['--version']);
		expect(r.status, r.combined).toBe(0);
		// An updater spawned in the background would take a moment to log its own refusal line.
		await new Promise(resolve => setTimeout(resolve, 2000));
		expect(logText(r.iso.configDir).split(REFUSAL).length - 1).toBe(1);
	});
});
