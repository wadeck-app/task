/**
 * Two REAL `task next` processes started at the same instant on one local project. The test asserts invariants that hold
 * under EVERY interleaving (it does not depend on who wins): no task claimed twice, one assignee per claimed task, files
 * and index still readable, no leftover write lock. Whether the two processes really overlap is up to the OS scheduler
 * (nothing forces it), so a pass proves the invariants, not that the race happened.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { addProject, defaultRegistryDir } from '@wadeck-app/project-sdk';
import { afterEach, describe, expect, it } from 'vitest';

import { createIsolatedCliEnv, type IsolatedCliEnv, runIsolated, spawnIsolated } from './isolatedCliEnv.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

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

/** Every file under `dir`, recursively (the throwaway tree is small). */
function walk(dir: string): string[] {
	const out: string[] = [];
	for (const name of readdirSync(dir)) {
		const full = join(dir, name);
		if (statSync(full).isDirectory()) out.push(...walk(full));
		else out.push(full);
	}
	return out;
}

let iso: IsolatedCliEnv | undefined;
afterEach(() => {
	iso?.cleanup();
	iso = undefined;
});

interface Setup {
	cli: (...args: string[]) => { exitCode: number | null; stdout: string; stderr: string; text: string };
	ids: string[];
	dataRoot: string;
	env: IsolatedCliEnv;
	tsx: string;
	entry: string;
}

async function setup(taskCount: number): Promise<Setup> {
	iso = createIsolatedCliEnv({ extra: { TASK_WORKER: '' } });
	const projectDir = join(iso.root, 'work');
	mkdirSync(projectDir, { recursive: true });
	await addProject(defaultRegistryDir(iso.env), { name: 'raceproj', path: projectDir });
	const tsx = resolveTsx();
	const entry = join(__dirname, 'TaskIndex.ts');
	const cli = (...args: string[]) => {
		const result = spawnIsolated(tsx, [entry, '-p', 'raceproj', ...args], iso!);
		return {
			exitCode: result.status,
			stdout: result.stdout,
			stderr: result.stderr,
			text: result.stdout + result.stderr,
		};
	};
	const ids: string[] = [];
	for (let i = 0; i < taskCount; i++) {
		const created = cli('new', `task ${i}`);
		expect(created.exitCode, created.text).toBe(0);
		ids.push((JSON.parse(created.stdout) as { id: string }).id);
	}
	const registry = defaultRegistryDir(iso.env);
	return { cli, ids, dataRoot: join(registry, 'projects'), env: iso, tsx, entry };
}

/** Both processes are started in the same tick, then awaited together. */
async function raceNext(
	s: Setup
): Promise<Array<{ worker: string; status: number | null; stdout: string; stderr: string }>> {
	const workers = ['w1', 'w2'];
	const children = workers.map(w =>
		runIsolated(s.tsx, [s.entry, '-p', 'raceproj', 'next', '--as', w, '--json'], s.env)
	);
	const results = await Promise.all(children);
	return results.map((r, i) => ({ worker: workers[i], status: r.status, stdout: r.stdout, stderr: r.stderr }));
}

function assertFilesIntact(s: Setup): void {
	const files = walk(s.dataRoot);
	expect(
		files.filter(f => f.endsWith('.write-lock')),
		'write lock left behind'
	).toEqual([]);
	expect(
		files.filter(f => /\.(tmp|takeover)$/.test(f) || /\.tmp-/.test(f)),
		'temp file left behind'
	).toEqual([]);
	for (const file of files.filter(f => f.endsWith('.json'))) JSON.parse(readFileSync(file, 'utf8'));
	// Each task, read through the CLI, has at most one assignee string and its id intact.
	for (const id of s.ids) {
		const shown = JSON.parse(s.cli('show', id).stdout) as { id: string; assignee?: unknown };
		expect(shown.id).toBe(id);
		if (shown.assignee !== undefined) expect(typeof shown.assignee).toBe('string');
	}
}

describe('task next, two simultaneous processes (subprocess)', () => {
	it('3 open tasks: nothing is claimed twice, every claim has one assignee, nothing is corrupt', async () => {
		const s = await setup(3);
		const results = await raceNext(s);
		const claims = results.flatMap(r => {
			expect(r.status, `${r.worker}: ${r.stdout}${r.stderr}`).toBe(0);
			const parsed = JSON.parse(r.stdout) as { taskId?: string; assignee?: string; task: unknown };
			return parsed.taskId === undefined
				? []
				: [{ worker: r.worker, taskId: parsed.taskId, assignee: parsed.assignee }];
		});
		const claimedIds = claims.map(c => c.taskId);
		expect(new Set(claimedIds).size, `claimed twice: ${JSON.stringify(claims)}`).toBe(claimedIds.length);
		expect(claims.length).toBe(2);
		for (const claim of claims) expect(claim.assignee).toBe(claim.worker);
		const held = JSON.parse(s.cli('list', '--assignee', 'w1', '--json').stdout) as Array<{ id: string }>;
		const held2 = JSON.parse(s.cli('list', '--assignee', 'w2', '--json').stdout) as Array<{ id: string }>;
		expect(held.length).toBe(1);
		expect(held2.length).toBe(1);
		expect(held[0].id).not.toBe(held2[0].id);
		assertFilesIntact(s);
	}, 180_000);

	it('1 open task: exactly one worker gets it, the other is told there is nothing (or the contention), exit codes as documented', async () => {
		const s = await setup(1);
		const results = await raceNext(s);
		const winners = results.filter(r => r.status === 0 && 'taskId' in (JSON.parse(r.stdout) as object));
		expect(winners.length, JSON.stringify(results)).toBe(1);
		const loser = results.find(r => r !== winners[0])!;
		// Documented: nothing available = exit 0 with {task: null}; any error = exit 1 with {error, hint}.
		if (loser.status === 0) {
			expect(JSON.parse(loser.stdout)).toMatchObject({ task: null });
		} else {
			expect(loser.status).toBe(1);
			expect(loser.stderr).toMatch(/claimed|contention|lock/i);
		}
		const shown = JSON.parse(s.cli('show', s.ids[0]).stdout) as { assignee: string };
		expect(shown.assignee).toBe(winners[0].worker);
		assertFilesIntact(s);
	}, 180_000);
});
