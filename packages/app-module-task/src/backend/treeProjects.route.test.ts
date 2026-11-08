import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModuleContext, ModuleRouteHandler } from '@wadeck-app/app-core-sdk';

import { registerTaskRoutes } from './routes.js';
import { createRecordingSink, createTestWorld, type TestWorld } from './testHelpers.js';

// GET /tree?allProjects=true: `projects`, what the accordion of the global Tree page reads (one entry per project, readable or not).
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
		fileVersion: vi.fn(() => Promise.resolve('v')),
		unchanged: vi.fn(() => false),
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

describe('GET /tree?allProjects=true projects', () => {
	it('answers one entry per project with figures, rows and a tree link, and nothing of the removed designs', async () => {
		const alpha = await world.createProject('alpha', { configYml: STATUSES_YML });
		await world.createProject('empty', { configYml: STATUSES_YML });
		const parent = await addTask(alpha, 'parent');
		const child = await addTask(alpha, 'child', parent);
		await addTask(alpha, 'second');
		const answer = await call('GET /tree', { allProjects: 'true' });
		expect(answer.status).toBe(200);
		for (const gone of ['groups', 'overview', 'rows']) expect(answer.body, gone).not.toHaveProperty(gone);
		const { projects } = answer.body;
		expect(projects.map((p: any) => p.name)).toEqual(['alpha', 'empty']);
		expect(projects[0]).toMatchObject({
			id: alpha,
			readable: true,
			open: 3,
			total: 3,
			hiddenCount: 0,
			treeHref: `/modules/task/tree/p/${alpha}`,
		});
		expect(projects[0].rows.map((r: any) => [r.id, r.depth])).toContainEqual([child, 1]);
		expect(projects[1]).toMatchObject({ empty: true, summaryText: 'No tasks', rows: [] });
		expect(answer.body['scopeText']).toBe('All projects: 2 projects, 3 open tasks.');
	});

	it('ignores ?rowCap (the parameter went with the designs that needed it)', async () => {
		const alpha = await world.createProject('alpha', { configYml: STATUSES_YML });
		for (let i = 0; i < 3; i++) await addTask(alpha, `task ${i}`);
		const { status, body } = await call('GET /tree', { allProjects: 'true', rowCap: '1' });
		expect(status).toBe(200);
		expect(body['projects'][0].rows).toHaveLength(3);
	});

	it('lists an unreadable project with its name and reason, and says so in ONE line without paths', async () => {
		await world.createProject('alpha', { configYml: STATUSES_YML });
		const broken = await world.createProject('broken');
		world.breakConfig(broken);
		const { body } = await call('GET /tree', { allProjects: 'true' });
		const entry = body['projects'].find((p: any) => p.id === broken);
		expect(entry).toMatchObject({ name: 'broken', readable: false, treeHref: `/modules/task/tree/p/${broken}` });
		expect(entry.problemText).toContain('not valid YAML');
		expect(body['warning']).toBe(
			'1 project cannot be read: broken. Open it in the list below for its reason and fix.'
		);
		expect(body['skippedCount']).toBe(1);
	});

	it('a registry without project answers an empty list, not an error', async () => {
		const { status, body } = await call('GET /tree', { allProjects: 'true' });
		expect(status).toBe(200);
		expect(body['projects']).toEqual([]);
	});
});
