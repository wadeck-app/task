// The fake GitLab server driven over plain HTTP: the behaviours the gitlab strategy is tested against. Each is DOCUMENTED (a
// docs.gitlab.com page says so) or ASSUMED (our guess, see the header of fakeGitLab.testkit.ts). Nothing here proves GitLab itself.
import { FakeGitLab } from './fakeGitLab.testkit.js';
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

const issues = (query = ''): string => `/projects/${fake.projectId}/issues${query}`;
const issueAt = (iid: number, tail = ''): string => `${issues()}/${iid}${tail}`;

describe('authentication and project addressing', () => {
	it('answers 401 without a token and with a wrong one (DOCUMENTED)', async () => {
		const missing = await call('GET', issues(), undefined, {});
		expect(missing.status).toBe(401);
		expect(missing.body).toEqual({ message: '401 Unauthorized' });
		const wrong = await call('GET', issues(), undefined, { 'private-token': 'nope' });
		expect(wrong.status).toBe(401);
	});

	it('accepts the Bearer form of the token', async () => {
		const answer = await call('GET', issues(), undefined, { authorization: `Bearer ${fake.token}` });
		expect(answer.status).toBe(200);
	});

	it('addresses the project by numeric id or by URL-encoded path, anything else is 404 (DOCUMENTED)', async () => {
		fake.seedIssue({ title: 'A' });
		expect((await call('GET', `/projects/${encodeURIComponent(fake.project)}/issues`)).body).toHaveLength(1);
		expect((await call('GET', `/projects/${fake.projectId}/issues`)).body).toHaveLength(1);
		const unknown = await call('GET', '/projects/999/issues');
		expect(unknown.status).toBe(404);
		expect(unknown.body).toEqual({ message: '404 Project Not Found' });
	});

	it('answers an unknown route with 404', async () => {
		const answer = await call('GET', '/nothing/here');
		expect(answer.status).toBe(404);
		expect(answer.body).toEqual({ message: '404 Not Found' });
	});
});

describe('issues: reads', () => {
	it('numbers issues by iid from 1 with a distinct global id and opened/closed states', async () => {
		fake.seedIssue({ title: 'A' });
		fake.seedIssue({ title: 'B', state: 'closed' });
		const one = (await call('GET', issueAt(1))).body;
		const two = (await call('GET', issueAt(2))).body;
		expect([one.iid, two.iid]).toEqual([1, 2]);
		expect(one.id).not.toBe(one.iid);
		expect(one.state).toBe('opened');
		expect(two.state).toBe('closed');
		expect(one.project_id).toBe(fake.projectId);
		expect(one.labels).toEqual([]);
		expect(one.issue_type).toBe('issue');
		const missing = await call('GET', issueAt(99));
		expect(missing.status).toBe(404);
		expect(missing.body).toEqual({ message: '404 Not found' });
	});

	it('filters the list by state, labels (all required, None, Any), search, iids[] and issue_type', async () => {
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
		expect(await titles('?search=alpha')).toEqual(['Alpha one', 'Beta']);
		expect(await titles('?iids[]=1&iids[]=3')).toEqual(['Alpha one', 'Gamma']);
		expect(await titles('?issue_type=incident')).toEqual(['Gamma']);
	});

	it('orders by created_at descending by default and honours sort and order_by', async () => {
		fake.seedIssue({ title: 'first' });
		fake.seedIssue({ title: 'second' });
		const defaults = (await call('GET', issues())).body as Array<{ iid: number }>;
		expect(defaults.map(i => i.iid)).toEqual([2, 1]);
		const asc = (await call('GET', issues('?order_by=created_at&sort=asc'))).body as Array<{ iid: number }>;
		expect(asc.map(i => i.iid)).toEqual([1, 2]);
		await call('PUT', issueAt(1), { title: 'first, edited' });
		const byUpdate = (await call('GET', issues('?order_by=updated_at&sort=desc'))).body as Array<{ iid: number }>;
		expect(byUpdate.map(i => i.iid)).toEqual([1, 2]);
	});

	it('paginates with per_page (default 20, max 100), page, absolute Link urls and x-next-page', async () => {
		for (let i = 1; i <= 45; i++) fake.seedIssue({ title: `T${i}` });
		const first = await call('GET', issues('?order_by=created_at&sort=asc'));
		expect(first.body).toHaveLength(20);
		expect(first.headers.get('x-next-page')).toBe('2');
		expect(first.headers.get('x-total')).toBe('45');
		const link = first.headers.get('link')!;
		expect(link).toMatch(
			/<http:\/\/127\.0\.0\.1:\d+\/api\/v4\/projects\/\d+\/issues\?[^>]*page=2[^>]*>; rel="next"/
		);
		expect(link).toContain('rel="first"');
		expect(link).toContain('rel="last"');
		const next = /<([^>]+)>; rel="next"/.exec(link)![1]!;
		const second = await fetch(next, { headers: { 'private-token': fake.token } });
		expect(((await second.json()) as unknown[]).length).toBe(20);
		const last = await call('GET', issues('?per_page=100&page=1'));
		expect(last.body).toHaveLength(45);
		expect(last.headers.get('x-next-page')).toBe('');
		expect(last.headers.get('link')).not.toContain('rel="next"');
		const capped = await call('GET', issues('?per_page=1000'));
		expect(capped.body).toHaveLength(45);
		expect(capped.headers.get('x-per-page')).toBe('100');
	});

	it('answers 403 on every issue call when issues are disabled (DOCUMENTED)', async () => {
		await fake.stop();
		await boot({ issuesEnabled: false });
		const answer = await call('GET', issues());
		expect(answer.status).toBe(403);
		expect(answer.body).toEqual({ message: '403 Forbidden' });
		expect((await call('GET', `/projects/${fake.projectId}`)).body.issues_enabled).toBe(false);
	});
});

