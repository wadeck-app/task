// The fake GitLab server driven over plain HTTP. gitlabConformance.test.ts proves the mock answers like the recorded LIVE GitLab for the
// recorded requests; these tests cover what the recording does not (limits, quotas, permissions, fault injection, the corners of
// each endpoint) and say how well each behaviour is known with the tags of the header of fakeGitLab.testkit.ts: LIVE-VERIFIED (the
// storage plan, "Live GitLab findings"), DOCUMENTED-NOT-LIVE, UNVERIFIABLE. Nothing here proves more than that.
import * as http from 'node:http';

import { FakeGitLab, LIVE_TOKEN_PERMISSIONS } from './fakeGitLab.testkit.js';
import type { FakeGitLabOptions } from './fakeGitLab.testkit.js';

let fake: FakeGitLab;

async function boot(options: FakeGitLabOptions = {}): Promise<FakeGitLab> {
	fake = await FakeGitLab.start(options);
	return fake;
}

beforeEach(async () => {
	await boot();
});

afterEach(async () => {
	await fake.stop();
});

interface Answer {
	status: number;
	body: any;
	text: string;
	headers: Headers;
}

async function raw(
	method: string,
	path: string,
	options: { body?: string; contentType?: string; headers?: Record<string, string>; absolute?: boolean } = {}
): Promise<Answer> {
	const response = await fetch(options.absolute === true ? path : `${fake.baseUrl}${path}`, {
		method,
		headers: {
			'private-token': fake.token,
			...(options.contentType === undefined ? {} : { 'content-type': options.contentType }),
			...options.headers,
		},
		...(options.body === undefined ? {} : { body: options.body }),
	});
	const text = await response.text();
	let parsed: unknown;
	try {
		parsed = text === '' ? undefined : JSON.parse(text);
	} catch {
		parsed = undefined;
	}
	return { status: response.status, body: parsed, text, headers: response.headers };
}

