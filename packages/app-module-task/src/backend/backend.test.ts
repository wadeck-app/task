import * as fs from 'node:fs';
import * as path from 'node:path';

import type { TaskTreeNode } from '@wadeck-app/task-core';
import { listForest, openTaskContext, projectsRegistryPath, unregisterProject } from '@wadeck-app/task-service';
import type { EventPublisher, EventSink, PublishOutcome } from '@wadeck-app/task-service';
import type { ModuleContext, ModuleRouteHandler } from '@wadeck-app/app-core-sdk';

import backend from './index.js';
import teardown from './teardown.js';
import { projectSlug } from './projectRef.js';
import { registerTaskRoutes, type TaskModuleInstance, type TaskRoutesOptions } from './routes.js';
import { createRecordingSink, createTestWorld, type RecordingSink, type TestWorld } from './testHelpers.js';

const EXPECTED_ROUTES = [
	'GET /projects',
	'GET /summary',
	'GET /tasks',
	'GET /tasks/:id',
	'GET /tasks/:id/history',
	'GET /tasks/:id/children',
	'GET /tasks/:id/ancestors',
	'GET /tasks/:id/links',
	'GET /tree',
	'GET /types',
	'POST /tasks',
	'POST /tasks/:id/status',
	'POST /tasks/:id/labels',
	'DELETE /tasks/:id/labels/:label',
	'POST /tasks/:id/links',
	'DELETE /tasks/:id/links',
	'POST /tasks/:id/parent',
	'DELETE /tasks/:id/parent',
	'POST /tasks/:id/type',
	'POST /tasks/:id/meta',
	'POST /types',
	'DELETE /types/:name',
	'POST /tasks/delete/plan',
	'POST /tasks/delete',
	'POST /projects',
	'POST /projects/relocate',
	'POST /projects/remove',
];

interface Answer {
	status: number;
	body: Record<string, any>;
}

interface Harness {
	instance: TaskModuleInstance;
	world: TestWorld;
	sink: RecordingSink;
	routes: Map<string, ModuleRouteHandler>;
	call(
		route: string,
		request?: { params?: Record<string, string>; query?: Record<string, unknown>; body?: unknown }
	): Promise<Answer>;
}

function collectRoutes(dataDir: string): { routes: Map<string, ModuleRouteHandler>; ctx: ModuleContext } {
	const routes = new Map<string, ModuleRouteHandler>();
	const ctx: ModuleContext = {
		dataDir,
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
	return { routes, ctx };
}

// `'default'` registers the routes WITHOUT an injected sink, so that the real queue sink (and `extra.createPublisher`) is used.
function setup(eventSink?: EventSink | 'default', extra: Partial<TaskRoutesOptions> = {}): Harness {
	const world = createTestWorld();
	const sink = createRecordingSink();
	// The module's own persistent folder (ctx.dataDir): per world, so a test never sees the state of another.
	const { routes, ctx } = collectRoutes(path.join(world.root, 'module-data'));
	const injected = eventSink === 'default' ? {} : { eventSink: eventSink ?? sink };
	const instance = registerTaskRoutes(ctx, { configDir: world.configDir, ...injected, ...extra });
	return {
		instance,
		world,
		sink,
		routes,
		async call(route, request = {}) {
			const handler = routes.get(route);
			if (!handler) throw new Error(`route not registered: ${route}`);
			let status = 0;
			let body: unknown;
			// The routes only call reply.code(n).send(body).
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
			await handler(
				{ params: request.params ?? {}, query: request.query ?? {}, body: request.body } as never,
				reply as never
			);
			if (status === 0) throw new Error(`route ${route} answered nothing`);
			return { status, body: body as Record<string, any> };
		},
	};
}

// `done` is terminal; the default config.yml of a project has no terminal status.
const STATUSES_YML = ['statuses:', '  - backlog', '  - in-progress', '  - name: done', '    terminal: true', ''].join(
	'\n'
);

let h: Harness;
let project: string;

beforeEach(() => {
	h = setup();
	project = h.world.createProject('alpha', { configYml: STATUSES_YML });
});
afterEach(() => h.world.cleanup());

async function createTask(description: string, extra: Record<string, unknown> = {}): Promise<string> {
	const answer = await h.call('POST /tasks', { query: { project }, body: { description, ...extra } });
	expect(answer.status).toBe(201);
	h.sink.events.length = 0;
	return answer.body['task'].id as string;
}

describe('route table', () => {
	it('registers exactly the documented routes', () => {
		expect([...h.routes.keys()].sort()).toEqual([...EXPECTED_ROUTES].sort());
	});

	it('the default export of the backend entry registers the same routes', () => {
		const { routes, ctx } = collectRoutes('/unused/data-dir');
		backend(ctx);
		expect([...routes.keys()].sort()).toEqual([...EXPECTED_ROUTES].sort());
	});
});

describe('project selection', () => {
	it('uses the only registered project when ?project is missing', async () => {
		const answer = await h.call('GET /tasks');
		expect(answer.status).toBe(200);
		expect(answer.body['project']).toEqual({ name: 'alpha', path: project });
	});

	it('400 listing the registered projects when several exist and ?project is missing', async () => {
		const beta = h.world.createProject('beta');
		const answer = await h.call('GET /tasks');
		expect(answer.status).toBe(400);
		expect(answer.body['registeredProjects']).toEqual([project, beta]);
		expect(answer.body['hint']).toContain('?project=');
	});

	it('404 for an unregistered project, listing nothing', async () => {
		const other = h.world.createProject('other', { register: false });
		const answer = await h.call('GET /tasks', { query: { project: other } });
		expect(answer.status).toBe(404);
		expect(JSON.stringify(answer.body)).not.toContain(project);
	});

	it('400 when ?project is repeated', async () => {
		const answer = await h.call('GET /tasks', { query: { project: [project, project] } });
		expect(answer.status).toBe(400);
		expect(answer.body['error']).toContain('project');
	});

	it('500 with the registry fix when projects.json is corrupt', async () => {
		fs.writeFileSync(projectsRegistryPath(h.world.configDir), '{not json');
		const answer = await h.call('GET /tasks', { query: { project } });
		expect(answer.status).toBe(500);
		expect(answer.body['error']).toContain('projects registry');
		expect(answer.body['hint']).toContain('Fix or delete');
	});

	it('every route resolves the project (mutating ones answer 404 before touching anything)', async () => {
		const other = h.world.createProject('other', { register: false });
		const calls: [string, Record<string, string>, unknown][] = [
			['GET /tasks/:id', { id: 'x' }, undefined],
			['GET /tasks/:id/history', { id: 'x' }, undefined],
			['GET /tasks/:id/children', { id: 'x' }, undefined],
			['GET /tasks/:id/ancestors', { id: 'x' }, undefined],
			['GET /tasks/:id/links', { id: 'x' }, undefined],
			['GET /tree', {}, undefined],
			['GET /types', {}, undefined],
			['GET /summary', {}, undefined],
			['POST /tasks/:id/parent', { id: 'x' }, { parent: 'y' }],
			['DELETE /tasks/:id/parent', { id: 'x' }, undefined],
			['POST /tasks/:id/type', { id: 'x' }, { type: 'bug' }],
			['POST /tasks/:id/meta', { id: 'x' }, { key: 'k', value: 'v' }],
			['POST /types', {}, { name: 'bug' }],
			['DELETE /types/:name', { name: 'bug' }, undefined],
			['POST /tasks/delete/plan', {}, { all: true }],
			['POST /tasks/delete', {}, { all: true, confirm: true }],
			['POST /tasks', {}, { description: 'd' }],
			['POST /tasks/:id/status', { id: 'x' }, { status: 'done' }],
			['POST /tasks/:id/labels', { id: 'x' }, { label: 'l' }],
			['DELETE /tasks/:id/labels/:label', { id: 'x', label: 'l' }, undefined],
			['POST /tasks/:id/links', { id: 'x' }, { type: 'blockedBy', target: 'y' }],
			['DELETE /tasks/:id/links', { id: 'x' }, { type: 'blockedBy', target: 'y' }],
		];
		for (const [route, params, body] of calls) {
			const answer = await h.call(route, { params, query: { project: other }, body });
			expect(answer.status, route).toBe(404);
		}
	});
});

describe('GET /projects', () => {
	it('lists the registered projects with their initialization state', async () => {
		const answer = await h.call('GET /projects');
		expect(answer.status).toBe(200);
		expect(answer.body['projects']).toEqual([
			{
				name: 'alpha',
				path: project,
				exists: true,
				initialized: true,
				openCount: 0,
				error: null,
				href: `/modules/task/tasks/p/${projectSlug(project)}`,
			},
		]);
	});

	it('is an empty list (not an error) when nothing is registered', async () => {
		fs.rmSync(projectsRegistryPath(h.world.configDir));
		const answer = await h.call('GET /projects');
		expect(answer.status).toBe(200);
		expect(answer.body).toMatchObject({ projects: [], multiple: false, needsSelection: false });
	});
});

describe('GET /tasks', () => {
	it('lists open tasks with the project, hiding terminal statuses by default', async () => {
		const open = await createTask('open one');
		const closed = await createTask('closed one');
		await h.call('POST /tasks/:id/status', {
			params: { id: closed },
			query: { project },
			body: { status: 'done' },
		});
		const answer = await h.call('GET /tasks', { query: { project } });
		expect(answer.status).toBe(200);
		expect(answer.body['tasks'].map((t: { id: string }) => t.id)).toEqual([open]);
	});

	it('showAll=true includes terminal statuses', async () => {
		const closed = await createTask('closed one');
		await h.call('POST /tasks/:id/status', {
			params: { id: closed },
			query: { project },
			body: { status: 'done' },
		});
		const answer = await h.call('GET /tasks', { query: { project, showAll: 'true' } });
		expect(answer.body['tasks'].map((t: { id: string }) => t.id)).toEqual([closed]);
	});

	it('400 for a showAll value that is not true or false', async () => {
		const answer = await h.call('GET /tasks', { query: { project, showAll: 'yes' } });
		expect(answer.status).toBe(400);
		expect(answer.body['hint']).toContain('true');
	});

	it('gives every row the encoded link to its detail page', async () => {
		const id = await createTask('linked');
		const answer = await h.call('GET /tasks', { query: { project } });
		expect(answer.body['tasks'][0]['href']).toBe(`/modules/task/tasks/p/${projectSlug(project)}/${id}`);
	});

	it('restricts to the direct children of ?parent', async () => {
		const parent = await createTask('parent');
		const child = await createTask('child', { parent });
		await createTask('other');
		const answer = await h.call('GET /tasks', { query: { project, parent: parent.slice(0, 8) } });
		expect(answer.body['tasks'].map((t: { id: string }) => t.id)).toEqual([child]);
	});

	it('404 for an unknown parent', async () => {
		const answer = await h.call('GET /tasks', { query: { project, parent: 'zzzzzzzz' } });
		expect(answer.status).toBe(404);
	});
});

describe('GET /tasks/:id', () => {
	it('returns the task by id prefix with children, links and parent summary', async () => {
		const parent = await createTask('parent');
		const child = await createTask('child', { parent });
		const answer = await h.call('GET /tasks/:id', { params: { id: child.slice(0, 8) }, query: { project } });
		expect(answer.status).toBe(200);
		expect(answer.body['task']).toMatchObject({ id: child, description: 'child', parentId: parent });
		expect(answer.body['parent']).toMatchObject({ id: parent });
		expect(answer.body['children']).toEqual([]);
		expect(answer.body['links']).toMatchObject({ blockedBy: [], blocks: [] });
		const parentAnswer = await h.call('GET /tasks/:id', { params: { id: parent }, query: { project } });
		expect(parentAnswer.body['parent']).toBeNull();
		expect(parentAnswer.body['children'].map((c: { id: string }) => c.id)).toEqual([child]);
		expect(parentAnswer.body['children'][0]['href']).toBe(`/modules/task/tasks/p/${projectSlug(project)}/${child}`);
	});

	it('has no warnings for a healthy task', async () => {
		const id = await createTask('fine');
		const answer = await h.call('GET /tasks/:id', { params: { id }, query: { project } });
		expect(answer.body['warnings']).toEqual([]);
		expect(answer.body['warningText']).toBeNull();
	});

	it('a dangling parentId still answers 200 with parent null and an actionable warning (the task stays reachable)', async () => {
		const parent = await createTask('parent');
		const child = await createTask('child', { parent });
		// Corrupt the hierarchy on purpose: drop the parent from the index only.
		const indexPath = `${project}/.task/task-index.json`;
		const index = JSON.parse(fs.readFileSync(indexPath, 'utf8')) as { tasks: Array<{ id: string }> };
		index.tasks = index.tasks.filter(x => x.id !== parent);
		fs.writeFileSync(indexPath, JSON.stringify(index));

		const answer = await h.call('GET /tasks/:id', { params: { id: child }, query: { project } });

		expect(answer.status).toBe(200);
		expect(answer.body['task']).toMatchObject({ id: child, parentId: parent });
		expect(answer.body['parent']).toBeNull();
		expect(answer.body['warnings']).toHaveLength(1);
		expect(answer.body['warnings'][0]).toContain(`parent "${parent}" of task "${child}" does not exist`);
		expect(answer.body['warnings'][0]).toContain(`task remove-parent ${child}`);
		expect(answer.body['warningText']).toBe(answer.body['warnings'][0]);
		expect(answer.body['links']).toMatchObject({ blockedBy: [] });
	});

	it('404 for an unknown id', async () => {
		const answer = await h.call('GET /tasks/:id', { params: { id: 'nope' }, query: { project } });
		expect(answer.status).toBe(404);
		expect(answer.body['error']).toContain('Task not found');
	});

	it('409 with the matching ids for an ambiguous prefix', async () => {
		const a = await createTask('a');
		const b = await createTask('b');
		const answer = await h.call('GET /tasks/:id', { params: { id: '' }, query: { project } });
		expect(answer.status).toBe(409);
		expect([...answer.body['matches']].sort()).toEqual([a, b].sort());
	});
});

describe('GET /tasks/:id/history', () => {
	it('returns the status history', async () => {
		const id = await createTask('t');
		await h.call('POST /tasks/:id/status', { params: { id }, query: { project }, body: { status: 'in-progress' } });
		const answer = await h.call('GET /tasks/:id/history', { params: { id }, query: { project } });
		expect(answer.status).toBe(200);
		expect(answer.body['id']).toBe(id);
		expect(answer.body['history'].map((e: { status: string }) => e.status)).toEqual(['backlog', 'in-progress']);
	});

	it('404 for an unknown id', async () => {
		const answer = await h.call('GET /tasks/:id/history', { params: { id: 'nope' }, query: { project } });
		expect(answer.status).toBe(404);
	});
});

describe('GET /tree', () => {
	it('returns the forest of open tasks', async () => {
		const parent = await createTask('parent');
		const child = await createTask('child', { parent });
		const answer = await h.call('GET /tree', { query: { project } });
		expect(answer.status).toBe(200);
		expect(answer.body['tree']).toHaveLength(1);
		expect(answer.body['tree'][0]).toMatchObject({ id: parent, children: [{ id: child }] });
	});

	it('with ?id returns the complete tree containing that task, flagged selected', async () => {
		const parent = await createTask('parent');
		const child = await createTask('child', { parent });
		const answer = await h.call('GET /tree', { query: { project, id: child } });
		expect(answer.body['tree']).toMatchObject({ id: parent, children: [{ id: child, selected: true }] });
	});
});

describe('GET /summary', () => {
	it('counts tasks by status, with the open ones apart', async () => {
		await createTask('a');
		await createTask('b');
		const c = await createTask('c');
		await h.call('POST /tasks/:id/status', { params: { id: c }, query: { project }, body: { status: 'done' } });
		const answer = await h.call('GET /summary', { query: { project } });
		expect(answer.status).toBe(200);
		expect(answer.body).toMatchObject({
			scope: 'project',
			projectCount: 1,
			open: 2,
			total: 3,
			byStatus: [
				{ status: 'backlog', count: 2, terminal: false },
				{ status: 'in-progress', count: 0, terminal: false },
				{ status: 'done', count: 1, terminal: true },
			],
			skipped: [],
		});
	});

	it('without ?project, aggregates every registered project instead of failing', async () => {
		await createTask('in alpha');
		const beta = h.world.createProject('beta');
		await h.call('POST /tasks', { query: { project: beta }, body: { description: 'in beta' } });
		const answer = await h.call('GET /summary');
		expect(answer.status).toBe(200);
		expect(answer.body).toMatchObject({ scope: 'all', projectCount: 2, open: 2, total: 2 });
		expect(answer.body['byStatus'][0]).toEqual({ status: 'backlog', count: 2, terminal: false });
	});

	it('the aggregate reports the projects it could not read, by path and reason', async () => {
		await createTask('in alpha');
		const gone = h.world.createProject('gone');
		fs.rmSync(`${gone}/.task`, { recursive: true });
		const answer = await h.call('GET /summary');
		expect(answer.status).toBe(200);
		expect(answer.body['projectCount']).toBe(1);
		expect(answer.body['skipped']).toEqual([
			{ path: gone, error: expect.stringContaining('not initialized') as unknown },
		]);
	});

	it('a partial aggregate states how many projects were skipped and why, in a ready-to-display warning', async () => {
		await createTask('in alpha');
		const gone = h.world.createProject('gone');
		fs.rmSync(`${gone}/.task`, { recursive: true });
		const answer = await h.call('GET /summary');
		expect(answer.status).toBe(200);
		expect(answer.body['skippedCount']).toBe(1);
		expect(answer.body['warning']).toContain('1 project');
		expect(answer.body['warning']).toContain('not counted');
		expect(answer.body['warning']).toContain('task init');
		expect(answer.body['warning']).toContain(gone);
	});

	it('a complete aggregate has skippedCount 0 and no warning', async () => {
		await createTask('in alpha');
		const answer = await h.call('GET /summary');
		expect(answer.body['skippedCount']).toBe(0);
		expect(answer.body['warning']).toBeNull();
	});

	it('the aggregate answers 500 (not zeros) when every registered project is unreadable, with the reasons and a hint', async () => {
		fs.rmSync(`${project}/.task`, { recursive: true });
		const gone = h.world.createProject('gone');
		fs.rmSync(`${gone}/.task`, { recursive: true });
		const answer = await h.call('GET /summary');
		expect(answer.status).toBe(500);
		expect(answer.body['error']).toContain('none of the 2 registered projects');
		expect(answer.body['hint']).toContain('task init');
		expect(answer.body['skipped']).toHaveLength(2);
		expect(answer.body['skipped'][0]).toMatchObject({
			path: project,
			error: expect.stringContaining('not initialized'),
		});
	});

	it('the aggregate with no registered project is a 200 flagged noProjects, with the two ways to register (not an error)', async () => {
		fs.rmSync(projectsRegistryPath(h.world.configDir));
		const answer = await h.call('GET /summary');
		expect(answer.status).toBe(200);
		expect(answer.body).toMatchObject({ scope: 'all', noProjects: true, projectCount: 0, open: 0, total: 0 });
		expect(answer.body['noProjectsText']).toContain('task init');
		expect(answer.body['noProjectsText']).toContain('task projects add');
		expect(answer.body['projectRows']).toEqual([]);
		expect(answer.body).not.toHaveProperty('errorText');
	});

	it('an explicit unregistered ?project stays a 404 (naming a project must fail loudly)', async () => {
		const other = h.world.createProject('other', { register: false });
		const answer = await h.call('GET /summary', { query: { project: other } });
		expect(answer.status).toBe(404);
	});

	it('has noProjects false and no text once a project is registered', async () => {
		const answer = await h.call('GET /summary');
		expect(answer.body['noProjects']).toBe(false);
		expect(answer.body['noProjectsText']).toBeNull();
	});
});

describe('GET /summary per-project rows (the global dashboard widget)', () => {
	it('gives one row per registered project with name, open, total and the link to its tasks page', async () => {
		const closed = await createTask('closed');
		await h.call('POST /tasks/:id/status', {
			params: { id: closed },
			query: { project },
			body: { status: 'done' },
		});
		await createTask('open one');
		const beta = h.world.createProject('beta');
		const answer = await h.call('GET /summary');
		expect(answer.body['projectRows']).toEqual([
			{
				name: 'alpha',
				label: 'alpha',
				path: project,
				openText: '1',
				totalText: '2',
				problem: '',
				href: `/modules/task/tasks/p/${projectSlug(project)}`,
			},
			{
				name: 'beta',
				label: 'beta',
				path: beta,
				openText: '0',
				totalText: '0',
				problem: '',
				href: `/modules/task/tasks/p/${projectSlug(beta)}`,
			},
		]);
		expect(answer.body).toMatchObject({ open: 1, total: 2, projectCount: 2 });
	});

	it('shows an unreadable project with its reason and no figures nor link, besides the readable ones', async () => {
		const broken = h.world.createProject('broken');
		fs.rmSync(`${broken}/.task`, { recursive: true });
		const gone = h.world.createProject('gone');
		fs.rmSync(gone, { recursive: true });
		const answer = await h.call('GET /summary');
		const [, brokenRow, goneRow] = answer.body['projectRows'];
		expect(brokenRow).toMatchObject({
			name: 'broken',
			label: 'broken (not initialized)',
			openText: '-',
			totalText: '-',
			href: null,
		});
		expect(brokenRow.problem).toContain('not initialized');
		expect(goneRow).toMatchObject({ name: 'gone', label: 'gone (missing)', href: null });
		expect(goneRow.problem).toContain('does not exist');
		expect(answer.body['projectCount']).toBe(1);
	});

	it('with ?project, has the single row of that project and scope project', async () => {
		await createTask('a');
		h.world.createProject('beta');
		const answer = await h.call('GET /summary', { query: { project } });
		expect(answer.body['scope']).toBe('project');
		expect(answer.body['projectRows']).toHaveLength(1);
		expect(answer.body['projectRows'][0]).toMatchObject({ name: 'alpha', openText: '1', totalText: '1' });
	});
});

describe('GET /tasks?allProjects=true (the global task list)', () => {
	let beta: string;

	async function createIn(dir: string, description: string): Promise<string> {
		const answer = await h.call('POST /tasks', { query: { project: dir }, body: { description } });
		expect(answer.status).toBe(201);
		return answer.body['task'].id as string;
	}

	beforeEach(() => {
		beta = h.world.createProject('beta', { configYml: STATUSES_YML });
	});

	it('lists the open tasks of every project, each with its project name and a detail link keeping the project', async () => {
		const a = await createIn(project, 'in alpha');
		const b = await createIn(beta, 'in beta');
		const answer = await h.call('GET /tasks', { query: { allProjects: 'true' } });
		expect(answer.status).toBe(200);
		expect(answer.body['scope']).toBe('all');
		expect(answer.body['tasks']).toMatchObject([
			{
				id: a,
				projectName: 'alpha',
				projectPath: project,
				titleText: 'in alpha',
				href: `/modules/task/tasks/p/${projectSlug(project)}/${a}`,
			},
			{ id: b, projectName: 'beta', href: `/modules/task/tasks/p/${projectSlug(beta)}/${b}` },
		]);
		expect(answer.body['tasks'][0].created).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d$/);
		expect(answer.body['scopeText']).toBe('All projects: 2 projects, 2 open tasks.');
		expect(answer.body['projectCount']).toBe(2);
	});

	it('hides closed tasks unless showAll, and the toggle keeps the global scope (no project in its link)', async () => {
		const done = await createIn(project, 'closed one');
		await h.call('POST /tasks/:id/status', { params: { id: done }, query: { project }, body: { status: 'done' } });
		await createIn(project, 'open one');
		const open = await h.call('GET /tasks', { query: { allProjects: 'true' } });
		expect(open.body['tasks']).toHaveLength(1);
		expect(open.body['showAllToggle']).toEqual({
			label: 'Show closed tasks',
			href: '/modules/task/tasks?showAll=true',
		});
		const all = await h.call('GET /tasks', { query: { allProjects: 'true', showAll: 'true' } });
		expect(all.body['tasks']).toHaveLength(2);
		expect(all.body['scopeText']).toBe('All projects: 2 projects, 2 tasks (closed ones included).');
		expect(all.body['showAllToggle']).toEqual({ label: 'Hide closed tasks', href: '/modules/task/tasks' });
	});

	it('is an empty list (not an error) when no project holds a task', async () => {
		const answer = await h.call('GET /tasks', { query: { allProjects: 'true' } });
		expect(answer.status).toBe(200);
		expect(answer.body['tasks']).toEqual([]);
		expect(answer.body['scopeText']).toBe('All projects: 2 projects, 0 open tasks.');
	});

	it('reports an unreadable project in a ready-to-display warning, besides the tasks of the others', async () => {
		await createIn(project, 'in alpha');
		const broken = h.world.createProject('broken');
		fs.rmSync(`${broken}/.task`, { recursive: true });
		const answer = await h.call('GET /tasks', { query: { allProjects: 'true' } });
		expect(answer.status).toBe(200);
		expect(answer.body['tasks']).toHaveLength(1);
		expect(answer.body['skippedCount']).toBe(1);
		expect(answer.body['warning']).toContain('1 project not listed');
		expect(answer.body['warning']).toContain(broken);
		expect(answer.body['warning']).toContain('not initialized');
	});

	it('has no warning when every project could be read', async () => {
		const answer = await h.call('GET /tasks', { query: { allProjects: 'true' } });
		expect(answer.body['skippedCount']).toBe(0);
		expect(answer.body['warning']).toBeNull();
	});

	it('answers 500 (not an empty list) when every registered project is unreadable, with reasons and hint', async () => {
		fs.rmSync(`${project}/.task`, { recursive: true });
		fs.rmSync(`${beta}/.task`, { recursive: true });
		const answer = await h.call('GET /tasks', { query: { allProjects: 'true' } });
		expect(answer.status).toBe(500);
		expect(answer.body['error']).toContain('none of the 2 registered projects');
		expect(answer.body['hint']).toContain('task init');
	});

	it('is a 400 together with ?project (one scope at a time)', async () => {
		const answer = await h.call('GET /tasks', { query: { allProjects: 'true', project } });
		expect(answer.status).toBe(400);
		expect(answer.body['error']).toContain('allProjects');
	});

	it('is a 400 for a value that is not true or false', async () => {
		const answer = await h.call('GET /tasks', { query: { allProjects: 'yes' } });
		expect(answer.status).toBe(400);
	});

	it('answers inline errors like the other view requests', async () => {
		fs.rmSync(`${project}/.task`, { recursive: true });
		fs.rmSync(`${beta}/.task`, { recursive: true });
		const answer = await h.call('GET /tasks', { query: { allProjects: 'true', inlineErrors: 'true' } });
		expect(answer.status).toBe(200);
		expect(answer.body['failed']).toBe(true);
		expect(answer.body['errorText']).toContain('none of the 2 registered projects');
	});

	it('without the flag, several registered projects and no ?project stay a 400 (the API contract is unchanged)', async () => {
		const answer = await h.call('GET /tasks');
		expect(answer.status).toBe(400);
	});
});