describe('issues: create', () => {
	it('requires a title (DOCUMENTED) and bounds the description and the labels', async () => {
		const none = await call('POST', issues(), {});
		expect(none.status).toBe(400);
		expect(none.body).toEqual({ message: '400 (Bad request) "title" not given' });
		const long = await call('POST', issues(), { title: 't', description: 'x'.repeat(1_048_577) });
		expect(long.status).toBe(400);
		expect(long.body.message.description[0]).toContain('too long');
		const many = await call('POST', issues(), {
			title: 't',
			labels: Array.from({ length: 101 }, (_, i) => `l${i}`).join(','),
		});
		expect(many.status).toBe(400);
		expect(many.body.message.labels).toBeDefined();
		const badType = await call('POST', issues(), { title: 't', issue_type: 'epic' });
		expect(badType.status).toBe(400);
	});

	it('creates the issue, auto-creates unknown labels and ignores state and state_event (DOCUMENTED)', async () => {
		const answer = await call('POST', issues(), {
			title: 'New',
			description: 'body',
			labels: 'x,y',
			state: 'closed',
			state_event: 'close',
			issue_type: 'task',
		});
		expect(answer.status).toBe(201);
		expect(answer.body.iid).toBe(1);
		expect(answer.body.state).toBe('opened');
		expect(answer.body.labels).toEqual(['x', 'y']);
		expect(answer.body.issue_type).toBe('task');
		expect(fake.projectLabels().map(l => l.name)).toEqual(['x', 'y']);
	});

	it('records label events for the labels given at creation (ASSUMED)', async () => {
		await call('POST', issues(), { title: 'New', labels: 'x' });
		const events = (await call('GET', issueAt(1, '/resource_label_events'))).body;
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({ action: 'add', label: { name: 'x' }, resource_type: 'Issue' });
	});
});

