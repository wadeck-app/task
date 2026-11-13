// The write path of the gitlab backend over the fake server: create, status, title and description, type, labels, meta (the hierarchy is in GitLabBackend.hierarchy.test.ts).
// Every test says what reached GitLab (`sent()`), because the order and the number of calls are part of the design.
// The fake is a copy of gitlab.com Free as recorded on 2026-11-09 (gitlabConformance.test.ts keeps it honest).
import {
	BackendLimitError,
	BackendRejectedError,
	BackendUnreachableError,
	PartialWriteError,
	StaleRevisionError,
	TaskConflictError,
	TaskNotFoundError,
	UnsupportedByBackendError,
} from '@wadeck-app/task-core';

import { FakeGitLab } from './fakeGitLab.testkit.js';
import { WRITE_STATUSES, makeGitLabBackend, writeStatusMap } from './gitlabBackend.testkit.js';
import type { TestBackend } from './gitlabBackend.testkit.js';
import type { DeclaredFills } from '../kinds.js';

let fake: FakeGitLab;
let t: TestBackend;

const P = '/projects/42';

async function start(extra: { fills?: DeclaredFills; types?: Record<string, unknown> } = {}) {
	fake = await FakeGitLab.start();
	t = makeGitLabBackend(fake, {
		statuses: WRITE_STATUSES,
		projectTypes: ['bug', 'feature', 'incident'],
		options: { statusMap: writeStatusMap(), ...(extra.types === undefined ? {} : { typeMap: extra.types }) },
		...(extra.fills === undefined ? {} : { fills: extra.fills }),
	});
}

beforeEach(async () => {
	await start();
});

afterEach(async () => {
	await fake.stop();
});

/** Every write that reached the fake, as `METHOD /path`. */
const sent = (): string[] => fake.writes().map(request => `${request.method} ${request.path.replace(P, '')}`);
const bodies = (): unknown[] => fake.writes().map(request => request.body);

const failure = async (call: () => Promise<unknown>): Promise<Error> => {
	try {
		await call();
	} catch (error) {
		return error as Error;
	}
	throw new Error('expected a failure');
};

describe('create', () => {
	it('creates an issue in the default status with one POST and returns the record read back', async () => {
		const created = await t.backend.create({ title: 'First', status: 'backlog' });

		expect(created).toMatchObject({ id: '1', title: 'First', status: 'backlog' });
		expect(created.revision).toBeTypeOf('string');
		expect(sent()).toEqual(['POST /issues']);
		expect(bodies()).toEqual([{ title: 'First' }]);
	});

	it('sends the description only when it differs from the title, and the status label with the create', async () => {
		await t.backend.create({ title: 'Same', status: 'backlog', description: ' Same ' });
		const second = await t.backend.create({ title: 'Other', status: 'review', description: 'Some words' });

		expect(second).toMatchObject({ status: 'review', description: 'Some words' });
		expect(bodies()).toEqual([
			{ title: 'Same' },
			{ title: 'Other', description: 'Some words', labels: 'status:review' },
		]);
	});

	it('creates a task in a terminal status with a create then a close, because GitLab has no state in a create', async () => {
		const created = await t.backend.create({ title: 'Already done', status: 'cancelled' });

		expect(created.status).toBe('cancelled');
		expect(sent()).toEqual(['POST /issues', 'PUT /issues/1']);
		expect(bodies()[1]).toEqual({ state_event: 'close' });
		expect(fake.issue(1)!.state).toBe('closed');
		expect(fake.labelsOf(1)).toEqual(['status:cancelled']);
	});

	it('says what GitLab holds when the closing fails after the creation (PartialWriteError with the command to finish)', async () => {
		fake.failNext({ status: 400, method: 'PUT', body: { message: '400 Bad request' } });

		const error = (await failure(() => t.backend.create({ title: 'Half', status: 'done' }))) as PartialWriteError;

		expect(error).toBeInstanceOf(PartialWriteError);
		expect(error.applied).toEqual(['created issue #1']);
		expect(error.notApplied).toEqual(['closed the issue']);
		expect(error.hint).toContain('task set-status 1 done');
		expect(fake.issue(1)!.state).toBe('opened');
	});

	it('refuses a parent that does not exist before creating anything', async () => {
		fake.requests.length = 0;

		const error = await failure(() => t.backend.create({ title: 'Child', status: 'backlog', parentId: '7' }));

		expect(error).toBeInstanceOf(TaskNotFoundError);
		expect(fake.writes()).toEqual([]);
	});

	it('refuses a status the map lacks with the key to write', async () => {
		const error = await failure(() => t.backend.create({ title: 'x', status: 'nonsense' }));

		expect(error).toBeInstanceOf(UnsupportedByBackendError);
		expect((error as UnsupportedByBackendError).hint).toContain('statusMap');
	});

	it('turns a refusal of GitLab into a BackendRejectedError that carries its words and says nothing changed', async () => {
		fake.failNext({ status: 400, body: { message: { title: ["can't be blank"] } } });

		const error = await failure(() => t.backend.create({ title: 'x', status: 'backlog' }));

		expect(error).toBeInstanceOf(BackendRejectedError);
		expect(error.message).toContain("title can't be blank");
		expect((error as BackendRejectedError).hint).toContain('Nothing was changed');
	});
});

