import { openResolvedProject, resolveProject, startTaskServer } from '@wadeck-app/task-service';
import type { RunningTaskServer, TaskEvent } from '@wadeck-app/task-service';

import { setup } from './routeHarness.js';
import type { Harness } from './routeHarness.js';

// A project on the remote strategy through the module routes: the same use cases, the data on the server, and the queue events raised
// by the server only -- the module delivers none for it (a local project of the same module still delivers its own).
const TOKEN = 'module-remote-token-0123456789';
const TOKEN_VARIABLE = 'TASK_MODULE_TEST_REMOTE_TOKEN';

let h: Harness;
let server: RunningTaskServer;
let serverEvents: TaskEvent[];
let remote: string;
let local: string;
let served: string;

function configFor(url: string): string {
	return `statuses:
    - backlog
    - in-progress
    - { name: done, terminal: true }
strategy:
    type: remote
    options:
        transport:
            type: plain-http
            options:
                url: ${url}
                tokenEnv: ${TOKEN_VARIABLE}
                timeoutSeconds: 3
`;
}

beforeEach(async () => {
	vi.stubEnv(TOKEN_VARIABLE, TOKEN);
	h = setup();
	served = await h.world.createProject('served', {
		configYml: 'statuses:\n    - backlog\n    - in-progress\n    - { name: done, terminal: true }\n',
	});
	serverEvents = [];
	server = await startTaskServer({
		ctx: openResolvedProject(resolveProject({ cwd: h.world.dirOf(served), projectRef: served })),
		token: TOKEN,
		failedAuthDelayMs: 0,
		eventSink: {
			deliver: event => {
				serverEvents.push(event);
				return Promise.resolve({ delivered: true });
			},
		},
	});
	remote = await h.world.createProject('client', { configYml: configFor(server.url) });
	local = await h.world.createProject('plain');
});

afterEach(async () => {
	vi.unstubAllEnvs();
	await server.close();
	h.world.cleanup();
});

describe('a remote project through the routes', () => {
	it('creates, lists and changes tasks on the server', async () => {
		const created = await h.call('POST /tasks', {
			query: { project: remote },
			body: { description: 'Remote task' },
		});
		const id = created.body['task'].id as string;
		const moved = await h.call('POST /tasks/:id/status', {
			params: { id },
			query: { project: remote },
			body: { status: 'in-progress' },
		});
		const listed = await h.call('GET /tasks', { query: { project: remote } });

		expect(created.status).toBe(201);
		expect(moved.status).toBe(200);
		expect(listed.body['tasks'].map((t: { id: string; status: string }) => [t.id, t.status])).toEqual([
			[id, 'in-progress'],
		]);
		expect((await h.call('GET /tasks', { query: { project: served } })).body['tasks']).toHaveLength(1);
	});

	it('delivers no event from the module for it, and the server raised them: nothing is delivered twice', async () => {
		const created = await h.call('POST /tasks', {
			query: { project: remote },
			body: { description: 'Remote task' },
		});
		const id = created.body['task'].id as string;
		await h.call('POST /tasks/:id/status', {
			params: { id },
			query: { project: remote },
			body: { status: 'done' },
		});

		expect(h.sink.events).toEqual([]);
		expect(serverEvents.map(event => event.name)).toEqual(['onTaskCreated', 'onStatusChange']);
		expect(created.body['undelivered']).toEqual([]);
		expect(created.body['undeliveredText']).toBeNull();
	});

	it('still delivers the events of a local project of the same module', async () => {
		await h.call('POST /tasks', { query: { project: local }, body: { description: 'Local task' } });
		await h.call('POST /tasks', { query: { project: remote }, body: { description: 'Remote task' } });
		await h.call('POST /tasks', { query: { project: local }, body: { description: 'Another local task' } });

		expect(h.sink.events.map(event => event.name)).toEqual(['onTaskCreated', 'onTaskCreated']);
		expect(serverEvents.map(event => event.name)).toEqual(['onTaskCreated']);
	});

	it('tells a server that is not there as an unavailable project (503) with the address and the fix', async () => {
		await server.close();

		const answer = await h.call('GET /tasks', { query: { project: remote } });

		expect(answer.status).toBe(503);
		expect(answer.body['error']).toContain('Cannot reach');
		expect(answer.body['hint']).toContain('task serve');
	});

	it('lists the project as unreadable, with its reason, and carries on with the others', async () => {
		await server.close();

		const answer = await h.call('GET /projects');

		const rows = answer.body['projectRows'] as Array<{ name: string; openText: string; problemText?: string }>;
		const client = rows.find(row => row.name === 'client')!;
		expect(client.problemText ?? '').toContain('Cannot reach');
		expect(rows.find(row => row.name === 'plain')).toBeDefined();
	});
});
