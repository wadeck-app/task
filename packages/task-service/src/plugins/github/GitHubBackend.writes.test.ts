// The write path of the github backend over the fake server: create, status, title and description, type, labels, meta.
// Every test says what reached GitHub (`sent()`), because the order and the number of calls are part of the design.
import {
	BackendLimitError,
	BackendRejectedError,
	BackendUnreachableError,
	PartialWriteError,
	TaskConflictError,
	TaskNotFoundError,
	UnsupportedByBackendError,
} from '@wadeck-app/task-core';

import { FakeGitHub } from './fakeGitHub.testkit.js';
import { WRITE_STATUS_MAP, WRITE_STATUSES, makeGitHubBackend } from './githubBackend.testkit.js';
import type { TestBackend } from './githubBackend.testkit.js';

let fake: FakeGitHub;
let t: TestBackend;

const R = '/repos/acme/shop';

function make(extra: Parameters<typeof makeGitHubBackend>[1] = {}): TestBackend {
	return makeGitHubBackend(fake, {
		statuses: WRITE_STATUSES,
		projectTypes: ['bug', 'feature'],
		...extra,
		options: { statusMap: WRITE_STATUS_MAP, ...extra.options },
	});
}

beforeEach(async () => {
	fake = await FakeGitHub.start({ repo: 'acme/shop' });
	t = make();
});

afterEach(async () => {
	await fake.stop();
});

/** Every write that reached the fake, as `METHOD /path`. */
const sent = (): string[] => fake.writes().map(request => `${request.method} ${request.path.replace(R, '')}`);

const failure = async (call: () => Promise<unknown>): Promise<Error> => {
	try {
		await call();
	} catch (error) {
		return error as Error;
	}
	throw new Error('expected a failure');
};

const labelsOf = (number: number): string[] => fake.issues.get(number)!.labels;