describe('issues: update', () => {
	it('needs a parameter, closes and reopens with state_event, and keeps a no-op close at 200 (ASSUMED)', async () => {
		fake.seedIssue({ title: 'A' });
		expect((await call('PUT', issueAt(1), {})).status).toBe(400);
		const closed = await call('PUT', issueAt(1), { state_event: 'close' });
		expect(closed.body.state).toBe('closed');
		expect(closed.body.closed_at).not.toBeNull();
		const again = await call('PUT', issueAt(1), { state_event: 'close' });
		expect(again.status).toBe(200);
		expect(again.body.updated_at).toBe(closed.body.updated_at);
		expect((await call('PUT', issueAt(1), { state_event: 'reopen' })).body.state).toBe('opened');
		expect((await call('PUT', issueAt(1), { state_event: 'nope' })).status).toBe(400);
	});

	it('labels replaces the set, "" clears it, add_labels and remove_labels are deltas (DOCUMENTED)', async () => {
		fake.seedIssue({ title: 'A', labels: ['a', 'b'] });
		expect((await call('PUT', issueAt(1), { labels: 'c,d' })).body.labels).toEqual(['c', 'd']);
		expect((await call('PUT', issueAt(1), { add_labels: 'e' })).body.labels).toEqual(['c', 'd', 'e']);
		expect((await call('PUT', issueAt(1), { remove_labels: 'c' })).body.labels).toEqual(['d', 'e']);
		expect((await call('PUT', issueAt(1), { labels: '' })).body.labels).toEqual([]);
		// ASSUMED order when both are sent: labels, then add_labels, then remove_labels.
		const mixed = await call('PUT', issueAt(1), { labels: 'p,q', add_labels: 'r', remove_labels: 'p' });
		expect(mixed.body.labels).toEqual(['q', 'r']);
	});

	it('changes the issue type only to issue, incident or test_case on update (DOCUMENTED)', async () => {
		fake.seedIssue({ title: 'A' });
		expect((await call('PUT', issueAt(1), { issue_type: 'incident' })).body.issue_type).toBe('incident');
		expect((await call('PUT', issueAt(1), { issue_type: 'task' })).status).toBe(400);
	});

	it('moves updated_at on a real change only, with milliseconds', async () => {
		fake.seedIssue({ title: 'A' });
		const before = (await call('GET', issueAt(1))).body.updated_at as string;
		expect(before).toMatch(/\.\d{3}Z$/);
		const same = await call('PUT', issueAt(1), { title: 'A' });
		expect(same.body.updated_at).toBe(before);
		const changed = await call('PUT', issueAt(1), { title: 'B' });
		expect(Date.parse(changed.body.updated_at)).toBeGreaterThan(Date.parse(before));
	});

	it('refuses a blank title', async () => {
		fake.seedIssue({ title: 'A' });
		const answer = await call('PUT', issueAt(1), { title: '' });
		expect(answer.status).toBe(400);
	});

	it('deletes with 204 and the issue is then 404', async () => {
		fake.seedIssue({ title: 'A' });
		expect((await call('DELETE', issueAt(1))).status).toBe(204);
		expect((await call('GET', issueAt(1))).status).toBe(404);
	});

	it('answers 403 to a delete when the user may not (DOCUMENTED)', async () => {
		await fake.stop();
		await boot({ canDelete: false });
		fake.seedIssue({ title: 'A' });
		const answer = await call('DELETE', issueAt(1));
		expect(answer.status).toBe(403);
		expect(answer.body).toEqual({ message: '403 Forbidden' });
		expect(fake.issue(1)).toBeDefined();
	});
});

describe('scoped labels', () => {
	it('on premium a scoped label added through add_labels replaces the one of the same scope (ASSUMED for the API)', async () => {
		await fake.stop();
		await boot({ tier: 'premium' });
		fake.seedIssue({ title: 'A', labels: ['status::todo', 'other'] });
		const swapped = await call('PUT', issueAt(1), { add_labels: 'status::doing' });
		expect(swapped.body.labels).toEqual(['other', 'status::doing']);
		// The scope is everything before the LAST "::".
		fake.seedIssue({ title: 'B', labels: ['meta::k::1'] });
		const meta = await call('PUT', issueAt(2), { add_labels: 'meta::k::2,meta::j::1' });
		expect(meta.body.labels.sort()).toEqual(['meta::j::1', 'meta::k::2']);
		const plain = await call('PUT', issueAt(2), { add_labels: 'a:b,a:c' });
		expect(plain.body.labels).toContain('a:b');
		expect(plain.body.labels).toContain('a:c');
	});

	it('on free there is no exclusivity at all', async () => {
		fake.seedIssue({ title: 'A', labels: ['status::todo'] });
		const both = await call('PUT', issueAt(1), { add_labels: 'status::doing' });
		expect(both.body.labels.sort()).toEqual(['status::doing', 'status::todo']);
	});
});

