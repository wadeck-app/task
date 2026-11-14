// Priority on GitLab: ALWAYS a label (GitLab Free has no priority field), `<priorityPrefix><name>` or a name of priorityMap. Written
// in ONE PUT of the whole label set (a swap), read from the label list of the issue list, reserved against add-label / remove-label.
import {
	BackendDataError,
	BackendRejectedError,
	InvalidTaskFieldError,
	StaleRevisionError,
	UnknownPriorityError,
} from '@wadeck-app/task-core';

import type { DeclaredFills } from '../kinds.js';
import { FakeGitLab } from './fakeGitLab.testkit.js';
import { WRITE_STATUSES, makeGitLabBackend, writeStatusMap } from './gitlabBackend.testkit.js';
import type { TestBackend } from './gitlabBackend.testkit.js';

let fake: FakeGitLab;
let t: TestBackend;

const P = '/projects/42';

async function start(
	options: Record<string, unknown> = {},
	extra: { priorities?: string[]; fills?: DeclaredFills } = {}
): Promise<void> {
	fake = await FakeGitLab.start();
	t = makeGitLabBackend(fake, {
		statuses: WRITE_STATUSES,
		projectTypes: ['bug', 'feature'],
		options: { statusMap: writeStatusMap(), ...options },
		...(extra.priorities === undefined ? {} : { priorities: extra.priorities }),
		...(extra.fills === undefined ? {} : { fills: extra.fills }),
	});
}

beforeEach(async () => {
	await start();
});

afterEach(async () => {
	await fake.stop();
});

const sent = (): string[] => fake.writes().map(request => `${request.method} ${request.path.replace(P, '')}`);

const failure = async (call: () => Promise<unknown>): Promise<Error> => {
	try {
		await call();
	} catch (error) {
		return error as Error;
	}
	throw new Error('expected a failure');
};

describe('setPriority / clearPriority', () => {
	it('adds the label priority:<name> with ONE PUT; the record and the list read it back; the label is not a user label', async () => {
		const iid = fake.seedIssue({ title: 'a', labels: ['frontend'] });

		const record = await t.backend.setPriority!(String(iid), 'high');

		expect(record.priority).toBe('high');
		expect(record.labels).toEqual(['frontend']);
		expect(fake.labelsOf(iid).sort()).toEqual(['frontend', 'priority:high']);
		expect(sent()).toEqual(['PUT /issues/1']);
		expect((await t.backend.list())[0]).toMatchObject({ id: '1', priority: 'high' });
	});

	it('a swap is ONE PUT that leaves exactly one priority label, whatever the issue held', async () => {
		const iid = fake.seedIssue({ title: 'a', labels: ['priority:low', 'bug'] });
		fake.requests.length = 0;

		const record = await t.backend.setPriority!(String(iid), 'urgent');

		expect(record.priority).toBe('urgent');
		expect(fake.labelsOf(iid).filter(label => label.startsWith('priority:'))).toEqual(['priority:urgent']);
		expect(sent()).toEqual(['PUT /issues/1']);
		expect(fake.writes()[0]!.body).toEqual({ labels: expect.stringContaining('priority:urgent') });
		expect(JSON.stringify(fake.writes()[0]!.body)).not.toContain('priority:low');
	});

	it('the same priority writes nothing', async () => {
		const iid = fake.seedIssue({ title: 'a', labels: ['priority:high'] });
		fake.requests.length = 0;

		const record = await t.backend.setPriority!(String(iid), 'high');

		expect(record.priority).toBe('high');
		expect(sent()).toEqual([]);
	});

	it('cleans up two priority labels written by hand (set repairs, no error on a write)', async () => {
		const iid = fake.seedIssue({ title: 'a', labels: ['priority:low', 'priority:high'] });

		await t.backend.setPriority!(String(iid), 'high');

		expect(fake.labelsOf(iid)).toEqual(['priority:high']);
	});

	it('clear removes every priority label with ONE PUT; clearing an issue with none writes nothing', async () => {
		const iid = fake.seedIssue({ title: 'a', labels: ['priority:high', 'bug'] });
		fake.requests.length = 0;

		const cleared = await t.backend.clearPriority!(String(iid));

		expect(cleared.priority).toBeUndefined();
		expect(fake.labelsOf(iid)).toEqual(['bug']);
		expect(sent()).toEqual(['PUT /issues/1']);
		fake.requests.length = 0;
		await t.backend.clearPriority!(String(iid));
		expect(sent()).toEqual([]);
	});

	it('refuses an unknown or blank priority before any request, listing the valid ones', async () => {
		const iid = fake.seedIssue({ title: 'a' });
		fake.requests.length = 0;

		const unknown = await failure(() => t.backend.setPriority!(String(iid), 'critical'));
		const blank = await failure(() => t.backend.setPriority!(String(iid), '  '));

		expect(unknown).toBeInstanceOf(UnknownPriorityError);
		expect(unknown.message).toContain('urgent');
		expect(blank).toBeInstanceOf(InvalidTaskFieldError);
		expect(fake.requests).toEqual([]);
	});

	it('an unknown task is not found', async () => {
		await expect(t.backend.setPriority!('99', 'high')).rejects.toMatchObject({ name: 'TaskNotFoundError' });
	});

	it('keeps the status, type and meta labels of the issue and the claim of its block', async () => {
		await start({}, { fills: { meta: { use: 'labels', fidelity: 'strict' } } });
		const iid = fake.seedIssue({ title: 'a', labels: ['status:review', 'type:bug', 'meta:owner=ann'] });
		await t.backend.setAssignee!(String(iid), 'w1');

		const record = await t.backend.setPriority!(String(iid), 'medium');

		expect(record).toMatchObject({ priority: 'medium', status: 'review', type: 'bug', assignee: 'w1' });
		expect(record.meta).toEqual({ owner: 'ann' });
	});
});