describe('GET /projects global view data (the Tasks page without ?project)', () => {
	it('several projects and none chosen: globalQuery asks for the global list, keeping showAll', async () => {
		h.world.createProject('beta');
		const plain = await h.call('GET /projects');
		expect(plain.body['globalQuery']).toBe('allProjects=true');
		const showAll = await h.call('GET /projects', { query: { showAll: 'true' } });
		expect(showAll.body['globalQuery']).toBe('allProjects=true&showAll=true');
	});

	it('scopeQuery is the project query when one is chosen, else the global query (the pages have one source)', async () => {
		h.world.createProject('beta');
		const global = await h.call('GET /projects', { query: { showAll: 'true' } });
		expect(global.body['scopeQuery']).toBe('allProjects=true&showAll=true');
		const chosen = await h.call('GET /projects', { query: { project } });
		expect(chosen.body['scopeQuery']).toBe(`project=${encodeURIComponent(project)}`);
		const unknown = await h.call('GET /projects', { query: { project: '/nowhere/ghost' } });
		expect(unknown.body['scopeQuery']).toBe('blank=true');
	});

	it('is empty with a project chosen, a single project or none registered (the page skips the global source)', async () => {
		const single = await h.call('GET /projects');
		expect(single.body['globalQuery']).toBe('');
		h.world.createProject('beta');
		const chosen = await h.call('GET /projects', { query: { project } });
		expect(chosen.body['globalQuery']).toBe('');
		fs.rmSync(projectsRegistryPath(h.world.configDir));
		const none = await h.call('GET /projects');
		expect(none.body['globalQuery']).toBe('');
	});

	it('answers no back link: the breadcrumb leads back to the parent pages (allProjectsHref, globalHrefs, tasksHref are gone)', async () => {
		h.world.createProject('beta');
		const answer = await h.call('GET /projects', { query: { project } });
		expect(answer.body).not.toHaveProperty('allProjectsHref');
		expect(answer.body).not.toHaveProperty('globalHrefs');
		expect(answer.body).not.toHaveProperty('tasksHref');
	});

	it('names the project of a page by the slug of its address, the way the directory is accepted (one resolution)', async () => {
		h.world.createProject('beta');
		const bySlug = await h.call('GET /projects', { query: { project: projectSlug(project) } });
		expect(bySlug.body['selectedText']).toBe('Project: alpha');
		expect(bySlug.body['projectQuery']).toBe(`project=${encodeURIComponent(project)}`);
		expect(bySlug.body['scopeQuery']).toBe(`project=${encodeURIComponent(project)}`);
		expect(bySlug.body['unknownProjectText']).toBeNull();
		const byDir = await h.call('GET /projects', { query: { project } });
		expect(byDir.body['projectQuery']).toBe(bySlug.body['projectQuery']);
	});

	it('keeps the page filters when the project is a slug', async () => {
		h.world.createProject('beta');
		const answer = await h.call('GET /projects', { query: { project: projectSlug(project), showAll: 'true' } });
		expect(answer.body['projectQuery']).toBe(`project=${encodeURIComponent(project)}&showAll=true`);
	});

	it('an unregistered project (slug or directory) is named in unknownProjectText with the next step, without a global query', async () => {
		h.world.createProject('beta');
		const answer = await h.call('GET /projects', { query: { project: '/nowhere/ghost' } });
		expect(answer.body['globalQuery']).toBe('');
		expect(answer.body['unknownProjectText']).toContain('/nowhere/ghost');
		expect(answer.body['unknownProjectText']).toContain('not registered');
		expect(answer.body['unknownProjectText']).toContain('Projects page');
	});

	it('has no unknownProjectText for a registered or absent ?project', async () => {
		const answer = await h.call('GET /projects', { query: { project } });
		expect(answer.body['unknownProjectText']).toBeNull();
		const none = await h.call('GET /projects');
		expect(none.body['unknownProjectText']).toBeNull();
	});

	it('says only that nothing is registered (not also that the project is unknown) when the registry is empty', async () => {
		fs.rmSync(projectsRegistryPath(h.world.configDir));
		const answer = await h.call('GET /projects', { query: { project: projectSlug(project) } });
		expect(answer.body['noProjects']).toBe(true);
		expect(answer.body['unknownProjectText']).toBeNull();
	});
});

describe('POST /tasks', () => {
	it('creates the task (201) and delivers onTaskCreated to the sink', async () => {
		const answer = await h.call('POST /tasks', { query: { project }, body: { description: 'write docs' } });
		expect(answer.status).toBe(201);
		expect(answer.body['task']).toMatchObject({ description: 'write docs', status: 'backlog' });
		expect(h.sink.events).toHaveLength(1);
		expect(h.sink.events[0]).toMatchObject({
			name: 'onTaskCreated',
			payload: { taskId: answer.body['task'].id, taskProjectName: 'alpha', taskProjectPath: project },
		});
	});

	it('creates it under a parent prefix', async () => {
		const parent = await createTask('parent');
		const answer = await h.call('POST /tasks', {
			query: { project },
			body: { description: 'child', parent: parent.slice(0, 8) },
		});
		expect(answer.body['task']['parentId']).toBe(parent);
	});

	it.each([
		['no body', undefined],
		['a non-object body', 'text'],
		['a missing description', {}],
		['an empty description', { description: '' }],
		['a non-string description', { description: 3 }],
		['a non-string parent', { description: 'd', parent: 3 }],
	])('400 for %s, creating and delivering nothing', async (_label, body) => {
		const answer = await h.call('POST /tasks', { query: { project }, body });
		expect(answer.status).toBe(400);
		expect(answer.body['error']).toBeTruthy();
		expect(answer.body['hint']).toContain('description');
		expect(h.sink.events).toEqual([]);
		expect((await h.call('GET /tasks', { query: { project } })).body['tasks']).toEqual([]);
	});

	it('404 for an unknown parent, delivering nothing', async () => {
		const answer = await h.call('POST /tasks', { query: { project }, body: { description: 'd', parent: 'zzzz' } });
		expect(answer.status).toBe(404);
		expect(h.sink.events).toEqual([]);
	});
});