describe('quick actions are never sent', () => {
	it.each([
		['create description', () => t.backend.create({ title: 'x', status: 'backlog', description: 'Fine\n/close' })],
		[
			'setDescription',
			async () => (
				await t.backend.create({ title: 'x', status: 'backlog' }),
				t.backend.setDescription('1', '/label ~bug')
			),
		],
		[
			'addComment',
			async () => (
				await t.backend.create({ title: 'x', status: 'backlog' }),
				t.backend.addComment('1', 'ok\n/duplicate #2')
			),
		],
	])('refuses %s with a line that starts with a slash command, before any request', async (_name, call) => {
		const before = fake.writes().length;
		const error = await failure(call);

		expect(error).toBeInstanceOf(BackendRejectedError);
		expect(error.message).toContain('quick action');
		expect((error as BackendRejectedError).hint).toContain('Nothing was sent');
		expect(fake.quickActionsRun).toBe(0);
		// the setup of the other two cases creates one issue; the guarded call itself sent nothing
		expect(fake.writes().length - before).toBeLessThanOrEqual(1);
	});

	it('refuses a quick action in setDescription BEFORE ANY request, reads included', async () => {
		await t.backend.create({ title: 'x', status: 'backlog' });
		fake.requests.length = 0;

		const error = await failure(() => t.backend.setDescription('1', 'fine\n/close'));

		expect(error).toBeInstanceOf(BackendRejectedError);
		expect(fake.requests).toEqual([]);
	});

	it('lets a path in the middle of a line, and a path with several slashes, through', async () => {
		await t.backend.create({ title: 'x', status: 'backlog', description: 'see /usr/bin/node\nand a/b' });

		expect(fake.issue(1)!.description).toBe('see /usr/bin/node\nand a/b');
	});

	it('does not look at titles', async () => {
		const created = await t.backend.create({ title: '/close me', status: 'backlog' });

		expect(created.title).toBe('/close me');
		expect(fake.quickActionsRun).toBe(0);
	});
});

