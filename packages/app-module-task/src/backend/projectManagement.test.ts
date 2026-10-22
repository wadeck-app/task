import * as fs from 'node:fs';
import * as path from 'node:path';

import type { ModuleContext, ModuleRouteHandler } from '@wadeck-app/app-core-sdk';
import { listRegisteredProjects, projectsRegistryPath } from '@wadeck-app/task-service';

import { registerTaskRoutes } from './routes.js';
import { createRecordingSink, createTestWorld } from './testHelpers.js';
import type { TestWorld } from './testHelpers.js';

interface Answer {
	status: number;
	body: Record<string, any>;
}

interface Harness {
	world: TestWorld;
	stderr: string[];
	call(route: string, request?: { query?: Record<string, unknown>; body?: unknown }): Promise<Answer>;
}

function setup(): Harness {
	const world = createTestWorld();
	const routes = new Map<string, ModuleRouteHandler>();
	const stderr: string[] = [];
	const ctx: ModuleContext = {
		dataDir: path.join(world.root, 'module-data'),
		setInterval: vi.fn(),
		setTimeout: vi.fn(),
		clearInterval: vi.fn(),
		clearTimeout: vi.fn(),
		on: vi.fn(),
		off: vi.fn(),
		emit: vi.fn(),
		registerRoute: (method, subPath, handler) => routes.set(`${method} ${subPath}`, handler),
		dispose: vi.fn(),
	};
	registerTaskRoutes(ctx, {
		configDir: world.configDir,
		eventSink: createRecordingSink(),
		writeStderr: text => void stderr.push(text),
	});
	return {
		world,
		stderr,
		async call(route, request = {}) {
			const handler = routes.get(route);
			if (!handler) throw new Error(`route not registered: ${route}`);
			let status = 0;
			let body: unknown;
			const reply = {
				code: (n: number) => {
					status = n;
					return {
						send: (payload: unknown) => {
							body = payload;
							return payload;
						},
					};
				},
			};
			await handler({ params: {}, query: request.query ?? {}, body: request.body } as never, reply as never);
			if (status === 0) throw new Error(`route ${route} answered nothing`);
			return { status, body: body as Record<string, any> };
		},
	};
}

let h: Harness;
beforeEach(() => {
	h = setup();
});
afterEach(() => h.world.cleanup());

/** An initialised project directory that is NOT registered. */
function unregistered(name: string): string {
	return h.world.createProject(name, { register: false });
}

