/**
 * Subprocess integration test for `task cli self-check`.
 *
 * Verifies that stdout contains [ok] lines when the CLI entry point is spawned
 * as a child process with stdio: 'pipe'. This guards against regressions where
 * output is swallowed (e.g. when the Go launcher redirects node's stdio to NUL).
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Resolve tsx by scanning upward through parent directories (handles npm workspace hoisting).
function resolveTsx(): string {
	let dir = __dirname;
	for (let i = 0; i < 6; i++) {
		const candidate = join(dir, 'node_modules', 'tsx', 'dist', 'cli.mjs');
		if (existsSync(candidate)) return candidate;
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	throw new Error('tsx not found in node_modules — run npm install in the monorepo root');
}

describe('task cli self-check (subprocess)', () => {
	it('prints [ok] lines to stdout when spawned directly via node', () => {
		const tsx = resolveTsx();
		const taskIndex = join(__dirname, 'TaskIndex.ts');

		const result = spawnSync(process.execPath, [tsx, taskIndex, 'cli', 'self-check'], {
			encoding: 'utf8',
			timeout: 30000,
			env: { ...process.env, CLI_SELF_CHECK_QUIET: '0' },
		});

		const combined = result.stdout + result.stderr;

		expect(
			result.status,
			`cli self-check exited with code ${String(result.status)}.\nstdout: ${result.stdout}\nstderr: ${result.stderr}`
		).toBe(0);
		expect(combined, `Expected [ok] lines in output.\nstdout: ${result.stdout}\nstderr: ${result.stderr}`).toContain('[ok]');
	});

	it('exits 0 when all checks pass', () => {
		const tsx = resolveTsx();
		const taskIndex = join(__dirname, 'TaskIndex.ts');

		const result = spawnSync(process.execPath, [tsx, taskIndex, 'cli', 'self-check'], {
			encoding: 'utf8',
			timeout: 30000,
			env: { ...process.env, CLI_SELF_CHECK_QUIET: '1' },
		});

		expect(
			result.status,
			`cli self-check exited non-zero.\nstdout: ${result.stdout}\nstderr: ${result.stderr}`
		).toBe(0);
	});
});