describe('updateStatus', () => {
	it('is ONE PUT with the state and the whole label set, and the answer is read back', async () => {
		await t.backend.create({ title: 'T', status: 'in-progress' });
		fake.requests.length = 0;

		const record = await t.backend.updateStatus('1', 'done');

		expect(record.status).toBe('done');
		expect(sent()).toEqual(['PUT /issues/1']);
		expect(bodies()).toEqual([{ labels: '', state_event: 'close' }]);
		expect(fake.labelsOf(1)).toEqual([]);
	});

	it('swaps one status label for another in one PUT, keeping the user labels', async () => {
		await t.backend.create({ title: 'T', status: 'in-progress' });
		await t.backend.addLabel('1', 'urgent');
		fake.requests.length = 0;

		await t.backend.updateStatus('1', 'review');

		expect(sent()).toEqual(['PUT /issues/1']);
		expect(bodies()).toEqual([{ labels: 'urgent,status:review' }]);
	});

	it('reopens with state_event reopen', async () => {
		await t.backend.create({ title: 'T', status: 'done' });
		fake.requests.length = 0;

		const record = await t.backend.updateStatus('1', 'backlog');

		expect(record.status).toBe('backlog');
		expect(bodies()).toEqual([{ state_event: 'reopen' }]);
	});

	it('tells two ways to end apart with their labels', async () => {
		await t.backend.create({ title: 'T', status: 'backlog' });

		expect((await t.backend.updateStatus('1', 'cancelled')).status).toBe('cancelled');
		expect((await t.backend.updateStatus('1', 'duplicate')).status).toBe('duplicate');
		expect((await t.backend.updateStatus('1', 'done')).status).toBe('done');
		expect(fake.labelsOf(1)).toEqual([]);
	});

	it('refuses the status the task already has, with nothing sent', async () => {
		await t.backend.create({ title: 'T', status: 'backlog' });
		fake.requests.length = 0;

		const error = await failure(() => t.backend.updateStatus('1', 'backlog'));

		expect(error).toBeInstanceOf(TaskConflictError);
		expect(fake.writes()).toEqual([]);
	});

	it('is a BackendDataError naming the issue when GitLab answers without applying the change', async () => {
		await t.backend.create({ title: 'T', status: 'backlog' });
		fake.failNext({ status: 200, method: 'PUT', body: fake.issue(1) && { ...jsonOfIssue(1) } });

		const error = await failure(() => t.backend.updateStatus('1', 'done'));

		expect(error.name).toBe('BackendDataError');
		expect(error.message).toContain('did not apply');
	});

	it('is a 404 as TaskNotFoundError', async () => {
		expect(await failure(() => t.backend.updateStatus('99', 'done'))).toBeInstanceOf(TaskNotFoundError);
	});
});

/** The issue as GitLab sends it, for forging an answer. */
function jsonOfIssue(iid: number): Record<string, unknown> {
	const issue = fake.issue(iid)!;
	return {
		id: issue.id,
		iid: issue.iid,
		project_id: 42,
		title: issue.title,
		description: issue.description,
		state: issue.state,
		labels: issue.labels,
		created_at: issue.createdAt,
		updated_at: issue.updatedAt,
		issue_type: issue.issueType,
	};
}

describe('revisions (optimistic, not atomic)', () => {
	it('refuses a write whose revision no longer matches the part it changes, before writing', async () => {
		const created = await t.backend.create({ title: 'T', status: 'backlog' });
		await t.backend.setTitle('1', 'Renamed elsewhere');
		fake.requests.length = 0;

		const error = await failure(() => t.backend.setTitle('1', 'Mine', { expectedRevision: created.revision }));

		expect(error).toBeInstanceOf(StaleRevisionError);
		expect(fake.writes()).toEqual([]);
	});

	it('does not call a comment or another field a conflict for a write that does not touch it', async () => {
		const created = await t.backend.create({ title: 'T', status: 'backlog' });
		await t.backend.addComment('1', 'a note');
		await t.backend.addLabel('1', 'urgent');

		const record = await t.backend.setTitle('1', 'Mine', { expectedRevision: created.revision });

		expect(record.title).toBe('Mine');
	});

	it('treats a revision this backend did not issue as stale for any write', async () => {
		await t.backend.create({ title: 'T', status: 'backlog' });

		expect(await failure(() => t.backend.setTitle('1', 'x', { expectedRevision: 'abc' }))).toBeInstanceOf(
			StaleRevisionError
		);
	});
});