describe('POST /projects (add: register an existing project, or initialise a new one)', () => {
	it('registers an existing task project: 201, the message, and the refreshed list', async () => {
		const dir = unregistered('existing');
		const answer = await h.call('POST /projects', { body: { path: dir, mode: 'register' } });
		expect(answer.status).toBe(201);
		expect(answer.body).toMatchObject({ path: dir, mode: 'register', added: true, initialized: false });
		expect(answer.body['messageText']).toContain(dir);
		expect(answer.body['messageText']).toContain('Registered');
		expect((answer.body['projects'] as Array<{ path: string }>).map(p => p.path)).toEqual([dir]);
		expect(listRegisteredProjects(h.world.configDir)).toEqual([dir]);
	});

	it('registering twice is a 200 that says it was already registered', async () => {
		const dir = unregistered('existing');
		await h.call('POST /projects', { body: { path: dir, mode: 'register' } });
		const again = await h.call('POST /projects', { body: { path: dir, mode: 'register' } });
		expect(again.status).toBe(200);
		expect(again.body['added']).toBe(false);
		expect(again.body['messageText']).toContain('already registered');
	});

	it('initialises a new project in an existing directory and registers it', async () => {
		const dir = path.join(h.world.root, 'fresh');
		fs.mkdirSync(dir);
		const answer = await h.call('POST /projects', { body: { path: dir, mode: 'init' } });
		expect(answer.status).toBe(201);
		expect(answer.body['initialized']).toBe(true);
		expect(answer.body['messageText']).toContain('Initialised');
		expect(fs.existsSync(path.join(dir, '.task', 'config.yml'))).toBe(true);
		expect(listRegisteredProjects(h.world.configDir)).toEqual([dir]);
	});

	it('creates the directory only with createDirectory, and says so', async () => {
		const dir = path.join(h.world.root, 'brand-new');
		const refused = await h.call('POST /projects', { body: { path: dir, mode: 'init' } });
		expect(refused.status).toBe(400);
		expect(refused.body['error']).toContain('does not exist');
		expect(refused.body['hint']).toContain('Create the directory');
		expect(fs.existsSync(dir)).toBe(false);
		const created = await h.call('POST /projects', { body: { path: dir, mode: 'init', createDirectory: true } });
		expect(created.status).toBe(201);
		expect(created.body['createdDirectory']).toBe(true);
		expect(created.body['messageText']).toContain('created the directory');
	});

	it('refuses a createDirectory that is not a boolean (a "false" text would otherwise be truthy)', async () => {
		const dir = path.join(h.world.root, 'x');
		const answer = await h.call('POST /projects', { body: { path: dir, mode: 'init', createDirectory: 'false' } });
		expect(answer.status).toBe(400);
		expect(answer.body['error']).toContain('createDirectory must be true or false');
		expect(fs.existsSync(dir)).toBe(false);
	});

	it.each([
		['a relative path', { path: 'some/dir', mode: 'register' }, 'is not absolute'],
		['a NUL byte', { path: 'C:\\x\0y', mode: 'register' }, 'NUL'],
		['no path', { mode: 'register' }, 'non-empty'],
		['an unknown mode', { path: '/x', mode: 'nuke' }, 'mode must be'],
	])('answers 400 with an actionable message for %s', async (_label, body, text) => {
		const answer = await h.call('POST /projects', { body });
		expect(answer.status).toBe(400);
		expect(answer.body['error']).toContain(text);
		expect(answer.body['hint']).toBeTruthy();
	});

	it('answers 400 for a body that is not an object', async () => {
		const answer = await h.call('POST /projects', { body: 'nope' });
		expect(answer.status).toBe(400);
	});

	it('a directory that is not a task project: 400 offering the init mode, nothing created', async () => {
		const dir = path.join(h.world.root, 'bare');
		fs.mkdirSync(dir);
		const answer = await h.call('POST /projects', { body: { path: dir, mode: 'register' } });
		expect(answer.status).toBe(400);
		expect(answer.body['hint']).toContain('initialise a new task project');
		expect(fs.existsSync(path.join(dir, '.task'))).toBe(false);
	});

	it('as an inline error (?inlineErrors=true) the failure is data: 200, failed, httpStatus and errorText', async () => {
		const answer = await h.call('POST /projects', {
			query: { inlineErrors: 'true' },
			body: { path: 'rel', mode: 'register' },
		});
		expect(answer.status).toBe(200);
		expect(answer.body).toMatchObject({ failed: true, httpStatus: 400 });
		expect(answer.body['errorText']).toContain('is not absolute');
	});

	it('a corrupt registry is a 500 that is logged, and the registry file is left alone', async () => {
		fs.mkdirSync(h.world.configDir, { recursive: true });
		fs.writeFileSync(projectsRegistryPath(h.world.configDir), '{not json');
		const dir = unregistered('p');
		const answer = await h.call('POST /projects', { body: { path: dir, mode: 'register' } });
		expect(answer.status).toBe(500);
		expect(answer.body['error']).toContain('projects registry');
		expect(answer.body['hint']).toContain('Fix or delete');
		expect(h.stderr.join('')).toContain('/projects');
		expect(fs.readFileSync(projectsRegistryPath(h.world.configDir), 'utf8')).toBe('{not json');
	});
});