describe('events and notes', () => {
	it('records a label event and a state event per change, and a system note for each', async () => {
		fake.seedIssue({ title: 'A' });
		await call('PUT', issueAt(1), { labels: 'x', state_event: 'close' });
		await call('PUT', issueAt(1), { labels: '', state_event: 'reopen' });
		const labels = (await call('GET', issueAt(1, '/resource_label_events'))).body;
		expect(labels.map((e: any) => `${e.action}:${e.label.name}`)).toEqual(['add:x', 'remove:x']);
		const states = (await call('GET', issueAt(1, '/resource_state_events'))).body;
		// The initial state is not recorded (DOCUMENTED).
		expect(states.map((e: any) => e.state)).toEqual(['closed', 'opened']);
		// The events of one request share one instant.
		expect(labels[0].created_at).toBe(states[0].created_at);
		expect(fake.systemNotes(1).length).toBe(4);
		const comments = (await call('GET', issueAt(1, '/notes?activity_filter=only_comments'))).body;
		expect(comments).toEqual([]);
		const activity = (await call('GET', issueAt(1, '/notes?activity_filter=only_activity'))).body;
		expect(activity).toHaveLength(4);
		expect(activity.every((n: any) => n.system === true)).toBe(true);
	});

	it('creates, lists, edits and deletes notes (DOCUMENTED fields)', async () => {
		fake.seedIssue({ title: 'A' });
		expect((await call('POST', issueAt(1, '/notes'), {})).status).toBe(400);
		const created = await call('POST', issueAt(1, '/notes'), { body: 'hello  \r\nsecond  ' });
		expect(created.status).toBe(201);
		// Carriage returns and trailing whitespace are stripped on save (DOCUMENTED).
		expect(created.body.body).toBe('hello\nsecond');
		expect(created.body).toMatchObject({ system: false, noteable_iid: 1, noteable_type: 'Issue' });
		expect(created.body.author.username).toBeTypeOf('string');
		const id = created.body.id as number;
		const edited = await call('PUT', issueAt(1, `/notes/${id}`), { body: 'changed' });
		expect(edited.body.body).toBe('changed');
		expect(edited.body.updated_at).not.toBe(edited.body.created_at);
		const listed = (await call('GET', issueAt(1, '/notes?sort=asc&order_by=created_at'))).body;
		expect(listed).toHaveLength(1);
		expect((await call('DELETE', issueAt(1, `/notes/${id}`))).status).toBe(204);
		expect((await call('DELETE', issueAt(1, `/notes/${id}`))).status).toBe(404);
		expect((await call('PUT', issueAt(1, '/notes/987654'), { body: 'x' })).status).toBe(404);
	});

	it('refuses to edit or delete a system note (ASSUMED 403)', async () => {
		fake.seedIssue({ title: 'A' });
		await call('PUT', issueAt(1), { labels: 'x' });
		const system = fake.systemNotes(1)[0]!;
		expect((await call('PUT', issueAt(1, `/notes/${system.id}`), { body: 'x' })).status).toBe(403);
		expect((await call('DELETE', issueAt(1, `/notes/${system.id}`))).status).toBe(403);
	});

	it('runs and strips the quick actions of a note, and counts them (DOCUMENTED for notes)', async () => {
		fake.seedIssue({ title: 'A' });
		const answer = await call('POST', issueAt(1, '/notes'), { body: 'text\n/close\n/label ~"two words" ~plain' });
		expect(answer.body.body).toBe('text');
		expect(fake.quickActionsRun).toBe(2);
		expect(fake.issue(1)!.state).toBe('closed');
		expect(fake.labelsOf(1).sort()).toEqual(['plain', 'two words']);
		// A path is not a quick action.
		const path = await call('POST', issueAt(1, '/notes'), { body: 'see /usr/bin/env' });
		expect(path.body.body).toBe('see /usr/bin/env');
		expect(fake.quickActionsRun).toBe(2);
	});

	it('runs the quick actions of a description too (ASSUMED)', async () => {
		const created = await call('POST', issues(), { title: 'A', description: 'hi\n/close' });
		expect(created.body.description).toBe('hi');
		expect(fake.quickActionsRun).toBe(1);
	});
});

