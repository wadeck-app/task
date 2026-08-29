// Integration tests for task CLI entry point.
// These tests build the bundle with a fixed test version and execute the updater directly.
// They verify that `task cli update` (UPDATER_FORCE=1) produces output (not silent).
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// agent-fleet root (4 levels up from src/cli/: src/cli → src → task-cli → packages → agent-fleet)
const agentFleetRoot = path.resolve(__dirname, '../../../..');
const updaterBundlePath = path.resolve(agentFleetRoot, 'packages/task-cli/dist-bundle/task-updater.cjs');

const TEST_VERSION = '0.0.0-test-integration';

beforeAll(() => {
	// Use shell: true so npm resolves correctly on Windows (npm.cmd)
	execFileSync('npm', ['run', 'bundle', '--workspace', 'packages/task-cli'], {
		cwd: agentFleetRoot,
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

describe('task cli update -- produces output', () => {
	it('writes at least one line to stdout when UPDATER_FORCE=1', () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-update-test-'));
		try {
			const result = spawnSync(process.execPath, [updaterBundlePath], {
				env: {
					...process.env,
					UPDATER_FORCE: '1',
					UPDATER_PKG_NAME: '@wadeck-app/task-cli',
					XDG_DATA_HOME: tmpDir,
					APPDATA: tmpDir,
					HOME: tmpDir,
				},
				timeout: 30000,
				encoding: 'utf-8',
			});
			const combined = (result.stdout ?? '') + (result.stderr ?? '');
			// Must produce at least one line of output
			expect(combined.trim().length, `Expected output from updater but got none. stdout: "${result.stdout}" stderr: "${result.stderr}"`).toBeGreaterThan(0);
		} finally {
			try {
				fs.rmSync(tmpDir, { recursive: true, force: true });
			} catch {
				// ignore
			}
		}
	});
});
