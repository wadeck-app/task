import * as fs from 'node:fs';
import * as path from 'node:path';

import type { ModuleContext, ModuleRouteHandler } from '@wadeck-app/app-core-sdk';

import { projectSlug } from './projectRef.js';
import { registerTaskRoutes } from './routes.js';
import { createRecordingSink, createTestWorld } from './testHelpers.js';
import type { RecordingSink, TestWorld } from './testHelpers.js';

// Stage 1 of the shared project registry in the module: `?project=<id|name|alias>`, ids in page addresses, registered projects
// first, a visible hint on the others, and a registry that is missing or corrupt never blanks a page.

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

describe('?project=<id|name|alias> (the legacy absolute directory still works)', () => {
	it('opens a registered project by id, name, alias and id prefix, and by its directory', async () => {
		const dir = world.createProject('shop-dir', { register: false });
		const project = await world.registerShared('shop', dir, ['store']);
		await call('POST /tasks', { query: { project: project.id }, body: { description: 'first' } });

		for (const ref of [project.id, project.id.slice(0, 4), 'shop', 'SHOP', 'store', dir]) {
			const answer = await call('GET /tasks', { query: { project: ref } });
			expect(answer.status, ref).toBe(200);
			expect(answer.body['tasks'], ref).toHaveLength(1);
		}
	});

	it('the project of a mutation is the registry one: the events carry taskProjectId and the registry name', async () => {
		const dir = world.createProject('shop-dir', { register: false });
		const project = await world.registerShared('shop', dir);

		await call('POST /tasks', { query: { project: 'shop' }, body: { description: 'first' } });

		expect(sink.events).toHaveLength(1);
		expect(sink.events[0]!.payload).toMatchObject({
			taskProjectId: project.id,
			taskProjectName: 'shop',
			taskProjectPath: path.resolve(dir),
		});
	});

	it('an unknown reference is a 404 with the suggestions, the projects are not guessed', async () => {
		await world.registerShared('shop', world.createProject('shop-dir', { register: false }));

		const answer = await call('GET /tasks', { query: { project: 'shpo' } });

		expect(answer.status).toBe(404);
		expect(answer.body['error']).toContain("no project matches 'shpo'");
		expect(answer.body['error']).toContain('did you mean: shop');
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

	it('a virtual project is refused naming it (it has no .task to read)', async () => {
		await world.registerShared('config-only');

		const answer = await call('GET /tasks', { query: { project: 'config-only' } });

		expect(answer.status).toBe(400);
		expect(answer.body['error']).toContain('config-only');
	});

	it('a registered project whose main path has no .task is a 404 saying what to run', async () => {
		const dir = path.join(world.root, 'bare');
		fs.mkdirSync(dir);
		await world.registerShared('bare', dir);

		const answer = await call('GET /tasks', { query: { project: 'bare' } });

		expect(answer.status).toBe(404);
		expect(answer.body['error']).toContain('bare');
		expect(answer.body['hint']).toContain('task init');
	});

	it('the only project is used without ?project, wherever it is registered', async () => {
		const dir = world.createProject('shop-dir', { register: false });
		await world.registerShared('shop', dir);

		const answer = await call('GET /tasks');

		expect(answer.status).toBe(200);
	});
});

describe('GET /projects: registered projects first, the others marked', () => {
	it('lists the registry project (id, registry name, id in its link), then the legacy one with the hint to register it', async () => {
		const shared = world.createProject('shared-dir', { register: false });
		const legacy = world.createProject('legacy-dir');
		const project = await world.registerShared('shop', shared);

		const { body } = await call('GET /projects');

		const [first, second] = body['projects'] as Array<Record<string, any>>;
		expect(first).toMatchObject({
			id: project.id,
			name: 'shop',
			registered: true,
			path: path.resolve(shared),
			href: `/modules/task/tasks/p/${project.id}`,
		});
		expect(second).toMatchObject({
			name: 'legacy-dir',
			registered: false,
			path: legacy,
			href: `/modules/task/tasks/p/${projectSlug(legacy)}`,
		});
		expect(second).not.toHaveProperty('id');
		expect(second['registryHint']).toBe(`Not in the shared project registry: project add "${legacy}"`);
		expect(first['registryHint']).toBeNull();
		expect(body['registryNotice']).toContain(`project add "${legacy}"`);
		expect(body['registryNotice']).not.toContain('shared-dir');
	});

	it('the Projects table carries the registry column and refuses Edit/Remove on a registry project with the fix', async () => {
		const shared = world.createProject('shared-dir', { register: false });
		const project = await world.registerShared('shop', shared);
		const legacy = world.createProject('legacy-dir');

		const { body } = await call('GET /projects');

		const rows = body['manageRows'] as Array<Record<string, any>>;
		expect(rows[0]!['registryText']).toContain(project.id);
		expect(rows[1]!['registryText']).toContain(`project add "${legacy}"`);

		const removal = await call('POST /projects/remove', { body: { path: path.resolve(shared), confirm: true } });
		const relocation = await call('POST /projects/relocate', { body: { from: path.resolve(shared), to: legacy } });

		for (const answer of [removal, relocation]) {
			expect(answer.status).toBe(409);
			expect(answer.body['error']).toContain('shared project registry');
			expect(answer.body['hint']).toContain('project');
		}
		expect(removal.body['hint']).toContain('project remove');
		expect(relocation.body['hint']).toContain('project paths');
	});

	it('page references: the id (and the slug of an older link) select the project, the name too', async () => {
		const shared = world.createProject('shared-dir', { register: false });
		const project = await world.registerShared('shop', shared, ['store']);

		for (const ref of [project.id, projectSlug(shared), 'shop', 'store', shared]) {
			const { body } = await call('GET /projects', { query: { project: ref } });
			expect(body['selectedText'], ref).toBe('Project: shop');
			expect(body['unknownProjectText'], ref).toBeNull();
			// The API reference the views send is the id, not the directory.
			expect(body['selectedParam'], ref).toBe(project.id);
			expect(body['projectQuery'], ref).toBe(`project=${project.id}`);
		}
	});

	it('an unknown reference is said on the page, with the suggestions', async () => {
		await world.registerShared('shop', world.createProject('shared-dir', { register: false }));

		const { body } = await call('GET /projects', { query: { project: 'shpo' } });

		expect(body['unknownProjectText']).toContain('shpo');
		expect(body['unknownProjectText']).toContain('shop');
		expect(body['selectedText']).toBeNull();
	});

	it('a missing registry is the first-use state: legacy projects only, no notice about the registry itself', async () => {
		world.createProject('legacy-dir');

		const { body } = await call('GET /projects');

		expect(fs.existsSync(world.registryDir)).toBe(false);
		expect((body['projects'] as unknown[]).length).toBe(1);
		expect(body['registryNotice']).toContain('project add');
		expect(body['registryNotice']).not.toContain('could not be read');
	});

	it('a corrupt registry never blanks the page: 200, the legacy projects, and the problem with the file in the notice', async () => {
		world.createProject('legacy-dir');
		corruptRegistry();

		const { status, body } = await call('GET /projects');

		expect(status).toBe(200);
		expect((body['projects'] as unknown[]).length).toBe(1);
		expect(body['registryNotice']).toContain('registry.json');
		expect(body['registryNotice']).toContain('could not be read');
	});

	it('the module never writes the shared registry', async () => {
		const shared = world.createProject('shared-dir', { register: false });
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
		expect(fs.readdirSync(world.registryDir).sort()).toEqual(['registry.json']);
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

	it('the legacy directory and slug still open a legacy project while the registry is corrupt', async () => {
		const legacy = world.createProject('legacy-dir');
		corruptRegistry();

		const byDir = await call('GET /tasks', { query: { project: legacy } });
		const bySlug = await call('GET /projects', { query: { project: projectSlug(legacy) } });

		expect(byDir.status).toBe(200);
		expect(bySlug.body['selectedText']).toBe('Project: legacy-dir');
	});
});

describe('the cross-project views with the shared registry', () => {
	it('GET /summary: rows of registered projects first, linking by id; the unregistered ones carry the hint', async () => {
		const shared = world.createProject('shared-dir', { register: false });
		const legacy = world.createProject('legacy-dir');
		const project = await world.registerShared('shop', shared);
		await call('POST /tasks', { query: { project: project.id }, body: { description: 'one' } });

		const { body } = await call('GET /summary');

		expect(body['projectRows']).toEqual([
			expect.objectContaining({
				name: 'shop',
				registered: true,
				openText: '1',
				href: `/modules/task/tasks/p/${project.id}`,
				registryHint: null,
			}),
			expect.objectContaining({
				name: 'legacy-dir',
				registered: false,
				registryHint: `Not in the shared project registry: project add "${legacy}"`,
			}),
		]);
		expect(body['registryNotice']).toContain(`project add "${legacy}"`);
	});

	it('GET /summary?project=<name> summarises the registry project, with its id', async () => {
		const shared = world.createProject('shared-dir', { register: false });
		await world.registerShared('shop', shared);

		const { body } = await call('GET /summary', { query: { project: 'shop' } });

		expect(body['scope']).toBe('project');
		expect((body['projectRows'] as Array<Record<string, any>>)[0]).toMatchObject({
			name: 'shop',
			registered: true,
		});
	});

	it('GET /tasks?allProjects=true tags the rows with the registry name and links the detail page by id', async () => {
		const shared = world.createProject('shared-dir', { register: false });
		const project = await world.registerShared('shop', shared);
		const created = await call('POST /tasks', { query: { project: project.id }, body: { description: 'one' } });
		const taskId = created.body['task'].id as string;

		const { body } = await call('GET /tasks', { query: { allProjects: 'true' } });

		expect(body['tasks']).toEqual([
			expect.objectContaining({ projectName: 'shop', href: `/modules/task/tasks/p/${project.id}/${taskId}` }),
		]);
	});

	it('the Tree, Types views and the create form use the id as project reference', async () => {
		const shared = world.createProject('shared-dir', { register: false });
		const project = await world.registerShared('shop', shared);

		const types = await call('GET /types', { query: { allProjects: 'true' } });
		const projects = await call('GET /projects');

		expect(types.body['projectOptions']).toEqual([{ value: project.id, label: 'shop' }]);
		expect(projects.body['projectOptions']).toEqual([{ value: project.id, label: 'shop' }]);
		expect(projects.body['forms'].create.projectParam).toBe(project.id);
	});

	it('a task created in a registered project answers a detail link with the id', async () => {
		const shared = world.createProject('shared-dir', { register: false });
		const project = await world.registerShared('shop', shared);

		const created = await call('POST /tasks', { query: { project: project.id }, body: { description: 'one' } });

		expect(created.body['href']).toBe(`/modules/task/tasks/p/${project.id}/${created.body['task'].id}`);
	});

	it('a corrupt registry does not stop the summary: the legacy projects are summarised and the notice says why', async () => {
		world.createProject('legacy-dir');
		corruptRegistry();

		const { status, body } = await call('GET /summary');

		expect(status).toBe(200);
		expect((body['projectRows'] as unknown[]).length).toBe(1);
		expect(body['registryNotice']).toContain('registry.json');
	});
});
