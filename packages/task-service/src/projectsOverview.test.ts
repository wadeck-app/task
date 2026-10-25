import * as fs from 'node:fs';
import * as path from 'node:path';

import { describeError } from './describeError.js';
import { NoReadableProjectsError } from './errors.js';
import { openResolvedProject } from './openContext.js';
import { resolveProject } from './resolveProject.js';
import { ownConfigFile } from './storage.js';
import { listTasksAcrossProjects, summarizeProjects } from './projectsOverview.js';
import { createSharedRegistrySandbox } from './testHelpers.js';
import type { SharedRegistrySandbox } from './testHelpers.js';

const CONFIG_YML = ['statuses:', '  - backlog', '  - name: done', '    terminal: true', ''].join('\n');

describe('projects overview (every project of the shared registry that has a folder)', () => {
	let sandbox: SharedRegistrySandbox;

	beforeEach(() => {
		sandbox = createSharedRegistrySandbox();
	});

	afterEach(() => {
		sandbox.cleanup();
	});

	/** A registered project whose tasks and config are in the registry. */
	async function registeredWith(name: string, tasks: Array<[string, string]> = []) {
		const dir = sandbox.dir(name);
		const project = await sandbox.register(name, dir);
		const resolved = resolveProject({ cwd: dir, env: sandbox.env });
		fs.mkdirSync(path.dirname(ownConfigFile(resolved.storage)), { recursive: true });
		fs.writeFileSync(ownConfigFile(resolved.storage), CONFIG_YML);
		const ctx = openResolvedProject(resolved);
		for (const [title, status] of tasks) ctx.store.create(title, status);
		return { dir: path.resolve(dir), project };
	}

	/** A registered project that cannot be read: its own config.yml is not valid YAML. */
	async function unreadable(name: string) {
		const registered = await registeredWith(name);
		const resolved = resolveProject({ cwd: registered.dir, env: sandbox.env });
		fs.writeFileSync(ownConfigFile(resolved.storage), 'statuses: [unclosed');
		return registered;
	}

	describe('summarizeProjects', () => {
		it('is empty (not an error) when nothing is registered', () => {
			expect(summarizeProjects({ env: sandbox.env })).toEqual({
				projects: [],
				readableCount: 0,
				open: 0,
				total: 0,
				byStatus: [],
			});
		});

		it('gives one entry per project (registration order) with its id, and the totals, closed tasks counted in total only', async () => {
			const alpha = await registeredWith('alpha', [
				['a1', 'backlog'],
				['a2', 'done'],
			]);
			const beta = await registeredWith('beta');
			const gamma = await registeredWith('gamma', [['g1', 'backlog']]);

			const summary = summarizeProjects({ env: sandbox.env });

			expect(summary.projects.map(p => [p.id, p.name, p.path, p.open, p.total, p.error])).toEqual([
				[alpha.project.id, 'alpha', alpha.dir, 1, 2, null],
				[beta.project.id, 'beta', beta.dir, 0, 0, null],
				[gamma.project.id, 'gamma', gamma.dir, 1, 1, null],
			]);
			expect(summary).toMatchObject({ readableCount: 3, open: 2, total: 3 });
			expect(summary).not.toHaveProperty('registryProblem');
			expect(summary.byStatus).toEqual([
				{ status: 'backlog', count: 2, terminal: false },
				{ status: 'done', count: 1, terminal: true },
			]);
			expect(summary.projects[0]!.byStatus).toEqual([
				{ status: 'backlog', count: 1, terminal: false },
				{ status: 'done', count: 1, terminal: true },
			]);
		});

		it('a row has exactly the documented keys', async () => {
			await registeredWith('alpha');

			const [row] = summarizeProjects({ env: sandbox.env }).projects;

			expect(Object.keys(row!).sort()).toEqual(
				['byStatus', 'error', 'exists', 'id', 'name', 'open', 'path', 'total'].sort()
			);
		});

		it('reports an unreadable project with its reason and null figures, and keeps it out of the totals', async () => {
			await registeredWith('alpha', [['a1', 'backlog']]);
			const broken = await unreadable('broken');

			const summary = summarizeProjects({ env: sandbox.env });

			expect(summary).toMatchObject({ readableCount: 1, open: 1, total: 1 });
			const brokenEntry = summary.projects[1];
			expect(brokenEntry).toMatchObject({
				id: broken.project.id,
				path: broken.dir,
				open: null,
				total: null,
				byStatus: [],
				exists: true,
			});
			expect(brokenEntry!.error).toContain('config.yml');
		});

		it('a registered project whose folder is gone is still listed, and still readable (its data is in the registry)', async () => {
			const gone = await registeredWith('gone', [['g1', 'backlog']]);
			fs.rmSync(gone.dir, { recursive: true });

			const [row] = summarizeProjects({ env: sandbox.env }).projects;

			expect(row).toMatchObject({ name: 'gone', exists: false, open: 1, total: 1, error: null });
		});

		it('throws NoReadableProjectsError (never zeros) when every registered project is unreadable', async () => {
			const a = await unreadable('a');
			const b = await unreadable('b');

			let thrown: unknown;
			try {
				summarizeProjects({ env: sandbox.env });
			} catch (error) {
				thrown = error;
			}

			expect(thrown).toBeInstanceOf(NoReadableProjectsError);
			const error = thrown as NoReadableProjectsError;
			expect(error.message).toContain('none of the 2 registered projects');
			expect(error.failures.map(f => f.path)).toEqual([a.dir, b.dir]);
			expect(error.hint).toContain('project CLI');
			expect(error.hint).not.toContain('task init');
		});

		it('describeError classifies it as internal with the failures as details', async () => {
			await unreadable('a');
			try {
				summarizeProjects({ env: sandbox.env });
				expect.unreachable();
			} catch (error) {
				const described = describeError(error);
				expect(described.kind).toBe('internal');
				expect(described.hint).toContain('project CLI');
				expect(described.details['skipped']).toEqual((error as NoReadableProjectsError).failures);
			}
		});

		it('an unreadable shared registry is reported, and lists no project (there is no other source)', () => {
			fs.mkdirSync(sandbox.registryDir, { recursive: true });
			fs.writeFileSync(path.join(sandbox.registryDir, 'registry.json'), '{ nope');

			const summary = summarizeProjects({ env: sandbox.env });

			expect(summary.registryProblem).toContain('registry.json');
			expect(summary.projects).toEqual([]);
		});

		it('a registered project with no task anywhere is listed (0 tasks), a virtual one is not', async () => {
			const fresh = await sandbox.register('fresh', sandbox.dir('fresh'));
			await sandbox.register('notes', undefined);

			const summary = summarizeProjects({ env: sandbox.env });

			expect(summary.projects.map(p => [p.id, p.name, p.open, p.total, p.error])).toEqual([
				[fresh.id, 'fresh', 0, 0, null],
			]);
		});

		it('is read from the registry data and the project config layers (statuses of its own config)', async () => {
			const { project } = await registeredWith('shop', [
				['a', 'backlog'],
				['b', 'done'],
			]);

			const summary = summarizeProjects({ env: sandbox.env });

			expect(summary.projects[0]).toMatchObject({ id: project.id, open: 1, total: 2 });
		});
	});

	describe('listTasksAcrossProjects', () => {
		it('is empty (not an error) when nothing is registered', () => {
			expect(listTasksAcrossProjects({ env: sandbox.env })).toEqual({
				tasks: [],
				readableCount: 0,
				unreadable: [],
			});
		});

		it('lists the open tasks of every project with their project (id included), sorted by project name then creation', async () => {
			const zeta = await registeredWith('zeta', [['z1', 'backlog']]);
			const alpha = await registeredWith('alpha', [
				['a1', 'backlog'],
				['a-closed', 'done'],
				['a2', 'backlog'],
			]);
			await registeredWith('empty');

			const result = listTasksAcrossProjects({ env: sandbox.env });

			expect(result.tasks.map(t => [t.project.name, t.title])).toEqual([
				['alpha', 'a1'],
				['alpha', 'a2'],
				['zeta', 'z1'],
			]);
			expect(result.tasks[0]).toMatchObject({
				project: { id: alpha.project.id, name: 'alpha', path: alpha.dir },
				status: 'backlog',
				id: expect.any(String),
				createdAt: expect.any(String),
			});
			expect(result.tasks[2]!.project).toEqual({ id: zeta.project.id, name: 'zeta', path: zeta.dir });
			expect(result).toMatchObject({ readableCount: 3, unreadable: [] });
		});

		it('showAll includes the tasks in a terminal status', async () => {
			await registeredWith('alpha', [
				['a1', 'backlog'],
				['a-closed', 'done'],
			]);

			const titles = listTasksAcrossProjects({ env: sandbox.env, showAll: true }).tasks.map(t => t.title);

			expect(titles).toEqual(['a1', 'a-closed']);
		});

		it('names the unreadable projects with their reason instead of dropping them', async () => {
			await registeredWith('alpha', [['a1', 'backlog']]);
			const broken = await unreadable('broken');

			const result = listTasksAcrossProjects({ env: sandbox.env });

			expect(result.tasks).toHaveLength(1);
			expect(result.readableCount).toBe(1);
			expect(result.unreadable).toEqual([
				{
					id: broken.project.id,
					name: 'broken',
					path: broken.dir,
					error: expect.stringContaining('config.yml') as unknown,
				},
			]);
		});

		it('throws NoReadableProjectsError when every registered project is unreadable', async () => {
			await unreadable('a');

			expect(() => listTasksAcrossProjects({ env: sandbox.env })).toThrow(NoReadableProjectsError);
		});
	});
});
