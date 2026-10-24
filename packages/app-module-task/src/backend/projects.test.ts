import * as fs from 'node:fs';
import * as path from 'node:path';

import { TaskStore } from '@wadeck-app/task-core';

import { RequestError } from './errors.js';
import { listProjects, openProject, readProjects } from './projects.js';
import { createTestWorld, type TestWorld } from './testHelpers.js';

let world: TestWorld;

beforeEach(() => {
	world = createTestWorld();
});
afterEach(() => world.cleanup());

function failure(call: () => unknown): RequestError {
	try {
		call();
	} catch (error) {
		expect(error).toBeInstanceOf(RequestError);
		return error as RequestError;
	}
	throw new Error('expected the call to throw a RequestError');
}

describe('openProject', () => {
	it('opens a registered project given by ?project (id) and builds a service context over its store', async () => {
		const id = await world.createProject('alpha');
		const ctx = openProject(id);
		expect(ctx.project).toEqual({ id, name: 'alpha', path: world.dirOf(id) });
		expect(ctx.config.statuses).toEqual(['backlog', 'in-progress', 'done']);
		expect(ctx.store.list()).toEqual([]);
	});

	it('opens a registered project by name (case-insensitive) and by a unique id prefix', async () => {
		const id = await world.createProject('alpha');
		expect(openProject('ALPHA').project.id).toBe(id);
		expect(openProject(id.slice(0, 4)).project.id).toBe(id);
	});

	it('uses the configured statuses of the project (its config in the registry)', async () => {
		const id = await world.createProject('alpha', {
			configYml: 'statuses:\n  - todo\n  - name: shipped\n    terminal: true\n',
		});
		expect(openProject(id).config.terminalStatuses).toEqual(['shipped']);
	});

	it('uses the only registered project when the param is missing', async () => {
		const id = await world.createProject('alpha');
		expect(openProject(undefined).project.id).toBe(id);
	});

	it('400 when the param is missing and several projects are registered, listing them', async () => {
		const a = await world.createProject('alpha');
		const b = await world.createProject('beta');
		const error = failure(() => openProject(undefined));
		expect(error.status).toBe(400);
		expect(error.extra).toEqual({ registeredProjects: [world.dirOf(a), world.dirOf(b)] });
		expect(error.hint).toContain('?project=');
		expect(error.hint).toContain(`alpha (${a})`);
	});

	it('404 when the param is missing and nothing is registered, telling to use the project CLI', () => {
		const error = failure(() => openProject(undefined));
		expect(error.status).toBe(404);
		expect(error.hint).toContain('project add');
		expect(error.hint).not.toContain('task init');
	});

	it('404 for a name the registry does not know: its own message and suggestions, plus a hint naming id, name or alias', async () => {
		await world.createProject('alpha');
		const error = failure(() => openProject('alpah'));
		expect(error.status).toBe(404);
		expect(error.message).toContain("no project matches 'alpah'");
		expect(error.hint).toContain('id, name or alias');
		expect(error.extra).toMatchObject({ suggestions: [expect.objectContaining({ text: 'alpha' })] });
	});

	it('404 for the absolute directory of a registered project: it is no longer a project reference', async () => {
		const id = await world.createProject('alpha');
		const dir = world.dirOf(id);
		const error = failure(() => openProject(dir));
		expect(error.status).toBe(404);
		expect(error.message).toBe(`no project matches "${dir}"`);
		expect(error.hint).toContain('id, name or alias');
		expect(error.hint).toContain('no longer accepted');
		expect(error.hint).toContain('/api/modules/task/projects');
	});

	it('404 for an old page slug (name~hex), also when its name is a registered project', async () => {
		await world.createProject('alpha');
		const error = failure(() => openProject('alpha~0a1b2c'));
		expect(error.status).toBe(404);
		expect(error.message).toBe('no project matches "alpha~0a1b2c"');
		expect(error.hint).toContain('id, name or alias');
		expect(error.hint).toContain('slug');
		expect(error.hint).toContain('no longer accepted');
	});

	it('a registered project whose folder has no .task needs none: its data is in the registry', async () => {
		const id = await world.createProject('alpha');
		expect(fs.existsSync(path.join(world.dirOf(id), '.task'))).toBe(false);
		expect(openProject(id).store.list()).toEqual([]);
	});

	it('propagates a corrupt registry as the registry error (mapped to 500 with its fix), never as an empty list', () => {
		fs.mkdirSync(world.registryDir, { recursive: true });
		fs.writeFileSync(path.join(world.registryDir, 'registry.json'), '{not json');
		expect(() => openProject(undefined)).toThrow(/registry\.json/);
	});

	it('a projects.json next to the module config is not read: it lists nothing and fails on nothing, corrupt or not', () => {
		fs.mkdirSync(world.configDir, { recursive: true });
		fs.writeFileSync(path.join(world.configDir, 'projects.json'), '{not json');
		const error = failure(() => openProject(undefined));
		expect(error.status).toBe(404);
		expect(error.message).toContain('no project is registered');
	});
});

describe('listProjects', () => {
	it('reports each registered project with its open count and the link to its tasks page (by id)', async () => {
		const a = await world.createProject('alpha');
		const b = await world.createProject('beta');
		expect(listProjects()).toEqual([
			{
				id: a,
				name: 'alpha',
				path: world.dirOf(a),
				exists: true,
				openCount: 0,
				error: null,
				href: `/modules/task/tasks/p/${a}`,
			},
			{
				id: b,
				name: 'beta',
				path: world.dirOf(b),
				exists: true,
				openCount: 0,
				error: null,
				href: `/modules/task/tasks/p/${b}`,
			},
		]);
	});

	it('has none of the retired legacy fields', async () => {
		await world.createProject('alpha');
		const [listing] = listProjects();
		for (const field of ['registered', 'registryHint', 'initialized']) {
			expect(listing, field).not.toHaveProperty(field);
		}
	});

	it('counts only the non-terminal tasks as open', async () => {
		const id = await world.createProject('alpha', {
			configYml: 'statuses:\n  - backlog\n  - name: done\n    terminal: true\n',
		});
		const store = new TaskStore(path.join(world.dataDirOf(id), 'tasks'));
		store.create('open', 'backlog');
		store.create('closed', 'done');
		expect(listProjects()[0]).toMatchObject({ openCount: 1, error: null });
	});

	it('reports an unreadable project (corrupt config.yml) with its reason instead of a zero count', async () => {
		const id = await world.createProject('alpha', { configYml: 'statuses: [unclosed' });
		const [listing] = listProjects();
		expect(listing).toMatchObject({ id, path: world.dirOf(id), openCount: null, href: null });
		expect(listing!.error).toEqual(expect.any(String));
		expect(listing!.error).not.toBe('');
	});

	it('is empty when nothing is registered', () => {
		expect(listProjects()).toEqual([]);
	});

	it('ignores a projects.json next to the module config, corrupt or not', () => {
		fs.mkdirSync(world.configDir, { recursive: true });
		const stray = path.join(world.root, 'stray');
		fs.mkdirSync(stray);
		fs.writeFileSync(path.join(world.configDir, 'projects.json'), JSON.stringify([stray]));
		expect(listProjects()).toEqual([]);
		fs.writeFileSync(path.join(world.configDir, 'projects.json'), '{not json');
		expect(readProjects()).toEqual({ projects: [], registryProblem: null });
	});
});