describe('title and description', () => {
	it('renames with one PUT, and sends nothing for the same title', async () => {
		await t.backend.create({ title: 'T', status: 'backlog' });
		fake.requests.length = 0;

		await t.backend.setTitle('1', 'T');
		await t.backend.setTitle('1', 'New');

		expect(sent()).toEqual(['PUT /issues/1']);
		expect(bodies()).toEqual([{ title: 'New' }]);
	});

	it('keeps the managed block of the description and clears a description equal to the title', async () => {
		fake.seedIssue({
			title: 'T',
			description:
				'old text\n\n<!-- task:begin v1 -->{"links":[{"type":"causedBy","target":"2"}]}<!-- task:end -->',
		});

		await t.backend.setDescription('1', 'new text');
		expect(fake.issue(1)!.description).toBe(
			'new text\n\n<!-- task:begin v1 -->{"links":[{"type":"causedBy","target":"2"}]}<!-- task:end -->'
		);

		await t.backend.setDescription('1', 'T');
		expect(fake.issue(1)!.description).toBe(
			'<!-- task:begin v1 -->{"links":[{"type":"causedBy","target":"2"}]}<!-- task:end -->'
		);
	});

	it('refuses a description over GitLab limit before any request', async () => {
		await t.backend.create({ title: 'T', status: 'backlog' });
		fake.requests.length = 0;

		const error = await failure(() => t.backend.setDescription('1', 'x'.repeat(1_048_577)));

		expect(error).toBeInstanceOf(BackendLimitError);
		expect(fake.writes()).toEqual([]);
	});
});

describe('type', () => {
	it('sets a type with the typePrefix label and swaps it in one PUT of the whole set', async () => {
		await t.backend.create({ title: 'T', status: 'backlog' });
		await t.backend.addLabel('1', 'urgent');

		await t.backend.setType('1', 'bug');
		fake.requests.length = 0;
		const record = await t.backend.setType('1', 'feature');

		expect(record.type).toBe('feature');
		expect(sent()).toEqual(['PUT /issues/1']);
		expect(bodies()).toEqual([{ labels: 'urgent,type:feature' }]);
	});

	it('clears the type label, and does nothing when the type is already that one', async () => {
		await t.backend.create({ title: 'T', status: 'backlog' });
		await t.backend.setType('1', 'bug');
		fake.requests.length = 0;

		await t.backend.setType('1', 'bug');
		expect(fake.writes()).toEqual([]);

		const cleared = await t.backend.clearType('1');
		expect(cleared.type).toBeUndefined();
		expect(fake.labelsOf(1)).toEqual([]);
	});

	it('maps a type to a native issue type (incident) and gives it back to issue when another type replaces it', async () => {
		await fake.stop();
		await start({ types: { incident: { issueType: 'incident' } } });
		await t.backend.create({ title: 'T', status: 'backlog' });

		const incident = await t.backend.setType('1', 'incident');
		expect(incident.type).toBe('incident');
		expect(fake.issue(1)!.issueType).toBe('incident');
		expect(fake.labelsOf(1)).toEqual([]);

		const bug = await t.backend.setType('1', 'bug');
		expect(bug.type).toBe('bug');
		expect(fake.issue(1)!.issueType).toBe('issue');
		expect(fake.labelsOf(1)).toEqual(['type:bug']);

		await t.backend.setType('1', 'incident');
		await t.backend.clearType('1');
		expect(fake.issue(1)!.issueType).toBe('issue');
	});
});

describe('labels', () => {
	it('adds with add_labels and removes with remove_labels, one call each, idempotent', async () => {
		await t.backend.create({ title: 'T', status: 'backlog' });
		fake.requests.length = 0;

		await t.backend.addLabel('1', 'urgent');
		await t.backend.addLabel('1', 'urgent');
		await t.backend.removeLabel('1', 'urgent');
		await t.backend.removeLabel('1', 'urgent');

		expect(bodies()).toEqual([{ add_labels: 'urgent' }, { remove_labels: 'urgent' }]);
		expect(fake.labelsOf(1)).toEqual([]);
	});

	it('refuses reserved labels (status, type, tombstone) and unsendable names before any request', async () => {
		await t.backend.create({ title: 'T', status: 'backlog' });
		fake.requests.length = 0;

		for (const name of ['status:review', 'type:bug', 'task:deleted', 'a,b', ' padded']) {
			expect(await failure(() => t.backend.addLabel('1', name))).toBeInstanceOf(BackendRejectedError);
		}
		expect(fake.requests).toEqual([]);
	});

	it('refuses a 101st label with the limit and the way out', async () => {
		fake.seedIssue({ title: 'Full', labels: Array.from({ length: 100 }, (_, index) => `l${index}`) });

		const error = await failure(() => t.backend.addLabel('1', 'one-more'));

		expect(error).toBeInstanceOf(BackendLimitError);
		expect(error.message).toContain('100');
	});
});