describe('POST /projects/relocate (edit: the project moved, or was registered with a wrong path)', () => {
	it('replaces the registered directory by the new one and answers the refreshed list', async () => {
		const old = h.world.createProject('old');
		const next = unregistered('next');
		const answer = await h.call('POST /projects/relocate', { body: { from: old, to: next } });
		expect(answer.status).toBe(200);
		expect(answer.body).toMatchObject({ from: old, to: next });
		expect(answer.body['messageText']).toContain(old);
		expect(answer.body['messageText']).toContain(next);
		expect((answer.body['projects'] as Array<{ path: string }>).map(p => p.path)).toEqual([next]);
		expect(listRegisteredProjects(h.world.configDir)).toEqual([next]);
		expect(fs.existsSync(path.join(old, '.task'))).toBe(true);
	});

	it('recovers a project whose directory vanished', async () => {
		const old = h.world.createProject('old');
		fs.rmSync(old, { recursive: true });
		const next = unregistered('next');
		const answer = await h.call('POST /projects/relocate', { body: { from: old, to: next } });
		expect(answer.status).toBe(200);
		expect(listRegisteredProjects(h.world.configDir)).toEqual([next]);
	});

	it('404 when the project is not registered, 409 when the target is, 400 when the target is not a task project', async () => {
		const a = h.world.createProject('a');
		const b = h.world.createProject('b');
		const stranger = unregistered('stranger');
		const bare = path.join(h.world.root, 'bare');
		fs.mkdirSync(bare);
		const unknown = await h.call('POST /projects/relocate', { body: { from: stranger, to: a } });
		expect(unknown.status).toBe(404);
		expect(unknown.body['error']).toContain('is not registered');
		const clash = await h.call('POST /projects/relocate', { body: { from: a, to: b } });
		expect(clash.status).toBe(409);
		expect(clash.body['error']).toContain('is already registered');
		const notProject = await h.call('POST /projects/relocate', { body: { from: a, to: bare } });
		expect(notProject.status).toBe(400);
		expect(notProject.body['error']).toContain('not an initialized task project');
		expect(listRegisteredProjects(h.world.configDir)).toEqual([a, b]);
	});

	it('requires from and to', async () => {
		const answer = await h.call('POST /projects/relocate', { body: { from: '/x' } });
		expect(answer.status).toBe(400);
		expect(answer.body['error']).toContain('to must be a non-empty string');
	});

	it('an inline failure keeps the edit form open with what was typed (the form is given the answer as its data)', async () => {
		const a = h.world.createProject('a');
		const bare = path.join(h.world.root, 'bare');
		fs.mkdirSync(bare);
		const answer = await h.call('POST /projects/relocate', {
			query: { inlineErrors: 'true' },
			body: { from: a, to: bare },
		});
		expect(answer.status).toBe(200);
		expect(answer.body).toMatchObject({ failed: true, httpStatus: 400, from: a, to: bare });
		expect(answer.body['editPrompt']).toContain(a);
		expect(answer.body['errorText']).toContain('not an initialized task project');
	});
});

describe('POST /projects/remove (unregister only: the tasks stay on disk)', () => {
	it('without confirm: 400 describing what would happen, nothing removed', async () => {
		const dir = h.world.createProject('a');
		const answer = await h.call('POST /projects/remove', { body: { path: dir } });
		expect(answer.status).toBe(400);
		expect(answer.body['error']).toContain('confirm must be true');
		expect(answer.body['error']).toContain('nothing was removed');
		expect(answer.body['hint']).toContain('stay on disk');
		expect(answer.body['hint']).toContain(dir);
		expect(listRegisteredProjects(h.world.configDir)).toEqual([dir]);
	});

	it('only a boolean true confirms (the text "true" does not)', async () => {
		const dir = h.world.createProject('a');
		const answer = await h.call('POST /projects/remove', { body: { path: dir, confirm: 'true' } });
		expect(answer.status).toBe(400);
		expect(listRegisteredProjects(h.world.configDir)).toEqual([dir]);
	});

	it('with confirm: unregisters, NEVER deletes the .task data, and says so', async () => {
		const dir = h.world.createProject('a');
		const other = h.world.createProject('b');
		fs.writeFileSync(path.join(dir, '.task', 'tasks', 'keep.md'), 'data');
		const answer = await h.call('POST /projects/remove', { body: { path: dir, confirm: true } });
		expect(answer.status).toBe(200);
		expect(answer.body['removed']).toBe(dir);
		expect(answer.body['messageText']).toContain('stay on disk');
		expect((answer.body['projects'] as Array<{ path: string }>).map(p => p.path)).toEqual([other]);
		expect(listRegisteredProjects(h.world.configDir)).toEqual([other]);
		expect(fs.readFileSync(path.join(dir, '.task', 'tasks', 'keep.md'), 'utf8')).toBe('data');
	});

	it('removes a project whose directory vanished', async () => {
		const dir = h.world.createProject('a');
		fs.rmSync(dir, { recursive: true });
		const answer = await h.call('POST /projects/remove', { body: { path: dir, confirm: true } });
		expect(answer.status).toBe(200);
		expect(listRegisteredProjects(h.world.configDir)).toEqual([]);
	});

	it('404 for a project that is not registered (also without confirm: no point asking), 400 for a relative path', async () => {
		const stranger = unregistered('stranger');
		const unknown = await h.call('POST /projects/remove', { body: { path: stranger } });
		expect(unknown.status).toBe(404);
		const relative = await h.call('POST /projects/remove', { body: { path: 'rel', confirm: true } });
		expect(relative.status).toBe(400);
	});
});