describe('what the priority label is not', () => {
	it('add-label and remove-label refuse a priority label BEFORE any request, naming set-priority', async () => {
		const iid = fake.seedIssue({ title: 'a', labels: ['priority:high'] });
		fake.requests.length = 0;

		const add = await failure(() => t.backend.addLabel(String(iid), 'priority:low'));
		const remove = await failure(() => t.backend.removeLabel(String(iid), 'priority:high'));

		for (const error of [add, remove]) {
			expect(error).toBeInstanceOf(BackendRejectedError);
			expect(error.message).toContain('is reserved');
			expect((error as BackendRejectedError).hint).toContain('task set-priority');
		}
		expect(fake.requests).toEqual([]);
		expect(fake.labelsOf(iid)).toEqual(['priority:high']);
	});

	it('a label that only looks alike (another prefix, another case) is an ordinary label', async () => {
		const iid = fake.seedIssue({ title: 'a', labels: ['Priority:high', 'priorities'] });

		const record = await t.backend.get(String(iid));

		expect(record.priority).toBeUndefined();
		expect(record.labels).toEqual(['Priority:high', 'priorities']);
		await t.backend.addLabel(String(iid), 'prio');
		expect(fake.labelsOf(iid)).toContain('prio');
	});

	it('the listing of labels leaves the priority labels out', async () => {
		fake.seedIssue({ title: 'a', labels: ['priority:high', 'frontend'] });

		expect(await t.backend.listLabels()).toEqual([{ label: 'frontend', count: 1 }]);
	});
});

