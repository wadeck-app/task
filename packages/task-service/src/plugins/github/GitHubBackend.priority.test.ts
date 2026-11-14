// The priority of a task on GitHub: a native organization issue field, or a label. Same commands and answers as the local store; what
// differs is what reaches GitHub, and that is pinned here. Labels first (what works with an Issues-only token), then the field.
import {
	BackendDataError,
	BackendRejectedError,
	InvalidTaskFieldError,
	StaleRevisionError,
	TaskNotFoundError,
	UnknownPriorityError,
} from '@wadeck-app/task-core';

import { FakeGitHub } from './fakeGitHub.testkit.js';
import { WRITE_STATUS_MAP, WRITE_STATUSES, makeGitHubBackend } from './githubBackend.testkit.js';
import type { TestBackend } from './githubBackend.testkit.js';
import { FIELDS_API_VERSION } from './githubPriorityStorage.js';

let fake: FakeGitHub;
let t: TestBackend;

const R = '/repos/acme/shop';
const FIELDS = [
	{ id: 501, name: 'Priority', options: ['Urgent', 'High', 'Medium', 'Low'] },
	{ id: 502, name: 'Area', options: ['Backend'] },
];

function make(extra: Parameters<typeof makeGitHubBackend>[1] = {}): TestBackend {
	return makeGitHubBackend(fake, {
		statuses: WRITE_STATUSES,
		projectTypes: ['bug', 'feature'],
		...extra,
		options: { statusMap: WRITE_STATUS_MAP, ...extra.options },
	});
}

afterEach(async () => {
	await fake.stop();
});

const sent = (): string[] => fake.writes().map(request => `${request.method} ${request.path.replace(R, '')}`);
const labelsOf = (number: number): string[] => fake.issues.get(number)!.labels;

const failure = async (call: () => Promise<unknown>): Promise<Error> => {
	try {
		await call();
	} catch (error) {
		return error as Error;
	}
	throw new Error('expected a failure');
};

