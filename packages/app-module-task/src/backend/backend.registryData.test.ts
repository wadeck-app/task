import * as fs from 'node:fs';
import * as path from 'node:path';

import type { ModuleContext, ModuleRouteHandler } from '@wadeck-app/app-core-sdk';
import { projectToolDir } from '@wadeck-app/project-sdk';

import { registerTaskRoutes } from './routes.js';
import { createRecordingSink, createTestWorld } from './testHelpers.js';
import type { RecordingSink, TestWorld } from './testHelpers.js';

// Stage 2a: the data and the config of a REGISTERED project live in the shared registry; the Projects page is a read-only list;
// the routes that edited the legacy list are gone; the last project is remembered by id.

interface Answer {
	status: number;
	body: Record<string, any>;
}

let world: TestWorld;
let sink: RecordingSink;
let routes: Map<string, ModuleRouteHandler>;
let moduleDataDir: string;

beforeEach(() => {
	world = createTestWorld();
	sink = createRecordingSink();
	routes = new Map();
	moduleDataDir = path.join(world.root, 'module-data');
	const ctx: ModuleContext = {
		dataDir: moduleDataDir,
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
	registerTaskRoutes(ctx, { configDir: world.configDir, eventSink: sink });
});

afterEach(() => world.cleanup());

async function call(
	route: string,
	request: { params?: Record<string, string>; query?: Record<string, unknown>; body?: unknown } = {}
): Promise<Answer> {
	const handler = routes.get(route);
	if (!handler) throw new Error(`route not registered: ${route}`);
	let result: Answer | undefined;
	const reply = {
		code: (status: number) => ({
			send: (body: unknown) => {
				result = { status, body: body as Record<string, any> };
				return body;
			},
		}),
	};
	await handler(
		{ params: request.params ?? {}, query: request.query ?? {}, body: request.body } as never,
		reply as never
	);
	if (result === undefined) throw new Error(`route ${route} answered nothing`);
	return result;
}

const dataDirOf = (id: string): string => projectToolDir(world.registryDir, id, 'task', 'data');
const configDirOf = (id: string): string => projectToolDir(world.registryDir, id, 'task', 'config');

describe('a registered project keeps its data and config in the shared registry', () => {
	it('a created task lands in <data>/tasks, the project folder stays clean, and the event keeps the main path as cwd', async () => {
		const dir = path.join(world.root, 'plain-dir');
		fs.mkdirSync(dir);
		const project = await world.registerShared('shop', dir);

		const created = await call('POST /tasks', { query: { project: 'shop' }, body: { description: 'first' } });
		const listed = await call('GET /tasks', { query: { project: project.id } });

		expect(created.status).toBe(201);
		expect(listed.body['tasks']).toHaveLength(1);
		expect(fs.readdirSync(path.join(dataDirOf(project.id), 'tasks'))).toHaveLength(1);
		expect(fs.existsSync(path.join(dir, '.task'))).toBe(false);
		expect(sink.events[0]!.payload).toMatchObject({
			taskProjectId: project.id,
			taskProjectPath: path.resolve(dir),
		});
	});

	it('POST /types writes the own config layer of the project, GET /types reads it', async () => {
		const dir = path.join(world.root, 'plain-dir');
		fs.mkdirSync(dir);
		const project = await world.registerShared('shop', dir);

		const added = await call('POST /types', { query: { project: 'shop' }, body: { name: 'bug' } });
		const listed = await call('GET /types', { query: { project: 'shop' } });

		expect(added.status).toBeLessThan(300);
		expect(JSON.stringify(listed.body)).toContain('bug');
		expect(fs.readFileSync(path.join(configDirOf(project.id), 'config.yml'), 'utf8')).toContain('bug');
		expect(fs.existsSync(path.join(dir, '.task'))).toBe(false);
	});

	it('a project with no task and no folder content is listed with 0 open tasks, and can take its first task', async () => {
		const dir = path.join(world.root, 'fresh-dir');
		fs.mkdirSync(dir);
		const project = await world.registerShared('fresh', dir);

		const projects = await call('GET /projects');
		const created = await call('POST /tasks', { query: { project: 'fresh' }, body: { description: 'first' } });

		expect(projects.body['projects']).toEqual([
			expect.objectContaining({ id: project.id, name: 'fresh', openCount: 0, error: null }),
		]);
		expect(created.status).toBe(201);
	});

	it('a virtual project (no folder) is not listed, and asking for it by name says why and what to use instead', async () => {
		await world.registerShared('notes', undefined);

		const projects = await call('GET /projects');
		const tasks = await call('GET /tasks', { query: { project: 'notes' } });

		expect(projects.body['projects']).toEqual([]);
		expect(tasks.status).toBe(409);
		expect(tasks.body['error']).toContain('notes');
		expect(tasks.body['error']).toContain('virtual');
		expect(tasks.body['hint']).toContain('task -p notes');
	});
});

describe('a folder of the project is never read for tasks or config', () => {
	it('tasks in <main path>/.task are not seen: the project is listed readable with 0 open tasks and answers its (empty) task list', async () => {
		const dir = path.join(world.root, 'shop-dir');
		fs.mkdirSync(path.join(dir, '.task', 'tasks'), { recursive: true });
		fs.writeFileSync(path.join(dir, '.task', 'tasks', 'abc12345.json'), '{}');
		fs.writeFileSync(path.join(dir, '.task', 'config.yml'), 'types:\n  - bug\n');
		const project = await world.registerShared('shop', dir);

		const projects = await call('GET /projects');
		const tasks = await call('GET /tasks', { query: { project: 'shop' } });

		expect(projects.body['projects']).toEqual([
			expect.objectContaining({ id: project.id, openCount: 0, error: null }),
		]);
		expect(tasks.status).toBe(200);
		expect(tasks.body['tasks']).toEqual([]);
		expect(fs.readdirSync(path.join(dir, '.task', 'tasks'))).toEqual(['abc12345.json']);
	});
});

describe('the Projects page is a read-only list', () => {
	it('GET /projects lists the registry projects with id, name, main path and open count; no marker, no registry column, no form data', async () => {
		const registeredDir = path.join(world.root, 'reg-dir');
		fs.mkdirSync(registeredDir);
		const project = await world.registerShared('shop', registeredDir);

		const answer = await call('GET /projects', { query: { page: 'projects' } });

		expect(answer.body['projectRows']).toEqual([
			{ id: project.id, name: 'shop', path: path.resolve(registeredDir), openText: '0', problemText: '' },
		]);
		for (const removed of ['projectForm', 'modeOptions', 'manageRows', 'registryNotice']) {
			expect(answer.body, removed).not.toHaveProperty(removed);
		}
	});

	it.each([['POST /projects'], ['POST /projects/relocate'], ['POST /projects/remove']])('%s is gone', route => {
		expect(routes.has(route)).toBe(false);
	});

	it('the module creates no projects.json next to its config', async () => {
		const dir = path.join(world.root, 'reg-dir');
		fs.mkdirSync(dir);
		await world.registerShared('shop', dir);

		await call('GET /projects');
		await call('GET /summary');
		await call('POST /tasks', { query: { project: 'shop' }, body: { description: 'x' } });

		expect(fs.existsSync(path.join(world.configDir, 'projects.json'))).toBe(false);
	});

	it('with nothing registered, the hint points to the project CLI, not to task init nor to a form that no longer exists', async () => {
		const answer = await call('GET /projects', { query: { page: 'projects' } });

		expect(answer.body['noProjects']).toBe(true);
		expect(answer.body['noProjectsText']).toContain('project add');
		expect(answer.body['noProjectsText']).not.toContain('task init');
		expect(answer.body['noProjectsText']).not.toContain('form below');
	});
});

describe('the last project is remembered by id', () => {
	const lastFile = (): string => path.join(moduleDataDir, 'last-project.json');

	it('writes the id of the registered project a task was created in, and preselects it on the New task page', async () => {
		const a = path.join(world.root, 'a');
		const b = path.join(world.root, 'b');
		fs.mkdirSync(a);
		fs.mkdirSync(b);
		await world.registerShared('alpha', a);
		const beta = await world.registerShared('beta', b);

		await call('POST /tasks', { query: { project: 'beta' }, body: { description: 'x' } });
		const projects = await call('GET /projects');

		expect(JSON.parse(fs.readFileSync(lastFile(), 'utf8'))).toEqual({ id: beta.id });
		expect(projects.body['forms'].create.projectParam).toBe(beta.id);
		expect(projects.body['lastProjectProblem']).toBeNull();
	});

	it('a file without an id (for example one holding only a path) is shown as a problem; nothing is preselected', async () => {
		const a = path.join(world.root, 'a');
		const b = path.join(world.root, 'b');
		fs.mkdirSync(a);
		fs.mkdirSync(b);
		await world.registerShared('alpha', a);
		await world.registerShared('beta', b);
		fs.mkdirSync(moduleDataDir, { recursive: true });
		fs.writeFileSync(lastFile(), JSON.stringify({ path: a }));

		const projects = await call('GET /projects');

		expect(projects.body['lastProjectProblem']).toContain('last-project.json');
		expect(projects.body['lastProjectProblem']).toContain('no "id" string');
		expect(projects.body['forms'].create.projectParam).toBe('');
	});
});
