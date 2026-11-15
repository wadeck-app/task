// createMigrated: the creation that carries the type, the labels, the priority (as a label) and the metadata of a migrated task in the
// ONE create request, so a task costs one write instead of one per field. Same checks as the separate writes, made BEFORE any request.
import {
	BackendLimitError,
	BackendRejectedError,
	PartialWriteError,
	UnsupportedByBackendError,
} from '@wadeck-app/task-core';

import { FakeGitHub } from './fakeGitHub.testkit.js';
import { WRITE_STATUS_MAP, WRITE_STATUSES, makeGitHubBackend } from './githubBackend.testkit.js';
import type { TestBackend } from './githubBackend.testkit.js';

let fake: FakeGitHub;
let t: TestBackend;

const R = '/repos/acme/shop';
const BLOCK = { meta: { use: 'body-block', fidelity: 'degrade' as const } };

function make(extra: Parameters<typeof makeGitHubBackend>[1] = {}): TestBackend {
	return makeGitHubBackend(fake, {
		statuses: WRITE_STATUSES,
		projectTypes: ['bug', 'feature'],
		fills: BLOCK,
		fidelity: 'degrade',
		...extra,
		options: { statusMap: WRITE_STATUS_MAP, ...extra.options },
	});
}

beforeEach(async () => {
	fake = await FakeGitHub.start({ repo: 'acme/shop' });
	t = make();
	for (const label of ['type:bug', 'planning', 'priority:high', 'status:in-progress']) fake.addRepoLabel(label);
});

afterEach(async () => {
	await fake.stop();
});

const sent = (): string[] => fake.writes().map(request => `${request.method} ${request.path.replace(R, '')}`);

const failure = async (call: () => Promise<unknown>): Promise<Error> => {
	try {
		await call();
	} catch (error) {
		return error as Error;
	}
	throw new Error('expected a failure');
};

describe('createMigrated carries the fields in the create request', () => {
	it('one POST holds the status label, the type, the labels, the priority label and the metadata block', async () => {
		const record = await t.backend.createMigrated!({
			title: 'Full',
			status: 'in-progress',
			description: 'The details',
			type: 'bug',
			labels: ['planning'],
			priority: 'high',
			meta: { migratedFrom: 'abc/12', owner: 'ann' },
		});

		expect(sent()).toEqual(['POST /issues']);
		const body = fake.writes()[0]!.body as { title: string; body: string; labels: string[] };
		expect(body.labels).toEqual(['status:in-progress', 'type:bug', 'planning', 'priority:high']);
		expect(body.body.startsWith('The details\n\n<!-- task:begin v1 -->')).toBe(true);
		expect(body.body).toContain('"migratedFrom":"abc/12"');
		expect(record).toMatchObject({
			status: 'in-progress',
			description: 'The details',
			type: 'bug',
			labels: ['planning'],
			priority: 'high',
			meta: { migratedFrom: 'abc/12', owner: 'ann' },
		});
	});

	it('a closed status is still the create followed by ONE close, which keeps every label', async () => {
		const record = await t.backend.createMigrated!({
			title: 'Done',
			status: 'done',
			type: 'bug',
			labels: ['planning'],
			priority: 'high',
			meta: { migratedFrom: 'abc/1' },
		});

		expect(sent()).toEqual(['POST /issues', 'PATCH /issues/1']);
		expect(fake.issues.get(1)!.labels.sort()).toEqual(['planning', 'priority:high', 'type:bug']);
		expect(record).toMatchObject({ status: 'done', type: 'bug', labels: ['planning'], priority: 'high' });
	});

	it('a child is attached with one more call, the fields stay in the create', async () => {
		await t.backend.createMigrated!({ title: 'Parent', status: 'backlog' });
		fake.requests.splice(0);

		const child = await t.backend.createMigrated!({
			title: 'Child',
			status: 'backlog',
			parentId: '1',
			type: 'bug',
			meta: { migratedFrom: 'abc/2' },
		});

		expect(sent()).toEqual(['POST /issues', 'POST /issues/1/sub_issues']);
		expect(child).toMatchObject({ parentId: '1', type: 'bug', meta: { migratedFrom: 'abc/2' } });
	});

	it('labels the repository lacks are created BEFORE the create call, once each, with the style of their kind', async () => {
		await fake.stop();
		fake = await FakeGitHub.start({ repo: 'acme/shop' });
		t = make();

		await t.backend.createMigrated!({
			title: 'A',
			status: 'backlog',
			type: 'bug',
			labels: ['planning'],
			priority: 'high',
		});
		await t.backend.createMigrated!({
			title: 'B',
			status: 'backlog',
			type: 'bug',
			labels: ['planning'],
			priority: 'high',
		});

		expect(sent()).toEqual(['POST /labels', 'POST /labels', 'POST /labels', 'POST /issues', 'POST /issues']);
		expect(
			fake
				.writes()
				.slice(0, 3)
				.map(request => (request.body as { name: string }).name)
		).toEqual(['type:bug', 'planning', 'priority:high']);
	});

	it('metadata as labels (fills.meta: labels) are labels of the create', async () => {
		t = make({ fills: { meta: { use: 'labels', fidelity: 'strict' } }, fidelity: 'strict' });

		const record = await t.backend.createMigrated!({
			title: 'Meta',
			status: 'backlog',
			meta: { migratedFrom: 'abc/3', owner: 'ann' },
		});

		expect(sent()).toEqual(['POST /labels', 'POST /labels', 'POST /issues']);
		expect(fake.issues.get(1)!.labels.sort()).toEqual(['meta:migratedFrom=abc/3', 'meta:owner=ann']);
		expect(record.meta).toEqual({ migratedFrom: 'abc/3', owner: 'ann' });
	});

	it('what is not written in the creation is left out, not faked: a priority kept in the issue field, a native issue type', async () => {
		await fake.stop();
		fake = await FakeGitHub.start({
			repo: 'acme/shop',
			issueFields: [{ id: 7, name: 'Priority', options: ['urgent', 'high', 'medium', 'low'] }],
			issueTypes: ['Bug'],
		});
		t = make({
			options: {
				priorityStorage: 'field',
				priorityFieldId: 7,
				typeMap: { bug: { issueType: 'Bug' } },
			},
		});

		const record = await t.backend.createMigrated!({
			title: 'Field',
			status: 'backlog',
			type: 'bug',
			priority: 'high',
			meta: { migratedFrom: 'abc/4' },
		});

		expect(sent()).toEqual(['POST /issues']);
		expect(record.priority).toBeUndefined();
		expect(record.type).toBeUndefined();
		expect(record.meta).toEqual({ migratedFrom: 'abc/4' });
		expect(fake.issues.get(1)!.labels).toEqual([]);
	});
});

