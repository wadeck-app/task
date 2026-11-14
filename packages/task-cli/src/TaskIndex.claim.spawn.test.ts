/**
 * Subprocess integration test for `task claim`: two real CLI processes, one after the other, on a local project of a throwaway
 * registry. The second worker meets the lease the first one took (the remaining time is in the message), and --force takes over.
 */
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { addProject, defaultRegistryDir } from '@wadeck-app/project-sdk';
import { afterEach, describe, expect, it } from 'vitest';

import { createIsolatedCliEnv, type IsolatedCliEnv, spawnIsolated } from './isolatedCliEnv.js';

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
	throw new Error('tsx not found in node_modules - run npm install in the monorepo root');
}

let iso: IsolatedCliEnv | undefined;
afterEach(() => {
	iso?.cleanup();
	iso = undefined;
});

describe('task claim (subprocess)', () => {
	it('a second worker meets the live lease of the first, --force takes over, release frees the task', async () => {
		iso = createIsolatedCliEnv({ extra: { TASK_WORKER: '' } });
		const projectDir = join(iso.root, 'work');
		mkdirSync(projectDir, { recursive: true });
		await addProject(defaultRegistryDir(iso.env), { name: 'claimproj', path: projectDir });
		const tsx = resolveTsx();
		const entry = join(__dirname, 'TaskIndex.ts');
		const cli = (...args: string[]) => {
			const result = spawnIsolated(tsx, [entry, '-p', 'claimproj', ...args], iso!);
			return {
				exitCode: result.status,
				stdout: result.stdout,
				stderr: result.stderr,
				text: result.stdout + result.stderr,
			};
		};

		const created = cli('new', 'Task to claim');
		expect(created.exitCode, created.text).toBe(0);
		const id = (JSON.parse(created.stdout) as { id: string }).id;

		const first = cli('claim', id, '--as', 'worker-1', '--lease', '5m');
		expect(first.exitCode, first.text).toBe(0);
		expect(first.stdout).toMatch(new RegExp(`^claimed ${id} as worker-1 until \\S+Z \\(5m\\)\\s*$`));

		const second = cli('claim', id, '--as', 'worker-2');
		expect(second.exitCode, second.text).toBe(1);
		expect(second.stderr).toContain('claimed by "worker-1"');
		expect(second.stderr).toMatch(/\(\d+m( \d+s)? left\)/);
		expect(second.stderr).toContain('--force');
		expect(second.stdout).toBe('');

		const forced = cli('claim', id, '--as', 'worker-2', '--force');
		expect(forced.exitCode, forced.text).toBe(0);
		expect(forced.stdout).toMatch(new RegExp(`^took over ${id} from worker-1 as worker-2 until `));

		const shown = JSON.parse(cli('show', id).stdout) as { assignee: string; leaseExpired: boolean };
		expect(shown).toMatchObject({ assignee: 'worker-2', leaseExpired: false });

		const released = cli('release', id);
		expect(released.stdout.trim()).toBe(`released ${id} (was held by worker-2)`);
	}, 120_000);
});
