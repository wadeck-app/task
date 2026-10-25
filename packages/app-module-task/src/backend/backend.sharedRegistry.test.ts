import * as fs from 'node:fs';
import * as path from 'node:path';

import type { ModuleContext, ModuleRouteHandler } from '@wadeck-app/app-core-sdk';

import { registerTaskRoutes } from './routes.js';
import { createRecordingSink, createTestWorld } from './testHelpers.js';
import type { RecordingSink, TestWorld } from './testHelpers.js';

// The shared project registry is the only list of projects of the module: `?project=<id|name|alias>`, ids in page addresses, a
// registry that is missing or corrupt never blanks a page, and a projects.json next to the config is ignored.

interface Answer {
	status: number;
	body: Record<string, any>;
}

let world: TestWorld;
let sink: RecordingSink;
let routes: Map<string, ModuleRouteHandler>;

beforeEach(() => {
	world = createTestWorld();
	sink = createRecordingSink();
	routes = new Map();
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

function corruptRegistry(): void {
	fs.mkdirSync(world.registryDir, { recursive: true });
	fs.writeFileSync(path.join(world.registryDir, 'registry.json'), '{ nope');
}

describe('?project=<id|name|alias>', () => {
	it('opens a registered project by id, name, alias and id prefix', async () => {
		const dir = world.createFolder('shop-dir');
		const project = await world.registerShared('shop', dir, ['store']);
		await call('POST /tasks', { query: { project: project.id }, body: { description: 'first' } });

		for (const ref of [project.id, project.id.slice(0, 4), 'shop', 'SHOP', 'store']) {
			const answer = await call('GET /tasks', { query: { project: ref } });
			expect(answer.status, ref).toBe(200);
			expect(answer.body['tasks'], ref).toHaveLength(1);
		}
	});

	it('the absolute directory of a registered project is no project reference: 404 no project matches, with a hint naming id, name or alias', async () => {
		const dir = world.createFolder('shop-dir');
		await world.registerShared('shop', dir, ['store']);

		const answer = await call('GET /tasks', { query: { project: dir } });

		expect(answer.status).toBe(404);
		expect(answer.body['error']).toContain('no project matches');
		expect(answer.body['error']).toContain(dir);
		expect(answer.body['hint']).toContain('id, name or alias');
		expect(answer.body['hint']).not.toContain('no longer accepted');
		expect(answer.body['hint']).toContain('/api/modules/task/projects');
	});

	it('a name~hex slug is refused the same way, also on a mutation', async () => {
		const dir = world.createFolder('shop-dir');
		await world.registerShared('shop', dir);

		for (const [route, extra] of [
			['GET /tasks', {}],
			['POST /tasks', { body: { description: 'x' } }],
		] as const) {
			const answer = await call(route, { query: { project: 'shop-dir~0a1b2c' }, ...extra });
			expect(answer.status, route).toBe(404);
			expect(answer.body['error'], route).toContain('no project matches');
			expect(answer.body['error'], route).toContain('shop-dir~0a1b2c');
			expect(answer.body['hint'], route).toContain('id, name or alias');
			expect(answer.body['hint'], route).not.toContain('no longer accepted');
		}
		expect(sink.events).toEqual([]);
	});

	it('the project of a mutation is the registry one: the events carry taskProjectId and the registry name', async () => {
		const dir = world.createFolder('shop-dir');
		const project = await world.registerShared('shop', dir);

		await call('POST /tasks', { query: { project: 'shop' }, body: { description: 'first' } });

		expect(sink.events).toHaveLength(1);
		expect(sink.events[0]!.payload).toMatchObject({
			taskProjectId: project.id,
			taskProjectName: 'shop',
			taskProjectPath: path.resolve(dir),
		});
	});

	it('an unknown name is a 404 with the registry suggestions and a hint naming id, name or alias; the projects are not guessed', async () => {
		await world.registerShared('shop', world.createFolder('shop-dir'));

		const answer = await call('GET /tasks', { query: { project: 'shpo' } });

		expect(answer.status).toBe(404);
		expect(answer.body['error']).toContain("no project matches 'shpo'");
		expect(answer.body['error']).toContain('did you mean: shop');
		expect(answer.body['hint']).toContain('id, name or alias');
		expect(answer.body['suggestions']).toEqual([
			{ text: 'shop', project: expect.objectContaining({ name: 'shop' }) },
		]);
	});

	it('an ambiguous id prefix is a 409 listing the candidates', async () => {
		fs.mkdirSync(world.registryDir, { recursive: true });
		const entry = (id: string, name: string): object => ({
			id,
			name,
			aliases: [],
			paths: [],
			createdAt: '2026-10-24T00:00:00.000Z',
		});
		fs.writeFileSync(
			path.join(world.registryDir, 'registry.json'),
			JSON.stringify({ schemaVersion: 1, projects: [entry('abcd0001', 'first'), entry('abcd0002', 'second')] })
		);

		const answer = await call('GET /tasks', { query: { project: 'abcd' } });

		expect(answer.status).toBe(409);
		expect(answer.body['candidates']).toEqual([
			{ id: 'abcd0001', name: 'first' },
			{ id: 'abcd0002', name: 'second' },
		]);
	});

	it('a virtual project is refused naming it (the module addresses projects by folder; the CLI works on it with -p)', async () => {
		await world.registerShared('config-only');

		const answer = await call('GET /tasks', { query: { project: 'config-only' } });

		expect(answer.status).toBe(409);
		expect(answer.body['error']).toContain('config-only');
		expect(answer.body['hint']).toContain('task -p config-only');
	});

	it('a registered project whose main path has no .task is a fresh project (its data is in the registry): empty, not an error', async () => {
		const dir = path.join(world.root, 'bare');
		fs.mkdirSync(dir);
		await world.registerShared('bare', dir);

		const answer = await call('GET /tasks', { query: { project: 'bare' } });

		expect(answer.status).toBe(200);
		expect(answer.body['tasks']).toEqual([]);
	});

	it('the only project is used without ?project, wherever it is registered', async () => {
		const dir = world.createFolder('shop-dir');
		await world.registerShared('shop', dir);

		const answer = await call('GET /tasks');

		expect(answer.status).toBe(200);
	});
});

describe('GET /projects: the projects of the shared registry', () => {
	it('lists the registry project: id, registry name, path, the id in its link', async () => {
		const shared = world.createFolder('shared-dir');
		const project = await world.registerShared('shop', shared);

		const { body } = await call('GET /projects');

		const [first] = body['projects'] as Array<Record<string, any>>;
		expect(first).toMatchObject({
			id: project.id,
			name: 'shop',
			path: path.resolve(shared),
			href: `/modules/task/tasks/p/${project.id}`,
		});
	});

	it('the Projects table lists id, name, main path and open count, with no registry column', async () => {
		const shared = world.createFolder('shared-dir');
		const project = await world.registerShared('shop', shared);
		await call('POST /tasks', { query: { project: project.id }, body: { description: 'one' } });

		const { body } = await call('GET /projects');

		expect(body['projectRows']).toEqual([
			{ id: project.id, name: 'shop', path: path.resolve(shared), openText: '1', problemText: '' },
		]);
	});

	it('page references: the id, the name, the alias and an id prefix select the project', async () => {
		const shared = world.createFolder('shared-dir');
		const project = await world.registerShared('shop', shared, ['store']);

		for (const ref of [project.id, project.id.slice(0, 4), 'shop', 'store']) {
			const { body } = await call('GET /projects', { query: { project: ref } });
			expect(body['selectedText'], ref).toBe('Project: shop');
			expect(body['unknownProjectText'], ref).toBeNull();
			// The API reference the views send is the id, not the directory.
			expect(body['selectedParam'], ref).toBe(project.id);
			expect(body['projectQuery'], ref).toBe(`project=${project.id}`);
		}
	});

	it('an old slug and an absolute directory are unknown projects on the page, with the unknown-project text', async () => {
		const shared = world.createFolder('shared-dir');
		await world.registerShared('shop', shared);

		for (const ref of ['shared-dir~0a1b2c', shared]) {
			const { body } = await call('GET /projects', { query: { project: ref } });
			expect(body['unknownProjectText'], ref).toContain(
				`Project "${ref}" is not registered with the task app-module`
			);
			expect(body['selectedText'], ref).toBeNull();
			expect(body['projectQuery'], ref).toBe('blank=true');
			expect(body['scopeQuery'], ref).toBe('blank=true');
		}
	});

	it('an unknown reference is said on the page, with the suggestions', async () => {
		await world.registerShared('shop', world.createFolder('shared-dir'));

		const { body } = await call('GET /projects', { query: { project: 'shpo' } });

		expect(body['unknownProjectText']).toContain('shpo');
		expect(body['unknownProjectText']).toContain('shop');
		expect(body['selectedText']).toBeNull();
	});

	it('a missing registry is the first-use state: no project, the next step, and no registry problem', async () => {
		const { body } = await call('GET /projects');

		expect(fs.existsSync(world.registryDir)).toBe(false);
		expect(body['projects']).toEqual([]);
		expect(body['noProjects']).toBe(true);
		expect(body['noProjectsText']).toContain('project add');
		expect(body['registryProblem']).toBeNull();
	});

	it('a corrupt registry never blanks the page: 200, no project, and the problem with the file', async () => {
		corruptRegistry();

		const { status, body } = await call('GET /projects');

		expect(status).toBe(200);
		expect(body['projects']).toEqual([]);
		expect(body['registryProblem']).toContain('registry.json');
		expect(body['registryProblem']).toContain('could not be read');
	});

	it('the module never writes registry.json: only the data folder of the project it works on appears (tool data, not the registry)', async () => {
		const shared = world.createFolder('shared-dir');
		await world.registerShared('shop', shared);
		const file = path.join(world.registryDir, 'registry.json');
		const before = fs.readFileSync(file, 'utf8');
		const mtime = fs.statSync(file).mtimeMs;

		await call('GET /projects');
		await call('GET /summary');
		await call('POST /tasks', { query: { project: 'shop' }, body: { description: 'x' } });
		await call('GET /tasks', { query: { allProjects: 'true' } });

		expect(fs.readFileSync(file, 'utf8')).toBe(before);
		expect(fs.statSync(file).mtimeMs).toBe(mtime);
		expect(fs.readdirSync(world.registryDir).sort()).toEqual(['projects', 'registry.json']);
		expect(fs.existsSync(path.join(world.registryDir, 'registry.lock'))).toBe(false);
	});
});

describe('a corrupt registry on a project route is an inline error with the fix, never a blank page', () => {
	it('?project=<name>: the registry error (500) with the file; with inlineErrors a 200 the view can show', async () => {
		corruptRegistry();

		const plain = await call('GET /tasks', { query: { project: 'shop' } });
		const inline = await call('GET /tasks', { query: { project: 'shop', inlineErrors: 'true' } });

		expect(plain.status).toBe(500);
		expect(plain.body['error']).toContain('registry.json');
		expect(inline.status).toBe(200);
		expect(inline.body).toMatchObject({ failed: true, httpStatus: 500 });
		expect(inline.body['errorText']).toContain('registry.json');
	});
});

describe('a corrupt registry without ?project is not read as "no project registered"', () => {
	it('answers 500 naming the registry file and what to do, also inline for the views', async () => {
		corruptRegistry();

		const plain = await call('GET /tasks');
		const inline = await call('GET /tasks', { query: { inlineErrors: 'true' } });

		expect(plain.status).toBe(500);
		expect(plain.body['error']).toContain('registry.json');
		expect(plain.body['hint']).toContain('project CLI');
		expect(inline.body).toMatchObject({ failed: true, httpStatus: 500 });
		expect(inline.body['errorText']).toContain('registry.json');
	});
});

describe('the cross-project views with the shared registry', () => {
	it('GET /summary: one row per registered project, linking by id, with no registered marker nor registry hint', async () => {
		const shared = world.createFolder('shared-dir');
		const project = await world.registerShared('shop', shared);
		await call('POST /tasks', { query: { project: project.id }, body: { description: 'one' } });

		const { body } = await call('GET /summary');

		expect(body['projectRows']).toEqual([
			expect.objectContaining({
				name: 'shop',
				openText: '1',
				href: `/modules/task/tasks/p/${project.id}`,
			}),
		]);
		expect(body['registryProblem']).toBeNull();
	});

	it('GET /summary?project=<name> summarises the registry project, with its id', async () => {
		const shared = world.createFolder('shared-dir');
		await world.registerShared('shop', shared);

		const { body } = await call('GET /summary', { query: { project: 'shop' } });

		expect(body['scope']).toBe('project');
		const [row] = body['projectRows'] as Array<Record<string, any>>;
		expect(row).toMatchObject({ name: 'shop' });
		expect(row).not.toHaveProperty('registered');
	});

	it('GET /tasks?allProjects=true tags the rows with the registry name and links the detail page by id', async () => {
		const shared = world.createFolder('shared-dir');
		const project = await world.registerShared('shop', shared);
		const created = await call('POST /tasks', { query: { project: project.id }, body: { description: 'one' } });
		const taskId = created.body['task'].id as string;

		const { body } = await call('GET /tasks', { query: { allProjects: 'true' } });

		expect(body['tasks']).toEqual([
			expect.objectContaining({ projectName: 'shop', href: `/modules/task/tasks/p/${project.id}/${taskId}` }),
		]);
	});

	it('the Tree, Types views and the create form use the id as project reference', async () => {
		const shared = world.createFolder('shared-dir');
		const project = await world.registerShared('shop', shared);

		const types = await call('GET /types', { query: { allProjects: 'true' } });
		const projects = await call('GET /projects');

		expect(types.body['projectOptions']).toEqual([{ value: project.id, label: 'shop' }]);
		expect(projects.body['projectOptions']).toEqual([{ value: project.id, label: 'shop' }]);
		expect(projects.body['forms'].create.projectParam).toBe(project.id);
	});

	it('a task created in a registered project answers a detail link with the id', async () => {
		const shared = world.createFolder('shared-dir');
		const project = await world.registerShared('shop', shared);

		const created = await call('POST /tasks', { query: { project: project.id }, body: { description: 'one' } });

		expect(created.body['href']).toBe(`/modules/task/tasks/p/${project.id}/${created.body['task'].id}`);
	});

	it('a corrupt registry does not stop the summary: 200, no project, and registryProblem says why', async () => {
		corruptRegistry();

		const { status, body } = await call('GET /summary');

		expect(status).toBe(200);
		expect(body['projectRows']).toEqual([]);
		expect(body['registryProblem']).toContain('registry.json');
		expect(body['registryProblem']).toContain('could not be read');
	});
});