describe('create', () => {
	it('creates an issue in the default status with one POST, and returns the record read back', async () => {
		const created = await t.backend.create({ title: 'First', status: 'backlog' });

		expect(created).toMatchObject({ id: '1', title: 'First', status: 'backlog' });
		expect(created.revision).toBeTypeOf('string');
		expect(sent()).toEqual(['POST /issues']);
		expect(fake.writes()[0]!.body).toEqual({ title: 'First' });
	});

	it('sends the description as the body, unless it is the title', async () => {
		await t.backend.create({ title: 'With body', status: 'backlog', description: 'The details' });
		await t.backend.create({ title: 'Same', status: 'backlog', description: 'Same' });

		expect((fake.writes()[0]!.body as { body: string }).body).toBe('The details');
		expect(fake.writes()[1]!.body).toEqual({ title: 'Same' });
		expect((await t.backend.get('1')).description).toBe('The details');
	});

	it('creates the status label first when the repository lacks it (the create call must not be the label factory)', async () => {
		const created = await t.backend.create({ title: 'Doing', status: 'in-progress' });

		expect(sent()).toEqual(['POST /labels', 'POST /issues']);
		expect(fake.writes()[0]!.body).toMatchObject({ name: 'status:in-progress' });
		expect((fake.writes()[0]!.body as { color: string }).color).toMatch(/^[0-9a-f]{6}$/);
		expect(fake.writes()[1]!.body).toEqual({ title: 'Doing', labels: ['status:in-progress'] });
		expect(created.status).toBe('in-progress');
	});

	it('does not create a label that exists, whatever its case', async () => {
		fake.addRepoLabel('Status:In-Progress');

		await t.backend.create({ title: 'Doing', status: 'in-progress' });

		expect(sent()).toEqual(['POST /issues']);
	});

	it('a task created in a terminal status is created, then closed with the reason of its status (GitHub ignores state on create)', async () => {
		const done = await t.backend.create({ title: 'Already done', status: 'done' });
		const cancelled = await t.backend.create({ title: 'Never', status: 'cancelled' });

		expect(sent()).toEqual(['POST /issues', 'PATCH /issues/1', 'POST /issues', 'PATCH /issues/2']);
		expect(fake.writes()[1]!.body).toEqual({ state: 'closed', state_reason: 'completed' });
		expect(fake.writes()[3]!.body).toEqual({ state: 'closed', state_reason: 'not_planned' });
		expect(done.status).toBe('done');
		expect(cancelled.status).toBe('cancelled');
		expect(fake.issues.get(2)).toMatchObject({ state: 'closed', stateReason: 'not_planned' });
	});

	it('when GitHub does not close the issue the answer says so (PartialWriteError: it was created, it is not closed)', async () => {
		fake.failNext({
			status: 200,
			method: 'PATCH',
			body: { number: 1, id: 1, state: 'open', state_reason: null, title: 'x', labels: [] },
		});

		const error = (await failure(() => t.backend.create({ title: 'Stuck', status: 'done' }))) as PartialWriteError;

		expect(error).toBeInstanceOf(PartialWriteError);
		expect(error.taskId).toBe('1');
		expect(error.applied).toEqual(['created issue #1']);
		expect(error.notApplied).toEqual([expect.stringContaining('close')]);
		expect(error.hint).toContain('task set-status 1 done');
		expect(fake.issues.get(1)!.state).toBe('open');
	});

	it('under a parent: the parent is checked before anything is created, then the sub-issue link is made with the numeric id', async () => {
		const parent = await t.backend.create({ title: 'Parent', status: 'backlog' });
		fake.requests.length = 0;

		const child = await t.backend.create({ title: 'Child', status: 'backlog', parentId: parent.id });

		expect(sent()).toEqual(['POST /issues', 'POST /issues/1/sub_issues']);
		expect(fake.writes()[1]!.body).toEqual({ sub_issue_id: fake.issues.get(2)!.id, replace_parent: true });
		expect(child.parentId).toBe('1');
	});

	it('an unknown parent is TaskNotFoundError and nothing is created', async () => {
		const error = await failure(() => t.backend.create({ title: 'Orphan', status: 'backlog', parentId: '99' }));

		expect(error).toBeInstanceOf(TaskNotFoundError);
		expect(fake.writes()).toEqual([]);
		expect(fake.issues.size).toBe(0);
	});

	it('when the link to the parent fails the issue exists: PartialWriteError says which one and how to attach it', async () => {
		await t.backend.create({ title: 'Parent', status: 'backlog' });
		fake.failNext({
			status: 422,
			method: 'POST',
			pathPrefix: `${R}/issues/1/sub_issues`,
			body: { message: 'Validation Failed' },
		});

		const error = (await failure(() =>
			t.backend.create({ title: 'Child', status: 'backlog', parentId: '1' })
		)) as PartialWriteError;

		expect(error).toBeInstanceOf(PartialWriteError);
		expect(error.taskId).toBe('2');
		expect(error.applied).toEqual(['created issue #2']);
		expect(error.hint).toContain('task set-parent 2 1');
	});

	it('a status the project does not map is refused before any request', async () => {
		const error = (await failure(() =>
			t.backend.create({ title: 'x', status: 'nope' })
		)) as UnsupportedByBackendError;

		expect(error).toBeInstanceOf(UnsupportedByBackendError);
		expect(error.capability).toBe('status');
		expect(error.hint).toContain('"nope"');
		expect(error.hint).toContain('statusMap');
		expect(fake.requests).toEqual([]);
	});
});