describe('createMigrated refuses before any request what GitHub would refuse', () => {
	it.each([
		['a label over 50 characters', { labels: ['x'.repeat(51)] }, BackendLimitError, /50/],
		['a label with a comma', { labels: ['a,b'] }, BackendRejectedError, /comma/],
		['a status label as a plain label', { labels: ['status:in-progress'] }, BackendRejectedError, /reserved/],
		['a type label as a plain label', { labels: ['type:feature'] }, BackendRejectedError, /reserved/],
		['a priority label as a plain label', { labels: ['priority:low'] }, BackendRejectedError, /reserved/],
		['a metadata label as a plain label', { labels: ['meta:owner=ann'] }, BackendRejectedError, /reserved/],
		['a type whose label is too long', { type: 'x'.repeat(60) }, BackendLimitError, /50/],
	])('%s', async (_name, input, errorClass, message) => {
		t = make({ fills: { meta: { use: 'labels', fidelity: 'strict' } }, fidelity: 'strict' });

		const error = await failure(() => t.backend.createMigrated!({ title: 'Bad', status: 'backlog', ...input }));

		expect(error).toBeInstanceOf(errorClass);
		expect(error.message).toMatch(message);
		expect(fake.requests).toEqual([]);
	});

	it('a metadata label GitHub would refuse (an "=" in the key) points to body-block', async () => {
		t = make({ fills: { meta: { use: 'labels', fidelity: 'strict' } }, fidelity: 'strict' });

		const error = await failure(() =>
			t.backend.createMigrated!({ title: 'Bad', status: 'backlog', meta: { 'a=b': 'c' } })
		);

		expect(error).toBeInstanceOf(BackendRejectedError);
		expect((error as BackendRejectedError).hint).toContain('body-block');
		expect(fake.requests).toEqual([]);
	});

	it('metadata with no fill declared is the same UnsupportedByBackendError as setMeta', async () => {
		t = make({ fills: {}, fidelity: 'strict' });

		const error = await failure(() =>
			t.backend.createMigrated!({ title: 'Bad', status: 'backlog', meta: { migratedFrom: 'abc/1' } })
		);

		expect(error).toBeInstanceOf(UnsupportedByBackendError);
		expect(fake.requests).toEqual([]);
	});

	it('a priority the project does not have, and a body over the limit, are refused too', async () => {
		const unknown = await failure(() =>
			t.backend.createMigrated!({ title: 'Bad', status: 'backlog', priority: 'nope' })
		);
		const long = await failure(() =>
			t.backend.createMigrated!({
				title: 'Long',
				status: 'backlog',
				description: 'x'.repeat(65530),
				meta: { migratedFrom: 'abc/1' },
			})
		);

		expect((unknown as Error).message).toMatch(/nope/);
		expect(long).toBeInstanceOf(BackendLimitError);
		expect(fake.requests).toEqual([]);
	});
});