describe('POST /tasks/:id/status', () => {
	it('changes the status and delivers onStatusChange', async () => {
		const id = await createTask('t');
		const answer = await h.call('POST /tasks/:id/status', {
			params: { id },
			query: { project },
			body: { status: 'in-progress' },
		});
		expect(answer.status).toBe(200);
		expect(answer.body).toMatchObject({
			task: { id, status: 'in-progress' },
			oldStatus: 'backlog',
			openBlockers: [],
			unblocked: [],
		});
		expect(h.sink.events.map(e => e.name)).toEqual(['onStatusChange']);
	});

	it('delivers onTaskUnblocked after onStatusChange when the last blocker closes', async () => {
		const blocker = await createTask('blocker');
		const blocked = await createTask('blocked');
		await h.call('POST /tasks/:id/links', {
			params: { id: blocked },
			query: { project },
			body: { type: 'blockedBy', target: blocker },
		});
		h.sink.events.length = 0;
		const answer = await h.call('POST /tasks/:id/status', {
			params: { id: blocker },
			query: { project },
			body: { status: 'done' },
		});
		expect(answer.body['unblocked'].map((t: { id: string }) => t.id)).toEqual([blocked]);
		expect(h.sink.events.map(e => e.name)).toEqual(['onStatusChange', 'onTaskUnblocked']);
	});

	it('400 for an unknown status, with the valid ones and a suggestion, delivering nothing', async () => {
		const id = await createTask('t');
		const answer = await h.call('POST /tasks/:id/status', {
			params: { id },
			query: { project },
			body: { status: 'dnoe' },
		});
		expect(answer.status).toBe(400);
		expect(answer.body).toMatchObject({ validStatuses: ['backlog', 'in-progress', 'done'], suggestions: ['done'] });
		expect(h.sink.events).toEqual([]);
	});

	it('409 when the task already has that status', async () => {
		const id = await createTask('t');
		const answer = await h.call('POST /tasks/:id/status', {
			params: { id },
			query: { project },
			body: { status: 'backlog' },
		});
		expect(answer.status).toBe(409);
		expect(h.sink.events).toEqual([]);
	});

	it('400 for a missing status', async () => {
		const id = await createTask('t');
		const answer = await h.call('POST /tasks/:id/status', { params: { id }, query: { project }, body: {} });
		expect(answer.status).toBe(400);
		expect(answer.body['hint']).toContain('status');
	});

	it('404 for an unknown task', async () => {
		const answer = await h.call('POST /tasks/:id/status', {
			params: { id: 'nope' },
			query: { project },
			body: { status: 'done' },
		});
		expect(answer.status).toBe(404);
	});
});

describe('labels', () => {
	it('POST adds a label, DELETE removes it; neither delivers an event', async () => {
		const id = await createTask('t');
		const added = await h.call('POST /tasks/:id/labels', {
			params: { id },
			query: { project },
			body: { label: 'bug' },
		});
		expect(added.status).toBe(200);
		expect(added.body['task']['labels']).toEqual(['bug']);
		const removed = await h.call('DELETE /tasks/:id/labels/:label', {
			params: { id, label: 'bug' },
			query: { project },
		});
		expect(removed.status).toBe(200);
		expect(removed.body['task']['labels'] ?? []).toEqual([]);
		expect(h.sink.events).toEqual([]);
	});

	it.each([
		['missing', {}],
		['empty', { label: '' }],
		['not a string', { label: 1 }],
	])('POST 400 for a label that is %s', async (_label, body) => {
		const id = await createTask('t');
		const answer = await h.call('POST /tasks/:id/labels', { params: { id }, query: { project }, body });
		expect(answer.status).toBe(400);
		expect(answer.body['hint']).toContain('label');
	});

	it('404 for an unknown task', async () => {
		const answer = await h.call('POST /tasks/:id/labels', {
			params: { id: 'nope' },
			query: { project },
			body: { label: 'x' },
		});
		expect(answer.status).toBe(404);
	});
});

describe('links', () => {
	it('POST adds a link and delivers onTaskLinked; the detail shows it with its derived inverse', async () => {
		const a = await createTask('a');
		const b = await createTask('b');
		const answer = await h.call('POST /tasks/:id/links', {
			params: { id: a },
			query: { project },
			body: { type: 'blockedBy', target: b.slice(0, 8) },
		});
		expect(answer.status).toBe(200);
		expect(answer.body['task']['links']).toEqual([{ type: 'blockedBy', target: b }]);
		expect(h.sink.events).toMatchObject([
			{ name: 'onTaskLinked', payload: { taskId: a, linkType: 'blockedBy', targetId: b } },
		]);
		const detail = await h.call('GET /tasks/:id', { params: { id: b }, query: { project } });
		expect(detail.body['links']['blocks'].map((t: { id: string }) => t.id)).toEqual([a]);
	});

	it('an inverse name is stored on the other task', async () => {
		const a = await createTask('a');
		const b = await createTask('b');
		const answer = await h.call('POST /tasks/:id/links', {
			params: { id: a },
			query: { project },
			body: { type: 'blocks', target: b },
		});
		expect(answer.body['task']).toMatchObject({ id: b, links: [{ type: 'blockedBy', target: a }] });
	});

	it('DELETE removes a link given in the body, and delivers onTaskUnlinked', async () => {
		const a = await createTask('a');
		const b = await createTask('b');
		await h.call('POST /tasks/:id/links', {
			params: { id: a },
			query: { project },
			body: { type: 'blockedBy', target: b },
		});
		h.sink.events.length = 0;
		const answer = await h.call('DELETE /tasks/:id/links', {
			params: { id: a },
			query: { project },
			body: { type: 'blockedBy', target: b },
		});
		expect(answer.status).toBe(200);
		expect(answer.body['task']['links'] ?? []).toEqual([]);
		expect(h.sink.events.map(e => e.name)).toEqual(['onTaskUnlinked']);
	});

	it('DELETE also accepts type and target in the query string', async () => {
		const a = await createTask('a');
		const b = await createTask('b');
		await h.call('POST /tasks/:id/links', {
			params: { id: a },
			query: { project },
			body: { type: 'causedBy', target: b },
		});
		const answer = await h.call('DELETE /tasks/:id/links', {
			params: { id: a },
			query: { project, type: 'causedBy', target: b },
		});
		expect(answer.status).toBe(200);
	});

	it('400 for an unknown link type, with valid types and a suggestion', async () => {
		const a = await createTask('a');
		const b = await createTask('b');
		const answer = await h.call('POST /tasks/:id/links', {
			params: { id: a },
			query: { project },
			body: { type: 'blokedBy', target: b },
		});
		expect(answer.status).toBe(400);
		expect(answer.body['validTypes']).toContain('blockedBy');
		expect(answer.body['suggestions']).toEqual(['blockedBy']);
		expect(h.sink.events).toEqual([]);
	});

	it.each([
		['type missing', { target: 'x' }],
		['target missing', { type: 'blockedBy' }],
		['no body', undefined],
	])('400 when %s', async (_label, body) => {
		const a = await createTask('a');
		const answer = await h.call('POST /tasks/:id/links', { params: { id: a }, query: { project }, body });
		expect(answer.status).toBe(400);
		expect(answer.body['hint']).toContain('type');
	});

	it('409 for a duplicate link, a self link and a cycle; DELETE of a missing link is 409 too', async () => {
		const a = await createTask('a');
		const b = await createTask('b');
		const add = (id: string, target: string) =>
			h.call('POST /tasks/:id/links', {
				params: { id },
				query: { project },
				body: { type: 'blockedBy', target },
			});
		expect((await add(a, b)).status).toBe(200);
		expect((await add(a, b)).status).toBe(409);
		expect((await add(a, a)).status).toBe(409);
		expect((await add(b, a)).status).toBe(409);
		const removeMissing = await h.call('DELETE /tasks/:id/links', {
			params: { id: b },
			query: { project },
			body: { type: 'blockedBy', target: a },
		});
		expect(removeMissing.status).toBe(409);
	});

	it('404 for an unknown target', async () => {
		const a = await createTask('a');
		const answer = await h.call('POST /tasks/:id/links', {
			params: { id: a },
			query: { project },
			body: { type: 'blockedBy', target: 'nope' },
		});
		expect(answer.status).toBe(404);
	});
});

describe('event delivery', () => {
	// The queue sink publishes with cwd = taskProjectPath: every event of every route must carry the project of the request.
	it('every event produced by the routes carries the project directory of the request', async () => {
		const blocker = await createTask('blocker');
		const blocked = await createTask('blocked');
		const other = await createTask('other');
		await h.call('POST /tasks', { query: { project }, body: { description: 'created through the route' } });
		const link = { params: { id: blocked }, query: { project }, body: { type: 'blockedBy', target: blocker } };
		await h.call('POST /tasks/:id/links', link);
		await h.call('DELETE /tasks/:id/links', link);
		await h.call('POST /tasks/:id/links', link);
		await h.call('POST /tasks/:id/status', {
			params: { id: blocker },
			query: { project },
			body: { status: 'done' },
		});
		await h.call('POST /tasks/:id/status', { params: { id: other }, query: { project }, body: { status: 'done' } });

		const names = new Set(h.sink.events.map(e => e.name));
		expect([...names].sort()).toEqual(
			['onStatusChange', 'onTaskCreated', 'onTaskLinked', 'onTaskUnblocked', 'onTaskUnlinked'].sort()
		);
		for (const event of h.sink.events) {
			expect(event.payload.taskProjectPath, event.name).toBe(project);
		}
	});

	it('answers 500 saying the change WAS applied when the sink throws', async () => {
		const failing: EventSink = { deliver: () => Promise.reject(new Error('queue exploded')) };
		const failingHarness = setup(failing);
		try {
			const dir = failingHarness.world.createProject('alpha');
			const answer = await failingHarness.call('POST /tasks', {
				query: { project: dir },
				body: { description: 'kept' },
			});
			expect(answer.status).toBe(500);
			expect(answer.body['error']).toContain('queue exploded');
			expect(answer.body['error']).toContain('applied');
			expect(answer.body['hint']).toContain('queue');
			const list = await failingHarness.call('GET /tasks', { query: { project: dir } });
			expect(list.body['tasks']).toHaveLength(1);
		} finally {
			failingHarness.world.cleanup();
		}
	});

	it('lists the undelivered events (reason + replay command) in a 2xx body when the sink reports them', async () => {
		const unreachable: EventSink = { deliver: () => Promise.resolve({ delivered: false, reason: 'exit 3' }) };
		const failingHarness = setup(unreachable);
		try {
			const dir = failingHarness.world.createProject('alpha', { configYml: STATUSES_YML });

			const created = await failingHarness.call('POST /tasks', {
				query: { project: dir },
				body: { description: 'kept' },
			});

			expect(created.status).toBe(201);
			expect(created.body['task']).toBeDefined();
			const undelivered = created.body['undelivered'] as Array<Record<string, unknown>>;
			expect(undelivered).toHaveLength(1);
			expect(undelivered[0]).toMatchObject({ event: 'onTaskCreated', reason: 'exit 3' });
			expect(undelivered[0]!['taskId']).toBe(created.body['task'].id);
			expect(undelivered[0]!['replay']).toMatch(/^cd '.+' && queue push onTaskCreated '\{.*\}'$/);

			const status = await failingHarness.call('POST /tasks/:id/status', {
				params: { id: created.body['task'].id },
				query: { project: dir },
				body: { status: 'in-progress' },
			});
			expect(status.status).toBe(200);
			expect((status.body['undelivered'] as unknown[]).length).toBeGreaterThan(0);
		} finally {
			failingHarness.world.cleanup();
		}
	});

	it('answers an empty undelivered array on mutating routes when everything was delivered', async () => {
		const answer = await h.call('POST /tasks', { query: { project }, body: { description: 'fine' } });

		expect(answer.status).toBe(201);
		expect(answer.body['undelivered']).toEqual([]);
	});

	describe('through the queue SDK publisher (the default sink)', () => {
		interface Call {
			event: string;
			cwd: string;
		}
		// Plain functions, not vi.fn(): the config's mockReset would wipe an implementation set at creation.
		function publisherFake(answer: () => PublishOutcome): {
			publisher: EventPublisher;
			calls: Call[];
			flushes: () => number;
		} {
			const calls: Call[] = [];
			let flushes = 0;
			return {
				calls,
				flushes: () => flushes,
				publisher: {
					publishAndWait(event, _payload, options) {
						calls.push({ event, cwd: options.cwd });
						return Promise.resolve(answer());
					},
					flush() {
						flushes++;
						return Promise.resolve();
					},
				},
			};
		}

		it('creates ONE publisher for the module, lazily at the first mutation, and sends each event with its project as cwd', async () => {
			const fake = publisherFake(() => ({ status: 'queued' }));
			let created = 0;
			const sdk = setup('default', {
				createPublisher: () => {
					created++;
					return fake.publisher;
				},
			});
			try {
				const alpha = sdk.world.createProject('alpha');
				const beta = sdk.world.createProject('beta');
				await sdk.call('GET /tasks', { query: { project: alpha } });
				expect(created).toBe(0);

				await sdk.call('POST /tasks', { query: { project: alpha }, body: { description: 'a' } });
				await sdk.call('POST /tasks', { query: { project: beta }, body: { description: 'b' } });
				await sdk.call('POST /tasks', { query: { project: alpha }, body: { description: 'c' } });

				expect(created).toBe(1);
				expect(fake.calls).toEqual([
					{ event: 'onTaskCreated', cwd: alpha },
					{ event: 'onTaskCreated', cwd: beta },
					{ event: 'onTaskCreated', cwd: alpha },
				]);
			} finally {
				sdk.world.cleanup();
			}
		});

		it('answers undelivered with status dropped, the SDK reason and the cd + queue push replay', async () => {
			const fake = publisherFake(() => ({ status: 'dropped', reason: 'queue is not installed' }));
			const sdk = setup('default', { createPublisher: () => fake.publisher });
			try {
				const dir = sdk.world.createProject('alpha');

				const created = await sdk.call('POST /tasks', {
					query: { project: dir },
					body: { description: 'kept' },
				});

				expect(created.status).toBe(201);
				const undelivered = created.body['undelivered'] as Array<Record<string, unknown>>;
				expect(undelivered).toHaveLength(1);
				expect(undelivered[0]).toMatchObject({
					event: 'onTaskCreated',
					status: 'dropped',
					reason: 'queue is not installed',
				});
				expect(undelivered[0]!['replay']).toMatch(/^cd '.+' && queue push onTaskCreated '{.*}'$/);
				expect(created.body['undeliveredText']).toContain('replay with: cd ');
			} finally {
				sdk.world.cleanup();
			}
		});

		it('answers undelivered with status unknown: may be recorded, check queue history before replaying', async () => {
			const fake = publisherFake(() => ({ status: 'unknown', reason: 'timed out' }));
			const sdk = setup('default', { createPublisher: () => fake.publisher });
			try {
				const dir = sdk.world.createProject('alpha');

				const created = await sdk.call('POST /tasks', {
					query: { project: dir },
					body: { description: 'kept' },
				});

				expect(created.status).toBe(201);
				const undelivered = created.body['undelivered'] as Array<Record<string, unknown>>;
				expect(undelivered[0]).toMatchObject({ event: 'onTaskCreated', status: 'unknown' });
				expect(undelivered[0]!['reason']).toContain('MAY be recorded');
				const text = created.body['undeliveredText'] as string;
				expect(text).toContain('MAY be recorded');
				expect(text).toContain('queue history');
				expect(text).toContain('queue replay <eventId>');
				expect(fake.calls).toHaveLength(1);
			} finally {
				sdk.world.cleanup();
			}
		});

		it('flushes the publisher in the teardown hook, through the instance the module returned', async () => {
			const fake = publisherFake(() => ({ status: 'queued' }));
			const sdk = setup('default', { createPublisher: () => fake.publisher });
			try {
				const dir = sdk.world.createProject('alpha');
				await sdk.call('POST /tasks', { query: { project: dir }, body: { description: 'a' } });

				await teardown({
					id: 'task',
					version: '0.1.0',
					previousVersion: null,
					dataDir: sdk.world.root,
					reason: 'shutdown',
					instance: sdk.instance,
				});

				expect(fake.flushes()).toBe(1);
			} finally {
				sdk.world.cleanup();
			}
		});

		it('the teardown hook tolerates a module that returned no instance', async () => {
			await expect(
				teardown({
					id: 'task',
					version: '0.1.0',
					previousVersion: null,
					dataDir: '/x',
					reason: 'unload',
					instance: undefined,
				})
			).resolves.toBeUndefined();
		});

		it('the backend entry returns the instance the teardown hook flushes', () => {
			const world = createTestWorld();
			try {
				const { ctx } = collectRoutes(path.join(world.root, 'module-data'));
				const instance = backend(ctx);
				expect(typeof (instance as TaskModuleInstance).flush).toBe('function');
			} finally {
				world.cleanup();
			}
		});
	});

	it('builds without an injected sink (the queue sink is the default and is only used on delivery)', () => {
		const world = createTestWorld();
		try {
			const { routes, ctx } = collectRoutes(path.join(world.root, 'module-data'));
			registerTaskRoutes(ctx, { configDir: world.configDir });
			expect(routes.size).toBe(EXPECTED_ROUTES.length);
		} finally {
			world.cleanup();
		}
	});
});