describe('updateStatus', () => {
	beforeEach(async () => {
		fake.addIssue({ title: 'One' });
	});

	// One PATCH carries the state, its reason and the whole label set: no reader sees two status labels, nor a half-done change,
	// and the history shows one change.
	it('to a status with a label: creates the label when missing, then ONE PATCH sets the label set', async () => {
		const moved = await t.backend.updateStatus('1', 'in-progress');

		expect(sent()).toEqual(['POST /labels', 'PATCH /issues/1']);
		expect(fake.writes()[1]!.body).toEqual({ labels: ['status:in-progress'] });
		expect(moved.status).toBe('in-progress');
		expect(labelsOf(1)).toEqual(['status:in-progress']);
	});

	it('back to the status without a label: the label goes, in the same single PATCH', async () => {
		fake.updateIssue(1, { labels: ['status:in-progress', 'urgent'] });

		const moved = await t.backend.updateStatus('1', 'backlog');

		expect(sent()).toEqual(['PATCH /issues/1']);
		expect(fake.writes()[0]!.body).toEqual({ labels: ['urgent'] });
		expect(moved.status).toBe('backlog');
	});

	it('to a closed status: the state, the reason and the label set go in ONE PATCH, the other labels are kept', async () => {
		fake.updateIssue(1, { labels: ['status:in-progress', 'urgent'] });

		const moved = await t.backend.updateStatus('1', 'done');

		expect(sent()).toEqual(['PATCH /issues/1']);
		expect(fake.writes()[0]!.body).toEqual({ labels: ['urgent'], state: 'closed', state_reason: 'completed' });
		expect(moved.status).toBe('done');
		expect(moved.labels).toEqual(['urgent']);
	});

	it('from a closed status to a labelled one: reopens and sets the label in one PATCH', async () => {
		fake.updateIssue(1, { state: 'closed', stateReason: 'completed' });
		fake.addRepoLabel('status:in-progress');

		const moved = await t.backend.updateStatus('1', 'in-progress');

		expect(sent()).toEqual(['PATCH /issues/1']);
		expect(fake.writes()[0]!.body).toEqual({ labels: ['status:in-progress'], state: 'open' });
		expect(moved.status).toBe('in-progress');
	});

	it('from one labelled status to another: one PATCH, so the issue never carries two status labels or none', async () => {
		fake.updateIssue(1, { labels: ['status:in-progress'] });
		fake.addRepoLabel('status:review');

		const moved = await t.backend.updateStatus('1', 'review');

		expect(sent()).toEqual(['PATCH /issues/1']);
		expect(moved.status).toBe('review');
		expect(labelsOf(1)).toEqual(['status:review']);
	});

	it('the history shows the change as one step (the label and the state of one request are one instant)', async () => {
		fake.updateIssue(1, { labels: ['status:in-progress'] });
		await t.backend.updateStatus('1', 'done');

		expect((await t.backend.get('1')).history.map(entry => entry.status)).toEqual([
			'backlog',
			'in-progress',
			'done',
		]);
	});

	it('from one way of ending to another: ONE PATCH with state: closed and the new reason (a reason alone would be ignored)', async () => {
		fake.updateIssue(1, { state: 'closed', stateReason: 'completed' });

		const moved = await t.backend.updateStatus('1', 'cancelled');

		expect(sent()).toEqual(['PATCH /issues/1']);
		expect(fake.writes()[0]!.body).toEqual({ state: 'closed', state_reason: 'not_planned' });
		expect(moved.status).toBe('cancelled');
		expect(fake.issues.get(1)).toMatchObject({ state: 'closed', stateReason: 'not_planned' });
	});

	it('the current status is a TaskConflictError and nothing is sent', async () => {
		const error = await failure(() => t.backend.updateStatus('1', 'backlog'));

		expect(error).toBeInstanceOf(TaskConflictError);
		expect(error.message).toBe('Task "1" is already in status "backlog"');
		expect(fake.writes()).toEqual([]);
	});

	it('an unknown task is TaskNotFoundError', async () => {
		expect(await failure(() => t.backend.updateStatus('99', 'done'))).toBeInstanceOf(TaskNotFoundError);
		expect(fake.writes()).toEqual([]);
	});

	it('a call refused for good, with nothing before it, changes nothing and is the original error, not a partial write', async () => {
		fake.updateIssue(1, { labels: ['status:in-progress'] });
		fake.failNext({ status: 422, method: 'PATCH', body: { message: 'Validation Failed' } });

		const error = await failure(() => t.backend.updateStatus('1', 'done'));

		expect(error).toBeInstanceOf(BackendRejectedError);
		expect(error).not.toBeInstanceOf(PartialWriteError);
		expect(labelsOf(1)).toEqual(['status:in-progress']);
		expect(fake.issues.get(1)!.state).toBe('open');
	});

	it('a 5xx on a call that DID apply is not an error: the issue is read again and the step counts as done', async () => {
		fake.addRepoLabel('status:in-progress');
		fake.failNext({ status: 502, method: 'PATCH', applyWrite: true });

		const moved = await t.backend.updateStatus('1', 'in-progress');

		expect(moved.status).toBe('in-progress');
		expect(labelsOf(1)).toEqual(['status:in-progress']);
	});

	it('a 5xx on a call that did NOT apply is the original unreachable error, nothing is claimed', async () => {
		fake.addRepoLabel('status:in-progress');
		fake.failNext({ status: 502, method: 'PATCH' });

		const error = await failure(() => t.backend.updateStatus('1', 'in-progress'));

		expect(error).toBeInstanceOf(BackendUnreachableError);
		expect(labelsOf(1)).toEqual([]);
	});
});

