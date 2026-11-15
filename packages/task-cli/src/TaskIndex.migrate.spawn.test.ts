/**
 * Subprocess integration test for `task strategy migrate`: the real CLI starts a migration on a migrating project of a throwaway
 * registry (two local strategies), launches the real detached worker (the same entry started again, hidden on Windows), and the test
 * polls `status --json` until the worker ended ready to finalize.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { addProject, defaultRegistryDir } from '@wadeck-app/project-sdk';
import { ownConfigFile, resolveProject } from '@wadeck-app/task-service';
import { afterEach, describe, expect, it } from 'vitest';

import { createIsolatedCliEnv, type IsolatedCliEnv, spawnIsolated, waitForProcessExit } from './isolatedCliEnv.js';

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

const CONFIG = `statuses:
    - backlog
    - { name: done, terminal: true }
strategy:
    type: migrating
    options:
        current: { type: local }
        new: { type: local }
`;

let iso: IsolatedCliEnv | undefined;
let workerPid: number | undefined;
afterEach(async () => {
	// A detached worker holds the throwaway tree as its cwd: wait for it before removing the tree.
	if (workerPid !== undefined) await waitForProcessExit(workerPid, 20_000);
	workerPid = undefined;
	iso?.cleanup();
	iso = undefined;
});

describe('task strategy migrate (subprocess)', () => {
	it('starts a migration, launches the real worker and ends ready to finalize with every task moved', async () => {
		iso = createIsolatedCliEnv({ extra: { TASK_WORKER: '' } });
		const projectDir = join(iso.root, 'work');
		mkdirSync(projectDir, { recursive: true });
		const registry = defaultRegistryDir(iso.env);
		const project = await addProject(registry, { name: 'migproj', path: projectDir });
		const tsx = resolveTsx();
		const entry = join(__dirname, 'TaskIndex.ts');
		const cli = (...args: string[]) => {
			const result = spawnIsolated(tsx, [entry, '-p', 'migproj', ...args], iso!, { timeout: 60_000 });
			return {
				exitCode: result.status,
				stdout: result.stdout,
				stderr: result.stderr,
				text: result.stdout + result.stderr,
			};
		};

		// Tasks are created while the project is still plain local, then the migrating section is written.
		const ids = ['one', 'two', 'three'].map(title => {
			const created = cli('new', title);
			expect(created.exitCode, created.text).toBe(0);
			return (JSON.parse(created.stdout) as { id: string }).id;
		});
		const { storage } = resolveProject({ cwd: projectDir, projectRef: project.id, env: iso.env });
		const configFile = ownConfigFile(storage);
		mkdirSync(dirname(configFile), { recursive: true });
		writeFileSync(configFile, CONFIG);

		const started = cli('strategy', 'migrate', 'start', '--allow-loss', 'all', '--json');
		expect(started.exitCode, started.text).toBe(0);
		const answer = JSON.parse(started.stdout) as { started: boolean; worker: { running: boolean; pid?: number } };
		expect(answer.started).toBe(true);
		workerPid = answer.worker.pid;

		let report: { status: string; counts: { moved: number; total: number } } | undefined;
		const deadline = Date.now() + 45_000;
		while (Date.now() < deadline) {
			const polled = cli('strategy', 'migrate', 'status', '--json');
			expect(polled.exitCode, polled.text).toBe(0);
			report = JSON.parse(polled.stdout) as typeof report;
			if (report?.status === 'ready-to-finalize') break;
			await new Promise(resolve => setTimeout(resolve, 500));
		}
		expect(report, 'no status was read').toBeDefined();
		expect(report).toMatchObject({ status: 'ready-to-finalize', counts: { moved: ids.length, total: ids.length } });

		const log = cli('strategy', 'migrate', 'log', '--json');
		expect(log.exitCode, log.text).toBe(0);
		expect((JSON.parse(log.stdout) as unknown[]).length).toBeGreaterThan(0);
	}, 90_000);
});