describe('priority stored in a label (priorityStorage: label)', () => {
	beforeEach(async () => {
		fake = await FakeGitHub.start({ repo: 'acme/shop' });
		t = make();
	});

	it('set: creates the label priority:<name>, which is not one of the labels of the task; the record and the list agree', async () => {
		const number = fake.addIssue({ title: 'a' });

		const record = await t.backend.setPriority!(String(number), 'high');

		expect(record.priority).toBe('high');
		expect(record.labels).toBeUndefined();
		expect(labelsOf(number)).toEqual(['priority:high']);
		expect(fake.repoLabels.has('priority:high')).toBe(true);
		expect((await t.backend.list()).find(task => task.id === String(number))?.priority).toBe('high');
		expect((await t.backend.resolve(String(number))).priority).toBe('high');
		expect(sent()).toEqual(['POST /labels', 'POST /issues/1/labels']);
	});

	it('the same priority writes nothing; the revision does not move', async () => {
		const number = fake.addIssue({ title: 'a', labels: ['priority:high'] });
		const before = await t.backend.get(String(number));
		fake.requests.splice(0);

		const again = await t.backend.setPriority!(String(number), 'high');

		expect(sent()).toEqual([]);
		expect(again.revision).toBe(before.revision);
	});

	it('change: ONE PATCH of the label set swaps the old label for the new one', async () => {
		const number = fake.addIssue({ title: 'a', labels: ['priority:high', 'urgent'] });
		fake.addRepoLabel('priority:low');

		const record = await t.backend.setPriority!(String(number), 'low');

		expect(record.priority).toBe('low');
		expect(record.labels).toEqual(['urgent']);
		expect(labelsOf(number)).toEqual(['urgent', 'priority:low']);
		expect(sent()).toEqual(['PATCH /issues/1']);
	});

	it('clear: removes the label with one DELETE; clearing again writes nothing', async () => {
		const number = fake.addIssue({ title: 'a', labels: ['priority:high'] });

		const cleared = await t.backend.clearPriority!(String(number));

		expect(cleared.priority).toBeUndefined();
		expect(labelsOf(number)).toEqual([]);
		expect(sent()).toEqual(['DELETE /issues/1/labels/priority%3Ahigh']);
		fake.requests.splice(0);
		await t.backend.clearPriority!(String(number));
		expect(sent()).toEqual([]);
	});

	it('refuses an unknown or blank priority before any request, with the valid ones listed', async () => {
		const number = fake.addIssue({ title: 'a' });
		fake.requests.splice(0);

		const unknown = await failure(() => t.backend.setPriority!(String(number), 'blocker'));
		const blank = await failure(() => t.backend.setPriority!(String(number), '  '));

		expect(unknown).toBeInstanceOf(UnknownPriorityError);
		expect(unknown.message).toContain('urgent, high, medium, low');
		expect(blank).toBeInstanceOf(InvalidTaskFieldError);
		expect(fake.requests).toEqual([]);
	});

	it('an unknown task is not found; a stale revision is refused and writes nothing', async () => {
		const number = fake.addIssue({ title: 'a' });

		expect(await failure(() => t.backend.setPriority!('999', 'high'))).toBeInstanceOf(TaskNotFoundError);
		expect(await failure(() => t.backend.clearPriority!('nope'))).toBeInstanceOf(TaskNotFoundError);
		fake.requests.splice(0);
		const stale = await failure(() =>
			t.backend.setPriority!(String(number), 'high', { expectedRevision: 'definitely-not-the-revision' })
		);
		expect(stale).toBeInstanceOf(StaleRevisionError);
		expect(sent()).toEqual([]);
	});

	it('a change of the priority on GitHub meanwhile is a conflict for a write that expected the old one; a comment is not', async () => {
		const number = fake.addIssue({ title: 'a', labels: ['priority:high'] });
		fake.addRepoLabel('priority:low');
		const read = await t.backend.get(String(number));
		fake.addComment(number, 'a note');
		const ok = await t.backend.setPriority!(String(number), 'low', { expectedRevision: read.revision });
		expect(ok.priority).toBe('low');

		const stale = await t.backend.get(String(number));
		fake.updateIssue(number, { labels: ['priority:urgent'] });
		const conflict = await failure(() =>
			t.backend.setPriority!(String(number), 'medium', { expectedRevision: stale.revision })
		);
		expect(conflict).toBeInstanceOf(StaleRevisionError);
	});

	it('two priority labels on one issue are an error naming the issue and the fix, on a read and on the list', async () => {
		const number = fake.addIssue({ title: 'a', labels: ['priority:high', 'priority:low'] });

		const error = await failure(() => t.backend.get(String(number)));

		expect(error).toBeInstanceOf(BackendDataError);
		expect(error.message).toContain('issue #1 carries two priority labels (priority:high, priority:low)');
		expect(await failure(() => t.backend.list())).toBeInstanceOf(BackendDataError);
	});

	it('a priority label of a priority the project does not have reads as no priority and says so', async () => {
		const number = fake.addIssue({ title: 'a', labels: ['priority:blocker'] });

		const record = await t.backend.get(String(number));

		expect(record.priority).toBeUndefined();
		expect(record.labels).toBeUndefined();
		expect(t.notices.map(notice => notice.text)).toEqual([
			expect.stringContaining(
				'issue #1 has the label "priority:blocker", which is not a priority of this project'
			),
		]);
		expect(t.notices[0]!.kind).toBe('ignored');
	});

	it('addLabel refuses a priority label before any request, and removeLabel leaves it alone', async () => {
		const number = fake.addIssue({ title: 'a', labels: ['priority:high'] });
		fake.requests.splice(0);

		const refused = await failure(() => t.backend.addLabel(String(number), 'Priority:Low'));
		await t.backend.removeLabel(String(number), 'priority:high');

		expect(refused).toBeInstanceOf(BackendRejectedError);
		expect(refused.message).toContain('is reserved');
		expect((refused as BackendRejectedError).hint).toContain('task set-priority');
		expect(labelsOf(number)).toEqual(['priority:high']);
		expect(sent()).toEqual([]);
	});

	it('priorityMap names the label: a mapped label is the whole name, read back both ways', async () => {
		t = make({ options: { priorityMap: { urgent: 'P0', high: 'P1' } } });
		const number = fake.addIssue({ title: 'a' });

		const record = await t.backend.setPriority!(String(number), 'urgent');

		expect(record.priority).toBe('urgent');
		expect(labelsOf(number)).toEqual(['P0']);
		expect(record.labels).toBeUndefined();
		fake.updateIssue(number, { labels: ['p1'] });
		expect((await t.backend.get(String(number))).priority).toBe('high');
		await t.backend.setPriority!(String(number), 'low');
		expect(labelsOf(number)).toEqual(['priority:low']);
	});

	it('a priority whose label GitHub would refuse is a limit error naming the fix, before any request', async () => {
		t = make({ priorities: ['x'.repeat(45)] });
		const number = fake.addIssue({ title: 'a' });
		fake.requests.splice(0);

		const error = await failure(() => t.backend.setPriority!(String(number), 'x'.repeat(45)));

		expect(error.message).toContain('label name length');
		expect(fake.requests).toEqual([]);
	});

	it('the timeline of a swap shows as priority activity', async () => {
		const number = fake.addIssue({ title: 'a', labels: ['priority:high'] });
		fake.addRepoLabel('priority:low');
		await t.backend.setPriority!(String(number), 'low');

		const activity = (await t.backend.get(String(number))).activity ?? [];

		expect(activity.filter(entry => entry.kind === 'priority')).toEqual([
			{ at: expect.any(String), kind: 'priority', newValue: 'high' },
			{ at: expect.any(String), kind: 'priority', oldValue: 'high' },
			{ at: expect.any(String), kind: 'priority', newValue: 'low' },
		]);
	});
});