describe('setTitle and setDescription', () => {
	it('sets the title with one PATCH; the same title sends nothing', async () => {
		fake.addIssue({ title: 'Old' });

		const renamed = await t.backend.setTitle('1', 'New');
		fake.requests.length = 0;
		await t.backend.setTitle('1', 'New');

		expect(renamed.title).toBe('New');
		expect(fake.writes()).toEqual([]);
	});

	it('sets the body; the same description sends nothing; an empty one clears it', async () => {
		fake.addIssue({ title: 'T', body: 'old' });

		const set = await t.backend.setDescription('1', 'new text');
		expect(set.description).toBe('new text');
		const before = fake.writes().length;
		await t.backend.setDescription('1', 'new text');
		expect(fake.writes()).toHaveLength(before);

		const cleared = await t.backend.setDescription('1', '');
		expect(cleared.description).toBeUndefined();
		expect(fake.issues.get(1)!.body).toBe('');
	});

	it('keeps the managed block of the body when the description or the title changes', async () => {
		const block = '<!-- task:begin v1 -->{"links":[{"type":"duplicateOf","target":"2"}]}<!-- task:end -->';
		fake.addIssue({ title: 'T' });
		fake.addIssue({ title: 'Other' });
		fake.updateIssue(1, { body: `old text\n\n${block}` });

		await t.backend.setDescription('1', 'new text');
		expect(fake.issues.get(1)!.body).toBe(`new text\n\n${block}`);
		await t.backend.setDescription('1', '');
		expect(fake.issues.get(1)!.body).toBe(block);
	});

	it('a description over the 65536 characters GitHub accepts is a limit error naming the limit, nothing is sent', async () => {
		fake.addIssue({ title: 'T' });

		const error = await failure(() => t.backend.setDescription('1', 'x'.repeat(65537)));

		expect(error).toBeInstanceOf(BackendLimitError);
		expect((error as BackendLimitError).limit).toBe(65536);
		expect(fake.writes()).toEqual([]);
	});

	it('the description is stored as a body that reads back the same, CRLF aside', async () => {
		fake.addIssue({ title: 'T' });

		const record = await t.backend.setDescription('1', 'line one\nline two');

		expect(record.description).toBe('line one\nline two');
	});
});

