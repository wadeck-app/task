import { FakeGitHub } from '@wadeck-app/task-service/fakeGitHub';

import { setup } from './routeHarness.js';
import type { Harness } from './routeHarness.js';

// A project on the github strategy through the module routes: the same use cases as the CLI, the errors of the remote system
// mapped to HTTP statuses with their hints, the reads of every request released with it.
const TOKEN_VARIABLE = 'TASK_MODULE_TEST_GITHUB_TOKEN';

let h: Harness;
let fake: FakeGitHub;
let project: string;

function configFor(baseUrl: string): string {
	return `statuses:
    - backlog
    - in-progress
    - { name: done, terminal: true }
strategy:
    type: github
    options:
        repo: acme/shop
        baseUrl: ${baseUrl}
        tokenEnv: ${TOKEN_VARIABLE}
        cache: { ttlSeconds: 0 }
        timeoutSeconds: 3
        statusMap:
            backlog: { state: open }
            in-progress: { state: open, label: 'status:in-progress' }
            done: { state: closed }
`;
}

beforeEach(async () => {
	fake = await FakeGitHub.start({ repo: 'acme/shop' });
	vi.stubEnv(TOKEN_VARIABLE, fake.token);
	h = setup();
	project = await h.world.createProject('shop', { configYml: configFor(fake.baseUrl) });
	fake.addIssue({ title: 'Alpha', labels: ['status:in-progress', 'billing'] });
	fake.addIssue({ title: 'Beta' });
	fake.addIssue({ title: 'Gamma', state: 'closed' });
	fake.setParent(2, 1);
});

afterEach(async () => {
	vi.unstubAllEnvs();
	h.world.cleanup();
	await fake.stop();
});

describe('reads', () => {
	it('GET /tasks lists the open issues with their number as id', async () => {
		const answer = await h.call('GET /tasks', { query: { project } });

		expect(answer.status).toBe(200);
		expect(answer.body['tasks'].map((t: { id: string; status: string }) => [t.id, t.status])).toEqual([
			['1', 'in-progress'],
			['2', 'backlog'],
		]);
		expect(answer.body['readNotices']).toBeUndefined();
	});

	it('GET /tasks/:id gives the record with its parent and children', async () => {
		const answer = await h.call('GET /tasks/:id', { params: { id: '2' }, query: { project } });

		expect(answer.status).toBe(200);
		expect(answer.body['task']).toMatchObject({ id: '2', title: 'Beta', parentId: '1' });
		expect(answer.body['parent']).toMatchObject({ id: '1' });
		const parent = await h.call('GET /tasks/:id', { params: { id: '1' }, query: { project } });
		expect(parent.body['children'].map((c: { id: string }) => c.id)).toEqual(['2']);
	});

	it('GET /tree shows the sub-issue tree', async () => {
		const answer = await h.call('GET /tree', { query: { project } });

		expect(answer.status).toBe(200);
		expect(JSON.stringify(answer.body)).toContain('Beta');
	});

	it('GET /projects lists the project with its open count, read from GitHub', async () => {
		const answer = await h.call('GET /projects');

		expect(answer.status).toBe(200);
		expect(answer.body['projectRows'][0]).toMatchObject({ name: 'shop' });
		expect(answer.body['projectRows'][0]['openText']).toContain('2');
	});

	it('a task that does not exist is 404', async () => {
		const answer = await h.call('GET /tasks/:id', { params: { id: '99' }, query: { project } });

		expect(answer.status).toBe(404);
	});
});

describe('writes are refused with the hint, and nothing is sent', () => {
	it.each([
		['POST /tasks/:id/status', { id: '1' }, { status: 'done' }],
		['POST /tasks/:id/labels', { id: '1' }, { label: 'x' }],
		['POST /tasks/:id/meta', { id: '1' }, { key: 'k', value: 'v' }],
	])('%s is 422 with the capability and where to make the change', async (route, params, body) => {
		const answer = await h.call(route, { params, query: { project }, body });

		expect(answer.status).toBe(422);
		expect(answer.body['capability']).toBe('writes');
		expect(answer.body['hint']).toContain('read-only in this version (stage 1');
		expect(fake.writes()).toEqual([]);
	});

	it('POST /tasks (a new task) is 422 too', async () => {
		const answer = await h.call('POST /tasks', { query: { project }, body: { description: 'New' } });

		expect(answer.status).toBe(422);
		expect(answer.body['capability']).toBe('writes');
	});

	it('with ?inlineErrors=true the view gets it as data', async () => {
		const answer = await h.call('POST /tasks/:id/status', {
			params: { id: '1' },
			query: { project, inlineErrors: 'true' },
			body: { status: 'done' },
		});

		expect(answer.status).toBe(200);
		expect(answer.body['failed']).toBe(true);
		expect(answer.body['httpStatus']).toBe(422);
		expect(answer.body['errorText']).toContain('read-only in this version (stage 1');
	});
});

describe('the remote system fails', () => {
	it('a missing token is 503 with the variable and the fix', async () => {
		vi.stubEnv(TOKEN_VARIABLE, '');

		const answer = await h.call('GET /tasks', { query: { project } });

		expect(answer.status).toBe(503);
		expect(answer.body['error']).toContain(`the environment variable ${TOKEN_VARIABLE} is not set`);
		expect(answer.body['hint']).toContain(`export ${TOKEN_VARIABLE}=<token>`);
	});

	it('an exhausted quota is 429 with the retry instant', async () => {
		fake.setRateLimit('core', { remaining: 0, resetAt: Math.floor(Date.now() / 1000) + 600 });

		const answer = await h.call('GET /tasks', { query: { project } });

		expect(answer.status).toBe(429);
		expect(answer.body['retryAt']).toMatch(/^20\d\d-/);
		expect(answer.body['hint']).toContain('Retry after');
	});

	it('an unreachable GitHub with a cached answer serves it and says so in readNotices', async () => {
		await h.call('GET /tasks', { query: { project } });
		fake.dropNext(10);

		const answer = await h.call('GET /tasks', { query: { project } });

		expect(answer.status).toBe(200);
		expect(answer.body['tasks']).toHaveLength(2);
		expect(answer.body['readNotices']).toHaveLength(1);
		expect(answer.body['readNotices'][0]).toContain('Cannot reach');
	});

	it('without a cache it is 503 with the network fix', async () => {
		fake.dropNext(10);

		const answer = await h.call('GET /tasks', { query: { project } });

		expect(answer.status).toBe(503);
		expect(answer.body['hint']).toContain('baseUrl');
	});

	it('GET /summary names the project that cannot be read and still counts the others', async () => {
		const local = await h.world.createProject('local', {
			configYml: 'statuses:\n  - backlog\n  - { name: done, terminal: true }\n',
		});
		await h.call('POST /tasks', { query: { project: local }, body: { description: 'local task' } });
		vi.stubEnv(TOKEN_VARIABLE, '');

		const answer = await h.call('GET /summary');

		expect(answer.status).toBe(200);
		const rows = answer.body['projectRows'] as Array<{ name: string; error?: string; errorText?: string }>;
		expect(rows.map(row => row.name).sort()).toEqual(['local', 'shop']);
		expect(JSON.stringify(rows.find(row => row.name === 'shop'))).toContain('No GitHub token');
		expect(answer.body['open']).toBe(1);
	});
});
