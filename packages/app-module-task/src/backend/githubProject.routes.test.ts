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
    - { name: cancelled, terminal: true, outcome: negative }
strategy:
    type: github
    options:
        repo: acme/shop
        baseUrl: ${baseUrl}
        tokenEnv: ${TOKEN_VARIABLE}
        cache: { ttlSeconds: 0 }
        timeoutSeconds: 3
        writeSpacingSeconds: 0
        statusMap:
            backlog: { state: open }
            in-progress: { state: open, label: 'status:in-progress' }
            done: { state: closed }
            cancelled: { state: closed, reason: not_planned }
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

describe('writes reach GitHub', () => {
	it('POST /tasks creates an issue and answers 201 with the task, its page and what the queue did not get', async () => {
		const answer = await h.call('POST /tasks', { query: { project }, body: { title: 'New one' } });

		expect(answer.status).toBe(201);
		expect(answer.body['task']).toMatchObject({ id: '4', title: 'New one', status: 'backlog' });
		expect(answer.body['message']).toContain('Created task 4');
		expect(answer.body['undelivered']).toBeDefined();
		expect(fake.issues.get(4)!.title).toBe('New one');
	});

	it('POST /tasks/:id/status moves the issue; the answer carries the task and the events as undelivered (queue off)', async () => {
		const answer = await h.call('POST /tasks/:id/status', {
			params: { id: '2' },
			query: { project },
			body: { status: 'in-progress' },
		});

		expect(answer.status).toBe(200);
		expect(answer.body['task']).toMatchObject({ id: '2', status: 'in-progress' });
		expect(fake.issues.get(2)!.labels).toEqual(['status:in-progress']);
		expect(answer.body['undelivered']).toBeDefined();
	});

	it('labels, comments and the parent are written too, and a read right after shows them', async () => {
		const labelled = await h.call('POST /tasks/:id/labels', {
			params: { id: '2' },
			query: { project },
			body: { label: 'urgent' },
		});
		const commented = await h.call('POST /tasks/:id/comments', {
			params: { id: '2' },
			query: { project },
			body: { text: 'hello' },
		});
		const detached = await h.call('DELETE /tasks/:id/parent', { params: { id: '2' }, query: { project } });

		expect(labelled.status).toBe(200);
		expect(commented.status).toBe(201);
		expect(detached.status).toBe(200);
		const read = await h.call('GET /tasks/:id', { params: { id: '2' }, query: { project } });
		expect(read.body['task']).toMatchObject({ id: '2', labels: ['urgent'] });
		expect(read.body['task']['parentId']).toBeUndefined();
	});

	it('what needs a fill is 422 with the capability and the key to write, as data with ?inlineErrors=true', async () => {
		const meta = await h.call('POST /tasks/:id/meta', {
			params: { id: '1' },
			query: { project },
			body: { key: 'k', value: 'v' },
		});
		const inline = await h.call('POST /tasks/:id/meta', {
			params: { id: '1' },
			query: { project, inlineErrors: 'true' },
			body: { key: 'k', value: 'v' },
		});

		expect(meta.status).toBe(422);
		expect(meta.body['capability']).toBe('meta');
		expect(meta.body['hint']).toContain('strategy.options.fills');
		expect(inline.status).toBe(200);
		expect(inline.body['failed']).toBe(true);
		expect(inline.body['httpStatus']).toBe(422);
		expect(inline.body['errorText']).toContain('meta: labels');
		expect(fake.writes()).toEqual([]);
	});

	it('a write that GitHub refuses is 400 with the reason, one that stops halfway is 500 with what was and was not applied', async () => {
		fake.failNext({ status: 422, method: 'PATCH', body: { message: 'Validation Failed' } });
		const refused = await h.call('POST /tasks/:id/status', {
			params: { id: '1' },
			query: { project },
			body: { status: 'done' },
		});

		fake.failNext({
			status: 422,
			method: 'POST',
			pathPrefix: '/repos/acme/shop/issues/1/sub_issues',
			body: { message: 'Validation Failed' },
		});
		const partial = await h.call('POST /tasks', {
			query: { project },
			body: { title: 'Under alpha', parent: '1' },
		});

		expect(refused.status).toBe(400);
		expect(refused.body['hint']).toContain('Nothing was changed');
		expect(partial.status).toBe(500);
		expect(partial.body['hint']).toContain('task set-parent 4 1');
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