describe('setType and clearType', () => {
	beforeEach(() => {
		fake.addIssue({ title: 'One' });
	});

	it('with a type label: creates it when missing and adds it', async () => {
		const typed = await t.backend.setType('1', 'bug');

		expect(sent()).toEqual(['POST /labels', 'POST /issues/1/labels']);
		expect(fake.writes()[0]!.body).toMatchObject({ name: 'type:bug' });
		expect(typed.type).toBe('bug');
		expect(typed.labels).toBeUndefined();
	});

	it('changing the type is ONE PATCH of the label set, so the issue never carries two type labels or none', async () => {
		fake.updateIssue(1, { labels: ['type:bug', 'urgent'] });
		fake.addRepoLabel('type:feature');

		const typed = await t.backend.setType('1', 'feature');

		expect(sent()).toEqual(['PATCH /issues/1']);
		expect(fake.writes()[0]!.body).toEqual({ labels: ['urgent', 'type:feature'] });
		expect(typed.type).toBe('feature');
	});

	it('the same type sends nothing', async () => {
		fake.updateIssue(1, { labels: ['type:bug'] });

		const typed = await t.backend.setType('1', 'bug');

		expect(typed.type).toBe('bug');
		expect(fake.writes()).toEqual([]);
	});

	it('with typeMap.issueType the native issue type is set', async () => {
		t = make({ options: { typeMap: { bug: { issueType: 'Bug' } } } });

		const typed = await t.backend.setType('1', 'bug');

		expect(sent()).toEqual(['PATCH /issues/1']);
		expect(fake.writes()[0]!.body).toEqual({ type: 'Bug' });
		expect(typed.type).toBe('bug');
	});

	it('with typeMap.label the label of the map is used', async () => {
		t = make({ options: { typeMap: { bug: { label: 'kind/bug' } } } });

		await t.backend.setType('1', 'bug');

		expect(labelsOf(1)).toEqual(['kind/bug']);
	});

	it('clearType removes the type label, and the native type too', async () => {
		fake.updateIssue(1, { labels: ['type:bug'], type: 'Bug' });

		const cleared = await t.backend.clearType('1');

		expect(sent()).toEqual(['PATCH /issues/1']);
		expect(fake.writes()[0]!.body).toEqual({ labels: [], type: null });
		expect(cleared.type).toBeUndefined();
	});

	it('clearType on a task without a type sends nothing', async () => {
		const record = await t.backend.clearType('1');

		expect(record.type).toBeUndefined();
		expect(fake.writes()).toEqual([]);
	});

	it('a type whose label would be over 50 characters is a limit error that says how to shorten it', async () => {
		const error = await failure(() => t.backend.setType('1', 'x'.repeat(50)));

		expect(error).toBeInstanceOf(BackendLimitError);
		expect((error as BackendLimitError).hint).toContain('typePrefix');
		expect(fake.writes()).toEqual([]);
	});
});

describe('labels', () => {
	beforeEach(() => {
		fake.addIssue({ title: 'One' });
	});

	it('creates a missing label with the default colour, then adds it', async () => {
		const labelled = await t.backend.addLabel('1', 'urgent');

		expect(sent()).toEqual(['POST /labels', 'POST /issues/1/labels']);
		expect(fake.writes()[0]!.body).toMatchObject({ name: 'urgent', color: 'ededed' });
		expect(labelled.labels).toEqual(['urgent']);
	});

	it('a label the repository has is not created again; one the issue has is not sent again, whatever its case', async () => {
		fake.addRepoLabel('Urgent');

		await t.backend.addLabel('1', 'urgent');
		const before = fake.writes().length;
		const again = await t.backend.addLabel('1', 'URGENT');

		expect(sent()).toEqual(['POST /issues/1/labels']);
		expect(fake.writes()).toHaveLength(before);
		expect(again.labels).toEqual(['Urgent']);
	});

	it('removing a label sends one DELETE; removing an absent one sends nothing', async () => {
		fake.updateIssue(1, { labels: ['urgent', 'backend'] });

		const removed = await t.backend.removeLabel('1', 'urgent');
		const before = fake.writes().length;
		const absent = await t.backend.removeLabel('1', 'urgent');

		expect(removed.labels).toEqual(['backend']);
		expect(absent.labels).toEqual(['backend']);
		expect(fake.writes()).toHaveLength(before);
	});

	it('a name over 50 characters is refused before any request, with the limit and the length', async () => {
		const error = await failure(() => t.backend.addLabel('1', 'x'.repeat(51)));

		expect(error).toBeInstanceOf(BackendLimitError);
		expect((error as BackendLimitError).limit).toBe(50);
		expect((error as BackendLimitError).hint).toContain('51');
		expect(fake.writes()).toEqual([]);
	});

	it('a comma, or a space at either end, is refused before any request', async () => {
		for (const name of ['a,b', ' lead', 'trail ']) {
			const error = await failure(() => t.backend.addLabel('1', name));
			expect(error).toBeInstanceOf(BackendRejectedError);
		}
		expect(fake.writes()).toEqual([]);
	});

	it('a label that would read as a status or a type is refused, and the hint names the command to use', async () => {
		const status = await failure(() => t.backend.addLabel('1', 'status:in-progress'));
		const type = await failure(() => t.backend.addLabel('1', 'type:bug'));

		expect(status).toBeInstanceOf(BackendRejectedError);
		expect((status as BackendRejectedError).hint).toContain('task set-status');
		expect((type as BackendRejectedError).hint).toContain('task set-type');
		expect(fake.writes()).toEqual([]);
	});

	it('the 101st label is refused by GitHub and the error says so', async () => {
		fake.updateIssue(1, { labels: Array.from({ length: 100 }, (_, i) => `l${i}`) });

		const error = await failure(() => t.backend.addLabel('1', 'one-more'));

		expect(error).toBeInstanceOf(BackendLimitError);
		expect((error as BackendLimitError).limit).toBe(100);
	});

	it('a 5xx on the label call that applied counts as done; one that did not is the error', async () => {
		fake.addRepoLabel('urgent');
		fake.failNext({ status: 502, method: 'POST', pathPrefix: `${R}/issues/1/labels`, applyWrite: true });
		const applied = await t.backend.addLabel('1', 'urgent');
		expect(applied.labels).toEqual(['urgent']);

		fake.addRepoLabel('later');
		fake.failNext({ status: 502, method: 'POST', pathPrefix: `${R}/issues/1/labels` });
		const error = await failure(() => t.backend.addLabel('1', 'later'));
		expect(error).toBeInstanceOf(BackendUnreachableError);
		expect(labelsOf(1)).toEqual(['urgent']);
	});
});