describe('meta', () => {
	it('is refused without a fill, naming the fills', async () => {
		await t.backend.create({ title: 'T', status: 'backlog' });

		const error = await failure(() => t.backend.setMeta('1', 'owner', 'ann'));

		expect(error).toBeInstanceOf(UnsupportedByBackendError);
		expect((error as UnsupportedByBackendError).capability).toBe('meta');
		expect((error as UnsupportedByBackendError).hint).toContain('meta: labels');
		expect((error as UnsupportedByBackendError).hint).toContain('body-block');
	});

	it('labels: meta:key=value, a changed value is one PUT swapping the label', async () => {
		await fake.stop();
		await start({ fills: { meta: { use: 'labels', fidelity: 'strict' } } });
		await t.backend.create({ title: 'T', status: 'backlog' });

		await t.backend.setMeta('1', 'owner', 'ann');
		expect(fake.labelsOf(1)).toEqual(['meta:owner=ann']);
		fake.requests.length = 0;
		const record = await t.backend.setMeta('1', 'owner', 'bob');

		expect(record.meta).toEqual({ owner: 'bob' });
		expect(sent()).toEqual(['PUT /issues/1']);
		expect(fake.labelsOf(1)).toEqual(['meta:owner=bob']);

		const removed = await t.backend.removeMeta('1', 'owner');
		expect(removed.meta).toBeUndefined();
		expect(fake.labelsOf(1)).toEqual([]);
	});

	it('refuses a value a label cannot hold, and says where it can go', async () => {
		await fake.stop();
		await start({ fills: { meta: { use: 'labels', fidelity: 'strict' } } });
		await t.backend.create({ title: 'T', status: 'backlog' });

		const error = await failure(() => t.backend.setMeta('1', 'note', 'a,b'));

		expect(error).toBeInstanceOf(BackendRejectedError);
		expect((error as BackendRejectedError).hint).toContain('body-block');
	});

	it('body-block: keeps the meta in the description block, warns once that it is approximate', async () => {
		await fake.stop();
		await start({ fills: { meta: { use: 'body-block', fidelity: 'degrade' } } });
		await t.backend.create({ title: 'T', status: 'backlog', description: 'text' });

		await t.backend.setMeta('1', 'a', '1');
		await t.backend.setMeta('1', 'b', 'x, y = z');

		expect(fake.issue(1)!.description).toBe(
			'text\n\n<!-- task:begin v1 -->{"meta":{"a":"1","b":"x, y = z"}}<!-- task:end -->'
		);
		expect((await t.backend.get('1')).meta).toEqual({ a: '1', b: 'x, y = z' });
		expect(t.notices.filter(notice => notice.kind === 'emulated')).toHaveLength(1);

		await t.backend.removeMeta('1', 'a');
		await t.backend.removeMeta('1', 'b');
		expect(fake.issue(1)!.description).toBe('text');
	});
});