describe('issue links', () => {
	beforeEach(async () => {
		await fake.stop();
		await boot({ tier: 'premium' });
		fake.seedIssue({ title: 'A' });
		fake.seedIssue({ title: 'B' });
		fake.seedIssue({ title: 'C' });
	});

	it('creates a link and lists it from both sides with the type seen from each (ASSUMED for the list)', async () => {
		const created = await call('POST', issueAt(1, '/links'), {
			target_project_id: fake.projectId,
			target_issue_iid: 2,
			link_type: 'blocks',
		});
		expect(created.status).toBe(201);
		expect(created.body.link_type).toBe('blocks');
		expect(created.body.source_issue.iid).toBe(1);
		expect(created.body.target_issue.iid).toBe(2);
		const mine = (await call('GET', issueAt(1, '/links'))).body;
		expect(mine).toHaveLength(1);
		expect(mine[0]).toMatchObject({ iid: 2, link_type: 'blocks' });
		expect(mine[0].issue_link_id).toBeTypeOf('number');
		const theirs = (await call('GET', issueAt(2, '/links'))).body;
		expect(theirs[0]).toMatchObject({ iid: 1, link_type: 'is_blocked_by' });
		const flipped = await call('POST', issueAt(3, '/links'), {
			target_project_id: fake.projectId,
			target_issue_iid: 1,
			link_type: 'is_blocked_by',
		});
		expect(flipped.body.link_type).toBe('is_blocked_by');
		expect(
			(await call('GET', issueAt(1, '/links'))).body.map((l: any) => `${l.iid}:${l.link_type}`).sort()
		).toEqual(['2:blocks', '3:blocks']);
	});

	it('defaults to relates_to, refuses duplicates (ASSUMED 409) and a link to itself', async () => {
		const body = { target_project_id: fake.projectId, target_issue_iid: 2 };
		const first = await call('POST', issueAt(1, '/links'), body);
		expect(first.body.link_type).toBe('relates_to');
		const second = await call('POST', issueAt(2, '/links'), { ...body, target_issue_iid: 1 });
		expect(second.status).toBe(409);
		expect(second.body).toEqual({ message: 'Issue already related' });
		const self = await call('POST', issueAt(1, '/links'), { ...body, target_issue_iid: 1 });
		expect(self.status).toBe(400);
		const missing = await call('POST', issueAt(1, '/links'), { ...body, target_issue_iid: 99 });
		expect(missing.status).toBe(404);
	});

	it('deletes a link by issue_link_id and answers the deleted link', async () => {
		await call('POST', issueAt(1, '/links'), { target_project_id: fake.projectId, target_issue_iid: 2 });
		const id = (await call('GET', issueAt(1, '/links'))).body[0].issue_link_id as number;
		const removed = await call('DELETE', issueAt(1, `/links/${id}`));
		expect(removed.status).toBe(200);
		expect(removed.body.link_type).toBe('relates_to');
		expect((await call('GET', issueAt(2, '/links'))).body).toEqual([]);
		expect((await call('DELETE', issueAt(1, `/links/${id}`))).status).toBe(404);
	});

	it('on free blocks and is_blocked_by are 403, relates_to works (ASSUMED code)', async () => {
		await fake.stop();
		await boot({ tier: 'free' });
		fake.seedIssue({ title: 'A' });
		fake.seedIssue({ title: 'B' });
		const blocked = await call('POST', issueAt(1, '/links'), {
			target_project_id: fake.projectId,
			target_issue_iid: 2,
			link_type: 'blocks',
		});
		expect(blocked.status).toBe(403);
		expect(blocked.body).toEqual({ message: '403 Forbidden' });
		const relates = await call('POST', issueAt(1, '/links'), {
			target_project_id: fake.projectId,
			target_issue_iid: 2,
			link_type: 'relates_to',
		});
		expect(relates.status).toBe(201);
	});
});