describe('reading the priority', () => {
	it('two priority labels are a BackendDataError naming the issue, on a read and on the list', async () => {
		const iid = fake.seedIssue({ title: 'a', labels: ['priority:high', 'priority:low'] });

		const read = await failure(() => t.backend.get(String(iid)));
		const list = await failure(() => t.backend.list());

		for (const error of [read, list]) {
			expect(error).toBeInstanceOf(BackendDataError);
			expect(error.message).toContain('issue #1 carries two priority labels');
			expect((error as BackendDataError).hint).toContain('Remove one of them');
		}
	});

	it('a label of a priority the project does not have reads as no priority, is reported once, and stays reserved', async () => {
		const iid = fake.seedIssue({ title: 'a', labels: ['priority:critical'] });

		const first = await t.backend.get(String(iid));
		await t.backend.get(String(iid));
		const summary = (await t.backend.list())[0]!;

		expect(first.priority).toBeUndefined();
		expect(first.labels).toBeUndefined();
		expect(summary.priority).toBeUndefined();
		const reported = t.notices.filter(notice => notice.text.includes('priority:critical'));
		expect(reported).toHaveLength(1);
		expect(reported[0]).toMatchObject({ kind: 'ignored' });
		expect(reported[0]!.text).toContain('urgent, high, medium, low');
	});

	it('the activity shows a priority change as kind priority, with the priority name', async () => {
		const iid = fake.seedIssue({ title: 'a' });
		await t.backend.setPriority!(String(iid), 'high');
		await t.backend.setPriority!(String(iid), 'low');
		const record = await t.backend.clearPriority!(String(iid));

		const rows = (record.activity ?? []).filter(entry => entry.kind === 'priority');

		expect(rows.map(({ kind, oldValue, newValue }) => ({ kind, oldValue, newValue }))).toEqual([
			// The swap high -> low is ONE PUT: GitLab records the added label before the removed one.
			{ kind: 'priority', oldValue: undefined, newValue: 'high' },
			{ kind: 'priority', oldValue: undefined, newValue: 'low' },
			{ kind: 'priority', oldValue: 'high', newValue: undefined },
			{ kind: 'priority', oldValue: 'low', newValue: undefined },
		]);
		expect(record.activity!.some(entry => entry.kind === 'label-added')).toBe(false);
	});
});

describe('options', () => {
	it('a scoped prefix (priority::) is an ordinary label on Free: written and read the same way', async () => {
		await fake.stop();
		await start({ priorityPrefix: 'priority::' });
		const iid = fake.seedIssue({ title: 'a' });

		const record = await t.backend.setPriority!(String(iid), 'high');

		expect(record.priority).toBe('high');
		expect(fake.labelsOf(iid)).toEqual(['priority::high']);
		// The swap is still ONE PUT: exclusivity is the wrapper's, not GitLab's.
		fake.requests.length = 0;
		await t.backend.setPriority!(String(iid), 'low');
		expect(sent()).toEqual(['PUT /issues/1']);
		expect(fake.labelsOf(iid)).toEqual(['priority::low']);
	});

	it('priorityMap gives a priority a whole label name; the other priorities keep the prefix', async () => {
		await fake.stop();
		await start({ priorityMap: { urgent: 'P0' } });
		const iid = fake.seedIssue({ title: 'a', labels: ['P0'] });

		expect((await t.backend.get(String(iid))).priority).toBe('urgent');
		await t.backend.setPriority!(String(iid), 'high');
		expect(fake.labelsOf(iid)).toEqual(['priority:high']);
		await t.backend.setPriority!(String(iid), 'urgent');
		expect(fake.labelsOf(iid)).toEqual(['P0']);
		const error = await failure(() => t.backend.addLabel(String(iid), 'P0'));
		expect(error.message).toContain('is reserved');
	});
});

describe('the revision of a priority', () => {
	it('is compared on the priority part: a priority changed meanwhile is stale, a title or a claim changed meanwhile is not', async () => {
		const iid = fake.seedIssue({ title: 'a', labels: ['priority:low'] });
		const read = await t.backend.get(String(iid));
		await t.backend.setTitle(String(iid), 'renamed');
		await t.backend.setAssignee!(String(iid), 'w1');

		const ok = await t.backend.setPriority!(String(iid), 'high', { expectedRevision: read.revision });
		expect(ok.priority).toBe('high');

		const second = await t.backend.get(String(iid));
		await t.backend.setPriority!(String(iid), 'urgent');
		const stale = await failure(() =>
			t.backend.setPriority!(String(iid), 'low', { expectedRevision: second.revision })
		);
		expect(stale).toBeInstanceOf(StaleRevisionError);
		expect(fake.labelsOf(iid)).toEqual(['priority:urgent']);
	});

	it('a priority change does not make a description edit or a claim stale', async () => {
		const iid = fake.seedIssue({ title: 'a', description: 'Text' });
		const read = await t.backend.get(String(iid));
		await t.backend.setPriority!(String(iid), 'high');

		const edited = await t.backend.setDescription(String(iid), 'Other', { expectedRevision: read.revision });

		expect(edited.description).toBe('Other');
		expect(edited.priority).toBe('high');
	});
});