describe('what gitlab.com Free was recorded to do', () => {
	it('refuses a title of 256 characters before sending anything, on create and on rename', async () => {
		await t.backend.create({ title: 'T', status: 'backlog' });
		fake.requests.length = 0;
		const long = 'x'.repeat(256);

		const created = await failure(() => t.backend.create({ title: long, status: 'backlog' }));
		const renamed = await failure(() => t.backend.setTitle('1', long));

		expect(created).toBeInstanceOf(BackendLimitError);
		expect(created.message).toContain('title length');
		expect(renamed).toBeInstanceOf(BackendLimitError);
		expect(fake.requests).toEqual([]);
		// 255 is the maximum: accepted
		await t.backend.setTitle('1', 'x'.repeat(255));
		expect(fake.issue(1)!.title).toHaveLength(255);
	});

	it('maps a 400 that names a too long field to a BackendLimitError with the field and the text', async () => {
		await t.backend.create({ title: 'T', status: 'backlog' });
		fake.failNext({
			status: 400,
			method: 'PUT',
			body: { message: { title: ['is too long (maximum is 255 characters)'] } },
		});

		const title = await failure(() => t.backend.setTitle('1', 'New'));
		fake.failNext({
			status: 400,
			method: 'PUT',
			body: { message: { description: ['is too long (1 MiB). The maximum size is 1 MiB.'] } },
		});
		const description = await failure(() => t.backend.setDescription('1', 'text'));

		expect(title).toBeInstanceOf(BackendLimitError);
		expect((title as BackendLimitError).hint).toContain('title is too long (maximum is 255 characters)');
		expect(description).toBeInstanceOf(BackendLimitError);
		expect((description as BackendLimitError).limit).toBe(1_048_576);
		expect((description as BackendLimitError).hint).toContain('description is too long');
	});

	it('maps any other validation error to BackendRejectedError naming the field and the text', async () => {
		await t.backend.create({ title: 'T', status: 'backlog' });
		fake.failNext({ status: 400, method: 'PUT', body: { message: { title: ["can't be blank"] } } });

		const error = await failure(() => t.backend.setTitle('1', 'New'));

		expect(error).toBeInstanceOf(BackendRejectedError);
		expect(error.message).toContain("title can't be blank");
	});

	it('compares label names exactly: bug and Bug are two labels, each added, removed and counted on its own', async () => {
		await t.backend.create({ title: 'T', status: 'backlog' });
		fake.requests.length = 0;

		await t.backend.addLabel('1', 'bug');
		await t.backend.addLabel('1', 'Bug');
		await t.backend.removeLabel('1', 'BUG');
		await t.backend.removeLabel('1', 'bug');

		expect(bodies()).toEqual([{ add_labels: 'bug' }, { add_labels: 'Bug' }, { remove_labels: 'bug' }]);
		expect(fake.labelsOf(1)).toEqual(['Bug']);
		expect(await t.backend.listLabels()).toEqual([{ label: 'Bug', count: 1 }]);
	});

	it('swaps status labels written status::x in one PUT: they are plain labels on Free, with no exclusivity to rely on', async () => {
		await fake.stop();
		fake = await FakeGitLab.start();
		t = makeGitLabBackend(fake, {
			statuses: WRITE_STATUSES,
			options: {
				statusMap: {
					backlog: { state: 'open' },
					'in-progress': { state: 'open', label: 'status::in-progress' },
					review: { state: 'open', label: 'status::review' },
					done: { state: 'closed' },
					cancelled: { state: 'closed', label: 'status::cancelled' },
					duplicate: { state: 'closed', label: 'status::duplicate' },
				},
			},
		});
		await t.backend.create({ title: 'T', status: 'backlog' });
		fake.requests.length = 0;

		const started = await t.backend.updateStatus('1', 'in-progress');
		const reviewed = await t.backend.updateStatus('1', 'review');
		const done = await t.backend.updateStatus('1', 'done');

		expect([started.status, reviewed.status, done.status]).toEqual(['in-progress', 'review', 'done']);
		expect(bodies()).toEqual([
			{ labels: 'status::in-progress' },
			{ labels: 'status::review' },
			{ labels: '', state_event: 'close' },
		]);
		expect(fake.labelsOf(1)).toEqual([]);
		expect(fake.issue(1)!.state).toBe('closed');
	});

	it('never sends updated_at (GitLab would SET the stamp with it) in any request of any operation', async () => {
		await fake.stop();
		await start({ types: { incident: { issueType: 'incident' } } });
		await t.backend.create({ title: 'Parent', status: 'backlog', description: 'body' });
		const child = await t.backend.create({ title: 'Child', status: 'review', parentId: '1' });
		await t.backend.updateStatus(child.id, 'done');
		await t.backend.setTitle('1', 'Parent 2');
		await t.backend.setDescription('1', 'body 2');
		await t.backend.setType('1', 'incident');
		await t.backend.clearType('1');
		await t.backend.addLabel('1', 'urgent');
		await t.backend.removeLabel('1', 'urgent');
		await t.backend.addComment('1', 'a note');
		await t.backend.removeParent(child.id);
		await t.backend.setParent(child.id, '1');
		await t.backend.list();
		await t.backend.get(child.id);

		const sentText = fake.requests
			.map(request => JSON.stringify(request.body ?? '') + request.query + request.rawPath)
			.join('\n');
		expect(fake.requests.length).toBeGreaterThan(30);
		expect(sentText).not.toContain('updated_at');
	});

	it('a new comment does not move updated_at, so it does not make the issue stale for a write with the revision read before', async () => {
		await t.backend.create({ title: 'T', status: 'backlog' });
		const before = await t.backend.get('1');

		await t.backend.addComment('1', 'a note');
		const after = await t.backend.get('1');
		const renamed = await t.backend.setTitle('1', 'Renamed', { expectedRevision: before.revision });

		expect(after.revision).toBe(before.revision);
		expect(renamed.title).toBe('Renamed');
	});

	it('an issue deleted on GitLab is TaskNotFoundError on every read and write, and false for a second delete', async () => {
		await fake.stop();
		fake = await FakeGitLab.start();
		t = makeGitLabBackend(fake, {
			statuses: WRITE_STATUSES,
			options: { statusMap: writeStatusMap() },
			fills: { delete: { use: 'hard', fidelity: 'strict' } },
		});
		await t.backend.create({ title: 'T', status: 'backlog' });

		expect(await t.backend.deleteTask('1')).toBe(true);

		expect(await failure(() => t.backend.get('1'))).toBeInstanceOf(TaskNotFoundError);
		expect(await failure(() => t.backend.updateStatus('1', 'done'))).toBeInstanceOf(TaskNotFoundError);
		expect(await failure(() => t.backend.addComment('1', 'late'))).toBeInstanceOf(TaskNotFoundError);
		expect(await t.backend.deleteTask('1')).toBe(false);
	});
});