async function call(
	method: string,
	path: string,
	body?: unknown,
	headers: Record<string, string> = { 'private-token': fake.token }
): Promise<Answer> {
	const response = await fetch(`${fake.baseUrl}${path}`, {
		method,
		headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
	const text = await response.text();
	let parsed: unknown;
	try {
		parsed = text === '' ? undefined : JSON.parse(text);
	} catch {
		parsed = undefined;
	}
	return { status: response.status, body: parsed, text, headers: response.headers };
}

async function gql(query: string, variables?: Record<string, unknown>, path = '/api/graphql'): Promise<Answer> {
	return await raw('POST', `${fake.baseUrl.replace('/api/v4', '')}${path}`, {
		absolute: true,
		contentType: 'application/json',
		body: JSON.stringify({ query, ...(variables === undefined ? {} : { variables }) }),
	});
}

const issues = (query = ''): string => `/projects/${fake.projectId}/issues${query}`;
const issueAt = (iid: number, tail = ''): string => `${issues()}/${iid}${tail}`;
const labelsPath = (tail = ''): string => `/projects/${fake.projectId}/labels${tail}`;
const gidOf = (iid: number): string => `gid://gitlab/WorkItem/${fake.issue(iid)!.id}`;

describe('authentication and project addressing', () => {
	it('answers 401 to a bad token and 404 to no token on the private project (LIVE-VERIFIED), both with the unauthenticated quota', async () => {
		const missing = await call('GET', issues(), undefined, {});
		expect(missing.status).toBe(404);
		expect(missing.body).toEqual({ message: '404 Project Not Found' });
		const wrong = await call('GET', issues(), undefined, { 'private-token': 'nope' });
		expect(wrong.status).toBe(401);
		expect(wrong.body).toEqual({ message: '401 Unauthorized' });
		for (const answer of [missing, wrong]) {
			expect(answer.headers.get('ratelimit-limit')).toBe('500');
			expect(answer.headers.get('ratelimit-name')).toBe('throttle_unauthenticated_api');
		}
		expect(fake.requests.map(request => request.auth)).toEqual(['missing', 'bad']);
		// LIVE-VERIFIED (step "GET version without a token"): a known route that is not a project route answers 401 to no token.
		expect((await call('GET', '/version', undefined, {})).status).toBe(401);
	});

	it('accepts the Bearer form of the token (LIVE-VERIFIED)', async () => {
		const answer = await call('GET', issues(), undefined, { authorization: `Bearer ${fake.token}` });
		expect(answer.status).toBe(200);
	});

	it('addresses the project by numeric id or by URL-encoded path, anything else is 404 (LIVE-VERIFIED)', async () => {
		fake.seedIssue({ title: 'A' });
		expect((await call('GET', `/projects/${encodeURIComponent(fake.project)}/issues`)).body).toHaveLength(1);
		expect((await call('GET', `/projects/${fake.projectId}/issues`)).body).toHaveLength(1);
		const unknown = await call('GET', '/projects/999/issues');
		expect(unknown.status).toBe(404);
		expect(unknown.body).toEqual({ message: '404 Project Not Found' });
	});

	it('echoes the project the way the client wrote it in the Link header (LIVE-VERIFIED)', async () => {
		for (let i = 0; i < 3; i++) fake.seedIssue({ title: `T${i}` });
		const byPath = await call('GET', `/projects/${encodeURIComponent(fake.project)}/issues?per_page=1`);
		expect(byPath.headers.get('link')).toContain(
			`/projects/${encodeURIComponent(fake.project)}/issues?id=${encodeURIComponent(fake.project)}&`
		);
		const byId = await call('GET', issues('?per_page=1'));
		expect(byId.headers.get('link')).toContain(`/projects/${fake.projectId}/issues?id=${fake.projectId}&`);
	});

	it('answers an unknown route and a wrong method with 404 {"error":"404 Not Found"} (LIVE-VERIFIED)', async () => {
		for (const [method, path] of [
			['GET', '/nothing/here'],
			['GET', `/projects/${fake.projectId}/nothing`],
			['PATCH', issues()],
		] as const) {
			const answer = await call(method, path, method === 'PATCH' ? {} : undefined);
			expect(answer.status).toBe(404);
			expect(answer.body).toEqual({ error: '404 Not Found' });
		}
	});
});

describe('headers of every answer (LIVE-VERIFIED)', () => {
	it('carries the quota, the correlation id, the cache-control and a weak md5 etag', async () => {
		fake.seedIssue({ title: 'A' });
		const read = await call('GET', issueAt(1));
		expect(read.headers.get('ratelimit-limit')).toBe('100');
		expect(read.headers.get('ratelimit-name')).toBe('burst_traffic_per_user_free_plan');
		expect(read.headers.get('ratelimit-observed')).toBe('1');
		expect(read.headers.get('ratelimit-remaining')).toBe('99');
		expect(read.headers.get('ratelimit-reset')).toMatch(/^\d{10}$/);
		expect(JSON.parse(read.headers.get('x-gitlab-meta')!)).toEqual({
			correlation_id: expect.any(String),
			version: '1',
		});
		expect(read.headers.get('cache-control')).toBe('max-age=0, private, must-revalidate');
		expect(read.headers.get('content-type')).toBe('application/json');
		expect(read.headers.get('etag')).toMatch(/^W\/"[0-9a-f]{32}"$/);
		const missing = await call('GET', issueAt(9));
		expect(missing.headers.get('cache-control')).toBe('no-store, private, max-age=0');
		expect(missing.headers.get('etag')).toBeNull();
		const gone = await call('DELETE', issueAt(1));
		expect(gone.status).toBe(204);
		expect(gone.headers.get('cache-control')).toBe('no-cache');
		expect(gone.headers.get('content-type')).toBeNull();
	});

	it('answers 304 to a matching If-None-Match on a single issue and on a list (with the pagination headers), 200 once it changed', async () => {
		fake.seedIssue({ title: 'A' });
		fake.seedIssue({ title: 'B' });
		const etag = (await call('GET', issueAt(1))).headers.get('etag')!;
		const same = await call('GET', issueAt(1), undefined, { 'private-token': fake.token, 'if-none-match': etag });
		expect(same.status).toBe(304);
		expect(same.headers.get('content-type')).toBeNull();
		expect(same.headers.get('etag')).toBe(etag);
		expect(same.text).toBe('');
		const list = await call('GET', issues('?per_page=1'));
		const cached = await call('GET', issues('?per_page=1'), undefined, {
			'private-token': fake.token,
			'if-none-match': list.headers.get('etag')!,
		});
		expect(cached.status).toBe(304);
		expect(cached.headers.get('x-total')).toBe('2');
		expect(cached.headers.get('link')).toContain('rel="next"');
		await call('PUT', issueAt(1), { title: 'changed' });
		const changed = await call('GET', issueAt(1), undefined, {
			'private-token': fake.token,
			'if-none-match': etag,
		});
		expect(changed.status).toBe(200);
	});

	it('ignores If-Match and If-Unmodified-Since on a PUT: there is no optimistic lock (LIVE-VERIFIED)', async () => {
		fake.seedIssue({ title: 'A' });
		const answer = await call(
			'PUT',
			issueAt(1),
			{ title: 'B' },
			{
				'private-token': fake.token,
				'if-match': 'W/"nothing"',
				'if-unmodified-since': 'Mon, 01 Jan 2001 00:00:00 GMT',
			}
		);
		expect(answer.status).toBe(200);
		expect(answer.body.title).toBe('B');
	});

	it('refuses an invalid JSON body before the rate limit (no ratelimit header), and another content type with 415', async () => {
		const invalid = await raw('POST', issues(), { contentType: 'application/json', body: '{nope' });
		expect(invalid.status).toBe(400);
		expect(invalid.body).toEqual({ error: 'Invalid JSON format' });
		expect(invalid.headers.get('ratelimit-limit')).toBeNull();
		const unsupported = await raw('POST', issues(), { contentType: 'text/plain', body: 'title=x' });
		expect(unsupported.status).toBe(415);
		expect(unsupported.body).toEqual({ error: "The provided content-type 'text/plain' is not supported." });
		expect(unsupported.headers.get('ratelimit-limit')).toBe('100');
	});

	it('accepts form-encoded and query-string bodies on POST and PUT (LIVE-VERIFIED)', async () => {
		const form = await raw('POST', issues(), {
			contentType: 'application/x-www-form-urlencoded',
			body: 'title=From+a+form&labels=a%2Cb&issue_type=incident',
		});
		expect(form.status).toBe(201);
		expect(form.body).toMatchObject({ title: 'From a form', labels: ['a', 'b'], issue_type: 'incident' });
		const query = await raw('POST', issues('?title=From%20the%20query&labels[]=x&labels[]=y'));
		expect(query.status).toBe(201);
		expect(query.body).toMatchObject({ title: 'From the query', labels: ['x', 'y'] });
		const put = await raw('PUT', issueAt(1, '?state_event=close'));
		expect(put.body.state).toBe('closed');
	});
});

describe('rate limit', () => {
	it('counts like GitLab in a fixed window but refuses nothing without the rateLimit option (LIVE-VERIFIED headers)', async () => {
		let last = await call('GET', issues());
		for (let i = 0; i < 120; i++) last = await call('GET', issues());
		expect(last.status).toBe(200);
		expect(last.headers.get('ratelimit-observed')).toBe('121');
		expect(last.headers.get('ratelimit-remaining')).toBe('0');
		expect(fake.remaining).toBe(0);
	});

	it('answers 429 text/plain with retry-after 2 and keeps answering 429 until the window ends (LIVE-VERIFIED), then opens a new window', async () => {
		await fake.stop();
		let now = Date.parse('2026-11-09T12:00:00.000Z');
		await boot({ rateLimit: { limit: 3, windowSeconds: 60 }, clock: () => now });
		for (let i = 1; i <= 3; i++) {
			const allowed = await call('GET', issues());
			expect(allowed.status).toBe(200);
			expect(allowed.headers.get('ratelimit-remaining')).toBe(String(3 - i));
		}
		const reset = Math.floor(now / 1000) + 60;
		const spent = await call('GET', issues());
		expect(spent.status).toBe(429);
		expect(spent.text).toBe(
			'Rate limit exceeded; see https://docs.gitlab.com/user/gitlab_com/rate_limits/ for more details'
		);
		expect(spent.headers.get('content-type')).toBe('text/plain');
		expect(spent.headers.get('retry-after')).toBe('2');
		expect(spent.headers.get('ratelimit-reset')).toBe(String(reset));
		expect(spent.headers.get('ratelimit-resettime')).toBe(new Date(reset * 1000).toUTCString());
		// The Retry-After is misleading: two seconds later the window is still closed.
		now += 2000;
		expect((await call('GET', issues())).status).toBe(429);
		now += 58_000;
		const reopened = await call('GET', issues());
		expect(reopened.status).toBe(200);
		expect(reopened.headers.get('ratelimit-observed')).toBe('1');
	});

	it('starts in the state rateLimit.remaining / resetAt describe, and setRateLimit changes it', async () => {
		await fake.stop();
		const resetAt = Math.floor(Date.now() / 1000) + 600;
		await boot({ rateLimit: { limit: 2000, remaining: 100, resetAt } });
		const first = await call('GET', issues());
		expect(first.headers.get('ratelimit-limit')).toBe('2000');
		expect(first.headers.get('ratelimit-remaining')).toBe('99');
		expect(first.headers.get('ratelimit-reset')).toBe(String(resetAt));
		fake.setRateLimit({ remaining: 0 });
		expect((await call('GET', issues())).status).toBe(429);
	});

	it('forceRateLimit answers the live 429 text with the Retry-After asked (default 2), then recovers', async () => {
		fake.forceRateLimit({ retryAfterSeconds: 7 });
		const limited = await call('GET', issues());
		expect(limited.status).toBe(429);
		expect(limited.headers.get('retry-after')).toBe('7');
		expect(limited.text).toContain('Rate limit exceeded');
		fake.forceRateLimit();
		expect((await call('GET', issues())).headers.get('retry-after')).toBe('2');
		expect((await call('GET', issues())).status).toBe(200);
	});
});

describe('fine-grained token permissions (LIVE-VERIFIED for the denied shapes)', () => {
	const denied = (kind: string, permission: string): unknown => ({
		error: 'insufficient_granular_scope',
		error_description: `Access denied: This operation requires a fine-grained personal access token with the following ${kind} permissions: [${permission}].`,
	});

	it('the default is exactly the live test token: Work Item and Label permissions and nothing else', async () => {
		expect([...LIVE_TOKEN_PERMISSIONS].sort()).toEqual(
			[
				'Label: Create',
				'Label: Delete',
				'Label: Read',
				'Label: Update',
				'Work Item: Create',
				'Work Item: Delete',
				'Work Item: Read',
				'Work Item: Update',
			].sort()
		);
		fake.seedIssue({ title: 'A' });
		expect((await call('GET', issues())).status).toBe(200);
		expect((await call('GET', labelsPath())).status).toBe(200);
		const cases: Array<[string, string, string, string]> = [
			['/user', 'user', 'User: Read', 'GET'],
			['/version', 'instance', 'Metadata: Read', 'GET'],
			['/metadata', 'instance', 'Metadata: Read', 'GET'],
			['/personal_access_tokens/self', 'user', 'Personal Access Token: Read', 'GET'],
			[`/projects/${fake.projectId}`, 'project', 'Project: Read', 'GET'],
			['/namespaces/group', 'user', 'Namespace: Read', 'GET'],
			[`/projects/${fake.projectId}/members/all`, 'project', 'Member: Read', 'GET'],
			[`/projects/${fake.projectId}/languages`, 'project', 'Project: Read', 'GET'],
			['/issues', 'user', 'Work Item: Read', 'GET'],
			['/search', 'user', 'Global Search: Use', 'GET'],
			[`/projects/${fake.projectId}/hooks`, 'project', 'Webhook: Read', 'GET'],
			['/issues/1000', 'instance', 'Work Item: Read', 'GET'],
		];
		for (const [path, kind, permission, method] of cases) {
			const answer = await call(method, path);
			expect([path, answer.status, answer.body]).toEqual([path, 403, denied(kind, permission)]);
		}
	});

	it('maps the verb to the action: GET Read, POST Create, PUT Update, DELETE Delete, for Work Item and Label', async () => {
		await fake.stop();
		await boot({ permissions: ['Work Item: Read'] });
		fake.seedIssue({ title: 'A' });
		expect((await call('GET', issueAt(1))).status).toBe(200);
		expect((await call('POST', issues(), { title: 'B' })).body).toEqual(denied('project', 'Work Item: Create'));
		expect((await call('PUT', issueAt(1), { title: 'B' })).body).toEqual(denied('project', 'Work Item: Update'));
		expect((await call('DELETE', issueAt(1))).body).toEqual(denied('project', 'Work Item: Delete'));
		expect((await call('POST', issueAt(1, '/notes'), { body: 'x' })).body).toEqual(
			denied('project', 'Work Item: Create')
		);
		expect((await call('GET', issueAt(1, '/resource_label_events'))).status).toBe(200);
		expect((await call('GET', `/projects/${fake.projectId}/issues_statistics`)).status).toBe(200);
		expect((await call('GET', labelsPath())).body).toEqual(denied('project', 'Label: Read'));
		expect((await call('POST', labelsPath(), { name: 'x', color: '#FF0000' })).body).toEqual(
			denied('project', 'Label: Create')
		);
		expect(fake.issue(1)!.title).toBe('A');
		fake.setPermissions([...LIVE_TOKEN_PERMISSIONS]);
		expect((await call('PUT', issueAt(1), { title: 'B' })).status).toBe(200);
	});

	it('looks the project up before checking the permission: an unknown project is 404 even without permission', async () => {
		await fake.stop();
		await boot({ permissions: [] });
		expect((await call('GET', '/projects/999/issues')).body).toEqual({ message: '404 Project Not Found' });
		expect((await call('GET', issues())).status).toBe(403);
	});

	it('classicToken (DOCUMENTED-NOT-LIVE) and permissions "all" read everything', async () => {
		await fake.stop();
		await boot({ classicToken: true });
		expect((await call('GET', `/projects/${fake.projectId}`)).status).toBe(200);
		expect((await call('GET', '/user')).body).toMatchObject({ username: 'tester' });
		fake.seedIssue({ title: 'A' });
		expect((await call('GET', `/issues/${fake.issue(1)!.id}`)).body.iid).toBe(1);
		await fake.stop();
		await boot({ permissions: 'all' });
		expect((await call('GET', '/metadata')).status).toBe(200);
	});

	it('GraphQL: project and namespace are null without Project: Read / Namespace: Read, the Work Item permissions gate workItem and the mutations', async () => {
		fake.seedIssue({ title: 'A' });
		const nulls = await gql(`{ project(fullPath: "${fake.project}") { id } namespace(fullPath: "group") { id } }`);
		expect(nulls.body).toEqual({ data: { project: null, namespace: null } });
		fake.setPermissions([...LIVE_TOKEN_PERMISSIONS, 'Project: Read', 'Namespace: Read']);
		const found = await gql(
			`{ project(fullPath: "${fake.project}") { fullPath } namespace(fullPath: "group") { fullPath } }`
		);
		expect(found.body.data.project).toEqual({ fullPath: fake.project });
		expect(found.body.data.namespace).toEqual({ fullPath: 'group' });
		fake.setPermissions(['Work Item: Update']);
		const read = await gql(`{ workItem(id: "${gidOf(1)}") { iid } }`);
		expect(read.status).toBe(403);
		expect(read.body).toEqual(denied('project', 'Work Item: Read'));
		fake.setPermissions(['Work Item: Read']);
		expect((await gql(`{ workItem(id: "${gidOf(1)}") { iid } }`)).body).toEqual({
			data: { workItem: { iid: '1' } },
		});
		const write = await gql(
			`mutation { workItemUpdate(input: {id: "${gidOf(1)}", hierarchyWidget: {parentId: null}}) { errors } }`
		);
		expect(write.status).toBe(403);
		expect(write.body).toEqual(denied('project', 'Work Item: Update'));
	});

	it('readOnlyToken: every write is a 403 insufficient_scope with a challenge (DOCUMENTED-NOT-LIVE shape)', async () => {
		await fake.stop();
		await boot({ readOnlyToken: true });
		fake.seedIssue({ title: 'A' });
		expect((await call('GET', issueAt(1))).status).toBe(200);
		const answer = await call('PUT', issueAt(1), { title: 'B' });
		expect(answer.status).toBe(403);
		expect(answer.body.error).toBe('insufficient_scope');
		expect(answer.headers.get('www-authenticate')).toBe(
			'Bearer realm="Protected by OAuth 2.0", error="insufficient_scope", scope="api read_api"'
		);
		expect(fake.issue(1)!.title).toBe('A');
	});

	it('canDelete false (a role below Planner) and issuesEnabled false are 403 {"message":"403 Forbidden"} (DOCUMENTED-NOT-LIVE)', async () => {
		await fake.stop();
		await boot({ canDelete: false, issuesEnabled: false });
		expect((await call('GET', issues())).body).toEqual({ message: '403 Forbidden' });
		await fake.stop();
		await boot({ canDelete: false });
		fake.seedIssue({ title: 'A' });
		const answer = await call('DELETE', issueAt(1));
		expect(answer.status).toBe(403);
		expect(answer.body).toEqual({ message: '403 Forbidden' });
		expect(fake.issue(1)).toBeDefined();
	});
});

describe('issues: the JSON', () => {
	it('has 39 keys on a single issue / create / update, 38 in a list and 29 inside a link answer (LIVE-VERIFIED)', async () => {
		const created = await call('POST', issues(), { title: 'A' });
		expect(Object.keys(created.body)).toHaveLength(39);
		expect(Object.keys((await call('PUT', issueAt(1), { title: 'B' })).body)).toHaveLength(39);
		expect(Object.keys((await call('GET', issueAt(1))).body)).toHaveLength(39);
		await call('POST', issues(), { title: 'C' });
		expect(Object.keys((await call('GET', issues())).body[0])).toHaveLength(38);
		const link = await call('POST', issueAt(1, '/links'), {
			target_project_id: fake.projectId,
			target_issue_iid: 2,
		});
		expect(Object.keys(link.body.source_issue)).toHaveLength(29);
		expect(Object.keys(link.body.target_issue)).toHaveLength(29);
		expect(Object.keys((await call('GET', issueAt(1, '/links'))).body[0])).toHaveLength(42);
	});

	it('gives type, issue_type and web_url the live rules: /-/work_items/N, /-/issues/N for an incident (LIVE-VERIFIED)', async () => {
		const issue = (await call('POST', issues(), { title: 'A' })).body;
		const incident = (await call('POST', issues(), { title: 'B', issue_type: 'incident' })).body;
		const task = (await call('POST', issues(), { title: 'C', issue_type: 'task' })).body;
		expect([issue.type, issue.issue_type, issue.web_url.replace(/^.*\/-\//, '')]).toEqual([
			'ISSUE',
			'issue',
			'work_items/1',
		]);
		expect([incident.type, incident.web_url.replace(/^.*\/-\//, '')]).toEqual(['INCIDENT', 'issues/2']);
		expect([task.type, task.web_url.replace(/^.*\/-\//, '')]).toEqual(['TASK', 'work_items/3']);
		expect(issue.references).toEqual({ short: '#1', relative: '#1', full: `${fake.project}#1` });
	});

	it('builds task_status from the checklist of the description', async () => {
		const none = await call('POST', issues(), { title: 'A' });
		expect([none.body.task_status, none.body.has_tasks]).toEqual(['', true]);
		const plain = await call('POST', issues(), { title: 'P', description: 'no boxes' });
		expect([plain.body.task_status, plain.body.has_tasks]).toEqual(['0 of 0 checklist items completed', true]);
		const some = await call('POST', issues(), { title: 'B', description: '- [x] one\n- [ ] two\n- [ ] three' });
		// LIVE-VERIFIED (step "create with a checklist"): with checkboxes has_tasks is false and task_status is absent.
		expect([some.body.has_tasks, 'task_status' in some.body]).toEqual([false, false]);
		expect(some.body.task_completion_status).toEqual({ count: 3, completed_count: 1 });
	});
});

describe('issues: create', () => {
	it('bounds the title at 255 characters and the description at 1 MiB with the live texts (LIVE-VERIFIED)', async () => {
		expect((await call('POST', issues(), { title: 't'.repeat(255) })).status).toBe(201);
		const long = await call('POST', issues(), { title: 't'.repeat(256) });
		expect(long.status).toBe(400);
		expect(long.body).toEqual({ message: { title: ['is too long (maximum is 255 characters)'] } });
		expect((await call('POST', issues(), { title: 't', description: 'x'.repeat(1_048_576) })).status).toBe(201);
		const big = await call('POST', issues(), { title: 't', description: 'x'.repeat(1_048_577) });
		expect(big.status).toBe(400);
		expect(big.body).toEqual({ message: { description: ['is too long (1 MiB). The maximum size is 1 MiB.'] } });
		expect((await call('POST', issues(), { title: 12345 })).body.title).toBe('12345');
		expect((await call('POST', issues(), { title: '   ' })).body).toEqual({
			message: { title: ["can't be blank"] },
		});
		expect((await call('POST', issues(), {})).body).toEqual({ error: 'title is missing' });
	});

	it('allows 100 labels and refuses 101 (LIVE-VERIFIED message)', async () => {
		const labels = (n: number): string => Array.from({ length: n }, (_, i) => `l${i}`).join(',');
		expect((await call('POST', issues(), { title: 't', labels: labels(100) })).status).toBe(201);
		const many = await call('POST', issues(), { title: 't', labels: labels(101) });
		expect(many.status).toBe(400);
		expect(many.body).toEqual({ message: 'Cannot add more than 100 labels to a work item.' });
		const update = await call('PUT', issueAt(1), { add_labels: 'one-more' });
		expect(update.status).toBe(400);
		expect(update.body.message).toBe('Cannot add more than 100 labels to a work item.');
	});

	it('creates unknown labels, sorts and deduplicates them per exact case, splits commas inside array elements (LIVE-VERIFIED)', async () => {
		const answer = await call('POST', issues(), { title: 'New', labels: ['b,a', 'c', 'a', 'A'] });
		expect(answer.body.labels).toEqual(['A', 'a', 'b', 'c']);
		expect(
			fake
				.projectLabels()
				.map(label => label.name)
				.sort()
		).toEqual(['A', 'a', 'b', 'c']);
	});

	it('ignores state and state_event, turns test_case into issue and refuses an unknown type (LIVE-VERIFIED)', async () => {
		const created = await call('POST', issues(), {
			title: 'N',
			state: 'closed',
			state_event: 'close',
			issue_type: 'test_case',
		});
		expect(created.body).toMatchObject({ state: 'opened', issue_type: 'issue', type: 'ISSUE' });
		const bad = await call('POST', issues(), { title: 'N', issue_type: 'epic' });
		expect(bad.body).toEqual({ error: 'issue_type does not have a valid value' });
	});

	it('normalizes CRLF and trailing blanks of the description and keeps the label events of the creation (LIVE-VERIFIED)', async () => {
		const created = await call('POST', issues(), { title: 'N', description: 'a\r\nb  \r\n', labels: 'x,y' });
		expect(created.body.description).toBe('a\nb');
		const events = (await call('GET', issueAt(1, '/resource_label_events'))).body;
		expect(events.map((e: any) => `${e.action}:${e.label.name}`)).toEqual(['add:x', 'add:y']);
		expect(events[0]).toMatchObject({ resource_type: 'Issue', resource_id: created.body.id });
	});
});

describe('issues: update', () => {
	it('needs a known parameter and says which (LIVE-VERIFIED text)', async () => {
		fake.seedIssue({ title: 'A' });
		for (const body of [{}, { bogus: 1 }, { state: 'closed' }]) {
			const answer = await call('PUT', issueAt(1), body);
			expect(answer.status).toBe(400);
			expect(answer.body.error).toMatch(
				/^assignee_id, assignee_ids, confidential, .*epic_iid are missing, at least one parameter must be provided$/
			);
		}
		expect((await call('PUT', issueAt(1), { state_event: 'nope' })).body).toEqual({
			error: 'state_event does not have a valid value',
		});
	});

	it('applies labels, then add_labels, then remove_labels (LIVE-VERIFIED)', async () => {
		fake.seedIssue({ title: 'A', labels: ['a', 'b'] });
		expect((await call('PUT', issueAt(1), { labels: 'c,d' })).body.labels).toEqual(['c', 'd']);
		expect((await call('PUT', issueAt(1), { add_labels: 'e' })).body.labels).toEqual(['c', 'd', 'e']);
		expect((await call('PUT', issueAt(1), { remove_labels: 'c' })).body.labels).toEqual(['d', 'e']);
		expect((await call('PUT', issueAt(1), { remove_labels: 'never-there' })).body.labels).toEqual(['d', 'e']);
		expect((await call('PUT', issueAt(1), { labels: '' })).body.labels).toEqual([]);
		expect(
			(await call('PUT', issueAt(1), { labels: 'p,q', add_labels: 'r', remove_labels: 'p' })).body.labels
		).toEqual(['q', 'r']);
		expect((await call('PUT', issueAt(1), { labels: null })).body.labels).toEqual([]);
		expect((await call('PUT', issueAt(1), { labels: ['x,y', 'z'] })).body.labels).toEqual(['x', 'y', 'z']);
	});

	it('changes the type: incident and issue work, test_case is ignored, task is refused (LIVE-VERIFIED)', async () => {
		fake.seedIssue({ title: 'A' });
		expect((await call('PUT', issueAt(1), { issue_type: 'incident' })).body.issue_type).toBe('incident');
		expect((await call('PUT', issueAt(1), { issue_type: 'test_case' })).body.issue_type).toBe('incident');
		const task = await call('PUT', issueAt(1), { issue_type: 'task' });
		expect(task.status).toBe(400);
		expect(task.body).toEqual({ message: { work_item_type_id: ['can not be changed to Task'] } });
		expect((await call('PUT', issueAt(1), { issue_type: 'issue' })).body.issue_type).toBe('issue');
	});

	it('moves updated_at on a new title, a description, a state change and on the FIRST PUT even with nothing changed; not on labels, a note, a repeated close, a later no-op; updated_at is no parameter (LIVE-VERIFIED)', async () => {
		fake.seedIssue({ title: 'A' });
		const before = (await call('GET', issueAt(1))).body.updated_at as string;
		expect(before).toMatch(/\.\d{3}Z$/);
		await call('POST', issueAt(1, '/notes'), { body: 'a comment' });
		expect((await call('GET', issueAt(1))).body.updated_at).toBe(before);
		// The first PUT after the creation moves it even when it changes nothing (step "updated order after the same title on a fresh
		// issue"); the next no-op PUTs do not.
		const first = (await call('PUT', issueAt(1), { title: 'A' })).body.updated_at as string;
		expect(Date.parse(first)).toBeGreaterThan(Date.parse(before));
		expect((await call('PUT', issueAt(1), { title: 'A' })).body.updated_at).toBe(first);
		expect((await call('PUT', issueAt(1), { labels: 'x' })).body.updated_at).toBe(first);
		expect((await call('PUT', issueAt(1), { description: null })).body.updated_at).toBe(first);
		const sameTitle = first;
		const closed = (await call('PUT', issueAt(1), { state_event: 'close' })).body.updated_at as string;
		expect(Date.parse(closed)).toBeGreaterThan(Date.parse(sameTitle));
		const again = (await call('PUT', issueAt(1), { state_event: 'close' })).body.updated_at as string;
		expect(again).toBe(closed);
		const stamped = await call('PUT', issueAt(1), { updated_at: '2020-01-02T03:04:05.678Z' });
		expect(stamped.status).toBe(400);
	});

	it('sets and clears the description, due date and confidentiality', async () => {
		fake.seedIssue({ title: 'A', description: 'old' });
		expect((await call('PUT', issueAt(1), { description: null })).body.description).toBeNull();
		const put = (await call('PUT', issueAt(1), { due_date: '2030-01-02', confidential: true })).body;
		expect([put.due_date, put.confidential]).toEqual(['2030-01-02', true]);
		const cleared = (await call('PUT', issueAt(1), { due_date: null, confidential: false })).body;
		expect([cleared.due_date, cleared.confidential]).toEqual([null, false]);
		expect(fake.systemNotes(1).map(note => note.body)).toEqual([
			'changed the description',
			'changed due date to January 02, 2030',
			'made the item confidential',
			'removed due date January 02, 2030',
			'made the item visible to everyone',
		]);
	});

	it('deletes with 204: afterwards GET, PUT and notes are 404, DELETE says "404 Issue Not Found" and the iid is not reused (LIVE-VERIFIED)', async () => {
		fake.seedIssue({ title: 'A' });
		fake.seedIssue({ title: 'B' });
		expect((await call('DELETE', issueAt(2))).status).toBe(204);
		expect((await call('GET', issueAt(2))).body).toEqual({ message: '404 Not found' });
		expect((await call('PUT', issueAt(2), { title: 'x' })).status).toBe(404);
		expect((await call('GET', issueAt(2, '/notes'))).status).toBe(404);
		expect((await call('DELETE', issueAt(2))).body).toEqual({ message: '404 Issue Not Found' });
		expect((await call('POST', issues(), { title: 'C' })).body.iid).toBe(3);
		expect((await call('GET', issueAt(0))).status).toBe(404);
		expect((await call('GET', issues('/abc'))).body).toEqual({ error: 'issue_iid is invalid' });
	});
});

describe('issues: lists', () => {
	it('filters by state, labels (all required, None, Any), not[labels], iids[], issue_type and search in title and description, case-insensitively (LIVE-VERIFIED)', async () => {
		fake.seedIssue({ title: 'Alpha one', labels: ['a', 'b'] });
		fake.seedIssue({ title: 'Beta', labels: ['a'], description: 'mentions ALPHA' });
		fake.seedIssue({ title: 'Gamma', state: 'closed', issueType: 'incident' });
		const titles = async (query: string): Promise<string[]> =>
			((await call('GET', issues(query))).body as Array<{ title: string }>).map(i => i.title).sort();
		expect(await titles('?state=closed')).toEqual(['Gamma']);
		expect(await titles('?state=opened')).toEqual(['Alpha one', 'Beta']);
		expect(await titles('?labels=a,b')).toEqual(['Alpha one']);
		expect(await titles('?labels=None')).toEqual(['Gamma']);
		expect(await titles('?labels=Any')).toEqual(['Alpha one', 'Beta']);
		expect(await titles('?not[labels]=b')).toEqual(['Beta', 'Gamma']);
		expect(await titles('?search=alpha')).toEqual(['Alpha one', 'Beta']);
		// Words, not substrings: every search word must START a word of the title or the description (LIVE-VERIFIED).
		expect(await titles('?search=a&in=title')).toEqual(['Alpha one']);
		expect(await titles('?search=lpha')).toEqual([]);
		expect(await titles('?search=one alp')).toEqual(['Alpha one']);
		expect(await titles('?search=MENTIONS&in=title')).toEqual([]);
		expect(await titles('?iids[]=1&iids[]=3')).toEqual(['Alpha one', 'Gamma']);
		expect(await titles('?issue_type=incident')).toEqual(['Gamma']);
		expect((await call('GET', issues('?issue_type=bogus'))).body).toEqual({
			error: 'issue_type does not have a valid value',
		});
	});

	it('orders by created_at descending by default and honours sort and order_by, with the live errors', async () => {
		fake.seedIssue({ title: 'first' });
		fake.seedIssue({ title: 'second' });
		const iids = async (query: string): Promise<number[]> =>
			((await call('GET', issues(query))).body as Array<{ iid: number }>).map(i => i.iid);
		expect(await iids('')).toEqual([2, 1]);
		expect(await iids('?order_by=created_at&sort=asc')).toEqual([1, 2]);
		await call('PUT', issueAt(1), { title: 'first, edited' });
		expect(await iids('?order_by=updated_at&sort=desc')).toEqual([1, 2]);
		expect((await call('GET', issues('?order_by=bogus'))).body).toEqual({
			error: 'order_by does not have a valid value',
		});
		expect((await call('GET', issues('?sort=bogus'))).body).toEqual({ error: 'sort does not have a valid value' });
		expect((await call('GET', issues('?state=bogus'))).body).toEqual({
			error: 'state does not have a valid value',
		});
	});

	it('paginates: per_page 0 is 400, above 100 clamps, page 0 is page 1, beyond the end is [] with no prev, Link follows rel=next (LIVE-VERIFIED)', async () => {
		for (let i = 1; i <= 45; i++) fake.seedIssue({ title: `T${i}` });
		const first = await call('GET', issues('?order_by=created_at&sort=asc'));
		expect(first.body).toHaveLength(20);
		expect(first.headers.get('x-next-page')).toBe('2');
		expect(first.headers.get('x-prev-page')).toBe('');
		expect(first.headers.get('x-total')).toBe('45');
		expect(first.headers.get('x-total-pages')).toBe('3');
		const link = first.headers.get('link')!;
		expect(link).toMatch(
			/<http:\/\/127\.0\.0\.1:\d+\/api\/v4\/projects\/\d+\/issues\?[^>]*page=2[^>]*>; rel="next"/
		);
		const next = /<([^>]+)>; rel="next"/.exec(link)![1]!;
		const second = await raw('GET', next, { absolute: true });
		expect(second.body).toHaveLength(20);
		expect(second.headers.get('x-prev-page')).toBe('1');
		expect(second.headers.get('link')).toMatch(
			/rel="prev", <[^>]+>; rel="next", <[^>]+>; rel="first", <[^>]+>; rel="last"/
		);
		const all = await call('GET', issues('?per_page=100&page=1'));
		expect(all.body).toHaveLength(45);
		expect(all.headers.get('link')).not.toContain('rel="next"');
		expect((await call('GET', issues('?per_page=1000'))).headers.get('x-per-page')).toBe('100');
		const zero = await call('GET', issues('?per_page=0'));
		expect(zero.status).toBe(400);
		expect(zero.body).toEqual({ error: 'per_page has a value not allowed' });
		expect((await call('GET', issues('?page=0'))).headers.get('x-page')).toBe('1');
		const beyond = await call('GET', issues('?page=9&per_page=20'));
		expect(beyond.body).toEqual([]);
		expect(beyond.headers.get('x-page')).toBe('9');
		expect(beyond.headers.get('link')).not.toContain('rel="prev"');
	});

	it('writes the parameters of the Link sorted by name with the defaults GitLab adds (LIVE-VERIFIED)', async () => {
		fake.seedIssue({ title: 'A', labels: ['x'] });
		const answer = await call('GET', issues('?labels=x,y&search=a%20b&iids[]=1'));
		const url = new URL(/<([^>]+)>; rel="first"/.exec(answer.headers.get('link')!)![1]!);
		expect(url.search).toBe(
			`?id=${fake.projectId}&iids%5B%5D=1&labels%5B%5D=x&labels%5B%5D=y&order_by=created_at&page=1&per_page=20&search=a+b&sort=desc&state=all&with_labels_details=false`
		);
	});

	it('answers issues_statistics with the counts of the filtered issues (LIVE-VERIFIED)', async () => {
		fake.seedIssue({ title: 'A', labels: ['x'] });
		fake.seedIssue({ title: 'B', labels: ['x'], state: 'closed' });
		fake.seedIssue({ title: 'C' });
		const stats = await call('GET', `/projects/${fake.projectId}/issues_statistics?labels=x`);
		expect(stats.body).toEqual({ statistics: { counts: { all: 2, closed: 1, opened: 1 } } });
	});
});

describe('events', () => {
	it('records label events (add before remove, one instant) and a state event 0.5 s earlier, and neither is a note (LIVE-VERIFIED)', async () => {
		fake.seedIssue({ title: 'A', labels: ['old'] });
		await call('PUT', issueAt(1), { labels: 'new', state_event: 'close' });
		const labels = (await call('GET', issueAt(1, '/resource_label_events'))).body;
		expect(labels.map((e: any) => `${e.action}:${e.label.name}`)).toEqual(['add:old', 'add:new', 'remove:old']);
		expect(labels[1].created_at).toBe(labels[2].created_at);
		const states = (await call('GET', issueAt(1, '/resource_state_events'))).body;
		expect(states.map((e: any) => e.state)).toEqual(['closed']);
		expect(Date.parse(labels[1].created_at) - Date.parse(states[0].created_at)).toBe(500);
		expect(fake.systemNotes(1)).toEqual([]);
		expect((await call('GET', issueAt(1, '/notes'))).body).toEqual([]);
	});

	it('names states closed and reopened, never opened, and does not record a no-op close (LIVE-VERIFIED)', async () => {
		fake.seedIssue({ title: 'A' });
		for (const event of ['close', 'close', 'reopen', 'reopen', 'close'])
			await call('PUT', issueAt(1), { state_event: event });
		const states = (await call('GET', issueAt(1, '/resource_state_events'))).body;
		expect(states.map((e: any) => e.state)).toEqual(['closed', 'reopened', 'closed']);
		expect(Object.keys(states[0]).sort()).toEqual(
			[
				'created_at',
				'id',
				'resource_id',
				'resource_type',
				'source_commit',
				'source_merge_request_id',
				'state',
				'user',
			].sort()
		);
	});

	it('shows label: null for a deleted label and the live label keys (LIVE-VERIFIED)', async () => {
		fake.seedIssue({ title: 'A', labels: ['gone', 'kept'] });
		await call('DELETE', labelsPath('/gone'));
		const events = (await call('GET', issueAt(1, '/resource_label_events'))).body;
		expect(events.map((e: any) => (e.label === null ? null : e.label.name))).toEqual([null, 'kept']);
		expect(Object.keys(events[1].label).sort()).toEqual(
			['archived', 'color', 'description', 'description_html', 'id', 'name', 'text_color'].sort()
		);
		expect(fake.issue(1)!.labels).toEqual(['kept']);
	});
});

describe('notes and system notes', () => {
	it('creates, lists, edits and deletes comments; CRLF and trailing blanks go; a 1,000,001 character body is accepted (LIVE-VERIFIED)', async () => {
		fake.seedIssue({ title: 'A' });
		expect((await call('POST', issueAt(1, '/notes'), {})).body).toEqual({ error: 'body is missing' });
		expect((await call('POST', issueAt(1, '/notes'), { body: '' })).body).toEqual({
			message: '400 Bad request - Note {:note=>["can\'t be blank"]}',
		});
		const created = await call('POST', issueAt(1, '/notes'), { body: 'hello  \r\nsecond  \r\n' });
		expect(created.status).toBe(201);
		expect(created.body.body).toBe('hello  \nsecond');
		expect(created.body).toMatchObject({
			system: false,
			noteable_iid: 1,
			noteable_type: 'Issue',
			commands_changes: {},
		});
		expect(Object.keys(created.body)).toHaveLength(17);
		const id = created.body.id as number;
		const edited = await call('PUT', issueAt(1, `/notes/${id}`), { body: 'changed' });
		expect(edited.body.body).toBe('changed');
		expect(edited.body.updated_at).not.toBe(edited.body.created_at);
		expect((await call('GET', issueAt(1, `/notes/${id}`))).body.body).toBe('changed');
		const huge = await call('POST', issueAt(1, '/notes'), { body: 'x'.repeat(1_000_001) });
		expect(huge.status).toBe(201);
		expect((await call('DELETE', issueAt(1, `/notes/${id}`))).status).toBe(204);
		expect((await call('DELETE', issueAt(1, `/notes/${id}`))).body).toEqual({ message: '404 Not found' });
		expect((await call('PUT', issueAt(1, '/notes/987654'), { body: 'x' })).status).toBe(404);
	});

	it('lists with activity_filter, sort (default desc) and order_by, and echoes them in the Link (LIVE-VERIFIED)', async () => {
		fake.seedIssue({ title: 'A' });
		fake.seedNote(1, 'one');
		await call('PUT', issueAt(1), { title: 'B' });
		fake.seedNote(1, 'two');
		const bodies = async (query: string): Promise<string[]> =>
			((await call('GET', issueAt(1, `/notes${query}`))).body as Array<{ body: string }>).map(note => note.body);
		expect(await bodies('?activity_filter=only_comments&sort=asc')).toEqual(['one', 'two']);
		expect(await bodies('?activity_filter=only_comments')).toEqual(['two', 'one']);
		expect(await bodies('?activity_filter=only_activity')).toHaveLength(1);
		const link = (await call('GET', issueAt(1, '/notes'))).headers.get('link')!;
		expect(link).toContain('activity_filter=all_notes&id=');
		expect(link).toContain('noteable_id=1&order_by=created_at&page=1&per_page=20&sort=desc');
		expect((await call('GET', issueAt(1, '/notes?activity_filter=bogus'))).status).toBe(400);
	});

	it('writes the system notes of GitLab: title as an HTML diff, description, type, due date, confidentiality (LIVE-VERIFIED texts)', async () => {
		fake.seedIssue({ title: 'Plan <it> & more' });
		await call('PUT', issueAt(1), { title: 'Plan <it> & more, later' });
		await call('PUT', issueAt(1), { title: 'Replace', description: 'd' });
		await call('PUT', issueAt(1), { issue_type: 'incident', due_date: '2030-01-02', confidential: true });
		await call('PUT', issueAt(1), { confidential: false });
		expect(fake.systemNotes(1).map(note => note.body)).toEqual([
			'<p>changed title from <code class="idiff">Plan &lt;it&gt; &amp; more</code> to <code class="idiff">Plan &lt;it&gt; &amp; more<span class="idiff left right addition">, later</span></code></p>',
			'<p>changed title from <code class="idiff"><span class="idiff left right deletion">Plan &lt;it&gt; &amp; more, later</span></code> to <code class="idiff"><span class="idiff left right addition">Replace</span></code></p>',
			'changed the description',
			'changed type to **Incident**',
			'changed due date to January 02, 2030',
			'made the item confidential',
			'made the item visible to everyone',
		]);
		expect(
			(await call('GET', issueAt(1, '/notes?activity_filter=only_activity&sort=asc'))).body.every(
				(n: any) => n.system
			)
		).toBe(true);
	});

	it('refuses to edit or delete a system note with 403 (LIVE-VERIFIED)', async () => {
		fake.seedIssue({ title: 'A' });
		await call('PUT', issueAt(1), { description: 'x' });
		const system = fake.systemNotes(1)[0]!;
		expect((await call('PUT', issueAt(1, `/notes/${system.id}`), { body: 'x' })).body).toEqual({
			message: '403 Forbidden',
		});
		expect((await call('DELETE', issueAt(1, `/notes/${system.id}`))).status).toBe(403);
	});
});

describe('quick actions (LIVE-VERIFIED)', () => {
	it('runs and strips them in a note: text stays, a note of commands only is 202 with commands_changes, an unknown label is ignored', async () => {
		fake.seedIssue({ title: 'A' });
		fake.seedLabel('known');
		const mixed = await call('POST', issueAt(1, '/notes'), { body: 'text\n/label ~known ~"never made"' });
		expect(mixed.status).toBe(201);
		expect(mixed.body.body).toBe('text');
		expect(fake.labelsOf(1)).toEqual(['known']);
		expect(fake.projectLabels().map(label => label.name)).toEqual(['known']);
		const only = await call('POST', issueAt(1, '/notes'), { body: '/close' });
		expect(only.status).toBe(202);
		expect(only.body).toEqual({ commands_changes: { state_event: 'close' }, summary: ['Closed this issue.'] });
		expect(only.headers.get('cache-control')).toBe('no-cache');
		expect(fake.issue(1)!.state).toBe('closed');
		expect(fake.notes(1).map(note => note.body)).toEqual(['text']);
		expect(fake.quickActionsRun).toBe(2);
	});

	it('does not run them in a code fence, in backticks, after a backslash or in the middle of a line', async () => {
		fake.seedIssue({ title: 'A' });
		for (const body of [
			'```\n/close\n```',
			'`/close`',
			'\\/close',
			'see /usr/bin/env',
			'~~~\n/close\n~~~\n/reopen',
		]) {
			const answer = await call('POST', issueAt(1, '/notes'), { body });
			expect(answer.body.body).toBe(body === '~~~\n/close\n~~~\n/reopen' ? '~~~\n/close\n~~~' : body);
		}
		expect(fake.issue(1)!.state).toBe('opened');
		expect(fake.quickActionsRun).toBe(1);
	});

	it('runs them in a description on create and on update, closing the issue and stripping the line', async () => {
		const created = await call('POST', issues(), { title: 'A', description: 'hi\n/close' });
		expect(created.body.description).toBe('hi');
		expect(fake.issue(1)!.state).toBe('closed');
		const updated = await call('PUT', issueAt(1), { description: 'again\n/reopen' });
		expect(updated.body.description).toBe('again');
		expect(updated.body.state).toBe('opened');
		expect(fake.quickActionsRun).toBe(2);
	});

	it('/relate creates a link and /duplicate closes the issue and sets closed_as_duplicate_of', async () => {
		fake.seedIssue({ title: 'A' });
		fake.seedIssue({ title: 'B' });
		fake.seedIssue({ title: 'C' });
		await call('POST', issueAt(1, '/notes'), { body: '/relate #2' });
		expect(fake.links(1)).toEqual([{ iid: 2, type: 'relates_to' }]);
		await call('POST', issueAt(3, '/notes'), { body: '/duplicate #1' });
		const duplicate = (await call('GET', issueAt(3))).body;
		expect(duplicate.state).toBe('closed');
		expect(duplicate._links.closed_as_duplicate_of).toBe(`${fake.baseUrl}/projects/${fake.projectId}/issues/1`);
		expect(fake.links(3)).toEqual([{ iid: 1, type: 'relates_to' }]);
	});
});

describe('issue links (LIVE-VERIFIED)', () => {
	beforeEach(() => {
		fake.seedIssue({ title: 'A' });
		fake.seedIssue({ title: 'B' });
		fake.seedIssue({ title: 'C', state: 'closed' });
	});

	const post = (from: number, to: unknown, extra: Record<string, unknown> = {}, project: unknown = fake.projectId) =>
		call('POST', issueAt(from, '/links'), { target_project_id: project, target_issue_iid: to, ...extra });

	it('creates a link (201), lists it from both sides with the live keys and writes a system note on both issues', async () => {
		const created = await post(1, 2);
		expect(created.status).toBe(201);
		expect(Object.keys(created.body).sort()).toEqual(['id', 'link_type', 'source_issue', 'target_issue']);
		expect(created.body.link_type).toBe('relates_to');
		const mine = (await call('GET', issueAt(1, '/links'))).body;
		expect(mine[0]).toMatchObject({ iid: 2, link_type: 'relates_to' });
		expect(mine[0].issue_link_id).toBe(created.body.id);
		expect((await call('GET', issueAt(2, '/links'))).body[0]).toMatchObject({ iid: 1, link_type: 'relates_to' });
		expect(fake.systemNotes(1).map(n => n.body)).toEqual(['marked as related to #2']);
		expect(fake.systemNotes(2).map(n => n.body)).toEqual(['marked as related to #1']);
	});

	it('takes the project as the numeric id or as the path, not as an URL-encoded path; a closed target is fine', async () => {
		expect((await post(1, 2, {}, fake.project)).status).toBe(201);
		expect((await post(1, 3, {}, encodeURIComponent(fake.project))).body).toEqual({
			message: '404 Project Not Found',
		});
		expect((await post(1, 3)).status).toBe(201);
		expect((await post(1, 99, {}, '999999999')).body).toEqual({ message: '404 Project Not Found' });
	});

	it('refuses with the live texts: duplicate in any direction 409, itself 422, unknown 404, bad type 400, missing parameter 400', async () => {
		await post(1, 2);
		expect((await post(1, 2)).body).toEqual({ message: 'Issue(s) already assigned' });
		const reverse = await post(2, 1);
		expect([reverse.status, reverse.body]).toEqual([409, { message: 'Issue(s) already assigned' }]);
		const self = await post(1, 1);
		expect([self.status, self.body]).toEqual([422, { message: '#1 cannot be added: cannot be related to itself' }]);
		expect((await post(1, 99)).body).toEqual({ message: '404 Not found' });
		expect(
			(await call('POST', issueAt(99, '/links'), { target_project_id: fake.projectId, target_issue_iid: 1 }))
				.status
		).toBe(404);
		expect((await post(1, 3, { link_type: 'bogus' })).body).toEqual({
			error: 'link_type does not have a valid value',
		});
		expect((await call('POST', issueAt(1, '/links'), { target_project_id: fake.projectId })).body).toEqual({
			error: 'target_issue_iid is missing',
		});
		expect((await call('POST', issueAt(1, '/links'), {})).body).toEqual({
			error: 'target_project_id, target_issue_iid are missing',
		});
	});

	it('refuses blocks and is_blocked_by with 403 "Blocked issues not available for current license" on Free', async () => {
		for (const link_type of ['blocks', 'is_blocked_by']) {
			const blocked = await post(1, 2, { link_type });
			expect([blocked.status, blocked.body]).toEqual([
				403,
				{ message: 'Blocked issues not available for current license' },
			]);
		}
		expect((await call('GET', issueAt(1, '/links'))).body).toEqual([]);
	});

	it('deletes a link by issue_link_id (200 with the link) and writes the removal notes; again is 404', async () => {
		const id = (await post(1, 2)).body.id as number;
		const removed = await call('DELETE', issueAt(1, `/links/${id}`));
		expect(removed.status).toBe(200);
		expect(removed.body).toMatchObject({ id, link_type: 'relates_to' });
		expect((await call('GET', issueAt(2, '/links'))).body).toEqual([]);
		expect(fake.systemNotes(2).map(n => n.body)).toEqual([
			'marked as related to #1',
			'removed the relation with #1',
		]);
		expect((await call('DELETE', issueAt(1, `/links/${id}`))).body).toEqual({ message: '404 Not found' });
	});

	it('seedLink makes the paid types a person could make in the UI (no license check)', () => {
		fake.seedLink(1, 2, 'blocks');
		expect(fake.links(2)).toEqual([{ iid: 1, type: 'is_blocked_by' }]);
		expect(fake.links(1)).toEqual([{ iid: 2, type: 'blocks' }]);
	});
});

describe('project labels (LIVE-VERIFIED)', () => {
	it('needs name and color and validates them with the live texts', async () => {
		const create = (body: Record<string, unknown>): Promise<Answer> => call('POST', labelsPath(), body);
		expect((await create({ name: 'x' })).body).toEqual({ error: 'color is missing' });
		expect((await create({ color: '#FF0000' })).body).toEqual({ error: 'name is missing' });
		expect((await create({ name: 'x', color: 'red!' })).body).toEqual({
			message: { color: ['must be a valid color code'] },
		});
		expect((await create({ name: '', color: '#FF0000' })).body).toEqual({
			message: { title: ["can't be blank", 'is invalid'] },
		});
		expect((await create({ name: 'a,b', color: '#FF0000' })).body).toEqual({ message: { title: ['is invalid'] } });
		expect((await create({ name: 'n'.repeat(256), color: '#FF0000' })).body).toEqual({
			message: { title: ['is too long (maximum is 255 characters)'] },
		});
		const named = await create({ name: ' padded ', color: 'red' });
		expect(named.status).toBe(201);
		expect(named.body).toMatchObject({ name: 'padded', color: '#FF0000', is_project_label: true, priority: null });
		expect(Object.keys(named.body)).toHaveLength(10);
		for (const name of ['a:b', 'a::b', 'a/b', '100%', 'a&b', 'q"uote', 'tab\there', 'cafe\u0301', 'caf\u00e9']) {
			expect((await create({ name, color: '#00FF00' })).status).toBe(201);
		}
	});

	it('is case sensitive: bug next to Bug is fine, the same name is 409 "Label already exists"', async () => {
		expect((await call('POST', labelsPath(), { name: 'bug', color: '#FF0000' })).status).toBe(201);
		expect((await call('POST', labelsPath(), { name: 'Bug', color: '#FF0000' })).status).toBe(201);
		const dup = await call('POST', labelsPath(), { name: 'bug', color: '#000000' });
		expect([dup.status, dup.body]).toEqual([409, { message: 'Label already exists' }]);
	});

	it('lists group labels with is_project_label false, blocks a project label of the same name, sorts by name', async () => {
		fake.seedGroupLabel('team');
		fake.seedLabel('alpha');
		const list = (await call('GET', labelsPath())).body;
		expect(list.map((l: any) => [l.name, l.is_project_label])).toEqual([
			['alpha', true],
			['team', false],
		]);
		const clash = await call('POST', labelsPath(), { name: 'team', color: '#FF0000' });
		expect([clash.status, clash.body]).toEqual([409, { message: 'Label already exists' }]);
		expect(fake.groupLabels().map(l => l.name)).toEqual(['team']);
		expect(fake.projectLabels().map(l => l.name)).toEqual(['alpha']);
		// UNVERIFIABLE (destructive on group data): changing or deleting a group label through the project is not modelled.
		const deleteGroup = await call('DELETE', labelsPath('/team'));
		expect([deleteGroup.status, deleteGroup.body]).toEqual([
			501,
			{ message: 'mock: not modelled: deleting a group label through the project route' },
		]);
		expect((await call('PUT', labelsPath('/team'), { description: 'x' })).status).toBe(501);
		// An issue using the group label does not create a project label.
		fake.seedIssue({ title: 'A', labels: ['team'] });
		expect(fake.projectLabels().map(l => l.name)).toEqual(['alpha']);
	});

	it('reads by name (URL-encoded) or id, renames with new_name, deletes with 204 then 404, counts on request', async () => {
		fake.seedLabel('status::doing');
		fake.seedIssue({ title: 'A', labels: ['status::doing'] });
		fake.seedIssue({ title: 'B', labels: ['status::doing'], state: 'closed' });
		const byName = await call('GET', labelsPath(`/${encodeURIComponent('status::doing')}`));
		expect(byName.status).toBe(200);
		expect((await call('GET', labelsPath(`/${byName.body.id}`))).body.name).toBe('status::doing');
		const counts = (await call('GET', labelsPath('?with_counts=true'))).body;
		expect(counts[0]).toMatchObject({ open_issues_count: 1, closed_issues_count: 1 });
		const renamed = await call('PUT', labelsPath(`/${encodeURIComponent('status::doing')}`), {
			new_name: 'doing',
			color: '#112233',
		});
		expect(renamed.body).toMatchObject({ name: 'doing', color: '#112233' });
		expect(fake.labelsOf(1)).toEqual(['doing']);
		expect((await call('PUT', labelsPath('/doing'), {})).status).toBe(400);
		expect((await call('DELETE', labelsPath('/doing'))).status).toBe(204);
		expect((await call('DELETE', labelsPath('/doing'))).body).toEqual({ message: '404 Label Not Found' });
		expect(fake.labelsOf(1)).toEqual([]);
		expect((await call('GET', labelsPath('/nope'))).status).toBe(404);
	});

	it('has no exclusivity at all: scoped looking labels are ordinary labels (Free)', async () => {
		fake.seedIssue({ title: 'A', labels: ['status::todo'] });
		const both = await call('PUT', issueAt(1), { add_labels: 'status::doing' });
		expect(both.body.labels).toEqual(['status::doing', 'status::todo']);
	});
});

describe('GraphQL (LIVE-VERIFIED shapes)', () => {
	const READ = (id: string): string =>
		`query($id: WorkItemID!) { workItem(id: $id) { id iid workItemType { name } widgets { ... on WorkItemWidgetHierarchy { type parent { id iid } children(first: 100) { nodes { id iid } } } } } }`;
	const SET_PARENT = `mutation($input: WorkItemUpdateInput!) { workItemUpdate(input: $input) { errors workItem { id iid } } }`;
	const CONVERT = `mutation($input: WorkItemConvertInput!) { workItemConvert(input: $input) { errors workItem { id iid workItemType { name } } } }`;
	const setParent = async (child: number, parent: number | null) =>
		await gql(SET_PARENT, {
			input: { id: gidOf(child), hierarchyWidget: { parentId: parent === null ? null : gidOf(parent) } },
		});

	beforeEach(() => {
		fake.seedIssue({ title: 'Issue' });
		fake.seedIssue({ title: 'Task', issueType: 'task' });
		fake.seedIssue({ title: 'Incident', issueType: 'incident' });
		fake.seedIssue({ title: 'Other task', issueType: 'task' });
	});

	it('reads the hierarchy widget at its place: 19 widgets for an issue (index 9), 16 for a task (index 6), the others are {}', async () => {
		const issue = await gql(READ(''), { id: gidOf(1) });
		expect(issue.headers.get('content-type')).toBe('application/json; charset=utf-8');
		expect(issue.headers.get('etag')).toMatch(/^W\//);
		const widgets = issue.body.data.workItem.widgets as unknown[];
		expect(widgets).toHaveLength(19);
		expect(widgets[9]).toEqual({ type: 'HIERARCHY', parent: null, children: { nodes: [] } });
		expect(widgets.filter((w, i) => i !== 9).every(w => JSON.stringify(w) === '{}')).toBe(true);
		expect(issue.body.data.workItem.iid).toBe('1');
		expect(issue.body.data.workItem.workItemType).toEqual({ name: 'Issue' });
		const task = (await gql(READ(''), { id: gidOf(2) })).body.data.workItem.widgets as unknown[];
		expect(task).toHaveLength(16);
		expect((task[6] as any).type).toBe('HIERARCHY');
		const incident = (await gql(READ(''), { id: gidOf(3) })).body.data.workItem.widgets as unknown[];
		// LIVE-VERIFIED (step "widget types of an Incident"): an Incident has 18 widgets, not the 19 of an Issue.
		expect(incident).toHaveLength(18);
	});

	it('also answers at /api/v4/graphql (where the conformance fixture addresses it)', async () => {
		const answer = await gql(READ(''), { id: gidOf(1) }, '/api/v4/graphql');
		expect(answer.body.data.workItem.iid).toBe('1');
	});

	it('puts a task under an issue or an incident, replaces the parent, removes it (idempotent), with system notes on both items', async () => {
		const set = await setParent(2, 1);
		expect(set.body).toEqual({ data: { workItemUpdate: { errors: [], workItem: { id: gidOf(2), iid: '2' } } } });
		const parent = (await gql(READ(''), { id: gidOf(1) })).body.data.workItem.widgets[9];
		expect(parent.children.nodes).toEqual([{ id: gidOf(2), iid: '2' }]);
		const child = (await gql(READ(''), { id: gidOf(2) })).body.data.workItem.widgets[6];
		expect(child.parent).toEqual({ id: gidOf(1), iid: '1' });
		expect(fake.systemNotes(1).map(n => n.body)).toEqual(['added #2 as child item']);
		expect(fake.systemNotes(2).map(n => n.body)).toEqual(['added #1 as parent item']);
		expect((await setParent(2, 3)).body.data.workItemUpdate.errors).toEqual([]);
		expect(fake.issue(2)!.parentIid).toBe(3);
		expect((await setParent(2, null)).body.data.workItemUpdate.errors).toEqual([]);
		expect((await setParent(2, null)).body.data.workItemUpdate.errors).toEqual([]);
		expect(fake.issue(2)!.parentIid).toBeNull();
		// LIVE-VERIFIED removal texts (steps "notes of HJ after the removal", "notes of HT after the removal").
		expect(fake.systemNotes(2).map(n => n.body)).toEqual([
			'added #1 as parent item',
			'added #3 as parent item',
			'removed parent item #3',
		]);
	});

	it('refuses the other combinations in the payload with errors and workItem null, and a self parent adds its own sentence', async () => {
		const taskUnderTask = await setParent(2, 4);
		expect(taskUnderTask.body).toEqual({
			data: {
				workItemUpdate: {
					errors: ["#2 cannot be added: it's not allowed to add this type of parent item"],
					workItem: null,
				},
			},
		});
		expect((await setParent(1, 3)).body.data.workItemUpdate.errors).toHaveLength(1);
		expect((await setParent(2, 2)).body.data.workItemUpdate.errors).toEqual([
			"#2 cannot be added: it's not allowed to add this type of parent item and is not allowed to point to itself",
		]);
		expect(fake.issue(2)!.parentIid).toBeNull();
	});

	it('answers an unknown work item with a top-level 404 error and a null field', async () => {
		const answer = await gql(SET_PARENT, {
			input: { id: 'gid://gitlab/WorkItem/1', hierarchyWidget: { parentId: null } },
		});
		expect(answer.status).toBe(200);
		expect(answer.body).toEqual({
			errors: [
				{
					message: '404 Not Found',
					locations: [{ line: 1, column: expect.any(Number) }],
					path: ['workItemUpdate'],
				},
			],
			data: { workItemUpdate: null },
		});
		// LIVE-VERIFIED (steps "read an unknown work item", "read a malformed global id").
		const unknown = (await gql(READ(''), { id: 'gid://gitlab/WorkItem/1' })).body;
		expect(unknown.data).toEqual({ workItem: null });
		expect(unknown.errors[0]).toMatchObject({
			message:
				"The resource that you are attempting to access does not exist or you don't have permission to perform this action",
			path: ['workItem'],
		});
		const bad = await gql(READ(''), { id: 'nope' });
		expect(bad.body.errors[0].message).toBe('Variable $id of type WorkItemID! was provided invalid value');
		expect(bad.body.errors[0].extensions.problems[0].explanation).toBe('"nope" is not a valid Global ID');
	});

	it('converts between Issue, Incident and Task by type id, refuses Test Case with a top-level error', async () => {
		const toTask = await gql(CONVERT, {
			input: { id: gidOf(1), workItemTypeId: 'gid://gitlab/WorkItems::Type/5' },
		});
		expect(toTask.body.data.workItemConvert).toEqual({
			errors: [],
			workItem: { id: gidOf(1), iid: '1', workItemType: { name: 'Task' } },
		});
		expect(fake.issue(1)!.issueType).toBe('task');
		const toIncident = await gql(CONVERT, {
			input: { id: gidOf(1), workItemTypeId: 'gid://gitlab/WorkItems::Type/2' },
		});
		expect(toIncident.body.data.workItemConvert.workItem.workItemType).toEqual({ name: 'Incident' });
		const testCase = await gql(CONVERT, {
			input: { id: gidOf(1), workItemTypeId: 'gid://gitlab/WorkItems::Type/3' },
		});
		expect(testCase.body).toEqual({
			errors: [
				{
					message: 'You are not allowed to change the Work Item type to Test Case.',
					locations: [{ line: 1, column: expect.any(Number) }],
					path: ['workItemConvert'],
				},
			],
			data: { workItemConvert: null },
		});
		expect(fake.systemNotes(1).map(n => n.body)).toContain('changed type to **Task**');
	});

	it('refuses a conversion that would break the hierarchy (LIVE-VERIFIED text)', async () => {
		await setParent(2, 1);
		const issueToTask = await gql(CONVERT, {
			input: { id: gidOf(1), workItemTypeId: 'gid://gitlab/WorkItems::Type/5' },
		});
		expect(issueToTask.body.data.workItemConvert.errors).toHaveLength(1);
		const taskToIssue = await gql(CONVERT, {
			input: { id: gidOf(2), workItemTypeId: 'gid://gitlab/WorkItems::Type/1' },
		});
		expect(taskToIssue.body.data.workItemConvert).toMatchObject({ workItem: null });
	});

	it('is a real executor: aliases batch reads, named and inline fragments, variables, @include and @skip, __typename', async () => {
		const batch = await gql(
			`query Both($a: WorkItemID!, $b: WorkItemID!, $with: Boolean = true) {
				first: workItem(id: $a) { iid ...Basics }
				second: workItem(id: $b) { iid ...Basics @include(if: $with) other: title @skip(if: $with) }
			}
			fragment Basics on WorkItem { title __typename state }`,
			{ a: gidOf(1), b: gidOf(2) }
		);
		expect(batch.body).toEqual({
			data: {
				first: { iid: '1', title: 'Issue', __typename: 'WorkItem', state: 'OPEN' },
				second: { iid: '2', title: 'Task', __typename: 'WorkItem', state: 'OPEN' },
			},
		});
		const widgets = await gql(`{ workItem(id: "${gidOf(1)}") { widgets { type } } }`);
		const items = widgets.body.data.workItem.widgets as any[];
		expect(items).toHaveLength(19);
		expect(items.every(item => typeof item.type === 'string')).toBe(true);
		// Only the hierarchy widget has fields: a field of another widget is not modelled (501), not "missing".
		const labelsWidget = await gql(
			`{ workItem(id: "${gidOf(1)}") { widgets { ... on WorkItemWidgetLabels { labels { nodes { title } } } } } }`
		);
		expect([labelsWidget.status, labelsWidget.body]).toEqual([
			501,
			{ message: 'mock: not modelled: the field labels of WorkItemWidgetLabels' },
		]);
		expect(labelsWidget.headers.get('x-mock-not-modelled')).toBe('1');
		const pageInfo = await gql(
			`{ workItem(id: "${gidOf(1)}") { widgets { ... on WorkItemWidgetHierarchy { children { pageInfo { hasNextPage } } } } } }`
		);
		expect([pageInfo.status, pageInfo.body.message]).toEqual([
			501,
			'mock: not modelled: the field pageInfo of WorkItemConnection',
		]);
		const update = await gql(
			'mutation($input: WorkItemUpdateInput!) { workItemUpdate(input: $input) { errors } }',
			{ input: { id: gidOf(1), title: 'renamed' } }
		);
		expect([update.status, update.body.message]).toEqual([
			501,
			'mock: not modelled: the workItemUpdate input title',
		]);
		const subscription = await gql('subscription { __typename }');
		expect([subscription.status, subscription.body.message]).toEqual([
			501,
			'mock: not modelled: a GraphQL subscription',
		]);
		const named = await gql(
			'query One { workItem(id: "' +
				gidOf(1) +
				'") { iid } } query Two { workItem(id: "' +
				gidOf(2) +
				'") { iid } }'
		);
		expect(named.body.errors[0].message).toBe('An operation name is required');
		const picked = await raw('POST', `${fake.baseUrl.replace('/api/v4', '')}/api/graphql`, {
			absolute: true,
			contentType: 'application/json',
			body: JSON.stringify({
				query:
					'query One { workItem(id: "' +
					gidOf(1) +
					'") { iid } } query Two { workItem(id: "' +
					gidOf(2) +
					'") { iid } }',
				operationName: 'Two',
			}),
		});
		expect(picked.body).toEqual({ data: { workItem: { iid: '2' } } });
	});

	it('reports a syntax error, an unknown field with a suggestion, wrong selections and bad variables like graphql-ruby', async () => {
		const unknown = await gql('{ nope }');
		expect(unknown.body).toEqual({
			errors: [
				{
					message: "Field 'nope' doesn't exist on type 'Query' (Did you mean `note`?)",
					locations: [{ line: 1, column: 3 }],
					path: ['query', 'nope'],
					extensions: { code: 'undefinedField', typeName: 'Query', fieldName: 'nope' },
				},
			],
		});
		const syntax = await gql('{ workItem(id: "x" { iid } }');
		expect(syntax.body.errors[0].message).toMatch(/^Parse error on "\{" \(LCURLY\) at \[1, \d+\]$/);
		expect(syntax.body.data).toBeUndefined();
		expect((await gql('{ workItem(id: "x") ')).body.errors[0].message).toBe('Unexpected end of document');
		const scalar = await gql(`{ workItem(id: "${gidOf(1)}") { iid { x } } }`);
		expect(scalar.body.errors[0].extensions.code).toBe('selectionMismatch');
		const bare = await gql(`{ workItem(id: "${gidOf(1)}") }`);
		expect(bare.body.errors[0].extensions.code).toBe('selectionMismatch');
		const noArg = await gql('{ workItem { iid } }');
		expect(noArg.body.errors[0].message).toBe("Field 'workItem' is missing required arguments: id");
		const missing = await gql(READ(''), {});
		expect(missing.body.errors[0].message).toBe('Variable $id of type WorkItemID! was provided invalid value');
		const input = await gql(SET_PARENT, { input: { id: gidOf(1), nope: true } });
		expect(input.body.errors[0].extensions.problems).toEqual([
			{ path: ['nope'], explanation: 'Field is not defined on WorkItemUpdateInput' },
		]);
		expect(
			(
				await raw('POST', `${fake.baseUrl.replace('/api/v4', '')}/api/graphql`, {
					absolute: true,
					contentType: 'application/json',
					body: '{}',
				})
			).body
		).toEqual({
			errors: [{ message: 'Unexpected end of document', locations: [{ line: 1, column: 1 }] }],
		});
	});
});

describe('seed helpers and read-back', () => {
	it('seedNote does not move updated_at, seedParent and seedGroupLabel exist, seedDemo makes a small project', () => {
		fake.seedIssue({ title: 'A' });
		fake.seedIssue({ title: 'B', issueType: 'task' });
		const before = fake.issue(1)!.updatedAt;
		const id = fake.seedNote(1, 'a comment', 'ann');
		expect(fake.notes(1).map(n => [n.id, n.author, n.body])).toEqual([[id, 'ann', 'a comment']]);
		expect(fake.issue(1)!.updatedAt).toBe(before);
		fake.seedParent(2, 1);
		expect(fake.issue(2)!.parentIid).toBe(1);
	});

	it('seedDemo covers every status and type, a child task, a link and comments', async () => {
		fake.seedDemo();
		const all = (await call('GET', issues('?per_page=100'))).body as Array<any>;
		expect(all.length).toBeGreaterThanOrEqual(6);
		expect(new Set(all.map(issue => issue.issue_type))).toEqual(new Set(['issue', 'incident', 'task']));
		expect(all.some(issue => issue.state === 'closed')).toBe(true);
		expect(all.some(issue => issue.labels.includes('status:in-progress'))).toBe(true);
		expect(all.some(issue => issue.labels.includes('status:cancelled') && issue.state === 'closed')).toBe(true);
		expect(all.some(issue => issue.user_notes_count > 0)).toBe(true);
		expect(all.some(issue => fake.issue(issue.iid)!.parentIid !== null)).toBe(true);
		expect(all.some(issue => fake.links(issue.iid).length > 0)).toBe(true);
	});

	it('steps the clock on each change by clockStepMs (0 keeps one instant)', async () => {
		fake.seedIssue({ title: 'A' });
		const a = fake.issue(1)!.createdAt;
		fake.seedIssue({ title: 'B' });
		expect(Date.parse(fake.issue(2)!.createdAt) - Date.parse(a)).toBe(5000);
		await fake.stop();
		await boot({ clockStepMs: 0 });
		fake.seedIssue({ title: 'A' });
		fake.seedIssue({ title: 'B' });
		expect(fake.issue(2)!.createdAt).toBe(fake.issue(1)!.createdAt);
	});

	it('answers the project, the namespace plan, version, metadata and the token to a token that may read them (DOCUMENTED-NOT-LIVE shapes)', async () => {
		await fake.stop();
		await boot({ classicToken: true, accessLevel: 30, tokenScopes: ['read_api'], tokenExpiresAt: '2027-01-01' });
		const project = (await call('GET', `/projects/${fake.projectId}`)).body;
		expect(project).toMatchObject({
			id: fake.projectId,
			path_with_namespace: fake.project,
			archived: false,
			issues_enabled: true,
			permissions: { project_access: { access_level: 30 } },
		});
		expect((await call('GET', `/namespaces/${project.namespace.id}`)).body).toMatchObject({ plan: 'free' });
		expect((await call('GET', '/version')).body).toMatchObject({ version: expect.any(String) });
		expect((await call('GET', '/personal_access_tokens/self')).body).toMatchObject({
			scopes: ['read_api'],
			expires_at: '2027-01-01',
		});
	});
});

describe('other fields on Free', () => {
	it('keeps discussion_locked, refuses an epic and a move without target or to an unknown project', async () => {
		fake.seedIssue({ title: 'A' });
		expect((await call('PUT', issueAt(1), { discussion_locked: true })).body.discussion_locked).toBe(true);
		expect((await call('PUT', issueAt(1), { epic_id: 5 })).status).toBe(404);
		expect((await call('PUT', issueAt(1), { weight: 3 })).status).toBe(200);
		expect((await call('POST', issueAt(1, '/move'), {})).body).toEqual({ error: 'to_project_id is missing' });
		const unknown = await call('POST', issueAt(1, '/move'), { to_project_id: 999999 });
		expect([unknown.status, unknown.body]).toEqual([404, { message: '404 Project Not Found' }]);
	});
});

describe('what the mock does not model answers 501 and says so (never an invented answer)', () => {
	const notModelled = (answer: Answer, what: string): void => {
		expect([answer.status, answer.body]).toEqual([501, { message: `mock: not modelled: ${what}` }]);
		expect(answer.headers.get('x-mock-not-modelled')).toBe('1');
	};

	it('time tracking, reactions, subscriptions, discussions and the other sub-resources of an issue', async () => {
		fake.seedIssue({ title: 'A' });
		notModelled(await call('POST', issueAt(1, '/time_estimate?duration=3h')), 'time tracking (time_estimate)');
		notModelled(
			await call('POST', issueAt(1, '/add_spent_time'), { duration: '1h' }),
			'time tracking (add_spent_time)'
		);
		notModelled(await call('GET', issueAt(1, '/time_stats')), 'time tracking (time_stats)');
		notModelled(await call('POST', issueAt(1, '/award_emoji'), { name: 'thumbsup' }), 'award emoji');
		notModelled(await call('POST', issueAt(1, '/subscribe')), 'subscriptions (subscribe)');
		notModelled(await call('GET', issueAt(1, '/discussions')), 'discussions');
		// The time_stats key of an issue stays (its shape is in the fixture) and always says nothing is tracked.
		expect((await call('GET', issueAt(1))).body.time_stats).toEqual({
			time_estimate: 0,
			total_time_spent: 0,
			human_time_estimate: null,
			human_total_time_spent: null,
		});
		// A route that does not exist at all stays the plain 404 of the fixture.
		expect((await call('GET', issueAt(1, '/nothing-here'))).body).toEqual({ error: '404 Not Found' });
	});

	it('a move to the project itself, global search, GraphQL over GET and a note reaction', async () => {
		fake.seedIssue({ title: 'A' });
		const noteId = fake.seedNote(1, 'hello');
		notModelled(
			await call('POST', issueAt(1, '/move'), { to_project_id: fake.projectId }),
			'moving an issue to the project it is already in'
		);
		notModelled(await call('GET', issueAt(1, `/notes/${noteId}/award_emoji`)), 'the award_emoji of a note');
		notModelled(
			await raw('GET', `${fake.baseUrl.replace('/api/v4', '')}/api/graphql?query=%7B__typename%7D`, {
				absolute: true,
			}),
			'GraphQL over GET (the strategy only POSTs)'
		);
		// The global search is reachable only with a token that may use it.
		fake.setPermissions('all');
		notModelled(
			await call('GET', '/search?scope=issues&search=a'),
			'global search (the strategy lists with the project route)'
		);
	});

	it('the parameters and quick actions it would otherwise ignore, order_by other than created_at / updated_at', async () => {
		fake.seedIssue({ title: 'A' });
		notModelled(await call('POST', issues(), { title: 'x', assignee_ids: [1] }), 'the parameter assignee_ids');
		notModelled(await call('PUT', issueAt(1), { milestone_id: 3 }), 'the parameter milestone_id');
		notModelled(
			await call('POST', issues(), { title: 'x', description: 'hello\n/assign @me' }),
			'the quick action /assign'
		);
		notModelled(await call('POST', issueAt(1, '/notes'), { body: '/estimate 1h' }), 'the quick action /estimate');
		notModelled(await call('GET', issues('?order_by=priority')), 'order_by=priority');
		// Nothing was created or changed by the refused requests; text in a code fence is not a command.
		expect(fake.issue(2)).toBeUndefined();
		expect((await call('POST', issueAt(1, '/notes'), { body: '```\n/assign @me\n```' })).status).toBe(201);
		expect((await call('POST', issueAt(1, '/notes'), { body: '/bogus' })).status).toBe(201);
	});

	it('a label priority, and a body without content type that is not JSON', async () => {
		notModelled(await call('POST', labelsPath(), { name: 'p', color: '#FF0000', priority: 1 }), 'label priority');
		// fetch always adds a content-type to a body, so this one goes through node:http.
		const bare = await new Promise<{ status: number; body: any; headers: Headers }>((resolve, reject) => {
			const req = http.request(
				`${fake.baseUrl}${issues()}`,
				{ method: 'POST', headers: { 'private-token': fake.token, 'content-length': '7' } },
				res => {
					const chunks: Buffer[] = [];
					res.on('data', (chunk: Buffer) => chunks.push(chunk));
					res.on('end', () =>
						resolve({
							status: res.statusCode ?? 0,
							body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
							headers: new Headers(res.headers as Record<string, string>),
						})
					);
				}
			);
			req.on('error', reject);
			req.end('title=x');
		});
		notModelled({ ...bare, text: '' }, 'a body without a content-type that is not JSON');
	});
});

describe('fault injection', () => {
	it('failNext honours method, pathPrefix, skip, applyWrite and status', async () => {
		fake.seedIssue({ title: 'A' });
		fake.failNext({ status: 502, method: 'PUT', pathPrefix: '/projects/42/issues', applyWrite: true });
		const failed = await call('PUT', issueAt(1), { title: 'B' });
		expect(failed.status).toBe(502);
		expect(fake.issue(1)!.title).toBe('B');
		fake.failNext({ status: 500, skip: 1 });
		expect((await call('GET', issues())).status).toBe(200);
		expect((await call('GET', issues())).status).toBe(500);
		expect((await call('GET', issues())).status).toBe(200);
		// A pathPrefix written with the id matches whichever form of the project the client used.
		fake.failNext({ status: 503, pathPrefix: '/projects/42/issues' });
		expect((await call('GET', `/projects/${encodeURIComponent(fake.project)}/issues`)).status).toBe(503);
	});

	it('dropNext destroys the connection', async () => {
		fake.dropNext();
		await expect(call('GET', issues())).rejects.toThrow();
		expect((await call('GET', issues())).status).toBe(200);
	});

	it('records requests (normalised path, body, status) and lists the writes', async () => {
		await call('POST', issues(), { title: 'A' });
		await call('GET', `/projects/${encodeURIComponent(fake.project)}/issues?state=opened`);
		expect(fake.writes()).toHaveLength(1);
		expect(fake.writes()[0]).toMatchObject({
			method: 'POST',
			path: '/projects/42/issues',
			status: 201,
			body: { title: 'A' },
		});
		expect(fake.requests[1]).toMatchObject({ method: 'GET', path: '/projects/42/issues', query: 'state=opened' });
		expect(fake.requestsTo('/projects/42/issues')).toHaveLength(2);
	});
});
