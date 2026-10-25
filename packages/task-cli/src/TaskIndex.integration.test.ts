// Integration tests for the task updater entry point.
// These tests build the bundle with a fixed test version and execute the updater directly.
// They verify that `task cli update` (UPDATER_FORCE=1) produces output (not silent).
//
// Isolation (incident 2026-10-24/25: a repo-built bundle ran a real `npm install -g` and the global CLI vanished):
// the updater only ever sees the throwaway tree of createIsolatedCliEnv (config dir, HOME, npm prefix and cache,
// npmrc) and an unreachable registry, so even a bug cannot install, uninstall or read anything real.
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { createIsolatedCliEnv, type IsolatedCliEnv, spawnIsolated } from './isolatedCliEnv.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// packages/task-cli package root (1 level up from src/)
const packageRoot = path.resolve(__dirname, '..');
const updaterBundlePath = path.resolve(packageRoot, 'dist-bundle/task-updater.cjs');

// A CalVer shape on purpose: the dev-build guard (non-CalVer versions refuse to update) must not hide these runs.
// The registry is unreachable, so no install can happen whatever the version.
const TEST_VERSION = '2026.01.01-001-deadbeef';

beforeAll(() => {
	// Use shell: true so npm resolves correctly on Windows (npm.cmd). The build itself is not isolated: it only
	// writes into this package.
	execFileSync('npm', ['run', 'bundle'], {
		cwd: packageRoot,
		encoding: 'utf-8',
		timeout: 120000,
		env: { ...process.env, BUNDLE_VERSION: TEST_VERSION },
		shell: true,
	});
}, 120000);

afterAll(() => {
	try {
		if (fs.existsSync(updaterBundlePath)) fs.unlinkSync(updaterBundlePath);
	} catch {
		// ignore cleanup errors
	}
});

let iso: IsolatedCliEnv | undefined;
afterEach(() => {
	iso?.cleanup();
	iso = undefined;
});

/** Runs the updater bundle as `task cli update` does (UPDATER_FORCE=1) inside the isolated tree. */
function runUpdater(setup?: (configDir: string) => void): { combined: string; stdout: string; stderr: string } {
	iso = createIsolatedCliEnv({ extra: { UPDATER_FORCE: '1', UPDATER_PKG_NAME: '@wadeck-app/task-cli' } });
	setup?.(iso.configDir);
	const result = spawnIsolated(updaterBundlePath, [], iso);
	const stdout = result.stdout ?? '';
	const stderr = result.stderr ?? '';
	return { combined: stdout + stderr, stdout, stderr };
}

describe('task cli update -- produces output', () => {
	it('writes at least one line to stdout when UPDATER_FORCE=1', () => {
		const { combined, stdout, stderr } = runUpdater();
		// Must produce at least one line of output
		expect(
			combined.trim().length,
			`Expected output from updater but got none. stdout: "${stdout}" stderr: "${stderr}"`
		).toBeGreaterThan(0);
		// The outcome must be attributed to the updater and name the failure, not just be non-empty.
		expect(combined).toContain('[task-updater]');
		expect(combined).toContain('version fetch failed');
		// The status block is always printed, and never the old vague "unexpected" message.
		expect(combined).toContain('[task-updater] current:');
		expect(combined).toContain('[task-updater] latest:');
		expect(combined).toContain('[task-updater] status:  update check failed --');
		expect(combined).not.toContain('unexpected');
	});

	it('reports autoUpdate disabled explicitly, not a silent/vague message', () => {
		// UPDATER_FORCE without UPDATER_MANUAL: force bypasses the check-interval, but the
		// autoUpdate:false flag in config.yml is only bypassed by UPDATER_MANUAL.
		const { combined } = runUpdater(configDir => {
			fs.writeFileSync(path.join(configDir, 'config.yml'), 'autoUpdate: false\n');
		});
		expect(combined).toContain('[task-updater] status:  skipped -- autoUpdate is disabled in');
		expect(combined).not.toContain('unexpected');
	});

	it('ignores a stale state file left over from a previous run', () => {
		const { combined } = runUpdater(configDir => {
			// Simulate a prior run that successfully updated, long before this run starts.
			fs.writeFileSync(
				path.join(configDir, 'update-state.json'),
				JSON.stringify({
					status: 'success',
					currentVersion: '0.0.0-ancient',
					targetVersion: '0.0.0-also-ancient',
					timestamp: Date.now() - 60 * 60 * 1000,
				})
			);
		});
		// This run's own outcome (fetch failed, since the registry is unreachable) must win
		// over the stale leftover 'success' state -- never report a success that didn't happen.
		expect(combined).toContain('[task-updater] status:  update check failed --');
		expect(combined).not.toContain('status:  updated to');
		expect(combined).not.toContain('unexpected');
	});

	it('never touches an npm global prefix: the isolated prefix stays empty', () => {
		runUpdater();
		expect(fs.readdirSync(iso!.npmPrefix)).toEqual([]);
	});
});