describe('project labels', () => {
	it('creates with name and color, refuses a duplicate, and reads by id or url-encoded name', async () => {
		expect((await call('POST', `/projects/${fake.projectId}/labels`, { name: 'x' })).status).toBe(400);
		expect((await call('POST', `/projects/${fake.projectId}/labels`, { name: 'x', color: 'zzz' })).status).toBe(
			400
		);
		const made = await call('POST', `/projects/${fake.projectId}/labels`, {
			name: 'status::doing',
			color: '#FFAABB',
			description: 'd',
		});
		expect(made.status).toBe(201);
		expect(made.body).toMatchObject({ name: 'status::doing', color: '#FFAABB', description: 'd' });
		const dup = await call('POST', `/projects/${fake.projectId}/labels`, {
			name: 'status::doing',
			color: '#000000',
		});
		expect(dup.status).toBe(409);
		expect(dup.body).toEqual({ message: 'Label already exists' });
		const byName = await call('GET', `/projects/${fake.projectId}/labels/${encodeURIComponent('status::doing')}`);
		expect(byName.body.id).toBe(made.body.id);
		const byId = await call('GET', `/projects/${fake.projectId}/labels/${made.body.id}`);
		expect(byId.body.name).toBe('status::doing');
		expect((await call('GET', `/projects/${fake.projectId}/labels/nope`)).status).toBe(404);
	});

	it('lists with search and counts, updates and deletes', async () => {
		fake.seedLabel('alpha');
		fake.seedLabel('beta');
		fake.seedIssue({ title: 'A', labels: ['alpha'] });
		fake.seedIssue({ title: 'B', labels: ['alpha'], state: 'closed' });
		const found = (await call('GET', `/projects/${fake.projectId}/labels?search=alp&with_counts=true`)).body;
		expect(found).toHaveLength(1);
		expect(found[0]).toMatchObject({ name: 'alpha', open_issues_count: 1, closed_issues_count: 1 });
		const renamed = await call('PUT', `/projects/${fake.projectId}/labels/alpha`, {
			new_name: 'omega',
			color: '#112233',
		});
		expect(renamed.body.name).toBe('omega');
		expect((await call('DELETE', `/projects/${fake.projectId}/labels/beta`)).status).toBe(204);
		expect(fake.projectLabels().map(l => l.name)).toEqual(['omega']);
	});
});

describe('instance, project and token', () => {
	it('answers the project with permissions and the namespace with the plan', async () => {
		await fake.stop();
		await boot({ tier: 'ultimate', accessLevel: 30 });
		const project = (await call('GET', `/projects/${fake.projectId}`)).body;
		expect(project).toMatchObject({
			id: fake.projectId,
			path_with_namespace: fake.project,
			archived: false,
			issues_enabled: true,
			issues_access_level: 'enabled',
			permissions: { project_access: { access_level: 30 } },
		});
		const namespace = (await call('GET', `/namespaces/${project.namespace.id}`)).body;
		expect(namespace).toMatchObject({ plan: 'ultimate', full_path: project.namespace.full_path });
		await fake.stop();
		await boot({ tier: 'ultimate', namespacePlan: 'free' });
		const lying = (await call('GET', `/namespaces/${encodeURIComponent(fake.project.split('/')[0]!)}`)).body;
		expect(lying.plan).toBe('free');
	});

	it('answers version, metadata and the token itself', async () => {
		await fake.stop();
		await boot({ instancePlan: 'premium', tokenScopes: ['read_api'], tokenExpiresAt: '2027-01-01' });
		expect((await call('GET', '/version')).body).toMatchObject({ version: expect.any(String) });
		expect((await call('GET', '/metadata')).body).toMatchObject({ enterprise: true, plan: 'premium' });
		const self = (await call('GET', '/personal_access_tokens/self')).body;
		expect(self).toMatchObject({ scopes: ['read_api'], expires_at: '2027-01-01', active: true });
	});
});