describe('server-side logging of unexpected errors (5xx)', () => {
	let stderr: string[];
	let failing: Harness;

	function logLines(h: Harness): Array<{ ts: string; level: string; msg: string }> {
		const dir = `${h.world.configDir}/logs`;
		if (!fs.existsSync(dir)) return [];
		return fs
			.readdirSync(dir)
			.flatMap(file => fs.readFileSync(`${dir}/${file}`, 'utf8').split('\n'))
			.filter(line => line !== '')
			.map(line => JSON.parse(line) as { ts: string; level: string; msg: string });
	}

	beforeEach(() => {
		stderr = [];
		const sink: EventSink = { deliver: () => Promise.reject(new Error('queue exploded')) };
		failing = setup(sink, { writeStderr: text => void stderr.push(text) });
	});
	afterEach(() => failing.world.cleanup());

	it('records a 5xx in the task log (same line format as undelivered events) and on stderr, with route, method, message and stack', async () => {
		const dir = failing.world.createProject('alpha');

		const answer = await failing.call('POST /tasks', { query: { project: dir }, body: { description: 'kept' } });

		expect(answer.status).toBe(500);
		const lines = logLines(failing);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toMatchObject({ level: 'error', ts: expect.any(String) as unknown });
		expect(lines[0]!.msg).toContain('POST /tasks');
		expect(lines[0]!.msg).toContain('500');
		expect(lines[0]!.msg).toContain('queue exploded');
		expect(lines[0]!.msg).toMatch(/\n\s+at /);
		expect(stderr.join('')).toContain('[task] POST /tasks failed (500)');
		expect(stderr.join('')).toContain('queue exploded');
	});

	it('records an unexpected (non-HTTP) error thrown by an operation, with its stack', async () => {
		const dir = failing.world.createProject('alpha');
		// A corrupt index makes the store throw a plain Error.
		fs.writeFileSync(`${dir}/.task/task-index.json`, '{not json');

		const answer = await failing.call('GET /tasks', { query: { project: dir } });

		expect(answer.status).toBe(500);
		const lines = logLines(failing);
		expect(lines).toHaveLength(1);
		expect(lines[0]!.msg).toContain('GET /tasks');
		expect(lines[0]!.msg).toContain(answer.body['error']);
	});

	it('does not log expected 4xx answers', async () => {
		const dir = failing.world.createProject('alpha');

		const notFound = await failing.call('GET /tasks/:id', { params: { id: 'nope' }, query: { project: dir } });
		const invalid = await failing.call('POST /tasks', { query: { project: dir }, body: {} });

		expect([notFound.status, invalid.status]).toEqual([404, 400]);
		expect(logLines(failing)).toEqual([]);
		expect(stderr).toEqual([]);
	});

	it('still answers the 500 when the log directory cannot be written, and says so on stderr', async () => {
		const dir = failing.world.createProject('alpha');
		// A file where the logs directory should be.
		fs.writeFileSync(`${failing.world.configDir}/logs`, 'x');

		const answer = await failing.call('POST /tasks', { query: { project: dir }, body: { description: 'kept' } });

		expect(answer.status).toBe(500);
		expect(stderr.join('')).toContain('could not record the error in the task log');
	});
});

const hrefOf = (id: string): string => `/modules/task/tasks/p/${projectSlug(project)}/${id}`;

describe('GET /tree rows (flat, navigable view of the forest)', () => {
	it('flattens the forest depth-first with depth, an indented label and the encoded detail link', async () => {
		const parent = await createTask('parent');
		const child = await createTask('child', { parent });
		const grandchild = await createTask('grandchild', { parent: child });
		const answer = await h.call('GET /tree', { query: { project } });
		const rows = answer.body['rows'] as Array<Record<string, unknown>>;
		expect(rows.map(r => [r['id'], r['depth']])).toEqual([
			[parent, 0],
			[child, 1],
			[grandchild, 2],
		]);
		expect(rows[0]).toMatchObject({ title: 'parent', label: 'parent', href: hrefOf(parent) });
		expect(rows[2]!['label']).toMatch(/grandchild$/);
		expect(rows[2]!['label']).not.toBe('grandchild');
		expect(answer.body['tree'][0]['children'][0]['href']).toBe(hrefOf(child));
	});

	it('with ?id marks the selected row', async () => {
		const parent = await createTask('parent');
		const child = await createTask('child', { parent });
		const answer = await h.call('GET /tree', { query: { project, id: child } });
		expect(answer.body['rows'].map((r: { id: string; selected?: boolean }) => [r.id, r.selected ?? false])).toEqual(
			[
				[parent, false],
				[child, true],
			]
		);
	});

	it('honours showAll and parent like GET /tasks', async () => {
		const parent = await createTask('parent');
		const child = await createTask('child', { parent });
		await h.call('POST /tasks/:id/status', { params: { id: child }, query: { project }, body: { status: 'done' } });
		const open = await h.call('GET /tree', { query: { project, parent } });
		expect(open.body['rows']).toEqual([]);
		const all = await h.call('GET /tree', { query: { project, parent, showAll: 'true' } });
		expect(all.body['rows'].map((r: { id: string }) => r.id)).toEqual([child]);
	});
});

describe('GET /tree nested forest (same structure as the service forest the CLI prints)', () => {
	const em = String.fromCodePoint(0x2003);
	const branch = String.fromCodePoint(0x2514);
	type Row = { id: string; label: string; depth: number; status: string; selected?: boolean };

	const close = (id: string): Promise<Answer> =>
		h.call('POST /tasks/:id/status', { params: { id }, query: { project }, body: { status: 'done' } });

	/** epic > (feature > sub > deep), (closed parent > open child), late; root2 > late2; closed root > closed leaf. */
	async function seedForest(): Promise<Record<string, string>> {
		const ids: Record<string, string> = {};
		ids['epic'] = await createTask('epic');
		ids['feature'] = await createTask('feature <b>bold</b> & "q"', { parent: ids['epic'] });
		ids['root2'] = await createTask('root2');
		ids['sub'] = await createTask('sub', { parent: ids['feature'] });
		ids['deep'] = await createTask('deep', { parent: ids['sub'] });
		ids['closedParent'] = await createTask('closed parent', { parent: ids['epic'] });
		ids['openChild'] = await createTask('open child', { parent: ids['closedParent'] });
		ids['late'] = await createTask('late', { parent: ids['epic'] });
		ids['late2'] = await createTask('late2', { parent: ids['root2'] });
		ids['closedRoot'] = await createTask('closed root');
		ids['closedLeaf'] = await createTask('closed leaf', { parent: ids['closedRoot'] });
		await close(ids['closedParent']!);
		await close(ids['closedLeaf']!);
		await close(ids['closedRoot']!);
		return ids;
	}

	it('indents each level with the branch prefix, keeps the order of the siblings, and keeps a closed parent of an open task', async () => {
		await seedForest();
		const rows = (await h.call('GET /tree', { query: { project } })).body['rows'] as Row[];
		expect(rows.map(r => [r.label, r.depth])).toEqual([
			['epic', 0],
			[`${branch} feature <b>bold</b> & "q"`, 1],
			[`${em}${branch} sub`, 2],
			[`${em}${em}${branch} deep`, 3],
			[`${branch} closed parent`, 1],
			[`${em}${branch} open child`, 2],
			[`${branch} late`, 1],
			['root2', 0],
			[`${branch} late2`, 1],
		]);
		expect(rows.find(r => r.label.endsWith('closed parent'))!.status).toBe('done');
	});

	it('shows the closed tasks with showAll, and gives the same ids, depths and order as the service forest', async () => {
		await seedForest();
		const ctx = openTaskContext({ projectDir: project });
		const flat = (nodes: TaskTreeNode[], depth = 0): Array<[string, number]> =>
			nodes.flatMap(node => [[node.id, depth] as [string, number], ...flat(node.children, depth + 1)]);
		for (const showAll of [false, true]) {
			const rows = (await h.call('GET /tree', { query: { project, ...(showAll ? { showAll: 'true' } : {}) } }))
				.body['rows'] as Row[];
			expect(rows.map(r => [r.id, r.depth])).toEqual(flat(listForest(ctx, { showAll })));
		}
		const all = (await h.call('GET /tree', { query: { project, showAll: 'true' } })).body['rows'] as Row[];
		expect(all.map(r => r.label).slice(-2)).toEqual(['closed root', `${branch} closed leaf`]);
	});

	it('with ?id shows the whole tree of the task, the task marked in its label, the others not, and names the project', async () => {
		const ids = await seedForest();
		const answer = await h.call('GET /tree', { query: { project, id: ids['sub']! } });
		const rows = answer.body['rows'] as Row[];
		expect(rows.map(r => [r.label, r.selected ?? false])).toEqual([
			['epic', false],
			[`${branch} feature <b>bold</b> & "q"`, false],
			[`${em}${branch} sub (this task)`, true],
			[`${em}${em}${branch} deep`, false],
			[`${branch} closed parent`, false],
			[`${em}${branch} open child`, false],
			[`${branch} late`, false],
		]);
		expect(answer.body['projectText']).toBe('Project: alpha');
	});

	it('survives a very deep chain (indentation grows, no stack overflow)', async () => {
		const depth = 1500;
		// The forest reads the index only: writing it directly keeps the fixture fast (a create rewrites the whole index).
		const now = new Date().toISOString();
		const tasks = Array.from({ length: depth }, (_, i) => ({
			id: `c${i}`,
			title: `chain ${i}`,
			status: 'backlog',
			createdAt: now,
			...(i === 0 ? {} : { parentId: `c${i - 1}` }),
		}));
		fs.writeFileSync(path.join(project, '.task', 'task-index.json'), JSON.stringify({ tasks }));
		const answer = await h.call('GET /tree', { query: { project } });
		expect(answer.status).toBe(200);
		const rows = answer.body['rows'] as Row[];
		expect(rows).toHaveLength(depth);
		expect(rows.at(-1)!.depth).toBe(depth - 1);
	});
});

describe('hierarchy routes', () => {
	it('POST /tasks/:id/parent attaches a task under a parent given by prefix', async () => {
		const parent = await createTask('parent');
		const child = await createTask('child');
		const answer = await h.call('POST /tasks/:id/parent', {
			params: { id: child.slice(0, 8) },
			query: { project },
			body: { parent: parent.slice(0, 8) },
		});
		expect(answer.status).toBe(200);
		expect(answer.body['task']).toMatchObject({ id: child, parentId: parent });
		expect(h.sink.events).toEqual([]);
	});

	it('POST /tasks/:id/parent is a 400 naming the usage without a parent', async () => {
		const child = await createTask('child');
		const answer = await h.call('POST /tasks/:id/parent', { params: { id: child }, query: { project }, body: {} });
		expect(answer.status).toBe(400);
		expect(answer.body['error']).toContain('parent');
		expect(answer.body['hint']).toContain('"parent"');
	});

	it('POST /tasks/:id/parent refuses a cycle with a 4xx explaining it (nothing changes)', async () => {
		const parent = await createTask('parent');
		const child = await createTask('child', { parent });
		const answer = await h.call('POST /tasks/:id/parent', {
			params: { id: parent },
			query: { project },
			body: { parent: child },
		});
		expect(answer.status).toBeGreaterThanOrEqual(400);
		expect(answer.status).toBeLessThan(500);
		const detail = await h.call('GET /tasks/:id', { params: { id: parent }, query: { project } });
		expect(detail.body['parent']).toBeNull();
	});

	it('POST /tasks/:id/parent is a 404 for an unknown parent', async () => {
		const child = await createTask('child');
		const answer = await h.call('POST /tasks/:id/parent', {
			params: { id: child },
			query: { project },
			body: { parent: 'zzzz' },
		});
		expect(answer.status).toBe(404);
	});

	it('DELETE /tasks/:id/parent makes the task a root task', async () => {
		const parent = await createTask('parent');
		const child = await createTask('child', { parent });
		const answer = await h.call('DELETE /tasks/:id/parent', { params: { id: child }, query: { project } });
		expect(answer.status).toBe(200);
		expect(answer.body['task']['parentId']).toBeUndefined();
	});

	it('GET /tasks/:id/children lists the direct children with their links', async () => {
		const parent = await createTask('parent');
		const child = await createTask('child', { parent });
		await createTask('grandchild', { parent: child });
		const answer = await h.call('GET /tasks/:id/children', { params: { id: parent }, query: { project } });
		expect(answer.status).toBe(200);
		expect(answer.body['children'].map((c: { id: string }) => c.id)).toEqual([child]);
		expect(answer.body['children'][0]['href']).toBe(hrefOf(child));
	});

	it('GET /tasks/:id/children?recursive=true returns the nested subtree and its flat rows', async () => {
		const parent = await createTask('parent');
		const child = await createTask('child', { parent });
		const grandchild = await createTask('grandchild', { parent: child });
		const answer = await h.call('GET /tasks/:id/children', {
			params: { id: parent },
			query: { project, recursive: 'true' },
		});
		expect(answer.body['children']).toMatchObject([{ id: child, children: [{ id: grandchild, children: [] }] }]);
		expect(answer.body['rows'].map((r: { id: string; depth: number }) => [r.id, r.depth])).toEqual([
			[child, 0],
			[grandchild, 1],
		]);
	});

	it('GET /tasks/:id/children 400s on a recursive value that is not true or false', async () => {
		const parent = await createTask('parent');
		const answer = await h.call('GET /tasks/:id/children', {
			params: { id: parent },
			query: { project, recursive: 'yes' },
		});
		expect(answer.status).toBe(400);
		expect(answer.body['hint']).toContain('true');
	});

	it('GET /tasks/:id/ancestors goes from the direct parent up to the root', async () => {
		const root = await createTask('root');
		const middle = await createTask('middle', { parent: root });
		const leaf = await createTask('leaf', { parent: middle });
		const answer = await h.call('GET /tasks/:id/ancestors', { params: { id: leaf }, query: { project } });
		expect(answer.status).toBe(200);
		expect(answer.body['ancestors'].map((a: { id: string }) => a.id)).toEqual([middle, root]);
		expect(answer.body['ancestors'][0]['href']).toBe(hrefOf(middle));
	});

	it('GET /tasks/:id/ancestors is a 404 for an unknown id', async () => {
		const answer = await h.call('GET /tasks/:id/ancestors', { params: { id: 'nope' }, query: { project } });
		expect(answer.status).toBe(404);
	});
});