describe('createMigrated after the create call', () => {
	it('a close that does not apply is a PartialWriteError that says the issue exists, with the labels it was created with', async () => {
		fake.failNext({
			status: 200,
			method: 'PATCH',
			body: { number: 1, id: 1, state: 'open', state_reason: null, title: 'x', labels: [] },
		});

		const error = (await failure(() =>
			t.backend.createMigrated!({ title: 'Stuck', status: 'done', type: 'bug' })
		)) as PartialWriteError;

		expect(error).toBeInstanceOf(PartialWriteError);
		expect(error.applied).toEqual(['created issue #1']);
		expect(error.hint).toContain('task set-status 1 done');
		expect(fake.issues.get(1)!.labels).toEqual(['type:bug']);
	});
});

describe('createMigrated counts and dedupes the labels of the issue as GitHub does (case-insensitive, status label included)', () => {
	const many = (count: number): string[] => Array.from({ length: count }, (_value, index) => `l${index}`);

	it('exactly 100 labels with no status label is accepted (the status label counts only when the status has one)', async () => {
		for (const label of many(100)) fake.addRepoLabel(label);

		const record = await t.backend.createMigrated!({ title: 'Many', status: 'backlog', labels: many(100) });

		expect(record.labels).toHaveLength(100);
		expect(sent()).toEqual(['POST /issues']);
	});

	it('100 labels plus a status label is 101: refused before any request, naming the limit', async () => {
		const error = await failure(() =>
			t.backend.createMigrated!({ title: 'Too many', status: 'in-progress', labels: many(100) })
		);

		expect(error).toBeInstanceOf(BackendLimitError);
		expect(fake.requests).toEqual([]);
	});

	it('99 labels plus the status label is exactly 100 and passes', async () => {
		for (const label of [...many(99), 'status:in-progress']) fake.addRepoLabel(label);

		const record = await t.backend.createMigrated!({ title: 'Edge', status: 'in-progress', labels: many(99) });

		expect(fake.issues.get(1)!.labels).toHaveLength(100);
		expect(record.status).toBe('in-progress');
	});

	it('a folded label equal to the status label (whatever its case) is ONE label of the POST', async () => {
		t = make({ options: { typeMap: { bug: { label: 'Status:In-Progress' } } } });

		await t.backend.createMigrated!({ title: 'Same', status: 'in-progress', type: 'bug' });

		expect(sent()).toEqual(['POST /issues']);
		expect((fake.writes()[0]!.body as { labels: string[] }).labels).toEqual(['status:in-progress']);
	});
});

describe('createMigrated asks about a label only when the label is really sent', () => {
	it('metadata in the body block (marker included) needs no label: no label request of any kind', async () => {
		await t.backend.createMigrated!({
			title: 'Block',
			status: 'backlog',
			meta: { migratedFrom: 'abc/3', owner: 'ann' },
		});

		expect(fake.requests.filter(request => request.path.includes('/labels'))).toEqual([]);
		expect(sent()).toEqual(['POST /issues']);
	});

	it('a status label is probed once even when a type label of another case names the same label', async () => {
		t = make({ options: { typeMap: { bug: { label: 'STATUS:IN-PROGRESS' } } } });

		await t.backend.createMigrated!({ title: 'Same', status: 'in-progress', type: 'bug' });

		expect(
			fake.requests.filter(request => request.method === 'GET' && request.path.includes('/labels/'))
		).toHaveLength(1);
	});
});

describe('createMigrated compares labels case-insensitively, as GitHub does', () => {
	it('a label the repository holds under another case is not created again, and two spellings in the input are one label', async () => {
		fake.addRepoLabel('Release');

		await t.backend.createMigrated!({ title: 'Cases', status: 'backlog', labels: ['release', 'RELEASE'] });

		expect(sent()).toEqual(['POST /issues']);
		expect((fake.writes()[0]!.body as { labels: string[] }).labels).toEqual(['release']);
	});
});
