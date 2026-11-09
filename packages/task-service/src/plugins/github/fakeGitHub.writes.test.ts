// The write side of the fake GitHub server, driven over plain HTTP: every behaviour listed here was measured on the real API
// (design 2.2.1, the stage 2 live run) and is what the strategy's write path is tested against.
import { FakeGitHub } from './fakeGitHub.testkit.js';

let fake: FakeGitHub;

beforeEach(async () => {
	fake = await FakeGitHub.start({ repo: 'acme/shop' });
});

afterEach(async () => {
	await fake.stop();
});

interface Answer {
	status: number;
	body: any;
	headers: Headers;
}

async function call(
	method: string,
	path: string,
	body?: unknown,
	headers: Record<string, string> = {},
	token: string = fake.token
): Promise<Answer> {
	const response = await fetch(`${fake.baseUrl}${path}`, {
		method,
		headers: {
			authorization: `Bearer ${token}`,
			accept: 'application/vnd.github+json',
			...(body === undefined ? {} : { 'content-type': 'application/json' }),
			...headers,
		},
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
	const text = await response.text();
	return {
		status: response.status,
		body: text === '' ? undefined : (JSON.parse(text) as unknown),
		headers: response.headers,
	};
}

const R = '/repos/acme/shop';

describe('create an issue', () => {
	it('answers 201 with the number, the id and the labels as objects; missing labels are created grey', async () => {
		const answer = await call('POST', `${R}/issues`, {
			title: 'First',
			body: 'text',
			labels: ['bug', 'status:todo'],
		});

		expect(answer.status).toBe(201);
		expect(answer.body).toMatchObject({
			number: 1,
			title: 'First',
			body: 'text',
			state: 'open',
			state_reason: null,
		});
		expect(answer.body.labels.map((label: { name: string }) => label.name)).toEqual(['bug', 'status:todo']);
		expect(typeof answer.body.id).toBe('number');
		expect(fake.repoLabels.get('bug')).toBe('ededed');
	});

	it('ignores state and state_reason silently: 201, still open (measured on the real API)', async () => {
		const answer = await call('POST', `${R}/issues`, {
			title: 'Closed?',
			state: 'closed',
			state_reason: 'not_planned',
		});

		expect(answer.status).toBe(201);
		expect(answer.body.state).toBe('open');
		expect(answer.body.state_reason).toBeNull();
	});

	it('refuses a title that is missing with 422', async () => {
		const answer = await call('POST', `${R}/issues`, { body: 'no title' });

		expect(answer.status).toBe(422);
		expect(answer.body.errors[0]).toMatchObject({ resource: 'Issue', field: 'title', code: 'missing_field' });
	});

	it('refuses a label of 51 characters with the field error (no message) and creates nothing', async () => {
		const answer = await call('POST', `${R}/issues`, { title: 'Long', labels: ['x'.repeat(51)] });

		expect(answer.status).toBe(422);
		expect(answer.body.errors[0]).toEqual({ resource: 'Label', field: 'name', code: 'invalid' });
		expect(fake.issues.size).toBe(0);
	});

	it('refuses a body over 65536 characters', async () => {
		const answer = await call('POST', `${R}/issues`, { title: 'Big', body: 'x'.repeat(65537) });

		expect(answer.status).toBe(422);
		expect(JSON.stringify(answer.body)).toContain('body is too long (maximum is 65536 characters)');
	});

	it('401 without a good token, 404 for another repository', async () => {
		expect((await call('POST', `${R}/issues`, { title: 'x' }, {}, 'wrong')).status).toBe(401);
		expect((await call('POST', '/repos/other/repo/issues', { title: 'x' })).status).toBe(404);
	});
});

describe('the issue list lags behind a creation (measured: about 4 s on the real API; updates show at once)', () => {
	it('an issue created over the API is missing from the list for listLagRequests list requests, but readable by number', async () => {
		const lagging = await FakeGitHub.start({ repo: 'acme/shop', listLagRequests: 2 });
		try {
			lagging.addIssue({ title: 'Old' });
			const get = async (path: string) =>
				(await (
					await fetch(`${lagging.baseUrl}${path}`, { headers: { authorization: `Bearer ${lagging.token}` } })
				).json()) as Array<{ number: number }> & { number: number };
			const made = await fetch(`${lagging.baseUrl}${R}/issues`, {
				method: 'POST',
				headers: { authorization: `Bearer ${lagging.token}`, 'content-type': 'application/json' },
				body: JSON.stringify({ title: 'New' }),
			});
			expect(made.status).toBe(201);

			expect((await get(`${R}/issues/2`)).number).toBe(2);
			const first = await get(`${R}/issues?state=all`);
			const second = await get(`${R}/issues?state=all`);
			const third = await get(`${R}/issues?state=all`);

			expect([first, second, third].map(list => list.map(issue => issue.number).sort())).toEqual([
				[1],
				[1],
				[1, 2],
			]);
		} finally {
			await lagging.stop();
		}
	});

	it('an update shows in the list at once', async () => {
		const lagging = await FakeGitHub.start({ repo: 'acme/shop', listLagRequests: 5 });
		try {
			lagging.addIssue({ title: 'Old' });
			await fetch(`${lagging.baseUrl}${R}/issues/1`, {
				method: 'PATCH',
				headers: { authorization: `Bearer ${lagging.token}`, 'content-type': 'application/json' },
				body: JSON.stringify({ title: 'Renamed' }),
			});

			const list = (await (
				await fetch(`${lagging.baseUrl}${R}/issues?state=all`, {
					headers: { authorization: `Bearer ${lagging.token}` },
				})
			).json()) as Array<{ title: string }>;

			expect(list.map(issue => issue.title)).toEqual(['Renamed']);
		} finally {
			await lagging.stop();
		}
	});
});

describe('edit an issue (PATCH)', () => {
	beforeEach(() => {
		fake.addIssue({ title: 'One', body: 'body' });
	});

	it('changes title and body and bumps updated_at; the same title does not', async () => {
		const before = (await call('GET', `${R}/issues/1`)).body.updated_at as string;
		const same = await call('PATCH', `${R}/issues/1`, { title: 'One' });
		expect(same.body.updated_at).toBe(before);

		const renamed = await call('PATCH', `${R}/issues/1`, { title: 'Renamed', body: 'new body' });
		expect(renamed.status).toBe(200);
		expect(renamed.body).toMatchObject({ title: 'Renamed', body: 'new body' });
		expect(renamed.body.updated_at).not.toBe(before);
	});

	it('state closed alone is completed, open alone is reopened', async () => {
		const closed = await call('PATCH', `${R}/issues/1`, { state: 'closed' });
		expect(closed.body).toMatchObject({ state: 'closed', state_reason: 'completed' });
		expect(closed.body.closed_at).not.toBeNull();

		const reopened = await call('PATCH', `${R}/issues/1`, { state: 'open' });
		expect(reopened.body).toMatchObject({ state: 'open', state_reason: 'reopened' });
	});

	it('accepts the close reasons and refuses an unknown one with the measured message', async () => {
		const notPlanned = await call('PATCH', `${R}/issues/1`, { state: 'closed', state_reason: 'not_planned' });
		expect(notPlanned.body.state_reason).toBe('not_planned');

		const bad = await call('PATCH', `${R}/issues/1`, { state: 'closed', state_reason: 'bogus' });
		expect(bad.status).toBe(422);
		expect(JSON.stringify(bad.body)).toContain('Please specify a valid state reason.');
	});

	it('a state_reason alone on a closed issue is accepted and changes nothing; with state: closed it changes the reason (measured)', async () => {
		await call('PATCH', `${R}/issues/1`, { state: 'closed', state_reason: 'completed' });

		const alone = await call('PATCH', `${R}/issues/1`, { state_reason: 'not_planned' });
		expect(alone.status).toBe(200);
		expect(alone.body.state_reason).toBe('completed');

		const withState = await call('PATCH', `${R}/issues/1`, { state: 'closed', state_reason: 'not_planned' });
		expect(withState.body).toMatchObject({ state: 'closed', state_reason: 'not_planned' });
	});

	it('duplicate_issue_id is accepted with the duplicate reason and is not readable afterwards', async () => {
		fake.addIssue({ title: 'Original' });
		const target = (await call('GET', `${R}/issues/2`)).body.id as number;

		const answer = await call('PATCH', `${R}/issues/1`, {
			state: 'closed',
			state_reason: 'duplicate',
			duplicate_issue_id: target,
		});

		expect(answer.status).toBe(200);
		expect(answer.body.state_reason).toBe('duplicate');
		expect(JSON.stringify(answer.body)).not.toContain('duplicate_of');
	});

	it('replaces the label set when labels is given, with unlabeled and labeled events', async () => {
		await call('PATCH', `${R}/issues/1`, { labels: ['a', 'b'] });

		const answer = await call('PATCH', `${R}/issues/1`, { labels: ['b', 'c'] });

		expect(answer.body.labels.map((label: { name: string }) => label.name)).toEqual(['b', 'c']);
		const events = (await call('GET', `${R}/issues/1/timeline`)).body.map(
			(event: { event: string }) => event.event
		);
		expect(events).toEqual(expect.arrayContaining(['labeled', 'unlabeled']));
	});

	it('sets and clears the native issue type', async () => {
		const set = await call('PATCH', `${R}/issues/1`, { type: 'Bug' });
		expect(set.body.type).toMatchObject({ name: 'Bug' });

		const cleared = await call('PATCH', `${R}/issues/1`, { type: null });
		expect(cleared.body.type).toBeNull();
	});

	it('the events of one PATCH (labels and state) all carry the same instant (measured on the real API)', async () => {
		await call('PATCH', `${R}/issues/1`, { labels: ['a'] });

		await call('PATCH', `${R}/issues/1`, { labels: ['b'], state: 'closed', state_reason: 'not_planned' });

		const events = (await call('GET', `${R}/issues/1/timeline`)).body as Array<{
			event: string;
			created_at: string;
		}>;
		const last = events.slice(-3);
		expect(last.map(event => event.event).sort()).toEqual(['closed', 'labeled', 'unlabeled']);
		expect(new Set(last.map(event => event.created_at)).size).toBe(1);
	});

	it('refuses conditional request headers on a write: If-Match and If-Unmodified-Since are 400, If-None-Match: * is 412', async () => {
		const match = await call('PATCH', `${R}/issues/1`, { title: 'x' }, { 'if-match': '"abc"' });
		expect(match.status).toBe(400);
		expect(match.body.message).toBe(
			'Conditional request headers are not allowed in unsafe requests unless supported by the endpoint'
		);

		const since = await call(
			'PATCH',
			`${R}/issues/1`,
			{ title: 'x' },
			{ 'if-unmodified-since': 'Sat, 08 Nov 2026 10:00:00 GMT' }
		);
		expect(since.status).toBe(400);

		const none = await call('PATCH', `${R}/issues/1`, { title: 'x' }, { 'if-none-match': '*' });
		expect(none.status).toBe(412);
		expect(none.body).toBeUndefined();
	});

	it('404 for an unknown issue, 410 for a deleted one', async () => {
		expect((await call('PATCH', `${R}/issues/99`, { title: 'x' })).status).toBe(404);
		fake.deleteIssue(1);
		expect((await call('PATCH', `${R}/issues/1`, { title: 'x' })).status).toBe(410);
	});
});

describe('labels on an issue', () => {
	beforeEach(() => {
		fake.addIssue({ title: 'One' });
	});

	it('POST adds labels and answers the full label list; adding one already there changes nothing', async () => {
		const first = await call('POST', `${R}/issues/1/labels`, { labels: ['a'] });
		expect(first.status).toBe(200);
		const second = await call('POST', `${R}/issues/1/labels`, { labels: ['a', 'b'] });
		expect(second.body.map((label: { name: string }) => label.name)).toEqual(['a', 'b']);
	});

	it('refuses the 101st label with the measured message', async () => {
		for (let batch = 0; batch < 10; batch++) {
			const labels = Array.from({ length: 10 }, (_, i) => `l${batch}-${i}`);
			expect((await call('POST', `${R}/issues/1/labels`, { labels })).status).toBe(200);
		}

		const over = await call('POST', `${R}/issues/1/labels`, { labels: ['one-more'] });

		expect(over.status).toBe(422);
		expect(JSON.stringify(over.body)).toContain('Issues cannot have more than 100 labels');
	});

	it('answers 502 to one POST that creates 100 new labels and applies nothing; 50 new labels give 502 with all applied', async () => {
		const hundred = await call('POST', `${R}/issues/1/labels`, {
			labels: Array.from({ length: 100 }, (_, i) => `h${i}`),
		});
		expect(hundred.status).toBe(502);
		expect(fake.issues.get(1)!.labels).toEqual([]);

		const fifty = await call('POST', `${R}/issues/1/labels`, {
			labels: Array.from({ length: 50 }, (_, i) => `f${i}`),
		});
		expect(fifty.status).toBe(502);
		expect(fake.issues.get(1)!.labels).toHaveLength(50);
	});

	it('ten new labels in one POST are fine', async () => {
		const answer = await call('POST', `${R}/issues/1/labels`, {
			labels: Array.from({ length: 10 }, (_, i) => `t${i}`),
		});

		expect(answer.status).toBe(200);
		expect(answer.body).toHaveLength(10);
	});

	it('DELETE removes one label and answers the rest; a label the issue does not have is 404', async () => {
		await call('POST', `${R}/issues/1/labels`, { labels: ['a', 'b:c'] });

		const removed = await call('DELETE', `${R}/issues/1/labels/${encodeURIComponent('b:c')}`);
		expect(removed.status).toBe(200);
		expect(removed.body.map((label: { name: string }) => label.name)).toEqual(['a']);

		expect((await call('DELETE', `${R}/issues/1/labels/gone`)).status).toBe(404);
	});

	it('PUT replaces the set', async () => {
		await call('POST', `${R}/issues/1/labels`, { labels: ['a'] });

		const answer = await call('PUT', `${R}/issues/1/labels`, { labels: ['x', 'y'] });

		expect(answer.status).toBe(200);
		expect(answer.body.map((label: { name: string }) => label.name)).toEqual(['x', 'y']);
	});

	it('a label change bumps updated_at', async () => {
		const before = (await call('GET', `${R}/issues/1`)).body.updated_at as string;

		await call('POST', `${R}/issues/1/labels`, { labels: ['a'] });

		expect((await call('GET', `${R}/issues/1`)).body.updated_at).not.toBe(before);
	});
});

describe('repository labels', () => {
	it('creates a label with colour and description; the same name in another case is already_exists', async () => {
		const created = await call('POST', `${R}/labels`, {
			name: 'Status:Todo',
			color: 'ff0000',
			description: 'task status',
		});
		expect(created.status).toBe(201);
		expect(created.body).toMatchObject({ name: 'Status:Todo', color: 'ff0000', description: 'task status' });

		const again = await call('POST', `${R}/labels`, { name: 'status:todo', color: 'ff0000' });
		expect(again.status).toBe(422);
		expect(again.body.errors[0]).toMatchObject({ resource: 'Label', code: 'already_exists', field: 'name' });
	});

	it('refuses a name over 50 characters, a comma, a bad colour and a description over 100 characters', async () => {
		const long = await call('POST', `${R}/labels`, { name: 'x'.repeat(51), color: 'ededed' });
		expect(long.status).toBe(422);
		expect(JSON.stringify(long.body)).toContain('name is too long (maximum is 50 characters)');

		expect((await call('POST', `${R}/labels`, { name: 'a,b', color: 'ededed' })).status).toBe(422);
		const color = await call('POST', `${R}/labels`, { name: 'c', color: '#ff0000' });
		expect(color.status).toBe(422);
		expect(color.body.errors[0]).toMatchObject({ code: 'invalid', field: 'color' });
		const description = await call('POST', `${R}/labels`, {
			name: 'd',
			color: 'ededed',
			description: 'x'.repeat(101),
		});
		expect(description.status).toBe(422);
		expect(JSON.stringify(description.body)).toContain('maximum is 100 characters');
	});

	it('GET one label is 200 or 404, DELETE is 204 or 404', async () => {
		await call('POST', `${R}/labels`, { name: 'a:b', color: 'ededed' });

		expect((await call('GET', `${R}/labels/${encodeURIComponent('a:b')}`)).status).toBe(200);
		expect((await call('GET', `${R}/labels/none`)).status).toBe(404);
		expect((await call('DELETE', `${R}/labels/${encodeURIComponent('a:b')}`)).status).toBe(204);
		expect((await call('DELETE', `${R}/labels/${encodeURIComponent('a:b')}`)).status).toBe(404);
	});
});

describe('comments', () => {
	beforeEach(() => {
		fake.addIssue({ title: 'One' });
	});

	it('creates (201), edits (200, updated_at later) and deletes (204) a comment; the issue counts them', async () => {
		const created = await call('POST', `${R}/issues/1/comments`, { body: 'first' });
		expect(created.status).toBe(201);
		expect(created.body).toMatchObject({ body: 'first', user: { login: 'fake-user' } });

		const edited = await call('PATCH', `${R}/issues/comments/${created.body.id}`, { body: 'edited' });
		expect(edited.status).toBe(200);
		expect(edited.body.updated_at > created.body.created_at).toBe(true);
		expect((await call('GET', `${R}/issues/1`)).body.comments).toBe(1);

		expect((await call('DELETE', `${R}/issues/comments/${created.body.id}`)).status).toBe(204);
		expect((await call('GET', `${R}/issues/1`)).body.comments).toBe(0);
		expect((await call('DELETE', `${R}/issues/comments/${created.body.id}`)).status).toBe(404);
	});

	it('a comment bumps the updated_at of the issue and refuses a body over 65536 characters', async () => {
		const before = (await call('GET', `${R}/issues/1`)).body.updated_at as string;

		await call('POST', `${R}/issues/1/comments`, { body: 'note' });
		expect((await call('GET', `${R}/issues/1`)).body.updated_at).not.toBe(before);

		const big = await call('POST', `${R}/issues/1/comments`, { body: 'x'.repeat(65537) });
		expect(big.status).toBe(422);
		expect(JSON.stringify(big.body)).toContain('Body is too long (maximum is 65536 characters)');
	});
});

describe('sub-issues', () => {
	beforeEach(() => {
		for (const title of ['Parent', 'Child', 'Other']) fake.addIssue({ title });
	});

	const idOf = (number: number): number => fake.issues.get(number)!.id;

	it('adds a sub-issue by its numeric id (201, the body is the PARENT) and rejects the issue number with 404', async () => {
		const byNumber = await call('POST', `${R}/issues/1/sub_issues`, { sub_issue_id: 2 });
		expect(byNumber.status).toBe(404);

		const added = await call('POST', `${R}/issues/1/sub_issues`, { sub_issue_id: idOf(2) });
		expect(added.status).toBe(201);
		expect(added.body.number).toBe(1);
		expect((await call('GET', `${R}/issues/2`)).body.parent_issue_url).toContain('/issues/1');
	});

	it('a second parent or a duplicate is 422 with the measured message; replace_parent moves it', async () => {
		await call('POST', `${R}/issues/1/sub_issues`, { sub_issue_id: idOf(2) });

		const duplicate = await call('POST', `${R}/issues/1/sub_issues`, { sub_issue_id: idOf(2) });
		expect(duplicate.status).toBe(422);
		expect(duplicate.body.message).toBe(
			'An error occurred while adding the sub-issue to the parent issue. Issue may not contain duplicate sub-issues and Sub issue may only have one parent'
		);
		const second = await call('POST', `${R}/issues/3/sub_issues`, { sub_issue_id: idOf(2) });
		expect(second.status).toBe(422);
		expect(second.body.message).toBe(
			'An error occurred while adding the sub-issue to the parent issue. Sub issue may only have one parent'
		);

		const moved = await call('POST', `${R}/issues/3/sub_issues`, { sub_issue_id: idOf(2), replace_parent: true });
		expect(moved.status).toBe(201);
		expect(fake.issues.get(2)!.parent).toBe(3);
	});

	it('a cycle is 422', async () => {
		await call('POST', `${R}/issues/1/sub_issues`, { sub_issue_id: idOf(2) });

		const cycle = await call('POST', `${R}/issues/2/sub_issues`, { sub_issue_id: idOf(1) });

		expect(cycle.status).toBe(422);
		expect(JSON.stringify(cycle.body)).toContain('Sub issue may not create a circular dependency');
	});

	it('the 8th level is 422 "more than 7 layers"', async () => {
		let previous = 1;
		for (let level = 2; level <= 8; level++) {
			const number = fake.addIssue({ title: `Level ${level}` });
			const answer = await call('POST', `${R}/issues/${previous}/sub_issues`, { sub_issue_id: idOf(number) });
			expect(answer.status).toBe(201);
			previous = number;
		}
		const deeper = fake.addIssue({ title: 'Level 9' });

		const refused = await call('POST', `${R}/issues/${previous}/sub_issues`, { sub_issue_id: idOf(deeper) });

		expect(refused.status).toBe(422);
		expect(JSON.stringify(refused.body)).toContain("You can't add more than 7 layers of sub-issues");
	});

	it('DELETE with a body removes the sub-issue (200)', async () => {
		await call('POST', `${R}/issues/1/sub_issues`, { sub_issue_id: idOf(2) });

		const removed = await call('DELETE', `${R}/issues/1/sub_issue`, { sub_issue_id: idOf(2) });

		expect(removed.status).toBe(200);
		expect(fake.issues.get(2)!.parent).toBeNull();
	});
});

describe('dependencies', () => {
	beforeEach(() => {
		for (const title of ['A', 'B', 'C']) fake.addIssue({ title });
	});

	const idOf = (number: number): number => fake.issues.get(number)!.id;

	it('adds a blocked_by (201) by numeric id and removes it (200); both sides see it', async () => {
		const added = await call('POST', `${R}/issues/1/dependencies/blocked_by`, { issue_id: idOf(2) });
		expect(added.status).toBe(201);
		expect(fake.issues.get(1)!.blockedBy).toEqual([2]);
		expect(
			(await call('GET', `${R}/issues/2/dependencies/blocking`)).body.map((i: { number: number }) => i.number)
		).toEqual([1]);

		const removed = await call('DELETE', `${R}/issues/1/dependencies/blocked_by/${idOf(2)}`);
		expect(removed.status).toBe(200);
		expect(fake.issues.get(1)!.blockedBy).toEqual([]);
	});

	it('refuses a duplicate, the issue itself and a cycle (direct and transitive) with 422', async () => {
		await call('POST', `${R}/issues/1/dependencies/blocked_by`, { issue_id: idOf(2) });
		await call('POST', `${R}/issues/2/dependencies/blocked_by`, { issue_id: idOf(3) });

		const duplicate = await call('POST', `${R}/issues/1/dependencies/blocked_by`, { issue_id: idOf(2) });
		expect(duplicate.status).toBe(422);
		expect(JSON.stringify(duplicate.body)).toContain('Target issue has already been taken');

		const itself = await call('POST', `${R}/issues/1/dependencies/blocked_by`, { issue_id: idOf(1) });
		expect(itself.status).toBe(422);
		expect(JSON.stringify(itself.body)).toContain('Target issue cannot be the same as the source issue');

		const direct = await call('POST', `${R}/issues/2/dependencies/blocked_by`, { issue_id: idOf(1) });
		expect(direct.status).toBe(422);
		expect(JSON.stringify(direct.body)).toContain('this dependency would create a cycle');
		const transitive = await call('POST', `${R}/issues/3/dependencies/blocked_by`, { issue_id: idOf(1) });
		expect(transitive.status).toBe(422);
	});

	it('removing a dependency that is not there is a 200 (measured: it is idempotent), an unknown issue id is 404', async () => {
		expect((await call('DELETE', `${R}/issues/1/dependencies/blocked_by/${idOf(2)}`)).status).toBe(200);
		expect((await call('DELETE', `${R}/issues/1/dependencies/blocked_by/123`)).status).toBe(404);
	});

	it('the errors are one message, like the real ones (no errors array)', async () => {
		await call('POST', `${R}/issues/1/dependencies/blocked_by`, { issue_id: idOf(2) });

		const duplicate = await call('POST', `${R}/issues/1/dependencies/blocked_by`, { issue_id: idOf(2) });

		expect(duplicate.body.errors).toBeUndefined();
		expect(duplicate.body.message).toBe(
			'An error occurred while adding the blocking issue to the issue. Validation failed: Target issue has already been taken'
		);
	});
});

describe('GraphQL deleteIssue', () => {
	const mutation = (nodeId: string): { query: string; variables: object } => ({
		query: 'mutation($id: ID!) { deleteIssue(input: {issueId: $id}) { clientMutationId } }',
		variables: { id: nodeId },
	});

	it('deletes the issue for an admin (GET then answers 410) and detaches its relations', async () => {
		fake.addIssue({ title: 'Parent' });
		fake.addIssue({ title: 'Child' });
		fake.setParent(2, 1);

		const answer = await call('POST', '/graphql', mutation(`I_${fake.issues.get(1)!.id}`));

		expect(answer.status).toBe(200);
		expect(answer.body.errors).toBeUndefined();
		expect((await call('GET', `${R}/issues/1`)).status).toBe(410);
		expect(fake.issues.get(2)!.parent).toBeNull();
	});

	it('answers a FORBIDDEN error in the body (HTTP 200) when the token is not admin of the repository', async () => {
		const restricted = await FakeGitHub.start({ repo: 'acme/shop', admin: false });
		try {
			restricted.addIssue({ title: 'Mine' });
			const response = await fetch(`${restricted.baseUrl}/graphql`, {
				method: 'POST',
				headers: { authorization: `Bearer ${restricted.token}`, 'content-type': 'application/json' },
				body: JSON.stringify(mutation(`I_${restricted.issues.get(1)!.id}`)),
			});
			const body = (await response.json()) as { errors: Array<{ type: string; message: string }> };

			expect(response.status).toBe(200);
			expect(body.errors[0]!.type).toBe('FORBIDDEN');
			expect(restricted.issues.get(1)!.deleted).toBe(false);
		} finally {
			await restricted.stop();
		}
	});
});

describe('tokens, limits and faults on writes', () => {
	it('a token without Issues write gets 403 with x-accepted-github-permissions', async () => {
		const readOnly = await FakeGitHub.start({ repo: 'acme/shop', readOnlyToken: true });
		try {
			const response = await fetch(`${readOnly.baseUrl}/repos/acme/shop/issues`, {
				method: 'POST',
				headers: { authorization: `Bearer ${readOnly.token}`, 'content-type': 'application/json' },
				body: JSON.stringify({ title: 'x' }),
			});

			expect(response.status).toBe(403);
			expect(response.headers.get('x-accepted-github-permissions')).toBe('issues=write');
		} finally {
			await readOnly.stop();
		}
	});

	it('a write spends the core quota like a read', async () => {
		const before = fake.coreRemaining;

		await call('POST', `${R}/issues`, { title: 'x' });

		expect(fake.coreRemaining).toBe(before - 1);
	});

	it('records writes with the instant they arrived, so a test can check the spacing', async () => {
		await call('POST', `${R}/issues`, { title: 'x' });

		const [write] = fake.writes();
		expect(write).toMatchObject({ method: 'POST', path: `${R}/issues`, status: 201 });
		expect(typeof write!.at).toBe('number');
	});

	it('invalid JSON is 400', async () => {
		const response = await fetch(`${fake.baseUrl}${R}/issues`, {
			method: 'POST',
			headers: { authorization: `Bearer ${fake.token}`, 'content-type': 'application/json' },
			body: '{nope',
		});

		expect(response.status).toBe(400);
	});
});

describe('updated_at', () => {
	it('has a resolution of one second when the clock steps by zero: two changes inside one second share it, the ETag still differs', async () => {
		const flat = await FakeGitHub.start({ repo: 'acme/shop', clockStepMs: 0 });
		try {
			flat.addIssue({ title: 'One' });
			const url = `${flat.baseUrl}${R}/issues/1`;
			const headers = { authorization: `Bearer ${flat.token}`, 'content-type': 'application/json' };
			const first = await fetch(url, { headers });
			await fetch(`${url}/labels`, { method: 'POST', headers, body: JSON.stringify({ labels: ['a'] }) });
			const second = await fetch(url, { headers });

			expect(((await first.json()) as { updated_at: string }).updated_at).toBe(
				((await second.json()) as { updated_at: string }).updated_at
			);
			expect(first.headers.get('etag')).not.toBe(second.headers.get('etag'));
		} finally {
			await flat.stop();
		}
	});
});
