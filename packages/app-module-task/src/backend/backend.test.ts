import * as fs from 'node:fs';

import { projectsRegistryPath } from '@wadeck-app/task-service';
import type { EventSink } from '@wadeck-app/task-service';
import type { ModuleContext, ModuleRouteHandler } from '@wadeck-app/app-core-sdk';

import backend from './index.js';
import { registerTaskRoutes, type TaskRoutesOptions } from './routes.js';
import { createRecordingSink, createTestWorld, type RecordingSink, type TestWorld } from './testHelpers.js';

const EXPECTED_ROUTES = [
	'GET /projects',
	'GET /summary',
	'GET /tasks',
	'GET /tasks/:id',
	'GET /tasks/:id/history',
	'GET /tree',
	'POST /tasks',
	'POST /tasks/:id/status',
	'POST /tasks/:id/labels',
	'DELETE /tasks/:id/labels/:label',
	'POST /tasks/:id/links',
	'DELETE /tasks/:id/links',
];

interface Answer {
	status: number;
	body: Record<string, any>;
}

interface Harness {
	world: TestWorld;
	sink: RecordingSink;
	routes: Map<string, ModuleRouteHandler>;
	call(
		route: string,
		request?: { params?: Record<string, string>; query?: Record<string, unknown>; body?: unknown }
	): Promise<Answer>;
}

function collectRoutes(): { routes: Map<string, ModuleRouteHandler>; ctx: ModuleContext } {
	const routes = new Map<string, ModuleRouteHandler>();
	const ctx: ModuleContext = {
		dataDir: '/unused/data-dir',
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

function setup(eventSink?: EventSink, extra: Partial<TaskRoutesOptions> = {}): Harness {
	const world = createTestWorld();
	const sink = createRecordingSink();
	const { routes, ctx } = collectRoutes();
	registerTaskRoutes(ctx, { configDir: world.configDir, eventSink: eventSink ?? sink, ...extra });
	return {
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
		const { routes, ctx } = collectRoutes();
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
			['GET /tree', {}, undefined],
			['GET /summary', {}, undefined],
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
		expect(answer).toEqual({
			status: 200,
			body: { projects: [{ name: 'alpha', path: project, initialized: true }] },
		});
	});

	it('is an empty list (not an error) when nothing is registered', async () => {
		fs.rmSync(projectsRegistryPath(h.world.configDir));
		expect(await h.call('GET /projects')).toEqual({ status: 200, body: { projects: [] } });
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
		expect(answer.body['tasks'][0]['href']).toBe(
			`/modules/task/tasks/${id}?project=${encodeURIComponent(project)}`
		);
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
		expect(parentAnswer.body['children'][0]['href']).toBe(
			`/modules/task/tasks/${child}?project=${encodeURIComponent(project)}`
		);
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

	it('the aggregate with no registered project is 404 with the task init fix', async () => {
		fs.rmSync(projectsRegistryPath(h.world.configDir));
		const answer = await h.call('GET /summary');
		expect(answer.status).toBe(404);
		expect(answer.body['hint']).toContain('task init');
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
			expect(undelivered[0]!['replay']).toMatch(/^queue push onTaskCreated '\{.*\}'$/);

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

	it('builds without an injected sink (the queue sink is the default and is only used on delivery)', () => {
		const world = createTestWorld();
		try {
			const { routes, ctx } = collectRoutes();
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
