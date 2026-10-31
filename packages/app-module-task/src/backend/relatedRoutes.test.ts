import * as fs from 'node:fs';
import * as path from 'node:path';

import type { ModuleContext, ModuleRouteHandler } from '@wadeck-app/app-core-sdk';

import { registerTaskRoutes } from './routes.js';
import { createRecordingSink, createTestWorld } from './testHelpers.js';
import type { RecordingSink, TestWorld } from './testHelpers.js';

// GET /related/project/:projectId: what the task module contributes to the detail page of a project of the project module
// (an aggregator that waits 2 s per module). Read only, urls inside /modules/, errors answered as plain statuses.

interface Answer {
	status: number;
	body: Record<string, any>;
}

const STATUSES_YML = ['statuses:', '  - backlog', '  - in-progress', '  - name: done', '    terminal: true', ''].join(
	'\n'
);
const ROUTE = 'GET /related/project/:projectId';

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

afterEach(() => {
	vi.useRealTimers();
	world.cleanup();
});

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

const related = (projectId: string) => call(ROUTE, { params: { projectId } });

/** Only Date is faked: the store stamps `createdAt` / `updatedAt` with `new Date()`. */
function at(iso: string): void {
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(new Date(iso));
}

async function createTask(project: string, description: string, when = '2026-01-01T00:00:00.000Z'): Promise<string> {
	at(when);
	const answer = await call('POST /tasks', { query: { project }, body: { description } });
	expect(answer.status).toBe(201);
	return answer.body['task'].id as string;
}

async function setStatus(project: string, id: string, status: string, when: string): Promise<void> {
	at(when);
	const answer = await call('POST /tasks/:id/status', { params: { id }, query: { project }, body: { status } });
	expect(answer.status).toBe(200);
}

describe('GET /related/project/:projectId', () => {
	it('lists the open tasks of the project, most recently updated first, with urls inside /modules/', async () => {
		const project = await world.createProject('alpha', { configYml: STATUSES_YML });
		const first = await createTask(project, 'First task', '2026-01-01T00:00:00.000Z');
		const second = await createTask(project, 'Second task', '2026-01-02T00:00:00.000Z');
		const third = await createTask(project, 'Third task', '2026-01-03T00:00:00.000Z');
		// The oldest task is touched last: updated time, not creation time, orders the list.
		await setStatus(project, first, 'in-progress', '2026-01-04T00:00:00.000Z');
		sink.events.length = 0;

		const answer = await related(project);

		expect(answer.status).toBe(200);
		expect(answer.body['title']).toBe('Tasks');
		expect(answer.body['count']).toBe(3);
		// The project module shows "{count} {countLabel}" and hides a count that comes without a label.
		expect(answer.body['countLabel']).toBe('open');
		expect(answer.body['moreUrl']).toBe(`/modules/task/tasks/p/${project}`);
		expect(answer.body['items']).toEqual([
			{
				label: 'First task',
				subtitle: `${first} · in-progress`,
				url: `/modules/task/tasks/p/${project}/${first}`,
			},
			{ label: 'Third task', subtitle: `${third} · backlog`, url: `/modules/task/tasks/p/${project}/${third}` },
			{
				label: 'Second task',
				subtitle: `${second} · backlog`,
				url: `/modules/task/tasks/p/${project}/${second}`,
			},
		]);
		for (const item of answer.body['items']) {
			expect(item.url.startsWith('/modules/')).toBe(true);
		}
	});

	it('counts and lists open tasks only: a task in a terminal status is neither', async () => {
		const project = await world.createProject('alpha', { configYml: STATUSES_YML });
		await createTask(project, 'Open one');
		const closed = await createTask(project, 'Closed one');
		await setStatus(project, closed, 'done', '2026-01-05T00:00:00.000Z');

		const answer = await related(project);

		expect(answer.body['count']).toBe(1);
		expect(answer.body['items'].map((item: { label: string }) => item.label)).toEqual(['Open one']);
	});

	it('gives at most 10 items while count is the number of all open tasks', async () => {
		const project = await world.createProject('alpha', { configYml: STATUSES_YML });
		for (let index = 1; index <= 12; index++) {
			const day = String(index).padStart(2, '0');
			await createTask(project, `Task ${day}`, `2026-02-${day}T00:00:00.000Z`);
		}

		const answer = await related(project);

		expect(answer.body['count']).toBe(12);
		expect(answer.body['items']).toHaveLength(10);
		expect(answer.body['items'][0].label).toBe('Task 12');
		expect(answer.body['items'][9].label).toBe('Task 03');
	});

	it('cuts a long title with an ellipsis', async () => {
		const project = await world.createProject('alpha', { configYml: STATUSES_YML });
		await createTask(project, `${'word '.repeat(40)}end`);

		const label = (await related(project)).body['items'][0].label as string;

		expect(label.length).toBeLessThanOrEqual(60);
		expect(label.endsWith('…')).toBe(true);
	});

	it('answers an empty list with count 0 for a project without task (a fresh project is not an error)', async () => {
		const project = await world.createProject('alpha', { configYml: STATUSES_YML });

		const answer = await related(project);

		expect(answer.status).toBe(200);
		expect(answer.body).toEqual({
			title: 'Tasks',
			count: 0,
			countLabel: 'open',
			items: [],
			moreUrl: `/modules/task/tasks/p/${project}`,
		});
	});

	it('emits no queue event', async () => {
		const project = await world.createProject('alpha', { configYml: STATUSES_YML });
		await createTask(project, 'One');
		sink.events.length = 0;

		await related(project);

		expect(sink.events).toEqual([]);
	});

	it('answers 404 with the registry message and its suggestions for an unknown project id', async () => {
		await world.createProject('alpha', { configYml: STATUSES_YML });

		const answer = await related('deadbeef');

		expect(answer.status).toBe(404);
		expect(answer.body['error']).toEqual(expect.stringContaining('deadbeef'));
		expect(answer.body['hint']).toEqual(expect.stringContaining('registered project'));
	});

	it('answers 409 for a virtual project (registered without folder), naming the CLI route, never a 500', async () => {
		const virtual = await world.registerShared('virt');

		const answer = await related(virtual.id);

		expect(answer.status).toBe(409);
		expect(answer.body['error']).toEqual(expect.stringContaining('virtual project'));
		expect(answer.body['hint']).toEqual(expect.stringContaining('project paths add'));
	});

	// Same mapping as every other route: invalid YAML is an unclassified error (500, logged) that still carries the file and the cause.
	it('answers an error status with the message for a project whose config is broken, never a crash', async () => {
		const project = await world.createProject('alpha', { configYml: STATUSES_YML });
		world.breakConfig(project);

		const answer = await related(project);

		expect(answer.status).toBeGreaterThanOrEqual(400);
		expect(answer.body['error']).toEqual(expect.stringContaining('config.yml'));
	});

	it('answers the registry problem, not "no project", when the shared registry cannot be read', async () => {
		const project = await world.createProject('alpha', { configYml: STATUSES_YML });
		fs.writeFileSync(path.join(world.registryDir, 'registry.json'), '{ nope');

		const answer = await related(project);

		expect(answer.status).toBeGreaterThanOrEqual(400);
		expect(String(answer.body['error'])).not.toMatch(/no project is registered/);
	});
});
