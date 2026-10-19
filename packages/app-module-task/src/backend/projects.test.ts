import * as fs from 'node:fs';
import * as path from 'node:path';

import { TaskStore } from '@wadeck-app/task-core';
import { projectsRegistryPath } from '@wadeck-app/task-service';

import { RequestError } from './errors.js';
import { listProjects, openProject } from './projects.js';
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
	it('opens a registered project given by ?project and builds a service context over its store', () => {
		const dir = world.createProject('alpha');
		const ctx = openProject(world.configDir, dir);
		expect(ctx.project).toEqual({ name: 'alpha', path: dir });
		expect(ctx.config.statuses).toEqual(['backlog', 'in-progress', 'done']);
		expect(ctx.store.list()).toEqual([]);
	});

	it('uses the configured statuses of the project', () => {
		const dir = world.createProject('alpha', {
			configYml: 'statuses:\n  - todo\n  - name: shipped\n    terminal: true\n',
		});
		expect(openProject(world.configDir, dir).config.terminalStatuses).toEqual(['shipped']);
	});

	it('uses the only registered project when the param is missing', () => {
		const dir = world.createProject('alpha');
		expect(openProject(world.configDir, undefined).project.path).toBe(dir);
	});

	it('400 when the param is missing and several projects are registered, listing them', () => {
		const a = world.createProject('alpha');
		const b = world.createProject('beta');
		const error = failure(() => openProject(world.configDir, undefined));
		expect(error.status).toBe(400);
		expect(error.extra).toEqual({ registeredProjects: [a, b] });
		expect(error.hint).toContain('?project=');
	});

	it('404 when the param is missing and nothing is registered, telling to run task init', () => {
		const error = failure(() => openProject(world.configDir, undefined));
		expect(error.status).toBe(404);
		expect(error.hint).toContain('task init');
	});

	it('404 for a project that is not registered, without listing the registered ones', () => {
		const registered = world.createProject('alpha');
		const other = world.createProject('other', { register: false });
		const error = failure(() => openProject(world.configDir, other));
		expect(error.status).toBe(404);
		expect(error.hint).toContain('task init');
		expect(JSON.stringify([error.message, error.hint, error.extra])).not.toContain(registered);
	});

	it('400 for a relative project path', () => {
		world.createProject('alpha');
		const error = failure(() => openProject(world.configDir, 'alpha'));
		expect(error.status).toBe(400);
		expect(error.message).toContain('absolute');
	});

	it('accepts a non-normalized spelling of a registered path', () => {
		const dir = world.createProject('alpha');
		expect(openProject(world.configDir, path.join(dir, 'x', '..') + path.sep).project.path).toBe(dir);
	});

	it('404 with a fix when the project is registered but its .task directory is gone', () => {
		const dir = world.createProject('alpha');
		fs.rmSync(path.join(dir, '.task'), { recursive: true });
		const error = failure(() => openProject(world.configDir, dir));
		expect(error.status).toBe(404);
		expect(error.message).toContain('not initialized');
		expect(error.hint).toContain('task init');
	});

	it('propagates a corrupt registry as the registry error (mapped to 500 with its fix), never as an empty list', () => {
		fs.mkdirSync(world.configDir, { recursive: true });
		fs.writeFileSync(projectsRegistryPath(world.configDir), '{not json');
		expect(() => openProject(world.configDir, undefined)).toThrow(/projects registry/);
	});
});

describe('listProjects', () => {
	it('reports each registered project with its initialization state, open count and the link to its tasks page', () => {
		const a = world.createProject('alpha');
		const b = world.createProject('beta');
		fs.rmSync(path.join(b, '.task'), { recursive: true });
		expect(listProjects(world.configDir)).toEqual([
			{
				name: 'alpha',
				path: a,
				exists: true,
				initialized: true,
				openCount: 0,
				error: null,
				href: `/modules/task/tasks?project=${encodeURIComponent(a)}`,
			},
			{
				name: 'beta',
				path: b,
				exists: true,
				initialized: false,
				openCount: null,
				error: expect.stringContaining('not initialized') as unknown,
				href: null,
			},
		]);
	});

	it('counts only the non-terminal tasks as open', () => {
		const dir = world.createProject('alpha', {
			configYml: 'statuses:\n  - backlog\n  - name: done\n    terminal: true\n',
		});
		const store = new TaskStore(path.join(dir, '.task', 'tasks'));
		store.create('open', 'backlog');
		store.create('closed', 'done');
		expect(listProjects(world.configDir)[0]).toMatchObject({ openCount: 1, error: null });
	});

	it('reports an unreadable project (corrupt config.yml) with its reason instead of a zero count', () => {
		const dir = world.createProject('alpha', { configYml: 'statuses: [unclosed' });
		const [listing] = listProjects(world.configDir);
		expect(listing).toMatchObject({ path: dir, initialized: true, openCount: null, href: null });
		expect(listing!.error).toEqual(expect.any(String));
		expect(listing!.error).not.toBe('');
	});

	it('is empty when nothing is registered', () => {
		expect(listProjects(world.configDir)).toEqual([]);
	});
});
