import { FakeGitLab } from '@wadeck-app/task-service/fakeGitLab';

import { setup } from './routeHarness.js';
import type { Harness } from './routeHarness.js';

// A project on the gitlab strategy through the module routes: the same use cases as the CLI, the errors of the remote system
// mapped to HTTP statuses with their hints, the reads of every request released with it. NOT verified against a real GitLab (fake).
const TOKEN_VARIABLE = 'TASK_MODULE_TEST_GITLAB_TOKEN';

let h: Harness;
let fake: FakeGitLab;
let project: string;

function configFor(baseUrl: string): string {
	return `statuses:
    - backlog
    - in-progress
    - { name: done, terminal: true }
    - { name: cancelled, terminal: true, outcome: negative }
strategy:
    type: gitlab
    options:
        project: acme/shop
        tier: premium
        baseUrl: ${baseUrl}
        tokenEnv: ${TOKEN_VARIABLE}
        cache: { ttlSeconds: 0 }
        timeoutSeconds: 3
        writeSpacingSeconds: 0
        statusMap:
            backlog: { state: open }
            in-progress: { state: open, label: 'status::in-progress' }
            done: { state: closed }
            cancelled: { state: closed, label: 'status::cancelled' }
`;
}

beforeEach(async () => {
	fake = await FakeGitLab.start({ project: 'acme/shop', tier: 'premium' });
	vi.stubEnv(TOKEN_VARIABLE, fake.token);
	h = setup();
	project = await h.world.createProject('shop', { configYml: configFor(fake.baseUrl) });
	fake.seedIssue({ title: 'Alpha', labels: ['status::in-progress', 'billing'] });
	fake.seedIssue({ title: 'Beta' });
	fake.seedIssue({ title: 'Gamma', state: 'closed' });
});

afterEach(async () => {
	vi.unstubAllEnvs();
	h.world.cleanup();
	await fake.stop();
});

describe('reads', () => {
	it('GET /tasks lists the open issues with their iid as id', async () => {
		const answer = await h.call('GET /tasks', { query: { project } });

		expect(answer.status).toBe(200);
		expect(answer.body['tasks'].map((t: { id: string; status: string }) => [t.id, t.status])).toEqual([
			['1', 'in-progress'],
			['2', 'backlog'],
		]);
		expect(answer.body['readNotices']).toBeUndefined();
	});

	it('GET /tasks/:id gives the record, with no parent and no children', async () => {
		const answer = await h.call('GET /tasks/:id', { params: { id: '1' }, query: { project } });

		expect(answer.status).toBe(200);
		expect(answer.body['task']).toMatchObject({ id: '1', title: 'Alpha', labels: ['billing'] });
		expect(answer.body['task']['parentId']).toBeUndefined();
		expect(answer.body['children']).toEqual([]);
	});

	it('GET /projects lists the project with its open count, read from GitLab', async () => {
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

describe('writes reach GitLab', () => {
	it('POST /tasks creates an issue and answers 201 with the task and what the queue did not get', async () => {
		const answer = await h.call('POST /tasks', { query: { project }, body: { title: 'New one' } });

		expect(answer.status).toBe(201);
		expect(answer.body['task']).toMatchObject({ id: '4', title: 'New one', status: 'backlog' });
		expect(answer.body['undelivered']).toBeDefined();
		expect(fake.issue(4)!.title).toBe('New one');
	});

	it('POST /tasks/:id/status moves the issue; the answer carries the task and the events as undelivered (queue off)', async () => {
		const answer = await h.call('POST /tasks/:id/status', {
			params: { id: '2' },
			query: { project },
			body: { status: 'in-progress' },
		});

		expect(answer.status).toBe(200);
		expect(answer.body['task']).toMatchObject({ id: '2', status: 'in-progress' });
		expect(fake.labelsOf(2)).toEqual(['status::in-progress']);
		expect(answer.body['undelivered']).toBeDefined();
	});

	it('labels, comments and a blocking link (premium) are written too, and a read right after shows them', async () => {
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
		const linked = await h.call('POST /tasks/:id/links', {
			params: { id: '2' },
			query: { project },
			body: { type: 'blockedBy', target: '1' },
		});

		expect(labelled.status).toBe(200);
		expect(commented.status).toBe(201);
		expect(linked.status, JSON.stringify(linked.body)).toBe(200);
		const read = await h.call('GET /tasks/:id', { params: { id: '2' }, query: { project } });
		expect(read.body['task']).toMatchObject({ id: '2', labels: ['urgent'] });
		expect(fake.links(2)).toEqual([{ iid: 1, type: 'is_blocked_by' }]);
	});

	it('a parent is 422 with the capability and the reason, as data with ?inlineErrors=true, and nothing is written', async () => {
		const parent = await h.call('POST /tasks/:id/parent', {
			params: { id: '2' },
			query: { project },
			body: { parent: '1' },
		});
		const inline = await h.call('POST /tasks/:id/parent', {
			params: { id: '2' },
			query: { project, inlineErrors: 'true' },
			body: { parent: '1' },
		});
		const created = await h.call('POST /tasks', {
			query: { project },
			body: { title: 'Under alpha', parent: '1' },
		});

		expect(parent.status).toBe(422);
		expect(parent.body['capability']).toBe('hierarchy');
		expect(parent.body['hint']).toMatch(/parent/i);
		expect(inline.status).toBe(200);
		expect(inline.body['failed']).toBe(true);
		expect(inline.body['httpStatus']).toBe(422);
		expect(created.status).toBe(422);
		expect(fake.writes()).toEqual([]);
	});

	it('what needs a fill is 422 with the key to write', async () => {
		const meta = await h.call('POST /tasks/:id/meta', {
			params: { id: '1' },
			query: { project },
			body: { key: 'k', value: 'v' },
		});

		expect(meta.status).toBe(422);
		expect(meta.body['capability']).toBe('meta');
		expect(meta.body['hint']).toContain('strategy.options.fills');
	});

	it('a write that GitLab refuses is 400 with the reason', async () => {
		fake.failNext({ status: 400, method: 'PUT', body: { message: { labels: ['are invalid'] } } });

		const refused = await h.call('POST /tasks/:id/status', {
			params: { id: '1' },
			query: { project },
			body: { status: 'done' },
		});

		expect(refused.status).toBe(400);
		expect(JSON.stringify(refused.body)).toContain('are invalid');
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

	it('a wrong token is 503 and the token is not in the answer', async () => {
		vi.stubEnv(TOKEN_VARIABLE, 'a-wrong-token-value');

		const answer = await h.call('GET /tasks', { query: { project } });

		expect(answer.status).toBe(503);
		expect(JSON.stringify(answer.body)).not.toContain('a-wrong-token-value');
		expect(JSON.stringify(answer.body)).toContain('GitLab refused the token');
	});

	it('a 429 is 429 with the retry instant', async () => {
		fake.forceRateLimit({ retryAfterSeconds: 120, times: 1 });

		const answer = await h.call('GET /tasks', { query: { project } });

		expect(answer.status).toBe(429);
		expect(answer.body['retryAt']).toMatch(/^20\d\d-/);
		expect(answer.body['hint']).toContain('Retry after');
	});

	it('an unreachable GitLab is 503 with the network fix', async () => {
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
		const rows = answer.body['projectRows'] as Array<{ name: string }>;
		expect(rows.map(row => row.name).sort()).toEqual(['local', 'shop']);
		expect(JSON.stringify(rows.find(row => row.name === 'shop'))).toContain('No GitLab token');
		expect(answer.body['open']).toBe(1);
	});
});
