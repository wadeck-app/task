import * as path from 'node:path';

import { setFavorite, setPriority } from '@wadeck-app/project-sdk';

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
		fileVersion: vi.fn(() => Promise.resolve('v')),
		unchanged: vi.fn(() => false),
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


/** Eight projects whose registry order (creation) differs from their importance order. */
async function registerMix(): Promise<void> {
	for (const name of ['delta', 'alpha', 'echo', 'bravo', 'zulu', 'charlie']) {
		await world.registerShared(name, world.createFolder(name));
	}
	await setFavorite(world.registryDir, 'zulu', true);
	await setFavorite(world.registryDir, 'echo', true);
	await setPriority(world.registryDir, 'delta', 'high');
	await setPriority(world.registryDir, 'alpha', 'low');
	await setPriority(world.registryDir, 'echo', 'low');
}

// Importance order: zulu (favorite), echo (favorite, low), delta (high), bravo, charlie, alpha (low).
const IMPORTANCE = ['zulu', 'echo', 'delta', 'bravo', 'charlie', 'alpha'];

describe('favorites and priority of the registry (read only)', () => {
	it('GET /projects lists in importance order, with favorite and priority, and options labelled by name only', async () => {
		await registerMix();

		const { body } = await call('GET /projects');

		const projects = body['projects'] as Array<Record<string, any>>;
		expect(projects.map(p => [p.name, p.favorite, p.priority])).toEqual([
			['zulu', true, 'normal'],
			['echo', true, 'low'],
			['delta', false, 'high'],
			['bravo', false, 'normal'],
			['charlie', false, 'normal'],
			['alpha', false, 'low'],
		]);
		expect((body['projectOptions'] as Array<{ label: string }>).map(o => o.label)).toEqual(IMPORTANCE);
		expect((body['projectRows'] as Array<Record<string, any>>).map(r => [r.name, r.favoriteText, r.priorityText])).toEqual([
			['zulu', 'Favorite', ''],
			['echo', 'Favorite', 'low'],
			['delta', '', 'high'],
			['bravo', '', ''],
			['charlie', '', ''],
			['alpha', '', 'low'],
		]);
		expect((body['openLinks'] as Array<{ label: unknown }>).length).toBe(6);
		expect(body['importanceNote']).toContain('project favorite');
		expect(body['importanceNote']).toContain('project priority');
	});

	it('GET /tasks?allProjects=true carries projectFavorite and projectPriority on rows, and every readable project with its count', async () => {
		await registerMix();
		const zulu = await call('POST /tasks', { query: { project: 'zulu' }, body: { description: 'z1' } });
		await call('POST /tasks', { query: { project: 'zulu' }, body: { description: 'z2' } });
		await call('POST /tasks', { query: { project: 'alpha' }, body: { description: 'a1' } });
		expect(zulu.status).toBe(201);

		const { body } = await call('GET /tasks', { query: { allProjects: 'true' } });

		expect((body['tasks'] as Array<Record<string, any>>).map(t => [t.projectName, t.projectFavorite, t.projectPriority])).toEqual([
			['zulu', true, 'normal'],
			['zulu', true, 'normal'],
			['alpha', false, 'low'],
		]);
		expect(body['projects']).toEqual([
			{ name: 'zulu', favorite: true, priority: 'normal', count: 2 },
			{ name: 'echo', favorite: true, priority: 'low', count: 0 },
			{ name: 'delta', favorite: false, priority: 'high', count: 0 },
			{ name: 'bravo', favorite: false, priority: 'normal', count: 0 },
			{ name: 'charlie', favorite: false, priority: 'normal', count: 0 },
			{ name: 'alpha', favorite: false, priority: 'low', count: 1 },
		]);
	});

	it('GET /types?allProjects=true offers its projects in importance order', async () => {
		await registerMix();

		const { body } = await call('GET /types', { query: { allProjects: 'true' } });

		expect((body['projectOptions'] as Array<{ label: string }>).map(o => o.label)).toEqual(IMPORTANCE);
	});

	it('GET /tree?allProjects=true lists its projects in importance order', async () => {
		await registerMix();

		const { body } = await call('GET /tree', { query: { allProjects: 'true' } });

		expect((body['projects'] as Array<{ name: string }>).map(p => p.name)).toEqual(IMPORTANCE);
	});

	it('GET /summary lists projects in importance order', async () => {
		await registerMix();

		const { body } = await call('GET /summary');

		expect((body['projectRows'] as Array<{ name: string }>).map(r => r.name)).toEqual(IMPORTANCE);
	});

	it('a project whose favorite flag is removed goes back to its place by name', async () => {
		await registerMix();
		await setFavorite(world.registryDir, 'zulu', false);

		const { body } = await call('GET /projects');

		expect((body['projects'] as Array<{ name: string }>).map(p => p.name)).toEqual([
			'echo',
			'delta',
			'bravo',
			'charlie',
			'zulu',
			'alpha',
		]);
	});
});