describe('failures', () => {
	it('a token that can only read (read_api) is a BackendAuthError that names the scope api', async () => {
		await fake.stop();
		fake = await FakeGitLab.start({ readOnlyToken: true });
		t = makeGitLabBackend(fake, { statuses: WRITE_STATUSES, options: { statusMap: writeStatusMap() } });

		const error = await failure(() => t.backend.create({ title: 'x', status: 'backlog' }));

		expect(error.name).toBe('BackendAuthError');
		expect((error as unknown as { hint: string }).hint).toContain('api');
	});

	it('a 502 after the write was applied is not retried: the re-read shows it applied, so the change counts', async () => {
		await t.backend.create({ title: 'T', status: 'backlog' });
		fake.requests.length = 0;
		fake.failNext({ status: 502, method: 'PUT', applyWrite: true, body: { message: 'Bad gateway' } });

		const record = await t.backend.setTitle('1', 'Renamed');

		expect(record.title).toBe('Renamed');
		expect(sent()).toEqual(['PUT /issues/1']);
	});

	it('a 502 where nothing was applied is the original error (nothing to report as partial)', async () => {
		await t.backend.create({ title: 'T', status: 'backlog' });
		fake.failNext({ status: 502, method: 'PUT', body: { message: 'Bad gateway' } });

		const error = await failure(() => t.backend.setTitle('1', 'Renamed'));

		expect(error).toBeInstanceOf(BackendUnreachableError);
		expect(fake.issue(1)!.title).toBe('T');
	});

	it('waits out a short 429 on a write and sends it again once', async () => {
		await t.backend.create({ title: 'T', status: 'backlog' });
		fake.failNext({ status: 429, method: 'PUT', body: 'Retry later', headers: { 'retry-after': '2' } });

		const record = await t.backend.setTitle('1', 'Renamed');

		expect(record.title).toBe('Renamed');
		expect(t.waits).toContain(2000);
	});
});