describe('GET /projects: data of the Projects page forms and table', () => {
	it('always gives the add form (also with no project), its mode options, and a welcome text naming the page', async () => {
		const answer = await h.call('GET /projects');
		expect(answer.body['noProjects']).toBe(true);
		expect(answer.body['forms']).toBeNull();
		expect(answer.body['projectForm']).toEqual({ path: '', mode: 'register', createDirectory: false });
		const options = answer.body['modeOptions'] as Array<{ value: string; label: string }>;
		expect(options.map(o => o.value)).toEqual(['register', 'init']);
		expect(answer.body['noProjectsText']).toContain('Projects page');
		expect(answer.body['noProjectsText']).toContain('task init');
		expect(answer.body['manageRows']).toEqual([]);
		expect(answer.body['hasOpenLinks']).toBe(false);
	});

	it('gives one row per project carrying everything the Edit and Remove steps send', async () => {
		const dir = h.world.createProject('alpha');
		const answer = await h.call('GET /projects');
		const [row] = answer.body['manageRows'] as Array<Record<string, unknown>>;
		expect(row).toMatchObject({
			name: 'alpha',
			path: dir,
			from: dir,
			to: dir,
			confirm: true,
			needsRepair: false,
			openText: '0',
			problemText: '',
		});
		expect(row!['editPrompt']).toContain('alpha');
		expect(row!['confirmText']).toContain('only unregisters');
		expect(row!['confirmText']).toContain('stay on disk');
		expect(row!['confirmLabel']).toContain('alpha');
		expect(answer.body['attentionText']).toBeNull();
	});

	it('flags a vanished or uninitialised project for repair, with the fix, and a banner counting them', async () => {
		const gone = h.world.createProject('gone');
		const bare = h.world.createProject('bare');
		h.world.createProject('fine');
		fs.rmSync(gone, { recursive: true });
		fs.rmSync(path.join(bare, '.task'), { recursive: true });
		const answer = await h.call('GET /projects');
		const rows = answer.body['manageRows'] as Array<Record<string, any>>;
		const byName = Object.fromEntries(rows.map(r => [r['name'], r]));
		expect(byName['gone']).toMatchObject({ needsRepair: true, openText: '-' });
		expect(byName['gone']['problemText']).toContain('no longer exists');
		expect(byName['gone']['problemText']).toContain('Edit');
		expect(byName['gone']['problemText']).toContain('Remove');
		expect(byName['bare']).toMatchObject({ needsRepair: true });
		expect(byName['fine']).toMatchObject({ needsRepair: false });
		expect(answer.body['attentionText']).toContain('2 projects cannot be read');
	});

	it('links only the readable projects to their tasks (a table with row buttons cannot navigate by row click)', async () => {
		const ok = h.world.createProject('ok');
		const gone = h.world.createProject('gone');
		fs.rmSync(gone, { recursive: true });
		const answer = await h.call('GET /projects');
		expect(answer.body['hasOpenLinks']).toBe(true);
		const links = answer.body['openLinks'] as Array<Record<string, unknown>>;
		expect(links).toHaveLength(1);
		expect(links[0]).toMatchObject({ $type: 'ButtonLink', label: 'ok' });
		expect(String(links[0]!['to'])).toContain(encodeURIComponent(ok));
	});

	it('the unknown-project fix on the page names the Projects page, not only the CLI', async () => {
		const dir = h.world.createProject('a');
		fs.rmSync(dir, { recursive: true });
		const answer = await h.call('GET /projects', { query: { project: dir } });
		expect(answer.body['selectedProblem']).toContain('Projects page');
		expect(answer.body['selectedProblem']).toContain('task projects remove');
	});
});
