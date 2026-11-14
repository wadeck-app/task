/**
 * Subprocess integration test for `task list --available --order priority-then-oldest --json` and `task next`: real CLI processes on
 * a local project of a throwaway registry, 4 tasks of mixed priority and age.
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

describe('task list --available / task next (subprocess)', () => {
	it('lists in priority-then-oldest order and next claims the head, then the following task, then reports nothing left', async () => {
		iso = createIsolatedCliEnv({ extra: { TASK_WORKER: '' } });
		const projectDir = join(iso.root, 'work');
		mkdirSync(projectDir, { recursive: true });
		await addProject(defaultRegistryDir(iso.env), { name: 'nextproj', path: projectDir });
		const tsx = resolveTsx();
		const entry = join(__dirname, 'TaskIndex.ts');
		const cli = (...args: string[]) => {
			const result = spawnIsolated(tsx, [entry, '-p', 'nextproj', ...args], iso!);
			return {
				exitCode: result.status,
				stdout: result.stdout,
				stderr: result.stderr,
				text: result.stdout + result.stderr,
			};
		};
		const create = (title: string, priority: string): string => {
			const created = cli('new', title);
			expect(created.exitCode, created.text).toBe(0);
			const id = (JSON.parse(created.stdout) as { id: string }).id;
			const set = cli('set-priority', id, priority);
			expect(set.exitCode, set.text).toBe(0);
			return id;
		};

		// Created one after the other (each a process of its own): older first.
		const oldLow = create('old low', 'low');
		const oldHigh = create('old high', 'high');
		const midLow = create('mid low', 'low');
		const newHigh = create('new high', 'high');

		const listed = cli('list', '--available', '--order', 'priority-then-oldest', '--json');
		expect(listed.exitCode, listed.text).toBe(0);
		const rows = JSON.parse(listed.stdout) as Array<{ id: string; priority: string; status: string }>;
		expect(rows.map(row => [row.id, row.priority])).toEqual([
			[oldHigh, 'high'],
			[newHigh, 'high'],
			[oldLow, 'low'],
			[midLow, 'low'],
		]);

		const limited = cli('list', '--available', '--order', 'priority-then-oldest', '--limit', '1', '--json');
		expect((JSON.parse(limited.stdout) as Array<{ id: string }>).map(row => row.id)).toEqual([oldHigh]);

		const first = cli('next', '--as', 'worker-1', '--lease', '5m');
		expect(first.exitCode, first.text).toBe(0);
		expect(first.stdout).toMatch(new RegExp(`^claimed ${oldHigh} as worker-1 until \\S+Z \\(5m\\)\\s*$`));

		const second = JSON.parse(cli('next', '--as', 'worker-2', '--json').stdout) as {
			taskId: string;
			assignee: string;
		};
		expect(second).toMatchObject({ taskId: newHigh, assignee: 'worker-2' });

		const held = cli('list', '--assignee', 'worker-1', '--json');
		const heldRows = JSON.parse(held.stdout) as Array<{ id: string; leaseExpired: boolean }>;
		expect(heldRows).toMatchObject([{ id: oldHigh, leaseExpired: false }]);

		expect(cli('next', '--as', 'worker-3').stdout).toMatch(
			new RegExp(`^claimed ${oldLow} as worker-3 until \\S+Z \\(30m\\)\\s*$`)
		);
		expect(cli('next', '--as', 'worker-4').stdout).toMatch(new RegExp(`^claimed ${midLow} as worker-4`));

		const empty = cli('next', '--as', 'worker-5');
		expect(empty.exitCode, empty.text).toBe(0);
		expect(empty.stdout.trim()).toBe('no available task');
		expect(JSON.parse(cli('next', '--as', 'worker-5', '--json').stdout)).toEqual({
			task: null,
			lost: 0,
			skippedBlocked: 0,
		});
	}, 180_000);
});