describe('GET /tasks/:id/links', () => {
	it('lists outgoing links and the derived inverses as rows naming the relation, with the other task and its link', async () => {
		const a = await createTask('a');
		const b = await createTask('b');
		await h.call('POST /tasks/:id/links', {
			params: { id: a },
			query: { project },
			body: { type: 'blockedBy', target: b },
		});
		const fromA = await h.call('GET /tasks/:id/links', { params: { id: a }, query: { project } });
		expect(fromA.status).toBe(200);
		expect(fromA.body['id']).toBe(a);
		expect(fromA.body['rows']).toEqual([
			{
				relation: 'blockedBy',
				direction: 'outgoing',
				id: b,
				title: 'b',
				titleText: 'b',
				status: 'backlog',
				href: hrefOf(b),
			},
		]);
		const fromB = await h.call('GET /tasks/:id/links', { params: { id: b }, query: { project } });
		expect(fromB.body['rows']).toEqual([
			{
				relation: 'blocks',
				direction: 'derived',
				id: a,
				title: 'a',
				titleText: 'a',
				status: 'backlog',
				href: hrefOf(a),
			},
		]);
		expect(fromB.body['links']['blocks'].map((t: { id: string }) => t.id)).toEqual([a]);
	});

	it('has no rows for a task without links', async () => {
		const a = await createTask('a');
		const answer = await h.call('GET /tasks/:id/links', { params: { id: a }, query: { project } });
		expect(answer.body['rows']).toEqual([]);
	});

	it('is a 404 for an unknown id', async () => {
		const answer = await h.call('GET /tasks/:id/links', { params: { id: 'nope' }, query: { project } });
		expect(answer.status).toBe(404);
	});
});

describe('GET /tasks/:id (display fields)', () => {
	it('gives the labels and the metadata as rows to display', async () => {
		const id = await createTask('t');
		await h.call('POST /tasks/:id/labels', { params: { id }, query: { project }, body: { label: 'urgent' } });
		await h.call('POST /tasks/:id/meta', {
			params: { id },
			query: { project },
			body: { key: 'owner', value: 'ann' },
		});
		const answer = await h.call('GET /tasks/:id', { params: { id }, query: { project } });
		expect(answer.body['labelRows']).toEqual([{ label: 'urgent' }]);
		expect(answer.body['metaRows']).toEqual([{ key: 'owner', value: 'ann' }]);
	});

	it('has empty rows for a bare task', async () => {
		const id = await createTask('t');
		const answer = await h.call('GET /tasks/:id', { params: { id }, query: { project } });
		expect(answer.body['labelRows']).toEqual([]);
		expect(answer.body['metaRows']).toEqual([]);
	});
});

describe('types', () => {
	it('GET /types is empty and unrestricted when none is configured', async () => {
		const answer = await h.call('GET /types', { query: { project } });
		expect(answer.status).toBe(200);
		expect(answer.body).toMatchObject({
			project: { name: 'alpha', path: project },
			types: [],
			rows: [],
			removeOptions: [],
			restricted: false,
		});
	});

	it('POST /types adds a valid type and answers the new list; adding twice is idempotent', async () => {
		const first = await h.call('POST /types', { query: { project }, body: { name: 'bug' } });
		expect(first.status).toBe(200);
		expect(first.body['types']).toEqual(['bug']);
		expect(first.body['restricted']).toBe(true);
		const second = await h.call('POST /types', { query: { project }, body: { name: 'bug' } });
		expect(second.body['types']).toEqual(['bug']);
		const list = await h.call('GET /types', { query: { project } });
		expect(list.body['rows']).toEqual([{ name: 'bug' }]);
	});

	it('POST /types keeps the statuses of config.yml', async () => {
		await h.call('POST /types', { query: { project }, body: { name: 'bug' } });
		const answer = await h.call('GET /summary', { query: { project } });
		expect(answer.body['byStatus'].map((s: { status: string }) => s.status)).toEqual([
			'backlog',
			'in-progress',
			'done',
		]);
	});

	it('POST /types is a 400 without a name', async () => {
		const answer = await h.call('POST /types', { query: { project }, body: {} });
		expect(answer.status).toBe(400);
		expect(answer.body['hint']).toContain('"name"');
	});

	it('DELETE /types/:name removes a configured type', async () => {
		await h.call('POST /types', { query: { project }, body: { name: 'bug' } });
		await h.call('POST /types', { query: { project }, body: { name: 'feature' } });
		const answer = await h.call('DELETE /types/:name', { params: { name: 'bug' }, query: { project } });
		expect(answer.status).toBe(200);
		expect(answer.body['types']).toEqual(['feature']);
	});

	it('DELETE /types/:name is a 404 (not a silent success) for a type that is not configured', async () => {
		await h.call('POST /types', { query: { project }, body: { name: 'bug' } });
		const answer = await h.call('DELETE /types/:name', { params: { name: 'bugg' }, query: { project } });
		expect(answer.status).toBe(404);
		expect(answer.body['error']).toContain('bugg');
		expect(answer.body['hint']).toContain('bug');
	});

	it('POST /tasks/:id/type sets the type, any string when none is configured', async () => {
		const id = await createTask('t');
		const answer = await h.call('POST /tasks/:id/type', {
			params: { id },
			query: { project },
			body: { type: 'whatever' },
		});
		expect(answer.status).toBe(200);
		expect(answer.body['task']).toMatchObject({ id, type: 'whatever' });
	});

	it('POST /tasks/:id/type is a 400 with the valid types when the type is not configured', async () => {
		const id = await createTask('t');
		await h.call('POST /types', { query: { project }, body: { name: 'bug' } });
		const answer = await h.call('POST /tasks/:id/type', {
			params: { id },
			query: { project },
			body: { type: 'bugg' },
		});
		expect(answer.status).toBe(400);
		expect(answer.body['error']).toContain('bugg');
		const fine = await h.call('POST /tasks/:id/type', {
			params: { id },
			query: { project },
			body: { type: 'bug' },
		});
		expect(fine.body['task']['type']).toBe('bug');
	});

	it('POST /tasks/:id/type is a 400 without a type', async () => {
		const id = await createTask('t');
		const answer = await h.call('POST /tasks/:id/type', { params: { id }, query: { project }, body: {} });
		expect(answer.status).toBe(400);
		expect(answer.body['hint']).toContain('"type"');
	});
});

describe('POST /tasks/:id/meta', () => {
	it('sets a metadata key, replacing an existing value', async () => {
		const id = await createTask('t');
		await h.call('POST /tasks/:id/meta', {
			params: { id },
			query: { project },
			body: { key: 'owner', value: 'ann' },
		});
		const answer = await h.call('POST /tasks/:id/meta', {
			params: { id: id.slice(0, 8) },
			query: { project },
			body: { key: 'owner', value: 'bob' },
		});
		expect(answer.status).toBe(200);
		expect(answer.body['task']['meta']).toEqual({ owner: 'bob' });
		expect(h.sink.events).toEqual([]);
	});

	it('accepts an empty value (like the CLI) but not an empty key or a non-string value', async () => {
		const id = await createTask('t');
		const call = (body: unknown): Promise<Answer> =>
			h.call('POST /tasks/:id/meta', { params: { id }, query: { project }, body });
		expect((await call({ key: 'k', value: '' })).status).toBe(200);
		const noKey = await call({ key: '', value: 'v' });
		expect(noKey.status).toBe(400);
		expect(noKey.body['hint']).toContain('"key"');
		const number = await call({ key: 'k', value: 3 });
		expect(number.status).toBe(400);
		expect(number.body['error']).toContain('value');
	});

	it('is a 404 for an unknown id', async () => {
		const answer = await h.call('POST /tasks/:id/meta', {
			params: { id: 'nope' },
			query: { project },
			body: { key: 'k', value: 'v' },
		});
		expect(answer.status).toBe(404);
	});
});

describe('delete', () => {
	async function ids(): Promise<string[]> {
		const answer = await h.call('GET /tasks', { query: { project, showAll: 'true' } });
		return answer.body['tasks'].map((t: { id: string }) => t.id);
	}
	const plan = (body: unknown): Promise<Answer> => h.call('POST /tasks/delete/plan', { query: { project }, body });
	const remove = (body: unknown): Promise<Answer> => h.call('POST /tasks/delete', { query: { project }, body });

	it('POST /tasks/delete/plan previews the selection without deleting', async () => {
		const a = await createTask('a');
		const b = await createTask('b');
		const answer = await plan({ ids: [a.slice(0, 8)] });
		expect(answer.status).toBe(200);
		expect(answer.body).toMatchObject({ count: 1, notFound: [], orphanCount: 0, danglingLinkCount: 0 });
		expect(answer.body['tasks'].map((t: { id: string }) => t.id)).toEqual([a]);
		expect(answer.body['summary']).toContain('Would delete 1 task');
		expect(await ids()).toEqual([a, b]);
	});

	it('accepts comma-separated ids in a string and reports prefixes that match nothing', async () => {
		const a = await createTask('a');
		const answer = await plan({ ids: `${a},zzzz` });
		expect(answer.body['count']).toBe(1);
		expect(answer.body['notFound']).toEqual(['zzzz']);
		expect(answer.body['summary']).toContain('zzzz');
	});

	it('selects with all, or with a field=glob filter', async () => {
		const a = await createTask('alpha job');
		await createTask('beta job');
		expect((await plan({ all: true })).body['count']).toBe(2);
		const filtered = await plan({ filter: 'title=alpha*' });
		expect(filtered.body['tasks'].map((t: { id: string }) => t.id)).toEqual([a]);
	});

	it('is a 400 listing the valid fields for an invalid filter', async () => {
		const answer = await plan({ filter: 'colour=red' });
		expect(answer.status).toBe(400);
		expect(answer.body['hint']).toContain('title');
	});

	it('is a 400 with the usage unless exactly one selector is given', async () => {
		for (const body of [
			{},
			{ all: true, filter: 'title=*' },
			{ ids: ['a'], all: true },
			{ ids: [] },
			{ all: false },
		]) {
			const answer = await plan(body);
			expect(answer.status, JSON.stringify(body)).toBe(400);
			expect(answer.body['hint'], JSON.stringify(body)).toContain('ids');
		}
	});

	it('cascade adds the descendants; without it the surviving children are counted as orphans', async () => {
		const parent = await createTask('parent');
		const child = await createTask('child', { parent });
		const plain = await plan({ ids: [parent] });
		expect(plain.body).toMatchObject({ count: 1, orphanCount: 1 });
		expect(plain.body['summary']).toContain('1 child task(s) would become root tasks');
		const cascade = await plan({ ids: [parent], cascade: true });
		expect(cascade.body['tasks'].map((t: { id: string }) => t.id)).toEqual([parent, child]);
		expect(cascade.body['orphanCount']).toBe(0);
	});

	it('counts the links of surviving tasks that point to a deleted task', async () => {
		const a = await createTask('a');
		const b = await createTask('b');
		await h.call('POST /tasks/:id/links', {
			params: { id: a },
			query: { project },
			body: { type: 'blockedBy', target: b },
		});
		const answer = await plan({ ids: [b] });
		expect(answer.body['danglingLinkCount']).toBe(1);
		expect(answer.body['summary']).toContain('1 link(s)');
	});

	it('POST /tasks/delete without confirm:true is a 400 carrying the plan, and deletes nothing', async () => {
		const a = await createTask('a');
		for (const body of [{ ids: [a] }, { ids: [a], confirm: false }, { ids: [a], confirm: 'true' }]) {
			const answer = await remove(body);
			expect(answer.status, JSON.stringify(body)).toBe(400);
			expect(answer.body['error']).toContain('confirm');
			expect(answer.body['hint']).toContain('"confirm": true');
			expect(answer.body['plan']).toMatchObject({ count: 1 });
		}
		expect(await ids()).toEqual([a]);
	});

	it('POST /tasks/delete with confirm:true deletes the planned tasks and reports the outcome', async () => {
		const parent = await createTask('parent');
		await createTask('child', { parent });
		const keep = await createTask('keep');
		const answer = await remove({ ids: [parent], cascade: true, confirm: true });
		expect(answer.status).toBe(200);
		expect(answer.body).toMatchObject({ deletedCount: 2, orphanCount: 0, danglingLinkCount: 0, notFound: [] });
		expect(answer.body['summary']).toContain('Deleted 2 task');
		expect(await ids()).toEqual([keep]);
		expect(h.sink.events).toEqual([]);
	});

	it('POST /tasks/delete with confirm:true and nothing matching is a 200 deleting nothing', async () => {
		const answer = await remove({ ids: ['zzzz'], confirm: true });
		expect(answer.status).toBe(200);
		expect(answer.body).toMatchObject({ deletedCount: 0, notFound: ['zzzz'] });
	});

	it('POST /tasks/delete validates the selector before checking the confirmation', async () => {
		const answer = await remove({ confirm: true });
		expect(answer.status).toBe(400);
		expect(answer.body['hint']).toContain('ids');
	});
});

describe('GET /tasks (list filters)', () => {
	it('parent and showAll combine', async () => {
		const parent = await createTask('parent');
		const child = await createTask('child', { parent });
		await h.call('POST /tasks/:id/status', { params: { id: child }, query: { project }, body: { status: 'done' } });
		const open = await h.call('GET /tasks', { query: { project, parent } });
		expect(open.body['tasks']).toEqual([]);
		const all = await h.call('GET /tasks', { query: { project, parent, showAll: 'true' } });
		expect(all.body['tasks'].map((t: { id: string }) => t.id)).toEqual([child]);
	});

	it('an empty ?parent or ?showAll (a cleared filter field) means no filter', async () => {
		await createTask('a');
		const answer = await h.call('GET /tasks', { query: { project, parent: '', showAll: '' } });
		expect(answer.status).toBe(200);
		expect(answer.body['tasks']).toHaveLength(1);
	});
});

describe('GET /tasks/:id (form options)', () => {
	it('gives the statuses and the configured types as select options, and the encoded project for action URLs', async () => {
		const id = await createTask('t');
		await h.call('POST /types', { query: { project }, body: { name: 'bug' } });
		const answer = await h.call('GET /tasks/:id', { params: { id }, query: { project } });
		expect(answer.body['statusOptions']).toEqual([
			{ value: 'backlog', label: 'backlog' },
			{ value: 'in-progress', label: 'in-progress' },
			{ value: 'done', label: 'done' },
		]);
		expect(answer.body['typeOptions']).toEqual([{ value: 'bug', label: 'bug' }]);
		expect(answer.body['projectParam']).toBe(encodeURIComponent(project));
	});
});

describe('undeliveredText (ready-to-display line for the views)', () => {
	it('is null when everything was delivered, on every event-producing route', async () => {
		const created = await h.call('POST /tasks', { query: { project }, body: { description: 'a' } });
		const id = created.body['task'].id as string;
		const other = await createTask('b');
		const status = await h.call('POST /tasks/:id/status', {
			params: { id },
			query: { project },
			body: { status: 'in-progress' },
		});
		const link = await h.call('POST /tasks/:id/links', {
			params: { id },
			query: { project },
			body: { type: 'blockedBy', target: other },
		});
		const unlink = await h.call('DELETE /tasks/:id/links', {
			params: { id },
			query: { project },
			body: { type: 'blockedBy', target: other },
		});
		for (const answer of [created, status, link, unlink]) {
			expect(answer.body['undeliveredText']).toBeNull();
		}
	});

	it('names the events, the reason and the replay command when the queue did not get them', async () => {
		const unreachable: EventSink = { deliver: () => Promise.resolve({ delivered: false, reason: 'exit 3' }) };
		const failingHarness = setup(unreachable);
		try {
			const dir = failingHarness.world.createProject('alpha', { configYml: STATUSES_YML });
			const created = await failingHarness.call('POST /tasks', {
				query: { project: dir },
				body: { description: 'kept' },
			});
			const text = created.body['undeliveredText'] as string;
			expect(text).toContain('onTaskCreated');
			expect(text).toContain('exit 3');
			expect(text).toContain('queue push onTaskCreated');
			expect(text).toContain('saved');
		} finally {
			failingHarness.world.cleanup();
		}
	});
});