describe('meta', () => {
	beforeEach(() => {
		fake.addIssue({ title: 'One' });
	});

	it('without a fill is UnsupportedByBackendError for meta, naming the key to declare, before any request', async () => {
		const error = (await failure(() => t.backend.setMeta('1', 'owner', 'ann'))) as UnsupportedByBackendError;

		expect(error).toBeInstanceOf(UnsupportedByBackendError);
		expect(error.capability).toBe('meta');
		expect(error.hint).toContain('fills');
		expect(error.hint).toContain('meta: labels');
		expect(error.hint).toContain('body-block');
		expect(fake.requests).toEqual([]);
		expect(await failure(() => t.backend.removeMeta('1', 'owner'))).toBeInstanceOf(UnsupportedByBackendError);
	});

	describe('with fills.meta: labels', () => {
		beforeEach(() => {
			t = make({ fills: { meta: { use: 'labels', fidelity: 'strict' } } });
		});

		it('sets a key as the label meta:key=value, creating the label when missing', async () => {
			const set = await t.backend.setMeta('1', 'owner', 'ann');

			expect(sent()).toEqual(['POST /labels', 'POST /issues/1/labels']);
			expect(labelsOf(1)).toEqual(['meta:owner=ann']);
			expect(set.meta).toEqual({ owner: 'ann' });
			expect(set.labels).toBeUndefined();
		});

		it('changing a value is ONE PATCH of the label set (the old label goes, the new one comes); the same value sends nothing', async () => {
			await t.backend.setMeta('1', 'owner', 'ann');
			fake.requests.length = 0;

			await t.backend.setMeta('1', 'owner', 'ann');
			expect(fake.writes()).toEqual([]);
			const changed = await t.backend.setMeta('1', 'owner', 'bob');

			expect(sent()).toEqual(['POST /labels', 'PATCH /issues/1']);
			expect(fake.writes()[1]!.body).toEqual({ labels: ['meta:owner=bob'] });
			expect(changed.meta).toEqual({ owner: 'bob' });
		});

		it('an empty value is the label meta:key, and an inherited property name is a key like any other', async () => {
			await t.backend.setMeta('1', 'flag', '');
			const odd = await t.backend.setMeta('1', 'constructor', 'x');

			expect(labelsOf(1)).toEqual(['meta:flag', 'meta:constructor=x']);
			expect(odd.meta).toEqual({ flag: '', constructor: 'x' });
		});

		it('removeMeta removes the label; an absent key sends nothing', async () => {
			await t.backend.setMeta('1', 'owner', 'ann');
			fake.requests.length = 0;

			const absent = await t.backend.removeMeta('1', 'other');
			const removed = await t.backend.removeMeta('1', 'owner');

			expect(absent.meta).toEqual({ owner: 'ann' });
			expect(removed.meta).toBeUndefined();
			expect(sent()).toEqual(['DELETE /issues/1/labels/meta%3Aowner%3Dann']);
		});

		it('key and value over the 50 characters of a label are a limit error that points to body-block', async () => {
			const error = await failure(() => t.backend.setMeta('1', 'key', 'v'.repeat(50)));

			expect(error).toBeInstanceOf(BackendLimitError);
			expect((error as BackendLimitError).hint).toContain('body-block');
			expect(fake.writes()).toEqual([]);
		});

		it('a comma, or an equals sign in the key, cannot be a label and is refused with the same pointer', async () => {
			for (const [key, value] of [
				['k', 'a,b'],
				['a=b', 'v'],
			] as const) {
				const error = await failure(() => t.backend.setMeta('1', key, value));
				expect(error).toBeInstanceOf(BackendRejectedError);
				expect((error as BackendRejectedError).hint).toContain('body-block');
			}
			expect(fake.writes()).toEqual([]);
		});
	});

	describe('with fills.meta: body-block (degrade)', () => {
		beforeEach(() => {
			t = make({ fills: { meta: { use: 'body-block', fidelity: 'degrade' } }, fidelity: 'degrade' });
		});

		it('keeps the meta in the managed block of the body, next to the description, and reads it back', async () => {
			fake.updateIssue(1, { body: 'The text' });

			const set = await t.backend.setMeta('1', 'owner', 'ann');

			expect(sent()).toEqual(['PATCH /issues/1']);
			expect(fake.issues.get(1)!.body).toBe(
				'The text\n\n<!-- task:begin v1 -->{"meta":{"owner":"ann"}}<!-- task:end -->'
			);
			expect(set.meta).toEqual({ owner: 'ann' });
			expect(set.description).toBe('The text');
			expect(set.labels).toBeUndefined();
		});

		it('values with a comma or more than 50 characters are fine there', async () => {
			const set = await t.backend.setMeta('1', 'notes', `a, b ${'x'.repeat(100)}`);

			expect(set.meta).toEqual({ notes: `a, b ${'x'.repeat(100)}` });
		});

		it('changes and removes keys; the block goes with its last key and keeps what else it holds', async () => {
			await t.backend.setMeta('1', 'a', '1');
			await t.backend.setMeta('1', 'b', '2');
			expect((await t.backend.setMeta('1', 'a', '3')).meta).toEqual({ a: '3', b: '2' });
			expect((await t.backend.removeMeta('1', 'a')).meta).toEqual({ b: '2' });
			const last = await t.backend.removeMeta('1', 'b');

			expect(last.meta).toBeUndefined();
			expect(fake.issues.get(1)!.body).toBe('');
		});

		it('keeps the duplicateOf link of the same block when the meta changes', async () => {
			fake.updateIssue(1, {
				body: '<!-- task:begin v1 -->{"links":[{"type":"duplicateOf","target":"2"}]}<!-- task:end -->',
			});
			fake.addIssue({ title: 'Other' });

			await t.backend.setMeta('1', 'a', '1');

			expect(
				JSON.parse(/<!-- task:begin v1 -->(.*)<!-- task:end -->/.exec(fake.issues.get(1)!.body!)![1]!)
			).toEqual({
				links: [{ type: 'duplicateOf', target: '2' }],
				meta: { a: '1' },
			});
		});

		it('says once, as a warning, that the meta is emulated and a human edit of the body may overwrite it', async () => {
			await t.backend.setMeta('1', 'a', '1');
			await t.backend.setMeta('1', 'b', '2');

			const emulated = t.notices.filter(notice => notice.kind === 'emulated');
			expect(emulated).toHaveLength(1);
			expect(emulated[0]!.text).toContain('meta');
			expect(emulated[0]!.text).toContain('body');
		});

		it('a block that cannot be read stops the write with the error naming the issue, and the body is not touched', async () => {
			fake.updateIssue(1, { body: 'text <!-- task:begin v1 -->{nope<!-- task:end -->' });

			const error = await failure(() => t.backend.setMeta('1', 'a', '1'));

			expect(error.message).toContain('issue #1');
			expect(fake.issues.get(1)!.body).toBe('text <!-- task:begin v1 -->{nope<!-- task:end -->');
		});
	});
});