describe('behaviours a test switches on', () => {
	it('readOnlyToken: every write is a 403 insufficient_scope (DOCUMENTED shape)', async () => {
		await fake.stop();
		await boot({ readOnlyToken: true });
		fake.seedIssue({ title: 'A' });
		expect((await call('GET', issueAt(1))).status).toBe(200);
		const answer = await call('PUT', issueAt(1), { title: 'B' });
		expect(answer.status).toBe(403);
		expect(answer.headers.get('www-authenticate')).toBe(
			'Bearer realm="Protected by OAuth 2.0", error="insufficient_scope", scope="api read_api"'
		);
		expect(fake.issue(1)!.title).toBe('A');
	});

	it('sends RateLimit headers and answers 429 with Retry-After and a plain text body once the quota is spent', async () => {
		await fake.stop();
		await boot({ rateLimit: { limit: 3, remaining: 2, resetAt: 2_000_000_000 } });
		const first = await call('GET', issues());
		expect(first.headers.get('ratelimit-limit')).toBe('3');
		expect(first.headers.get('ratelimit-remaining')).toBe('1');
		expect(first.headers.get('ratelimit-reset')).toBe('2000000000');
		await call('GET', issues());
		const spent = await call('GET', issues());
		expect(spent.status).toBe(429);
		expect(spent.text).toBe('Retry later');
		expect(spent.headers.get('retry-after')).toBeTruthy();
	});

	it('forceRateLimit answers 429 text with the Retry-After asked, then recovers', async () => {
		fake.forceRateLimit({ retryAfterSeconds: 7 });
		const limited = await call('GET', issues());
		expect(limited.status).toBe(429);
		expect(limited.headers.get('retry-after')).toBe('7');
		expect(limited.text).toBe('Retry later');
		expect((await call('GET', issues())).status).toBe(200);
	});

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

	it('etags: true adds a weak ETag to reads and answers 304 to If-None-Match (UNVERIFIED on GitLab)', async () => {
		await fake.stop();
		await boot({ etags: true });
		fake.seedIssue({ title: 'A' });
		const first = await call('GET', issueAt(1));
		const etag = first.headers.get('etag')!;
		expect(etag).toMatch(/^W\//);
		const again = await call('GET', issueAt(1), undefined, { 'private-token': fake.token, 'if-none-match': etag });
		expect(again.status).toBe(304);
		await call('PUT', issueAt(1), { title: 'B' });
		const changed = await call('GET', issueAt(1), undefined, {
			'private-token': fake.token,
			'if-none-match': etag,
		});
		expect(changed.status).toBe(200);
	});

	it('without etags there is no ETag header', async () => {
		fake.seedIssue({ title: 'A' });
		expect((await call('GET', issueAt(1))).headers.get('etag')).toBeNull();
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

	it('seedNote, seedLink and read-back accessors', async () => {
		await fake.stop();
		await boot({ tier: 'premium' });
		fake.seedIssue({ title: 'A' });
		fake.seedIssue({ title: 'B' });
		const id = fake.seedNote(1, 'a comment', 'ann');
		expect(fake.notes(1).map(n => [n.id, n.author, n.body])).toEqual([[id, 'ann', 'a comment']]);
		fake.seedLink(1, 2, 'blocks');
		expect(fake.links(2)).toEqual([{ iid: 1, type: 'is_blocked_by' }]);
		expect(fake.links(1)).toEqual([{ iid: 2, type: 'blocks' }]);
	});
});