describe('view data: page links, filters and form defaults', () => {
	const projectParam = (): string => encodeURIComponent(project);
	// The address of a page of the project: the slug is a path segment (the breadcrumb keeps those, not the query).
	const page = (name: 'tasks' | 'tree' | 'types' | 'new' | 'delete', query = ''): string => {
		const section = name === 'new' || name === 'delete' ? 'tasks' : name;
		const tail = name === 'new' || name === 'delete' ? `/${name}` : '';
		return `/modules/task/${section}/p/${projectSlug(project)}${tail}${query}`;
	};

	it('GET /tasks, /tree, /types and /tasks/:id link the pages that act on the project, by path (no ?project=)', async () => {
		const id = await createTask('t');
		const expected = {
			newTask: page('new'),
			deleteTasks: page('delete'),
			projects: '/modules/task/projects',
		};
		for (const [route, params] of [
			['GET /tasks', {}],
			['GET /tree', {}],
			['GET /types', {}],
			['GET /tasks/:id', { id }],
		] as const) {
			const answer = await h.call(route, { params, query: { project } });
			expect(answer.body['hrefs'], route).toEqual(expected);
		}
	});

	describe('GET /tasks filters', () => {
		it('reports the active filters and a link toggling showAll while keeping the parent filter', async () => {
			const parent = await createTask('parent');
			const plain = await h.call('GET /tasks', { query: { project } });
			expect(plain.body['filters']).toEqual({ showAll: false, parent: null });
			expect(plain.body['showAllToggle']).toEqual({
				label: 'Show closed tasks',
				href: page('tasks', '?showAll=true'),
			});
			expect(plain.body['clearParentHref']).toBeNull();

			const filtered = await h.call('GET /tasks', { query: { project, showAll: 'true', parent } });
			expect(filtered.body['filters']).toEqual({ showAll: true, parent });
			expect(filtered.body['showAllToggle']).toEqual({
				label: 'Hide closed tasks',
				href: page('tasks', `?parent=${parent}`),
			});
			expect(filtered.body['clearParentHref']).toBe(page('tasks', '?showAll=true'));
			expect(filtered.body['parentFilterText']).toContain(parent);
		});

		it('gives the open tasks as options for a parent selector', async () => {
			const a = await createTask('first task');
			const closed = await createTask('closed task');
			await h.call('POST /tasks/:id/status', {
				params: { id: closed },
				query: { project },
				body: { status: 'done' },
			});
			const answer = await h.call('GET /tasks', { query: { project } });
			expect(answer.body['parentOptions']).toEqual([{ value: a, label: `${a} first task` }]);
		});
	});

	it('GET /tree gives the showAll toggle like GET /tasks', async () => {
		const answer = await h.call('GET /tree', { query: { project } });
		expect(answer.body['showAllToggle']).toEqual({
			label: 'Show closed tasks',
			href: page('tree', '?showAll=true'),
		});
	});

	describe('GET /tasks/:id form data', () => {
		it('gives each form its encoded project and current values, and the options of the selects', async () => {
			const id = await createTask('t');
			await h.call('POST /types', { query: { project }, body: { name: 'bug' } });
			await h.call('POST /tasks/:id/labels', {
				params: { id },
				query: { project },
				body: { label: 'needs review' },
			});
			const answer = await h.call('GET /tasks/:id', { params: { id }, query: { project } });
			const base = { projectParam: projectParam() };
			expect(answer.body['forms']).toEqual({
				status: { ...base, status: 'backlog' },
				type: { ...base, type: '' },
				label: { ...base, label: '' },
				meta: { ...base, key: '', value: '' },
				parent: { ...base, parent: '' },
				link: { ...base, type: 'blockedBy', target: '' },
				empty: base,
			});
			expect(answer.body['hasTypes']).toBe(true);
			expect(answer.body['noTypes']).toBe(false);
			expect(answer.body['hasLabels']).toBe(true);
			expect(answer.body['labelOptions']).toEqual([
				{ value: encodeURIComponent('needs review'), label: 'needs review' },
			]);
			expect(answer.body['linkTypeOptions'].map((o: { value: string }) => o.value)).toEqual([
				'blockedBy',
				'duplicateOf',
				'causedBy',
				'blocks',
				'duplicates',
				'causes',
			]);
		});

		it('hasTypes is false when no type is configured', async () => {
			const id = await createTask('t');
			const answer = await h.call('GET /tasks/:id', { params: { id }, query: { project } });
			expect(answer.body['hasTypes']).toBe(false);
			// The DSL has no negation in $if: the opposite flag is given too.
			expect(answer.body['noTypes']).toBe(true);
			expect(answer.body['hasLabels']).toBe(false);
		});

		it('links to the history, the tree of the task and the list of its children', async () => {
			const id = await createTask('t');
			const answer = await h.call('GET /tasks/:id', { params: { id }, query: { project } });
			expect(answer.body['taskHrefs']).toEqual({
				detail: `/modules/task/tasks/p/${projectSlug(project)}/${id}`,
				history: `/modules/task/tasks/p/${projectSlug(project)}/${id}/history`,
				childrenList: page('tasks', `?parent=${id}&showAll=true`),
			});
		});
	});

	describe('GET /types form data', () => {
		it('gives the add and remove forms their encoded project and the removable types encoded for the URL', async () => {
			await h.call('POST /types', { query: { project }, body: { name: 'my type' } });
			const answer = await h.call('GET /types', { query: { project } });
			expect(answer.body['forms']).toEqual({
				add: { projectParam: projectParam(), name: '' },
				remove: { projectParam: projectParam(), name: '' },
			});
			expect(answer.body['removeOptions']).toEqual([{ value: encodeURIComponent('my type'), label: 'my type' }]);
		});
	});

	describe('GET /projects selection data', () => {
		it('with several projects and none selected, asks for a selection and offers the projects as encoded options', async () => {
			const beta = h.world.createProject('beta');
			const answer = await h.call('GET /projects');
			expect(answer.body['multiple']).toBe(true);
			expect(answer.body['needsSelection']).toBe(true);
			// The views skip their sources while this is empty (a failing source would blank the whole page).
			expect(answer.body['selectedParam']).toBe('');
			expect(answer.body['projectOptions']).toEqual([
				{ value: encodeURIComponent(project), label: 'alpha' },
				{ value: encodeURIComponent(beta), label: 'beta' },
			]);
			expect(answer.body['forms']['create']).toMatchObject({ projectParam: '', description: '', parent: '' });
		});

		it('with ?project given, nothing is left to select and the forms carry the encoded project', async () => {
			h.world.createProject('beta');
			const answer = await h.call('GET /projects', { query: { project } });
			expect(answer.body['needsSelection']).toBe(false);
			expect(answer.body['selectedParam']).toBe(encodeURIComponent(project));
			expect(answer.body['forms']['delete']).toEqual({
				projectParam: encodeURIComponent(project),
				ids: '',
				filter: '',
				all: false,
				cascade: false,
			});
		});

		it('with a single project, it is the selection', async () => {
			const answer = await h.call('GET /projects');
			expect(answer.body['multiple']).toBe(false);
			expect(answer.body['needsSelection']).toBe(false);
			expect(answer.body['forms']['create']['projectParam']).toBe(encodeURIComponent(project));
		});
	});

	describe('GET /projects projectQuery (query string the views append to their sources)', () => {
		it('is the encoded project plus the pass-through filters given, and the blank request while no project is selected', async () => {
			h.world.createProject('beta');
			const none = await h.call('GET /projects', { query: { showAll: 'true' } });
			expect(none.body['projectQuery']).toBe('blank=true');
			const withFilters = await h.call('GET /projects', {
				query: { project, showAll: 'true', parent: 'ab cd', id: '', ignored: 'x' },
			});
			expect(withFilters.body['projectQuery']).toBe(
				`project=${encodeURIComponent(project)}&showAll=true&parent=ab%20cd`
			);
			const plain = await h.call('GET /projects', { query: { project } });
			expect(plain.body['projectQuery']).toBe(`project=${encodeURIComponent(project)}`);
		});
	});

	describe('POST /tasks answer for the create page', () => {
		it('gives a message and the link to the created task', async () => {
			const answer = await h.call('POST /tasks', { query: { project }, body: { description: 'new one' } });
			const id = answer.body['task'].id as string;
			expect(answer.body['message']).toBe(`Created task ${id}: new one`);
			expect(answer.body['href']).toBe(`/modules/task/tasks/p/${projectSlug(project)}/${id}`);
		});
	});

	describe('delete plan answer for the delete page', () => {
		it('offers the confirmation request only when something would be deleted, with the exact selector', async () => {
			const a = await createTask('a');
			const withTask = await h.call('POST /tasks/delete/plan', {
				query: { project },
				body: { ids: [a], cascade: true },
			});
			expect(withTask.body['canConfirm']).toBe(true);
			expect(withTask.body['confirmRequest']).toEqual({
				projectParam: projectParam(),
				ids: [a],
				cascade: true,
				confirm: true,
			});
			const none = await h.call('POST /tasks/delete/plan', {
				query: { project },
				body: { filter: 'title=nothing*' },
			});
			expect(none.body['canConfirm']).toBe(false);
			expect(none.body['confirmRequest']).toBeNull();
		});

		it('ignores the blank fields a form sends and the extra keys, selecting with the one that is filled', async () => {
			const a = await createTask('alpha');
			await createTask('beta');
			const answer = await h.call('POST /tasks/delete/plan', {
				query: { project },
				body: { projectParam: projectParam(), ids: '', filter: 'title=alpha', all: false, cascade: false },
			});
			expect(answer.status).toBe(200);
			expect(answer.body['tasks'].map((t: { id: string }) => t.id)).toEqual([a]);
			expect(answer.body['confirmRequest']).toEqual({
				projectParam: projectParam(),
				filter: 'title=alpha',
				cascade: false,
				confirm: true,
			});
		});

		it('still 400s when every selector is blank', async () => {
			const answer = await h.call('POST /tasks/delete/plan', {
				query: { project },
				body: { ids: '', filter: '', all: false },
			});
			expect(answer.status).toBe(400);
		});
	});
});

describe('POST /tasks from a form', () => {
	it('a blank parent (the empty select of a form) means no parent', async () => {
		const answer = await h.call('POST /tasks', { query: { project }, body: { description: 'root', parent: '' } });
		expect(answer.status).toBe(201);
		expect(answer.body['task']['parentId']).toBeUndefined();
	});

	it('extra fields of the form (projectParam...) are ignored', async () => {
		const answer = await h.call('POST /tasks', {
			query: { project },
			body: { description: 'x', parent: '', projectParam: 'whatever' },
		});
		expect(answer.status).toBe(201);
	});
});

describe('inline errors (?inlineErrors=true): the views cannot read a failed request, so the answer carries the error', () => {
	const projectQuery = (): Record<string, unknown> => ({ project, inlineErrors: 'true' });

	it('a rejected action answers 200 with failed, the original status and a ready-to-display errorText (message and hint)', async () => {
		const id = await createTask('a');
		const answer = await h.call('POST /tasks/:id/links', {
			params: { id },
			query: projectQuery(),
			body: { type: 'blockedBy', target: 'zzzzzzzz' },
		});
		expect(answer.status).toBe(200);
		expect(answer.body).toMatchObject({ failed: true, httpStatus: 404 });
		expect(answer.body['errorText']).toContain(answer.body['error']);
		expect(answer.body['errorText']).toContain('zzzzzzzz');
	});

	it('appends the hint of the error to errorText when there is one', async () => {
		const id = await createTask('a');
		const answer = await h.call('POST /tasks/:id/status', {
			params: { id },
			query: projectQuery(),
			body: { status: 'nope' },
		});
		expect(answer.status).toBe(200);
		expect(answer.body['hint']).toBeTruthy();
		expect(answer.body['errorText']).toContain(answer.body['hint']);
	});

	it('leaves out the hints that explain the JSON body of the API: a form user has no body to fix', async () => {
		const answer = await h.call('POST /tasks', { query: projectQuery(), body: { description: '   ' } });
		expect(answer.status).toBe(200);
		expect(answer.body['hint']).toContain('Send a JSON body');
		expect(answer.body['errorText']).toBe('description must not be blank');
	});

	it('without the flag the same failure keeps its HTTP status (API callers, the CLI-like contract)', async () => {
		const id = await createTask('a');
		const answer = await h.call('POST /tasks/:id/links', {
			params: { id },
			query: { project },
			body: { type: 'blockedBy', target: 'zzzzzzzz' },
		});
		expect(answer.status).toBe(404);
		expect(answer.body).not.toHaveProperty('errorText');
	});

	it('also covers reads: a task that does not exist', async () => {
		const answer = await h.call('GET /tasks/:id', { params: { id: 'nope' }, query: projectQuery() });
		expect(answer.status).toBe(200);
		expect(answer.body).toMatchObject({ failed: true, httpStatus: 404 });
		expect(answer.body['errorText']).toContain('nope');
	});

	it('a successful request has no errorText nor failed flag (the view hides its error badge)', async () => {
		const id = await createTask('a');
		const answer = await h.call('POST /tasks/:id/labels', {
			params: { id },
			query: projectQuery(),
			body: { label: 'x' },
		});
		expect(answer.status).toBe(200);
		expect(answer.body).not.toHaveProperty('errorText');
		expect(answer.body).not.toHaveProperty('failed');
	});

	it('an unexpected failure (5xx) is still logged on the server side and answered inline', async () => {
		const lines: string[] = [];
		const broken = setup(
			{ deliver: () => Promise.reject(new Error('sink exploded')) },
			{ writeStderr: text => lines.push(text) }
		);
		try {
			const dir = broken.world.createProject('gamma', { configYml: STATUSES_YML });
			const answer = await broken.call('POST /tasks', {
				query: { project: dir, inlineErrors: 'true' },
				body: { description: 'x' },
			});
			expect(answer.status).toBe(200);
			expect(answer.body).toMatchObject({ failed: true, httpStatus: 500 });
			expect(lines.join('')).toContain('sink exploded');
		} finally {
			broken.world.cleanup();
		}
	});

	it('the delete route reports the missing confirmation inline', async () => {
		const id = await createTask('a');
		const answer = await h.call('POST /tasks/delete', {
			query: projectQuery(),
			body: { ids: id },
		});
		expect(answer.status).toBe(200);
		expect(answer.body).toMatchObject({ failed: true, httpStatus: 400 });
		expect(answer.body['errorText']).toContain('confirm must be true');
	});
});

describe('POST /tasks: blank descriptions', () => {
	it('rejects a description made of whitespace only (it would create a task with an empty title)', async () => {
		const answer = await h.call('POST /tasks', { query: { project }, body: { description: '   ' } });
		expect(answer.status).toBe(400);
		expect(answer.body['error']).toContain('description');
	});
});

describe('selected project that cannot be read', () => {
	it('GET /projects names the problem and asks for the blank answer (projectQuery), so the views show the reason instead of failing', async () => {
		const broken = h.world.createProject('broken');
		fs.rmSync(`${broken}/.task`, { recursive: true });
		const answer = await h.call('GET /projects', { query: { project: broken } });
		expect(answer.body['projectQuery']).toBe('blank=true');
		expect(answer.body['selectedProblem']).toContain('not initialized');
		expect(answer.body['selectedProblem']).toContain('task init');
	});

	it('has no selectedProblem for a readable project', async () => {
		const answer = await h.call('GET /projects', { query: { project } });
		expect(answer.body['selectedProblem']).toBeNull();
	});
});