describe('priority stored in the native issue field (priorityStorage: auto, definitions readable)', () => {
	beforeEach(async () => {
		fake = await FakeGitHub.start({ repo: 'acme/shop', issueFields: FIELDS, issueFieldDefinitions: 'readable' });
		t = make({ options: { priorityStorage: 'auto' } });
	});

	it('the list carries the priority of every issue in ONE request, asked with the field API version (once the storage is known)', async () => {
		const a = fake.addIssue({ title: 'a' });
		const b = fake.addIssue({ title: 'b' });
		fake.setIssueField(a, 'Priority', 'High');
		fake.setIssueField(b, 'Priority', 'Low');
		// A write, a check or an earlier command found where the priority lives (a plain read never asks, see the resolution tests).
		await t.resolver.resolve();
		fake.requests.splice(0);

		const tasks = await t.backend.list();

		expect(tasks.map(task => [task.id, task.priority])).toEqual([
			['1', 'high'],
			['2', 'low'],
		]);
		expect(fake.requests.map(request => `${request.method} ${request.path}`)).toEqual([
			'GET /repos/acme/shop/issues',
		]);
		expect(fake.requests[0]!.apiVersion).toBe(FIELDS_API_VERSION);
	});

	it('set: one POST of the value by option name, no label, the record and the list agree; the same value writes nothing', async () => {
		const number = fake.addIssue({ title: 'a' });

		const record = await t.backend.setPriority!(String(number), 'high');

		expect(record.priority).toBe('high');
		expect(fake.fieldValuesOf(number)).toEqual({ Priority: 'High' });
		expect(labelsOf(number)).toEqual([]);
		expect(fake.writes().map(request => `${request.method} ${request.path.replace(R, '')}`)).toEqual([
			'POST /issues/1/issue-field-values',
		]);
		expect(fake.writes()[0]!.body).toEqual({ issue_field_values: [{ field_id: 501, value: 'High' }] });
		expect(fake.writes()[0]!.apiVersion).toBe(FIELDS_API_VERSION);
		expect((await t.backend.list())[0]!.priority).toBe('high');
		fake.requests.splice(0);
		await t.backend.setPriority!(String(number), 'high');
		expect(sent()).toEqual([]);
	});

	it('the other issue fields of the issue are never touched', async () => {
		const number = fake.addIssue({ title: 'a' });
		fake.setIssueField(number, 'Area', 'Backend');

		await t.backend.setPriority!(String(number), 'urgent');
		expect(fake.fieldValuesOf(number)).toEqual({ Priority: 'Urgent', Area: 'Backend' });
		await t.backend.clearPriority!(String(number));
		expect(fake.fieldValuesOf(number)).toEqual({ Area: 'Backend' });
	});

	it('clear: one DELETE of the field value; clearing again writes nothing', async () => {
		const number = fake.addIssue({ title: 'a' });
		fake.setIssueField(number, 'Priority', 'Low');

		const cleared = await t.backend.clearPriority!(String(number));

		expect(cleared.priority).toBeUndefined();
		expect(fake.writes().map(request => `${request.method} ${request.path.replace(R, '')}`)).toEqual([
			'DELETE /issues/1/issue-field-values/501',
		]);
		fake.requests.splice(0);
		await t.backend.clearPriority!(String(number));
		expect(sent()).toEqual([]);
	});

	it('a priority the field has no option for is refused before any write, naming the options and the fix', async () => {
		await fake.stop();
		fake = await FakeGitHub.start({
			repo: 'acme/shop',
			issueFields: [{ id: 501, name: 'Priority', options: ['Urgent', 'High'] }],
			issueFieldDefinitions: 'readable',
		});
		t = make({ options: { priorityStorage: 'auto' } });
		const number = fake.addIssue({ title: 'a' });

		const error = await failure(() => t.backend.setPriority!(String(number), 'low'));

		expect(error).toBeInstanceOf(BackendRejectedError);
		expect(error.message).toContain(
			'the issue field "Priority" has no option for the priority "low" (it has: Urgent, High)'
		);
		expect((error as BackendRejectedError).hint).toContain('priorityMap');
		expect(sent()).toEqual([]);
	});

	it('priorityMap maps a priority to the option of the field', async () => {
		await fake.stop();
		fake = await FakeGitHub.start({
			repo: 'acme/shop',
			issueFields: [{ id: 501, name: 'Priority', options: ['P0', 'P1', 'P2', 'P3'] }],
			issueFieldDefinitions: 'readable',
		});
		t = make({
			options: { priorityStorage: 'auto', priorityMap: { urgent: 'P0', high: 'P1', medium: 'P2', low: 'P3' } },
		});
		const number = fake.addIssue({ title: 'a' });

		const record = await t.backend.setPriority!(String(number), 'medium');

		expect(record.priority).toBe('medium');
		expect(fake.fieldValuesOf(number)).toEqual({ Priority: 'P2' });
	});

	it('an option the project has no priority for reads as no priority and says so, once', async () => {
		await fake.stop();
		fake = await FakeGitHub.start({
			repo: 'acme/shop',
			issueFields: [{ id: 501, name: 'Priority', options: ['Blocker', 'High'] }],
			issueFieldDefinitions: 'readable',
		});
		t = make({ options: { priorityStorage: 'auto' } });
		const number = fake.addIssue({ title: 'a' });
		fake.setIssueField(number, 'Priority', 'Blocker');
		await t.resolver.resolve();

		expect((await t.backend.list())[0]!.priority).toBeUndefined();
		await t.backend.get(String(number));

		expect(t.notices.filter(notice => notice.kind === 'ignored')).toHaveLength(1);
		expect(t.notices[0]!.text).toContain(
			'has the value "Blocker" in the issue field Priority, which is not a priority'
		);
	});

	it('in the field storage a label priority:low is an ordinary label: shown, never read as the priority, never touched', async () => {
		const number = fake.addIssue({ title: 'a', labels: ['priority:low'] });
		fake.setIssueField(number, 'Priority', 'High');
		await t.resolver.resolve();

		const record = await t.backend.get(String(number));
		expect(record.priority).toBe('high');
		expect(record.labels).toEqual(['priority:low']);
		await t.backend.setPriority!(String(number), 'urgent');
		expect(labelsOf(number)).toEqual(['priority:low']);
		const cleared = await t.backend.clearPriority!(String(number));
		expect(cleared.priority).toBeUndefined();
		expect(labelsOf(number)).toEqual(['priority:low']);
	});

	it('a change of the field on GitHub meanwhile is a conflict for a write that expected the old value', async () => {
		const number = fake.addIssue({ title: 'a' });
		fake.setIssueField(number, 'Priority', 'High');
		const read = await t.backend.get(String(number));
		fake.setIssueField(number, 'Priority', 'Low');

		const conflict = await failure(() =>
			t.backend.setPriority!(String(number), 'urgent', { expectedRevision: read.revision })
		);

		expect(conflict).toBeInstanceOf(StaleRevisionError);
		expect(fake.fieldValuesOf(number)).toEqual({ Priority: 'Low' });
	});

	it('a refusal of GitHub is the loud error with the hint about the option names, and nothing is applied', async () => {
		await fake.stop();
		// The options are not known with priorityFieldId (the definitions are not read): GitHub judges the value. The status GitHub
		// answers for an unknown option was never observed, so this test FORCES a 422 to prove how a refusal reaches the user.
		fake = await FakeGitHub.start({ repo: 'acme/shop', issueFields: FIELDS });
		t = make({ options: { priorityStorage: 'field', priorityFieldId: 501 } });
		const number = fake.addIssue({ title: 'a' });
		fake.failNext({
			status: 422,
			method: 'POST',
			pathPrefix: `${R}/issues/1/issue-field-values`,
			body: { message: 'Validation Failed', errors: ['value is not an option of the field'] },
		});

		const refused = await failure(() => t.backend.setPriority!(String(number), 'high'));

		expect(refused).toBeInstanceOf(BackendRejectedError);
		expect(refused.message).toContain('GitHub refused setPriority');
		expect((refused as BackendRejectedError).hint).toContain('priorityMap');
		expect(fake.fieldValuesOf(number)).toEqual({});
	});
});

