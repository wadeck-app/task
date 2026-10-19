import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { describeError } from './describeError.js';
import { NoReadableProjectsError } from './errors.js';
import { openTaskContext } from './openContext.js';
import { listTasksAcrossProjects, summarizeProjects } from './projectsOverview.js';
import { registerProject } from './projectsRegistry.js';

const CONFIG_YML = ['statuses:', '  - backlog', '  - name: done', '    terminal: true', ''].join('\n');

describe('projects overview (all registered projects)', () => {
	let root: string;
	let configDir: string;

	beforeEach(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-overview-'));
		configDir = path.join(root, 'config');
	});

	afterEach(() => {
		fs.rmSync(root, { recursive: true, force: true });
	});

	/** An initialized, registered project holding the given tasks (title -> status). */
	function project(name: string, tasks: Array<[string, string]> = []): string {
		const dir = path.join(root, name);
		fs.mkdirSync(path.join(dir, '.task', 'tasks'), { recursive: true });
		fs.writeFileSync(path.join(dir, '.task', 'config.yml'), CONFIG_YML);
		registerProject(configDir, dir);
		const ctx = openTaskContext({ projectDir: dir });
		for (const [title, status] of tasks) ctx.store.create(title, status);
		return dir;
	}

	/** A registered project whose `.task` is gone. */
	function uninitialized(name: string): string {
		const dir = project(name);
		fs.rmSync(path.join(dir, '.task'), { recursive: true });
		return dir;
	}

	describe('summarizeProjects', () => {
		it('is empty (not an error) when nothing is registered', () => {
			expect(summarizeProjects(configDir)).toEqual({
				projects: [],
				readableCount: 0,
				open: 0,
				total: 0,
				byStatus: [],
			});
		});

		it('gives one entry per project (registration order) and the totals, closed tasks counted in total only', () => {
			const alpha = project('alpha', [
				['a1', 'backlog'],
				['a2', 'done'],
			]);
			const beta = project('beta');
			const gamma = project('gamma', [['g1', 'backlog']]);
			const summary = summarizeProjects(configDir);
			expect(summary.projects.map(p => [p.name, p.path, p.open, p.total, p.error])).toEqual([
				['alpha', alpha, 1, 2, null],
				['beta', beta, 0, 0, null],
				['gamma', gamma, 1, 1, null],
			]);
			expect(summary).toMatchObject({ readableCount: 3, open: 2, total: 3 });
			expect(summary.byStatus).toEqual([
				{ status: 'backlog', count: 2, terminal: false },
				{ status: 'done', count: 1, terminal: true },
			]);
			expect(summary.projects[0]!.byStatus).toEqual([
				{ status: 'backlog', count: 1, terminal: false },
				{ status: 'done', count: 1, terminal: true },
			]);
		});

		it('reports an unreadable project with its reason and null figures, and keeps it out of the totals', () => {
			project('alpha', [['a1', 'backlog']]);
			const bare = uninitialized('bare');
			const gone = project('gone');
			fs.rmSync(gone, { recursive: true });
			const summary = summarizeProjects(configDir);
			expect(summary).toMatchObject({ readableCount: 1, open: 1, total: 1 });
			const [, bareEntry, goneEntry] = summary.projects;
			expect(bareEntry).toMatchObject({ path: bare, open: null, total: null, byStatus: [], exists: true });
			expect(bareEntry!.error).toContain('not initialized');
			expect(goneEntry).toMatchObject({ path: gone, open: null, total: null, exists: false });
			expect(goneEntry!.error).toContain('does not exist');
		});

		it('throws NoReadableProjectsError (never zeros) when every registered project is unreadable', () => {
			const a = uninitialized('a');
			const b = uninitialized('b');
			let thrown: unknown;
			try {
				summarizeProjects(configDir);
			} catch (error) {
				thrown = error;
			}
			expect(thrown).toBeInstanceOf(NoReadableProjectsError);
			const error = thrown as NoReadableProjectsError;
			expect(error.message).toContain('none of the 2 registered projects');
			expect(error.failures.map(f => f.path)).toEqual([a, b]);
			expect(error.hint).toContain('task init');
			expect(error.hint).toContain('task projects remove');
		});

		it('describeError classifies it as internal with the failures as details', () => {
			uninitialized('a');
			try {
				summarizeProjects(configDir);
				expect.unreachable();
			} catch (error) {
				const described = describeError(error);
				expect(described.kind).toBe('internal');
				expect(described.hint).toContain('task init');
				expect(described.details['skipped']).toEqual((error as NoReadableProjectsError).failures);
			}
		});
	});

	describe('listTasksAcrossProjects', () => {
		it('is empty (not an error) when nothing is registered', () => {
			expect(listTasksAcrossProjects(configDir)).toEqual({ tasks: [], readableCount: 0, unreadable: [] });
		});

		it('lists the open tasks of every project with their project, sorted by project name then creation', () => {
			const zeta = project('Zeta', [['z1', 'backlog']]);
			const alpha = project('alpha', [
				['a1', 'backlog'],
				['a-closed', 'done'],
				['a2', 'backlog'],
			]);
			project('empty');
			const result = listTasksAcrossProjects(configDir);
			expect(result.tasks.map(t => [t.project.name, t.title])).toEqual([
				['alpha', 'a1'],
				['alpha', 'a2'],
				['Zeta', 'z1'],
			]);
			expect(result.tasks[0]).toMatchObject({
				project: { name: 'alpha', path: alpha },
				status: 'backlog',
				id: expect.any(String),
				createdAt: expect.any(String),
			});
			expect(result.tasks[2]!.project.path).toBe(zeta);
			expect(result).toMatchObject({ readableCount: 3, unreadable: [] });
		});

		it('showAll includes the tasks in a terminal status', () => {
			project('alpha', [
				['a1', 'backlog'],
				['a-closed', 'done'],
			]);
			const titles = listTasksAcrossProjects(configDir, { showAll: true }).tasks.map(t => t.title);
			expect(titles).toEqual(['a1', 'a-closed']);
		});

		it('names the unreadable projects with their reason instead of dropping them', () => {
			project('alpha', [['a1', 'backlog']]);
			const bare = uninitialized('bare');
			const result = listTasksAcrossProjects(configDir);
			expect(result.tasks).toHaveLength(1);
			expect(result.readableCount).toBe(1);
			expect(result.unreadable).toEqual([
				{ name: 'bare', path: bare, error: expect.stringContaining('not initialized') as unknown },
			]);
		});

		it('throws NoReadableProjectsError when every registered project is unreadable', () => {
			uninitialized('a');
			expect(() => listTasksAcrossProjects(configDir)).toThrow(NoReadableProjectsError);
		});

		it('a corrupt registry throws the registry error, not an empty list', () => {
			fs.mkdirSync(configDir, { recursive: true });
			fs.writeFileSync(path.join(configDir, 'projects.json'), '{not json');
			expect(() => listTasksAcrossProjects(configDir)).toThrow();
		});
	});
});