describe('display text of dates and titles (the views cannot format a column)', () => {
	it('task rows carry a short UTC "created" text and a truncated titleText, the title stays whole', async () => {
		const long = `word ${'long '.repeat(40)}end`;
		await createTask(long);
		const answer = await h.call('GET /tasks', { query: { project } });
		const row = answer.body['tasks'][0];
		expect(row['title']).toBe(long);
		expect(row['titleText'].length).toBeLessThanOrEqual(90);
		expect(row['titleText'].endsWith('\u2026')).toBe(true);
		expect(row['created']).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d$/);
	});

	it('a short title is shown as is', async () => {
		await createTask('short');
		const answer = await h.call('GET /tasks', { query: { project } });
		expect(answer.body['tasks'][0]['titleText']).toBe('short');
	});

	it('tree rows truncate the label, not the title', async () => {
		const long = `x${' y'.repeat(100)}`;
		await createTask(long);
		const answer = await h.call('GET /tree', { query: { project } });
		expect(answer.body['rows'][0]['title']).toBe(long);
		expect(answer.body['rows'][0]['label'].length).toBeLessThanOrEqual(90);
	});

	it('the history has rows with a short UTC time', async () => {
		const id = await createTask('t');
		await h.call('POST /tasks/:id/status', { params: { id }, query: { project }, body: { status: 'in-progress' } });
		const answer = await h.call('GET /tasks/:id/history', { params: { id }, query: { project } });
		expect(answer.body['rows'].map((r: { status: string }) => r.status)).toEqual(['backlog', 'in-progress']);
		expect(answer.body['rows'][0]['time']).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d$/);
	});
});

describe('detail page flags', () => {
	it('canDetach is true when the task has a parentId, even a dangling one (the fix must be reachable from the page)', async () => {
		const parent = await createTask('parent');
		const child = await createTask('child', { parent });
		const root = await h.call('GET /tasks/:id', { params: { id: parent }, query: { project } });
		expect(root.body['canDetach']).toBe(false);
		const indexPath = `${project}/.task/task-index.json`;
		const index = JSON.parse(fs.readFileSync(indexPath, 'utf8')) as { tasks: Array<{ id: string }> };
		index.tasks = index.tasks.filter(x => x.id !== parent);
		fs.writeFileSync(indexPath, JSON.stringify(index));
		const answer = await h.call('GET /tasks/:id', { params: { id: child }, query: { project } });
		expect(answer.body['parent']).toBeNull();
		expect(answer.body['canDetach']).toBe(true);
	});

	it('every page body names the project in a projectText line (a header with actions drops its subtitle)', async () => {
		const id = await createTask('t');
		for (const [route, params] of [
			['GET /tasks', {}],
			['GET /tree', {}],
			['GET /tasks/:id', { id }],
		] as const) {
			const answer = await h.call(route, { params, query: { project } });
			expect(answer.body['projectText'], route).toBe('Project: alpha');
		}
	});

	it('the hierarchy of a task marks its own row', async () => {
		const parent = await createTask('parent');
		const child = await createTask('child', { parent });
		const answer = await h.call('GET /tree', { query: { project, id: child } });
		const labels = answer.body['rows'].map((r: { label: string }) => r.label);
		expect(labels[0]).toBe('parent');
		expect(labels[1]).toMatch(/child \(this task\)$/);
	});
});

describe('delete answers drive the page state', () => {
	it('a preview carries previewText, an executed delete deletedText and canConfirm false (the stale preview goes away)', async () => {
		const id = await createTask('a');
		const preview = await h.call('POST /tasks/delete/plan', { query: { project }, body: { ids: id } });
		expect(preview.body['previewText']).toBe(`Project alpha: ${preview.body['summary']}`);
		const done = await h.call('POST /tasks/delete', {
			query: { project },
			body: { ids: id, confirm: true },
		});
		expect(done.status).toBe(200);
		expect(done.body['deletedText']).toBe('Deleted 1 task(s) from project alpha.');
		expect(done.body['canConfirm']).toBe(false);
		expect(done.body).not.toHaveProperty('previewText');
	});
});

describe('GET /summary display rows', () => {
	it('marks the closed statuses and gives a short skipped text for the narrow widget', async () => {
		const c = await createTask('c');
		await h.call('POST /tasks/:id/status', { params: { id: c }, query: { project }, body: { status: 'done' } });
		const broken = h.world.createProject('broken');
		fs.rmSync(`${broken}/.task`, { recursive: true });
		const answer = await h.call('GET /summary');
		expect(answer.body['rows']).toEqual([
			{ statusText: 'backlog', count: 0 },
			{ statusText: 'in-progress', count: 0 },
			{ statusText: 'done (closed)', count: 1 },
		]);
		expect(answer.body['skippedText']).toBe('1 project not counted (see the table).');
	});
});

describe('GET /projects tasks link', () => {
	it('is gone: the views have no link to the tasks page, the breadcrumb leads there', async () => {
		h.world.createProject('beta');
		const selected = await h.call('GET /projects', { query: { project } });
		expect(selected.body).not.toHaveProperty('tasksHref');
	});
});

describe('nothing registered yet (the views must say what to do)', () => {
	beforeEach(() => {
		fs.rmSync(projectsRegistryPath(h.world.configDir));
	});

	it('GET /projects flags noProjects with the two ways to register a project', async () => {
		const answer = await h.call('GET /projects');
		expect(answer.status).toBe(200);
		expect(answer.body['noProjects']).toBe(true);
		expect(answer.body['noProjectsText']).toContain('No project is registered');
		expect(answer.body['noProjectsText']).toContain('task init');
		expect(answer.body['noProjectsText']).toContain('task projects add');
	});

	it('GET /projects has no noProjects flag nor text once a project is registered', async () => {
		h.world.createProject('beta');
		const answer = await h.call('GET /projects');
		expect(answer.body['noProjects']).toBe(false);
		expect(answer.body['noProjectsText']).toBeNull();
	});

	it('the routes that need a project name both commands in their hint', async () => {
		const answer = await h.call('GET /tasks');
		expect(answer.status).toBe(404);
		expect(answer.body['hint']).toContain('task init');
		expect(answer.body['hint']).toContain('task projects add');
	});
});

describe('registered project whose directory vanished', () => {
	it('GET /projects names the missing directory and the way to unregister it, not `task init`', async () => {
		fs.rmSync(project, { recursive: true });
		const answer = await h.call('GET /projects', { query: { project } });
		expect(answer.body['projectQuery']).toBe('blank=true');
		expect(answer.body['selectedProblem']).toContain('no longer exists');
		expect(answer.body['selectedProblem']).toContain('task projects remove');
		expect(answer.body['selectedProblem']).not.toContain('recreate');
	});
});

describe('registered projects that cannot be used', () => {
	it('selectedProblem is two sentences (the cause ends with a period before the fix)', async () => {
		fs.rmSync(`${project}/.task`, { recursive: true });
		const answer = await h.call('GET /projects', { query: { project } });
		expect(answer.body['selectedProblem']).toMatch(/\.\s+Run `task init`/);
	});

	it('GET /projects offers no form for the selected project when it cannot be read (its submit could only fail)', async () => {
		fs.rmSync(`${project}/.task`, { recursive: true });
		const answer = await h.call('GET /projects', { query: { project } });
		expect(answer.body['forms']).toBeNull();
	});

	it('the all-projects summary failure hint covers a vanished directory too', async () => {
		fs.rmSync(project, { recursive: true });
		const answer = await h.call('GET /summary');
		expect(answer.status).toBe(500);
		expect(answer.body['hint']).toContain('task projects remove');
		expect(answer.body['hint']).toContain('task init');
	});
});

describe('GET /tree?allProjects=true (the global forest, grouped by project)', () => {
	let beta: string;
	const enc = encodeURIComponent;

	async function createIn(dir: string, description: string, extra: Record<string, unknown> = {}): Promise<string> {
		const answer = await h.call('POST /tasks', { query: { project: dir }, body: { description, ...extra } });
		expect(answer.status).toBe(201);
		return answer.body['task'].id as string;
	}

	const global = (extra: Record<string, string> = {}): Promise<Answer> =>
		h.call('GET /tree', { query: { allProjects: 'true', ...extra } });

	beforeEach(() => {
		beta = h.world.createProject('beta', { configYml: STATUSES_YML });
	});

	// The DataTable of the installed shell has no row styling or grouping: the global forest is a list of sections, one
	// per project, built by the route as DSL nodes (the view renders them with an ExtensionSlot).
	it('has one section per project: its name and count as the title, a link to its own tree, then its forest as a table', async () => {
		const parent = await createIn(project, 'parent');
		const child = await createIn(project, 'child', { parent });
		const other = await createIn(beta, 'in beta');
		const answer = await global();
		expect(answer.status).toBe(200);
		expect(answer.body['scope']).toBe('all');
		expect(answer.body).not.toHaveProperty('rows');
		const groups = answer.body['groups'] as Array<Record<string, any>>;
		expect(groups.map(g => [g['$type'], g['title']])).toEqual([
			['Section', 'alpha (2 tasks)'],
			['Section', 'beta (1 task)'],
		]);
		const [link, table] = groups[0]!['items'] as Array<Record<string, any>>;
		expect(link).toMatchObject({
			$type: 'ButtonLink',
			label: 'Open the tree of alpha',
			to: `/modules/task/tree/p/${projectSlug(project)}`,
		});
		expect(table).toMatchObject({ $type: 'DataTable', navigateTo: '{href}' });
		const rows = table['rows'] as Array<Record<string, any>>;
		expect(rows.map(r => [r['id'], r['depth']])).toEqual([
			[parent, 0],
			[child, 1],
		]);
		expect(rows[0]).toMatchObject({
			label: 'parent',
			href: `/modules/task/tasks/p/${projectSlug(project)}/${parent}`,
		});
		expect(rows[1]!['label']).toMatch(/child$/);
		expect(rows[1]!['label']).not.toBe('child');
		const betaTable = (groups[1]!['items'] as Array<Record<string, any>>)[1]!;
		expect(betaTable['rows'].map((r: { id: string }) => r.id)).toEqual([other]);
		expect(answer.body['scopeText']).toBe('All projects: 2 projects, 3 open tasks.');
	});

	it('shows an empty project as a section with an explicit "no open tasks" table (not as a missing project)', async () => {
		await createIn(project, 'x');
		const groups = (await global()).body['groups'] as Array<Record<string, any>>;
		expect(groups.map(g => g['title'])).toEqual(['alpha (1 task)', 'beta (0 tasks)']);
		const betaTable = (groups[1]!['items'] as Array<Record<string, any>>)[1]!;
		expect(betaTable['rows']).toEqual([]);
		expect(betaTable['emptyMessage']).toBe('No open tasks');
	});

	it('hides closed tasks unless showAll, and the toggle keeps the global scope', async () => {
		const done = await createIn(project, 'closed one');
		await h.call('POST /tasks/:id/status', { params: { id: done }, query: { project }, body: { status: 'done' } });
		const idsOf = (answer: Answer): string[] =>
			(answer.body['groups'] as Array<Record<string, any>>).flatMap(g =>
				(g['items'][1]['rows'] as Array<{ id: string }>).map(r => r.id)
			);
		const open = await global();
		expect(idsOf(open)).toEqual([]);
		expect(open.body['showAllToggle']).toEqual({
			label: 'Show closed tasks',
			href: '/modules/task/tree?showAll=true',
		});
		const all = await global({ showAll: 'true' });
		expect(idsOf(all)).toEqual([done]);
		expect((all.body['groups'] as Array<Record<string, any>>)[1]!['items'][1]['emptyMessage']).toBe('No tasks');
		expect(all.body['scopeText']).toBe('All projects: 2 projects, 1 task (closed ones included).');
		expect(all.body['showAllToggle']).toEqual({ label: 'Hide closed tasks', href: '/modules/task/tree' });
	});

	// The table is the only place of the hierarchy in a section: the label carries the indentation, depth by depth.
	it('indents every nested level in the table of its project, keeps a closed parent of an open task, and counts honestly', async () => {
		const epic = await createIn(project, 'epic');
		const feature = await createIn(project, 'feature', { parent: epic });
		const sub = await createIn(project, 'sub', { parent: feature });
		await createIn(project, 'deep', { parent: sub });
		const closedParent = await createIn(project, 'closed parent', { parent: epic });
		await createIn(project, 'open under closed', { parent: closedParent });
		const close = (id: string): Promise<Answer> =>
			h.call('POST /tasks/:id/status', { params: { id }, query: { project }, body: { status: 'done' } });
		await close(closedParent);
		const closedRoot = await createIn(project, 'closed root');
		const closedLeaf = await createIn(project, 'closed leaf', { parent: closedRoot });
		await close(closedLeaf);
		await close(closedRoot);
		const betaRoot = await createIn(beta, 'beta root');
		const betaLeaf = await createIn(beta, 'beta child', { parent: betaRoot });
		const em = String.fromCodePoint(0x2003);
		const branch = String.fromCodePoint(0x2514);
		const groups = (await global()).body['groups'] as Array<Record<string, any>>;
		const alphaRows = groups[0]!['items'][1]['rows'] as Array<{ label: string; depth: number; id: string }>;
		expect(alphaRows.map(r => [r.label, r.depth])).toEqual([
			['epic', 0],
			[`${branch} feature`, 1],
			[`${em}${branch} sub`, 2],
			[`${em}${em}${branch} deep`, 3],
			[`${branch} closed parent`, 1],
			[`${em}${branch} open under closed`, 2],
		]);
		const betaRows = groups[1]!['items'][1]['rows'] as Array<{ label: string; id: string }>;
		expect(betaRows.map(r => [r.label, r.id === betaLeaf])).toEqual([
			['beta root', false],
			[`${branch} beta child`, true],
		]);
		expect(groups.map(g => g['title'])).toEqual(['alpha (6 tasks)', 'beta (2 tasks)']);
		// 7 open tasks (alpha 5, beta 2): the closed parent kept above an open task is said, not counted as open.
		expect((await global()).body['scopeText']).toBe(
			'All projects: 2 projects, 7 open tasks, plus 1 closed parent kept for context.'
		);
	});

	// Strings of a node prop starting with "$" are read by the renderer as an expression on the page context.
	it('shows a project whose name starts with "$" as text, not as an expression of the page', async () => {
		const dollar = h.world.createProject('$ctx.secret');
		await createIn(dollar, 'x');
		const groups = (await global()).body['groups'] as Array<Record<string, any>>;
		const title = groups.map(g => g['title'] as string).find(text => text.includes('$ctx.secret'))!;
		expect(title.startsWith('$')).toBe(false);
		expect(title.replace(String.fromCodePoint(0x200b), '')).toBe('$ctx.secret (1 task)');
		const link = groups
			.flatMap(g => g['items'] as Array<Record<string, any>>)
			.find(n => n['label']?.includes('$ctx.secret'))!;
		expect(link['label'].startsWith('$')).toBe(false);
	});

	it('reports an unreadable project in a warning besides the forests of the others, never dropped silently', async () => {
		await createIn(project, 'in alpha');
		const broken = h.world.createProject('broken');
		fs.rmSync(`${broken}/.task`, { recursive: true });
		const answer = await global();
		expect(answer.status).toBe(200);
		expect(answer.body['skippedCount']).toBe(1);
		expect(answer.body['warning']).toContain('1 project not listed');
		expect(answer.body['warning']).toContain(broken);
		expect(JSON.stringify(answer.body['groups'])).not.toContain('broken');
		expect(answer.body['scopeText']).toBe('All projects: 2 projects, 1 open task.');
	});

	it('has no warning when every project could be read', async () => {
		const answer = await global();
		expect(answer.body['skippedCount']).toBe(0);
		expect(answer.body['warning']).toBeNull();
	});

	it('answers 500 with reasons when every registered project is unreadable, inline for the views', async () => {
		fs.rmSync(`${project}/.task`, { recursive: true });
		fs.rmSync(`${beta}/.task`, { recursive: true });
		const answer = await global();
		expect(answer.status).toBe(500);
		expect(answer.body['error']).toContain('none of the 2 registered projects');
		const inline = await global({ inlineErrors: 'true' });
		expect(inline.status).toBe(200);
		expect(inline.body['errorText']).toContain('none of the 2 registered projects');
	});

	it('is a 400 together with ?project or ?id, and for a value that is not true or false', async () => {
		const withProject = await h.call('GET /tree', { query: { allProjects: 'true', project } });
		expect(withProject.status).toBe(400);
		expect(withProject.body['error']).toContain('allProjects');
		expect((await global({ id: 'abc' })).status).toBe(400);
		expect((await h.call('GET /tree', { query: { allProjects: 'yes' } })).status).toBe(400);
	});

	it('without the flag, several registered projects and no ?project stay a 400 (API contract unchanged)', async () => {
		expect((await h.call('GET /tree')).status).toBe(400);
	});
});