describe('priorityStorage: auto without the right to read the definitions', () => {
	it('falls back to labels: the same commands, nothing set in a field, and the issues are read with the default API version', async () => {
		fake = await FakeGitHub.start({ repo: 'acme/shop', issueFields: FIELDS });
		t = make({ options: { priorityStorage: 'auto' } });
		const number = fake.addIssue({ title: 'a' });
		// A value somebody put in the field must not hide the label this strategy writes.
		fake.setIssueField(number, 'Priority', 'Urgent');

		const record = await t.backend.setPriority!(String(number), 'low');

		expect(record.priority).toBe('low');
		expect(labelsOf(number)).toEqual(['priority:low']);
		expect(fake.fieldValuesOf(number)).toEqual({ Priority: 'Urgent' });
		expect(
			fake.requests.filter(request => request.path.includes('/issues')).every(r => r.apiVersion === '2022-11-28')
		).toBe(true);
	});

	it('priorityStorage: field with no way to find the field fails at the first use with the fix, and writes nothing', async () => {
		fake = await FakeGitHub.start({ repo: 'acme/shop', issueFields: FIELDS });
		t = make({ options: { priorityStorage: 'field' } });
		const number = fake.addIssue({ title: 'a' });

		const error = await failure(() => t.backend.setPriority!(String(number), 'high'));

		expect(error).toBeInstanceOf(BackendRejectedError);
		expect(error.message).toContain('priorityStorage: field needs the issue field "Priority"');
		expect(sent()).toEqual([]);
	});
});

