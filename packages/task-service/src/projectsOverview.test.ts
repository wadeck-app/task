import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { describeError } from './describeError.js';
import { NoReadableProjectsError } from './errors.js';
import { openResolvedProject, openTaskContext } from './openContext.js';
import { resolveProject } from './resolveProject.js';
import { ownConfigFile } from './storage.js';
import { listTasksAcrossProjects, summarizeProjects } from './projectsOverview.js';
import { addLegacyEntry, createSharedRegistrySandbox } from './testHelpers.js';
import type { SharedRegistrySandbox } from './testHelpers.js';

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
		addLegacyEntry(configDir, dir);
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
			expect(bareEntry!.error).toContain('project add');
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
			expect(error.hint).toContain('project CLI');
			expect(error.hint).not.toContain('task init');
		});

		it('describeError classifies it as internal with the failures as details', () => {
			uninitialized('a');
			try {
				summarizeProjects(configDir);
				expect.unreachable();
			} catch (error) {
				const described = describeError(error);
				expect(described.kind).toBe('internal');
				expect(described.hint).toContain('project CLI');
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
				{
					name: 'bare',
					path: bare,
					registered: false,
					error: expect.stringContaining('not initialized') as unknown,
				},
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

describe('projects overview with the shared project registry (stage 2a: registered data lives in the registry)', () => {
	let sandbox: SharedRegistrySandbox;
	let configDir: string;

	beforeEach(() => {
		sandbox = createSharedRegistrySandbox();
		configDir = path.join(sandbox.root, 'task-config');
		fs.mkdirSync(configDir, { recursive: true });
	});

	afterEach(() => {
		sandbox.cleanup();
	});

	/** A LEGACY project: a directory with a `.task` holding the given tasks, listed in projects.json (not in the shared registry). */
	function taskDir(name: string, tasks: Array<[string, string]>, legacy = true): string {
		const dir = sandbox.dir(name, { task: true });
		fs.writeFileSync(path.join(dir, '.task', 'config.yml'), CONFIG_YML);
		const ctx = openTaskContext({ projectDir: dir });
		for (const [title, status] of tasks) ctx.store.create(title, status);
		if (legacy) addLegacyEntry(configDir, dir);
		return dir;
	}

	/** A REGISTERED project whose tasks and config are in the shared registry (its main path holds no .task). */
	async function registeredWith(name: string, dirName: string, tasks: Array<[string, string]>) {
		const dir = sandbox.dir(dirName);
		const project = await sandbox.register(name, dir);
		const resolved = resolveProject({ cwd: dir, env: sandbox.env });
		fs.mkdirSync(path.dirname(ownConfigFile(resolved.storage)), { recursive: true });
		fs.writeFileSync(ownConfigFile(resolved.storage), CONFIG_YML);
		const ctx = openResolvedProject(resolved);
		for (const [title, status] of tasks) ctx.store.create(title, status);
		return { dir, project };
	}

	it('summarizeProjects lists the registered projects first (id, registry name, registered) and the legacy-only ones second', async () => {
		const { dir: shared, project } = await registeredWith('shop', 'shared-dir', [['s1', 'backlog']]);
		const old = taskDir('old-dir', [['o1', 'backlog']]);

		const summary = summarizeProjects(configDir, { env: sandbox.env });

		expect(summary.projects.map(p => [p.id, p.name, p.registered, p.open])).toEqual([
			[project.id, 'shop', true, 1],
			[undefined, 'old-dir', false, 1],
		]);
		expect(summary.projects[0]!.path).toBe(path.resolve(shared));
		expect(summary.projects[1]!.path).toBe(path.resolve(old));
		expect(summary.total).toBe(2);
		expect(summary).not.toHaveProperty('registryProblem');
	});

	it('a project in both registries is counted once', async () => {
		const { dir } = await registeredWith('both', 'both', [['t', 'backlog']]);
		addLegacyEntry(configDir, dir);

		const summary = summarizeProjects(configDir, { env: sandbox.env });

		expect(summary.projects).toHaveLength(1);
		expect(summary.total).toBe(1);
	});

	it('an unreadable shared registry is reported next to the legacy projects, which are still summarised', () => {
		taskDir('old-dir', [['o1', 'backlog']], true);
		fs.mkdirSync(sandbox.registryDir, { recursive: true });
		fs.writeFileSync(path.join(sandbox.registryDir, 'registry.json'), '{ nope');

		const summary = summarizeProjects(configDir, { env: sandbox.env });

		expect(summary.registryProblem).toContain('registry.json');
		expect(summary.projects.map(p => p.name)).toEqual(['old-dir']);
	});

	it('listTasksAcrossProjects tags each task with its project, id included for a registered one', async () => {
		const { dir: shared, project } = await registeredWith('shop', 'shared-dir', [['s1', 'backlog']]);
		taskDir('old-dir', [['o1', 'backlog']]);

		const answer = listTasksAcrossProjects(configDir, { env: sandbox.env });

		const byTitle = Object.fromEntries(answer.tasks.map(task => [task.title, task.project]));
		expect(byTitle['s1']).toEqual({ id: project.id, name: 'shop', path: path.resolve(shared) });
		expect(byTitle['o1']).toEqual({
			name: 'old-dir',
			path: path.resolve(path.join(sandbox.root, 'work', 'old-dir')),
		});
	});

	it('listTasksAcrossProjects still reads a registered project whose data is in its .task (unmigrated): listed with its id, nothing unreadable', async () => {
		await registeredWith('shop', 'shared-dir', [['s1', 'backlog']]);
		// Unmigrated: tasks in the .task of the main path, nothing in the registry data folder: read from the .task like stage 1.
		const old = taskDir('old-dir', [['b1', 'backlog']], false);
		const oldProject = await sandbox.register('old', old);

		const answer = listTasksAcrossProjects(configDir, { env: sandbox.env });

		expect(answer.unreadable).toEqual([]);
		const byTitle = Object.fromEntries(answer.tasks.map(task => [task.title, task.project]));
		expect(byTitle['b1']).toEqual({ id: oldProject.id, name: 'old', path: path.resolve(old) });
	});

	it('a REAL split (tasks in both places, different ids) is listed unreadable with both folders and the way out', async () => {
		await registeredWith('shop', 'shared-dir', [['s1', 'backlog']]);
		const { dir, project } = await registeredWith('split', 'split-dir', [['in registry', 'backlog']]);
		fs.mkdirSync(path.join(dir, '.task', 'tasks'), { recursive: true });
		fs.writeFileSync(path.join(dir, '.task', 'tasks', 'other.json'), '{}');

		const answer = listTasksAcrossProjects(configDir, { env: sandbox.env });

		expect(answer.unreadable).toEqual([
			{
				id: project.id,
				name: 'split',
				path: path.resolve(dir),
				registered: true,
				error: expect.stringContaining('Keep one of them') as unknown,
			},
		]);
	});

	it('a registered project with no task anywhere is listed (0 tasks), a virtual one is not', async () => {
		const fresh = await sandbox.register('fresh', sandbox.dir('fresh'));
		await sandbox.register('notes', undefined);

		const summary = summarizeProjects(configDir, { env: sandbox.env });

		expect(summary.projects.map(p => [p.id, p.name, p.open, p.total, p.error])).toEqual([
			[fresh.id, 'fresh', 0, 0, null],
		]);
	});

	it('the registered project is read from the registry data and its project config layers (statuses of its own config)', async () => {
		const { project } = await registeredWith('shop', 'shop-dir', [
			['a', 'backlog'],
			['b', 'done'],
		]);

		const summary = summarizeProjects(configDir, { env: sandbox.env });

		expect(summary.projects[0]).toMatchObject({ id: project.id, open: 1, total: 2 });
	});
});
