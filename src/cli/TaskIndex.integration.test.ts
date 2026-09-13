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
// agent-fleet root (4 levels up from src/cli/: src/cli -> src -> task-cli -> packages -> agent-fleet)
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
			// TASK_CONFIG_DIR is the only env var the updater honours for its config dir: ConfigDir.get
			// reads XDG_CONFIG_HOME or os.homedir(), and os.homedir() ignores $HOME on Windows, so
			// overriding HOME/APPDATA/XDG_DATA_HOME would leak into the developer's real ~/.config/task
			// (which carries `autoUpdate: false` and makes shared-updater return early and silently).
			//
			// NPM_CONFIG_USERCONFIG replaces ~/.npmrc so the developer's `@wadeck-app:registry` and auth
			// token cannot apply. Both the default and the scoped registry point at a closed port, so
			// `npm view` fails fast: the run is offline, deterministic, and installs nothing globally.
			const npmrcPath = path.join(tmpDir, 'npmrc');
			const deadRegistry = 'http://127.0.0.1:1/';
			fs.writeFileSync(
				npmrcPath,
				`registry=${deadRegistry}\n@wadeck-app:registry=${deadRegistry}\nfetch-retries=0\n`
			);

			// Running under npm/npx exports NPM_CONFIG_USERCONFIG pointing at the real ~/.npmrc.
			// Windows env vars are case-insensitive while JS object keys are not, so adding a
			// lowercase `npm_config_userconfig` would leave a duplicate that the real path wins.
			// Drop every case variant first, then set exactly one canonical key.
			const childEnv: Record<string, string | undefined> = {};
			for (const [key, value] of Object.entries(process.env)) {
				if (!/^npm_config_userconfig$/i.test(key)) childEnv[key] = value;
			}

			const result = spawnSync(process.execPath, [updaterBundlePath], {
				env: {
					...childEnv,
					UPDATER_FORCE: '1',
					UPDATER_PKG_NAME: '@wadeck-app/task-cli',
					TASK_CONFIG_DIR: tmpDir,
					NPM_CONFIG_USERCONFIG: npmrcPath,
				},
				timeout: 30000,
				encoding: 'utf-8',
			});
			const combined = (result.stdout ?? '') + (result.stderr ?? '');
			// Must produce at least one line of output
			expect(
				combined.trim().length,
				`Expected output from updater but got none. stdout: "${result.stdout}" stderr: "${result.stderr}"`
			).toBeGreaterThan(0);
			// The outcome must be attributed to the updater and name the failure, not just be non-empty.
			expect(combined).toContain('[task-updater]');
			expect(combined).toContain('version fetch failed');
		} finally {
			try {
				fs.rmSync(tmpDir, { recursive: true, force: true });
			} catch {
				// ignore
			}
		}
	});
});