describe('the whole backlog with priority, assignee and lease in ONE list read (no request per issue)', () => {
	const claimBlock = (json: string): string => `<!-- task:begin v1 -->${json}<!-- task:end -->`;

	async function seed(): Promise<void> {
		for (let index = 1; index <= 230; index++) {
			const claimed = index % 10 === 0;
			fake.addIssue({
				title: `Task ${index}`,
				labels: index % 3 === 0 ? ['priority:high'] : [],
				...(claimed
					? {
							body: `Text\n\n${claimBlock('{"claim":{"assignee":"w1","claimedAt":"2026-11-14T10:00:00.000Z","leaseUntil":"2026-11-14T10:30:00.000Z"}}')}`,
						}
					: {}),
			});
		}
		fake.requests.splice(0);
	}

	it('labels: three requests for 230 issues (pages of 100), every summary carries what a dispatcher needs', async () => {
		fake = await FakeGitHub.start({ repo: 'acme/shop' });
		t = make();
		await seed();

		const tasks = await t.backend.list();

		expect(fake.requests.map(request => request.path)).toEqual([
			'/repos/acme/shop/issues',
			'/repos/acme/shop/issues',
			'/repos/acme/shop/issues',
		]);
		expect(tasks).toHaveLength(230);
		expect(tasks.filter(task => task.priority === 'high')).toHaveLength(76);
		const claimed = tasks.filter(task => task.assignee !== undefined);
		expect(claimed).toHaveLength(23);
		expect(claimed[0]).toMatchObject({ assignee: 'w1', leaseUntil: '2026-11-14T10:30:00.000Z' });
	});

	it('the field: the same pages, no request of their own for the storage', async () => {
		fake = await FakeGitHub.start({ repo: 'acme/shop', issueFields: FIELDS, issueFieldDefinitions: 'readable' });
		t = make({ options: { priorityStorage: 'auto' } });
		await seed();
		fake.setIssueField(7, 'Priority', 'Urgent');
		await t.resolver.resolve();
		fake.requests.splice(0);

		const tasks = await t.backend.list();

		expect(fake.requests.map(request => request.path)).toEqual([
			'/repos/acme/shop/issues',
			'/repos/acme/shop/issues',
			'/repos/acme/shop/issues',
		]);
		expect(tasks.find(task => task.id === '7')?.priority).toBe('urgent');
		expect(tasks).toHaveLength(230);
	});
});