describe('GET /types?allProjects=true (every project types, read-only list)', () => {
	let beta: string;
	const enc = encodeURIComponent;

	beforeEach(() => {
		beta = h.world.createProject('beta', { configYml: STATUSES_YML });
	});

	const global = (extra: Record<string, string> = {}): Promise<Answer> =>
		h.call('GET /types', { query: { allProjects: 'true', ...extra } });

	it('lists a row per project type with its project column and link, and a row saying so for a project without type', async () => {
		await h.call('POST /types', { query: { project }, body: { name: 'bug' } });
		await h.call('POST /types', { query: { project }, body: { name: 'feature' } });
		const answer = await global();
		expect(answer.status).toBe(200);
		expect(answer.body['scope']).toBe('all');
		expect(answer.body['rows']).toEqual([
			{
				projectName: 'alpha',
				projectPath: project,
				typeText: 'bug',
				projectParam: enc(project),
				name: 'bug',
				canRemove: true,
				confirmText: 'Remove the type "bug" from the project alpha?',
				confirmLabel: 'Remove "bug" from alpha',
			},
			{
				projectName: 'alpha',
				projectPath: project,
				typeText: 'feature',
				projectParam: enc(project),
				name: 'feature',
				canRemove: true,
				confirmText: 'Remove the type "feature" from the project alpha?',
				confirmLabel: 'Remove "feature" from alpha',
			},
			{
				projectName: 'beta',
				projectPath: beta,
				typeText: '(none configured: any text is accepted)',
				projectParam: enc(beta),
				name: '',
				canRemove: false,
				confirmText: '',
				confirmLabel: '',
			},
		]);
		expect(answer.body['scopeText']).toBe(
			'All projects: 2 projects, 2 types configured. Remove on a row deletes that type from its project.'
		);
	});

	// A global row carries what the remove action needs (the shell fills {name} and {projectParam} of the action URL
	// from the row the form was given): the row alone must be enough to remove the type, no cascading select.
	it('a row is enough to remove its type: its encoded name and project fill the DELETE route as the shell does', async () => {
		await h.call('POST /types', { query: { project }, body: { name: 'tech debt' } });
		await h.call('POST /types', { query: { project: beta }, body: { name: 'tech debt' } });
		const rows = (await global()).body['rows'] as Record<string, any>[];
		const row = rows.find(r => r['projectName'] === 'beta')!;
		expect(row['name']).toBe('tech%20debt');
		const removed = await h.call('DELETE /types/:name', {
			params: { name: decodeURIComponent(row['name']) },
			query: { project: decodeURIComponent(row['projectParam']), inlineErrors: 'true' },
		});
		expect(removed.status).toBe(200);
		const left = (await global()).body['rows'] as Record<string, any>[];
		expect(left.map(r => `${r['projectName']}:${r['typeText']}`)).toEqual([
			'alpha:tech debt',
			'beta:(none configured: any text is accepted)',
		]);
	});

	it('offers adding to a chosen project only: no default project, unreadable ones are not selectable', async () => {
		const broken = h.world.createProject('broken');
		fs.rmSync(`${broken}/.task`, { recursive: true });
		const answer = await global();
		expect(answer.body['projectOptions']).toEqual([
			{ value: enc(project), label: 'alpha' },
			{ value: enc(beta), label: 'beta' },
		]);
		expect(answer.body['forms']).toEqual({ add: { projectParam: '', name: '' } });
		expect(answer.body['warning']).toContain('1 project not listed');
		expect(answer.body['warning']).toContain(broken);
		// No remove form in the global scope: the type options depend on the project.
		expect(answer.body).not.toHaveProperty('restricted');
	});

	it('answers 500 with reasons when no project is readable, inline for the views', async () => {
		fs.rmSync(`${project}/.task`, { recursive: true });
		fs.rmSync(`${beta}/.task`, { recursive: true });
		expect((await global()).status).toBe(500);
		const inline = await global({ inlineErrors: 'true' });
		expect(inline.body['errorText']).toContain('none of the 2 registered projects');
	});

	it('is a 400 together with ?project', async () => {
		expect((await h.call('GET /types', { query: { allProjects: 'true', project } })).status).toBe(400);
	});

	it('the per-project answer names the project for the page (headerActions drop the subtitle)', async () => {
		const answer = await h.call('GET /types', { query: { project } });
		expect(answer.body['projectText']).toBe('Project: alpha');
	});

	it('adding a type with an empty project (the unselected form select) is a 400 asking to choose', async () => {
		const answer = await h.call('POST /types', { query: { project: '' }, body: { name: 'bug' } });
		expect(answer.status).toBe(400);
		expect(answer.body['error']).toContain('no project chosen');
		expect(answer.body['hint']).toContain('Choose a project');
	});
});

describe('scope data of GET /projects (one source per page for the global and the project views)', () => {
	let beta: string;
	const enc = encodeURIComponent;

	beforeEach(() => {
		beta = h.world.createProject('beta', { configYml: STATUSES_YML });
	});

	it('scopeQuery: the project, else the global scope (showAll kept) while several are registered', async () => {
		const chosen = await h.call('GET /projects', { query: { project } });
		expect(chosen.body['scopeQuery']).toBe(`project=${enc(project)}`);
		const global = await h.call('GET /projects', { query: { showAll: 'true' } });
		expect(global.body['scopeQuery']).toBe('allProjects=true&showAll=true');
	});

	it('scopeQuery asks for a blank answer when the project is unknown or unreadable, to replace the data of the previous scope', async () => {
		const unknown = await h.call('GET /projects', { query: { project: '/nowhere/ghost' } });
		expect(unknown.body['scopeQuery']).toBe('blank=true');
		expect(unknown.body['projectQuery']).toBe('blank=true');
		fs.rmSync(`${beta}/.task`, { recursive: true });
		const unreadable = await h.call('GET /projects', { query: { project: beta } });
		expect(unreadable.body['scopeQuery']).toBe('blank=true');
		expect(unreadable.body['projectQuery']).toBe('blank=true');
		// The field that made a view skip its source (and keep the previous answer) is gone: nothing may use it again.
		expect(unreadable.body).not.toHaveProperty('selectedQuery');
	});

	it('projectQuery (pages that always need one project): the project, else blank, never global', async () => {
		const chosen = await h.call('GET /projects', { query: { project } });
		expect(chosen.body['projectQuery']).toBe(`project=${enc(project)}`);
		const none = await h.call('GET /projects');
		expect(none.body['projectQuery']).toBe('blank=true');
	});

	it('with nothing registered there is no scope to ask for; a single project is its own scope', async () => {
		fs.rmSync(projectsRegistryPath(h.world.configDir));
		const none = await h.call('GET /projects');
		expect(none.body['scopeQuery']).toBe('blank=true');
		const solo = h.world.createProject('solo');
		const single = await h.call('GET /projects');
		expect(single.body['scopeQuery']).toBe(`project=${enc(solo)}`);
	});

	it('projectOptions leave out the projects that cannot be read (picking one could only fail)', async () => {
		const broken = h.world.createProject('broken');
		fs.rmSync(`${broken}/.task`, { recursive: true });
		const answer = await h.call('GET /projects');
		expect(answer.body['projectOptions']).toEqual([
			{ value: enc(project), label: 'alpha' },
			{ value: enc(beta), label: 'beta' },
		]);
	});

	it('the create form defaults to the only readable project among several, else asks for a choice', async () => {
		const several = await h.call('GET /projects');
		expect(several.body['forms']['create']['projectParam']).toBe('');
		fs.rmSync(`${beta}/.task`, { recursive: true });
		const one = await h.call('GET /projects');
		expect(one.body['forms']['create']['projectParam']).toBe(enc(project));
	});

	it('the delete form never has a default project (destructive: always an explicit choice)', async () => {
		fs.rmSync(`${beta}/.task`, { recursive: true });
		const answer = await h.call('GET /projects');
		expect(answer.body['forms']['delete']['projectParam']).toBe('');
	});

	it('selectedText names the selected project for the pages, null while none is selected', async () => {
		const chosen = await h.call('GET /projects', { query: { project } });
		expect(chosen.body['selectedText']).toBe('Project: alpha');
		const none = await h.call('GET /projects');
		expect(none.body['selectedText']).toBeNull();
	});
});

describe('last used project (the New task page preselects it while several projects are registered)', () => {
	let beta: string;
	const enc = encodeURIComponent;
	const dataDir = (): string => path.join(h.world.root, 'module-data');

	beforeEach(() => {
		beta = h.world.createProject('beta', { configYml: STATUSES_YML });
	});

	const createIn = (dir: string): Promise<Answer> =>
		h.call('POST /tasks', { query: { project: dir }, body: { description: 'a task' } });

	it('is not preselected before any task was created: the choice stays explicit', async () => {
		const answer = await h.call('GET /projects');
		expect(answer.body['forms']['create']['projectParam']).toBe('');
		expect(answer.body['lastProjectProblem']).toBeNull();
	});

	it('is the project of the last created task, in the form of the New task page only', async () => {
		await createIn(beta);
		const answer = await h.call('GET /projects');
		expect(answer.body['forms']['create']['projectParam']).toBe(enc(beta));
		// The choice stays free: the select still offers every readable project.
		expect(answer.body['needsSelection']).toBe(true);
		// A deletion never gets a default project.
		expect(answer.body['forms']['delete']).toEqual({
			ids: '',
			filter: '',
			all: false,
			cascade: false,
			projectParam: '',
		});
	});

	it('follows the latest creation, and a failed creation does not change it', async () => {
		await createIn(project);
		await createIn(beta);
		expect((await h.call('POST /tasks', { query: { project }, body: { description: '  ' } })).status).toBe(400);
		const answer = await h.call('GET /projects');
		expect(answer.body['forms']['create']['projectParam']).toBe(enc(beta));
	});

	it('an explicit project (URL) wins over the last used one', async () => {
		await createIn(beta);
		const answer = await h.call('GET /projects', { query: { project } });
		expect(answer.body['forms']['create']['projectParam']).toBe(enc(project));
	});

	it('is dropped when that project is not readable any more, rather than preselecting one that can only fail', async () => {
		// A third readable project: with only one left it would be preselected as the only choice, which is another rule.
		h.world.createProject('gamma', { configYml: STATUSES_YML });
		await createIn(beta);
		fs.rmSync(`${beta}/.task`, { recursive: true });
		const answer = await h.call('GET /projects');
		expect(answer.body['forms']['create']['projectParam']).toBe('');
	});

	it('is dropped when that project was unregistered', async () => {
		h.world.createProject('gamma', { configYml: STATUSES_YML });
		await createIn(beta);
		unregisterProject(h.world.configDir, beta);
		const answer = await h.call('GET /projects');
		expect(answer.body['forms']['create']['projectParam']).toBe('');
	});

	it('says when the remembered project cannot be read (corrupt file), and still lets the choice be made', async () => {
		fs.mkdirSync(dataDir(), { recursive: true });
		fs.writeFileSync(path.join(dataDir(), 'last-project.json'), '{not json');
		const answer = await h.call('GET /projects');
		expect(answer.status).toBe(200);
		expect(answer.body['forms']['create']['projectParam']).toBe('');
		expect(answer.body['lastProjectProblem']).toContain('last-project.json');
		expect(answer.body['lastProjectProblem']).toContain('Delete it');
		// The next creation replaces the broken file: the problem goes away.
		await createIn(beta);
		const fixed = await h.call('GET /projects');
		expect(fixed.body['lastProjectProblem']).toBeNull();
		expect(fixed.body['forms']['create']['projectParam']).toBe(enc(beta));
	});

	it('does not fail the creation when it cannot be remembered, and says so', async () => {
		// A file where the folder should be: the module data dir cannot be created.
		fs.writeFileSync(path.join(h.world.root, 'module-data'), 'not a directory');
		const answer = await createIn(beta);
		expect(answer.status).toBe(201);
		expect(answer.body['lastProjectWarning']).toContain('could not be remembered');
		expect(answer.body['lastProjectWarning']).toContain('module-data');
	});

	it('is reported as no warning when it was remembered', async () => {
		const answer = await createIn(beta);
		expect(answer.body['lastProjectWarning']).toBeNull();
	});
});

describe('blank=true (a view asks it to replace the data of its previous scope)', () => {
	it.each(['GET /tasks', 'GET /tree', 'GET /types'])(
		'%s answers an empty body without opening any project',
		async route => {
			h.world.createProject('beta');
			const answer = await h.call(route, { query: { blank: 'true', inlineErrors: 'true' } });
			expect(answer).toEqual({ status: 200, body: { blank: true } });
		}
	);

	it('is rejected for another value', async () => {
		expect((await h.call('GET /tasks', { query: { blank: 'yes' } })).status).toBe(400);
	});

	// The detail and history pages read the task of ONE project: when that project is unknown or unreadable they ask
	// for the blank answer too, else the shell keeps the previous task on screen (a skipped source keeps its data).
	it.each(['GET /tasks/:id', 'GET /tasks/:id/history', 'GET /tasks/:id/links'])(
		'%s answers an empty body, not a 404 for a task that does not exist, and opens no project',
		async route => {
			const answer = await h.call(route, {
				params: { id: 'nosuchtask' },
				query: { blank: 'true', inlineErrors: 'true' },
			});
			expect(answer).toEqual({ status: 200, body: { blank: true } });
		}
	);

	it.each(['GET /tasks/:id', 'GET /tasks/:id/history', 'GET /tasks/:id/links'])(
		'%s still fails loudly for an unknown task when blank is not asked',
		async route => {
			const answer = await h.call(route, { params: { id: 'nosuchtask' }, query: { project } });
			expect(answer.status).toBe(404);
		}
	);

	it('the task page tree source (GET /tree?id=...) is blank too', async () => {
		const answer = await h.call('GET /tree', { query: { blank: 'true', id: 'nosuchtask' } });
		expect(answer).toEqual({ status: 200, body: { blank: true } });
	});
});

describe('delete stays explicit per project', () => {
	let beta: string;

	beforeEach(() => {
		beta = h.world.createProject('beta', { configYml: STATUSES_YML });
	});

	it('the preview and the confirm request name the project, with the path', async () => {
		await createTask('a');
		const preview = await h.call('POST /tasks/delete/plan', { query: { project }, body: { all: true } });
		expect(preview.body['previewText']).toBe('Project alpha: Would delete 1 task(s).');
		expect(preview.body['projectText']).toBe(
			`Project alpha (${project}): only its tasks listed above will be deleted.`
		);
		expect(preview.body['confirmLabel']).toBe('Delete these tasks from alpha');
		expect(preview.body['project']).toEqual({ name: 'alpha', path: project });
	});

	it('the executed delete names the project too', async () => {
		const id = await createTask('a');
		const done = await h.call('POST /tasks/delete', { query: { project }, body: { ids: id, confirm: true } });
		expect(done.body['deletedText']).toBe('Deleted 1 task(s) from project alpha.');
	});

	it('refuses to run without a project, and ignores allProjects: nothing is ever deleted globally', async () => {
		await createTask('a');
		await h.call('POST /tasks', { query: { project: beta }, body: { description: 'b' } });
		for (const route of ['POST /tasks/delete/plan', 'POST /tasks/delete']) {
			const answer = await h.call(route, { query: { allProjects: 'true' }, body: { all: true, confirm: true } });
			expect(answer.status, route).toBe(400);
			expect(answer.body['error'], route).toContain('project');
		}
		const left = await h.call('GET /tasks', { query: { allProjects: 'true' } });
		expect(left.body['tasks']).toHaveLength(2);
	});

	it('an empty project (the unselected form select) is a 400 asking to choose, nothing deleted', async () => {
		await createTask('a');
		const answer = await h.call('POST /tasks/delete', {
			query: { project: '' },
			body: { all: true, confirm: true },
		});
		expect(answer.status).toBe(400);
		expect(answer.body['error']).toContain('no project chosen');
		const left = await h.call('GET /tasks', { query: { project } });
		expect(left.body['tasks']).toHaveLength(1);
	});
});
