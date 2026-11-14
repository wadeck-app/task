// The organization issue fields of the fake GitHub server, driven over plain HTTP. What was MEASURED live (2026-11-14, the probe
// scripts/live-github-fields-probe.mjs, API version 2026-03-10): GET, PUT and DELETE of the values work with Issues read/write, the
// issue and the issue list carry `issue_field_values`, the definitions are a 403 naming `issue_fields=read`. The POST route, the
// shape of the definitions on REST and the status of an unknown option were NOT observed: the fake answers "not modelled" (501) for
// what it does not know. The ledger (fakeGitHubLedger.testkit.ts) says which line is which.
import { FakeGitHub } from './fakeGitHub.testkit.js';

let fake: FakeGitHub;

afterEach(async () => {
	await fake.stop();
});

interface Answer {
	status: number;
	body: any;
	headers: Headers;
}

async function call(method: string, path: string, body?: unknown, version = '2026-03-10'): Promise<Answer> {
	const response = await fetch(`${fake.baseUrl}${path}`, {
		method,
		headers: {
			authorization: `Bearer ${fake.token}`,
			accept: 'application/vnd.github+json',
			'x-github-api-version': version,
			...(body === undefined ? {} : { 'content-type': 'application/json' }),
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
const FIELDS = [
	{ id: 501, name: 'Priority', options: ['Urgent', 'High', 'Medium', 'Low'] },
	{ id: 502, name: 'Area', options: ['Backend', 'Frontend'] },
];

describe('a repository whose organization has no issue fields', () => {
	it('serves issues without issue_field_values', async () => {
		fake = await FakeGitHub.start({ repo: 'acme/shop' });
		const number = fake.addIssue({ title: 'plain' });

		expect((await call('GET', `${R}/issues/${number}`)).body).not.toHaveProperty('issue_field_values');
	});
});

describe('issue field values', () => {
	beforeEach(async () => {
		fake = await FakeGitHub.start({ repo: 'acme/shop', issueFields: FIELDS });
	});

	it('an issue and the issue list carry issue_field_values, empty until a value is set', async () => {
		const number = fake.addIssue({ title: 'a' });

		expect((await call('GET', `${R}/issues/${number}`)).body.issue_field_values).toEqual([]);
		expect((await call('GET', `${R}/issues?state=all`)).body[0].issue_field_values).toEqual([]);
		expect((await call('GET', `${R}/issues/${number}/issue-field-values`)).body).toEqual([]);
	});

	it('PUT sets a single-select value by option name and answers the values with the chosen option', async () => {
		const number = fake.addIssue({ title: 'a' });

		const put = await call('PUT', `${R}/issues/${number}/issue-field-values`, {
			issue_field_values: [{ field_id: 501, value: 'High' }],
		});

		expect(put.status).toBe(200);
		expect(put.body).toEqual([
			{
				issue_field_id: 501,
				node_id: expect.any(String),
				data_type: 'single_select',
				issue_field_name: 'Priority',
				value: 501002,
				single_select_option: { id: 501002, name: 'High', color: 'gray' },
			},
		]);
		expect((await call('GET', `${R}/issues/${number}`)).body.issue_field_values).toEqual(put.body);
		expect((await call('GET', `${R}/issues`)).body[0].issue_field_values).toEqual(put.body);
		expect((await call('GET', `${R}/issues/${number}/issue-field-values`)).body).toEqual(put.body);
	});

	it('PUT replaces ALL the values of the issue (measured); POST adds or updates one and keeps the others (not probed)', async () => {
		const number = fake.addIssue({ title: 'a' });
		const path = `${R}/issues/${number}/issue-field-values`;
		await call('PUT', path, {
			issue_field_values: [
				{ field_id: 501, value: 'High' },
				{ field_id: 502, value: 'Backend' },
			],
		});

		await call('POST', path, { issue_field_values: [{ field_id: 501, value: 'Low' }] });
		expect(fake.fieldValuesOf(number)).toEqual({ Priority: 'Low', Area: 'Backend' });

		await call('PUT', path, { issue_field_values: [{ field_id: 501, value: 'Urgent' }] });
		expect(fake.fieldValuesOf(number)).toEqual({ Priority: 'Urgent' });
	});

	it('DELETE of one field value answers 204 and leaves the others', async () => {
		const number = fake.addIssue({ title: 'a' });
		const path = `${R}/issues/${number}/issue-field-values`;
		await call('PUT', path, {
			issue_field_values: [
				{ field_id: 501, value: 'High' },
				{ field_id: 502, value: 'Backend' },
			],
		});

		const deleted = await call('DELETE', `${path}/501`);

		expect(deleted.status).toBe(204);
		expect(fake.fieldValuesOf(number)).toEqual({ Area: 'Backend' });
	});

	it('what was not observed on the real API answers 501 "mock: not modelled", never an invented behaviour', async () => {
		const number = fake.addIssue({ title: 'a' });
		const path = `${R}/issues/${number}/issue-field-values`;

		for (const answer of [
			await call('PUT', path, { issue_field_values: [{ field_id: 501, value: 'Blocker' }] }),
			await call('PUT', path, { issue_field_values: [{ field_id: 999, value: 'High' }] }),
			await call('DELETE', `${path}/501`),
		]) {
			expect(answer.status).toBe(501);
			expect(answer.body.message).toMatch(/^mock: not modelled: /);
			expect(answer.headers.get('x-mock-not-modelled')).toBe('1');
		}
		expect(fake.fieldValuesOf(number)).toEqual({});
	});

	it('a person can set a value on the fake the way they would on GitHub', async () => {
		const number = fake.addIssue({ title: 'a' });
		fake.setIssueField(number, 'Priority', 'Urgent');

		expect((await call('GET', `${R}/issues/${number}`)).body.issue_field_values[0].single_select_option.name).toBe(
			'Urgent'
		);
		fake.setIssueField(number, 'Priority', null);
		expect(fake.fieldValuesOf(number)).toEqual({});
	});

	it('records the API version of every request', async () => {
		const number = fake.addIssue({ title: 'a' });
		await call('GET', `${R}/issues/${number}`, undefined, '2022-11-28');
		await call('GET', `${R}/issues/${number}`);

		expect(fake.requests.map(request => request.apiVersion)).toEqual(['2022-11-28', '2026-03-10']);
	});
});

describe('the definitions of the fields', () => {
	it('are refused to a token without the organization permission (measured): 403 naming issue_fields=read', async () => {
		fake = await FakeGitHub.start({ repo: 'acme/shop', issueFields: FIELDS });

		const answer = await call('GET', '/orgs/acme/issue-fields');

		expect(answer.status).toBe(403);
		expect(answer.body.message).toBe('Resource not accessible by personal access token');
		expect(answer.headers.get('x-accepted-github-permissions')).toBe('issue_fields=read');
	});

	it('are listed in the shape of the MCP list when readable (the REST shape was not observed)', async () => {
		fake = await FakeGitHub.start({ repo: 'acme/shop', issueFields: FIELDS, issueFieldDefinitions: 'readable' });

		const answer = await call('GET', '/orgs/acme/issue-fields');

		expect(answer.status).toBe(200);
		expect(answer.body[0]).toEqual({
			id: 'IFSS_501',
			full_database_id: 501,
			name: 'Priority',
			data_type: 'SINGLE_SELECT',
			options: [
				{ id: 501001, name: 'Urgent', color: 'GRAY', priority: 1 },
				{ id: 501002, name: 'High', color: 'GRAY', priority: 2 },
				{ id: 501003, name: 'Medium', color: 'GRAY', priority: 3 },
				{ id: 501004, name: 'Low', color: 'GRAY', priority: 4 },
			],
		});
	});

	it('the routes of the repository and of a user do not exist (measured: 404)', async () => {
		fake = await FakeGitHub.start({ repo: 'acme/shop', issueFields: FIELDS, issueFieldDefinitions: 'readable' });

		expect((await call('GET', `${R}/issue-fields`)).status).toBe(404);
		expect((await call('GET', '/users/acme/issue-fields')).status).toBe(404);
	});
});
