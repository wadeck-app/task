import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModuleContext, ModuleRouteHandler } from '@wadeck-app/app-core-sdk';

import { registerTaskRoutes } from './routes.js';
import { createRecordingSink, createTestWorld, type TestWorld } from './testHelpers.js';

// GET /tree?allProjects=true: `groups` (the page as shipped) plus `overview` (what the Tree page variants read).
const STATUSES_YML = ['statuses:', '  - backlog', '  - name: done', '    terminal: true', ''].join('\n');

let world: TestWorld;
let routes: Map<string, ModuleRouteHandler>;

async function call(route: string, query: Record<string, unknown> = {}, body?: unknown) {
	const handler = routes.get(route);
	if (!handler) throw new Error(`route not registered: ${route}`);
	let status = 0;
	let answer: unknown;
	const reply = {
		code: (n: number) => {
			status = n;
			return { send: (payload: unknown) => (answer = payload) };
		},
	};
	await handler({ params: {}, query, body } as never, reply as never);
	return { status, body: answer as Record<string, any> };
}

beforeEach(() => {
	world = createTestWorld();
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
	registerTaskRoutes(ctx, { configDir: world.configDir, eventSink: createRecordingSink() });
});

afterEach(() => world.cleanup());

async function addTask(project: string, description: string, parent?: string): Promise<string> {
	const answer = await call('POST /tasks', { project }, { description, ...(parent ? { parent } : {}) });
	expect(answer.status).toBe(201);
	return answer.body['task'].id as string;
}

describe('GET /tree?allProjects=true overview', () => {
	it('keeps groups and adds one overview entry per project with figures, capped rows and a tree link', async () => {
		const alpha = await world.createProject('alpha', { configYml: STATUSES_YML });
		await world.createProject('empty', { configYml: STATUSES_YML });
		const parent = await addTask(alpha, 'parent');
		const child = await addTask(alpha, 'child', parent);
		await addTask(alpha, 'second');
		const answer = await call('GET /tree', { allProjects: 'true' });
		expect(answer.status).toBe(200);
		expect(answer.body['groups']).toHaveLength(2);
		const { overview } = answer.body;
		expect(overview.projects.map((p: any) => p.name)).toEqual(['alpha', 'empty']);
		expect(overview.projects[0]).toMatchObject({
			id: alpha,
			readable: true,
			open: 3,
			total: 3,
			rowCount: 3,
			hiddenCount: 0,
			treeHref: `/modules/task/tree/p/${alpha}`,
		});
		expect(overview.projects[0].roots).toMatchObject([{ id: parent, done: 0, total: 1 }]);
		expect(overview.projects[0].rows.map((r: any) => [r.id, r.depth])).toContainEqual([child, 1]);
		expect(overview.projects[1]).toMatchObject({ empty: true, summaryText: 'No tasks', rows: [] });
		expect(overview.totals).toMatchObject({ projects: 2, readable: 2, unreadable: 0, open: 3, total: 3 });
	});

	it('?rowCap cuts the rows of each project and says how many are left out', async () => {
		const alpha = await world.createProject('alpha', { configYml: STATUSES_YML });
		for (let i = 0; i < 5; i++) await addTask(alpha, `task ${i}`);
		const { body } = await call('GET /tree', { allProjects: 'true', rowCap: '2' });
		expect(body['overview'].rowCap).toBe(2);
		expect(body['overview'].projects[0]).toMatchObject({ hiddenCount: 3, rowCount: 5 });
		expect(body['overview'].projects[0].rows).toHaveLength(2);
	});

	it('an invalid rowCap is a 400 naming the parameter (not clamped)', async () => {
		await world.createProject('alpha', { configYml: STATUSES_YML });
		const bad = await call('GET /tree', { allProjects: 'true', rowCap: '0' });
		expect(bad.status).toBe(400);
		expect(bad.body['error']).toContain('rowCap');
	});

	it('lists an unreadable project with its name and reason next to the readable ones', async () => {
		await world.createProject('alpha', { configYml: STATUSES_YML });
		const broken = await world.createProject('broken');
		world.breakConfig(broken);
		const { body } = await call('GET /tree', { allProjects: 'true' });
		const entry = body['overview'].projects.find((p: any) => p.id === broken);
		expect(entry).toMatchObject({ name: 'broken', readable: false, treeHref: `/modules/task/tree/p/${broken}` });
		expect(entry.problemText).toContain('not valid YAML');
		expect(body['overview'].totals).toMatchObject({ readable: 1, unreadable: 1 });
	});

	it('a registry without project answers an empty overview, not an error', async () => {
		const { status, body } = await call('GET /tree', { allProjects: 'true' });
		expect(status).toBe(200);
		expect(body['overview'].projects).toEqual([]);
	});
});
