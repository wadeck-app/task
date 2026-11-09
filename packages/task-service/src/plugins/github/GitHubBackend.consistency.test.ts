// Consistency of the write path: expectedRevision (re-read, then write), what a read shows after a write (cache, activity, history),
// the pace of the writes, and the capabilities that follow the declared fills.
import {
	BackendAuthError,
	RateLimitedError,
	StaleRevisionError,
	TaskConflictError,
	UnsupportedByBackendError,
} from '@wadeck-app/task-core';

import { FakeGitHub } from './fakeGitHub.testkit.js';
import type { IssuePatch } from './fakeGitHub.testkit.js';
import { WRITE_STATUS_MAP, WRITE_STATUSES, makeGitHubBackend } from './githubBackend.testkit.js';
import type { TestBackend } from './githubBackend.testkit.js';
import { GITHUB_CAPABILITIES, githubCapabilities } from './GitHubBackend.js';

let fake: FakeGitHub;
let t: TestBackend;

const R = '/repos/acme/shop';

function make(extra: Parameters<typeof makeGitHubBackend>[1] = {}): TestBackend {
	return makeGitHubBackend(fake, {
		statuses: WRITE_STATUSES,
		projectTypes: ['bug'],
		...extra,
		options: { statusMap: WRITE_STATUS_MAP, ...extra.options },
	});
}

beforeEach(async () => {
	fake = await FakeGitHub.start({ repo: 'acme/shop' });
	t = make();
	fake.addIssue({ title: 'One' });
});

afterEach(async () => {
	await fake.stop();
});

const failure = async (call: () => Promise<unknown>): Promise<Error> => {
	try {
		await call();
	} catch (error) {
		return error as Error;
	}
	throw new Error('expected a failure');
};

describe('expectedRevision: the issue is read again, compared, then written', () => {
	it('re-reads the issue before every write (a conditional GET, free when nothing changed)', async () => {
		const read = await t.backend.get('1');
		fake.requests.length = 0;

		await t.backend.setTitle('1', 'Renamed', { expectedRevision: read.revision });

		const order = fake.requests.map(request => `${request.method} ${request.path.replace(R, '')}`);
		expect(order[0]).toBe('GET /issues/1');
		expect(order[1]).toBe('PATCH /issues/1');
	});

	it('is accepted when nothing changed, and the new record carries a new revision', async () => {
		const read = await t.backend.get('1');

		const renamed = await t.backend.setTitle('1', 'Renamed', { expectedRevision: read.revision });

		expect(renamed.title).toBe('Renamed');
		expect(renamed.revision).not.toBe(read.revision);
		expect((await t.backend.get('1')).revision).toBe(renamed.revision);
	});

	it('is a StaleRevisionError when the part being written changed behind our back, and nothing is written', async () => {
		const read = await t.backend.get('1');
		fake.updateIssue(1, { title: 'Renamed by someone else' });

		const error = await failure(() => t.backend.setTitle('1', 'Mine', { expectedRevision: read.revision }));

		expect(error).toBeInstanceOf(StaleRevisionError);
		expect(error).toBeInstanceOf(TaskConflictError);
		expect((error as StaleRevisionError).kind).toBe('stale');
		expect(fake.issues.get(1)!.title).toBe('Renamed by someone else');
		expect(fake.writes()).toEqual([]);
	});

	it('is NOT stale when only a comment or another part changed (those bump updated_at, but not what is written)', async () => {
		const read = await t.backend.get('1');
		fake.addComment(1, 'a note by someone');
		fake.updateIssue(1, { labels: ['urgent'] });

		const renamed = await t.backend.setTitle('1', 'Mine', { expectedRevision: read.revision });

		expect(renamed.title).toBe('Mine');
	});

	it('two changes inside the same second are still told apart (the parts are compared, not only updated_at)', async () => {
		await fake.stop();
		fake = await FakeGitHub.start({ repo: 'acme/shop', clockStepMs: 0 });
		t = make();
		fake.addIssue({ title: 'One' });
		const read = await t.backend.get('1');
		fake.updateIssue(1, { title: 'Renamed' });
		expect(fake.issues.get(1)!.updatedAt).toBe(read.updatedAt.replace('.000Z', 'Z'));

		const error = await failure(() => t.backend.setTitle('1', 'Mine', { expectedRevision: read.revision }));

		expect(error).toBeInstanceOf(StaleRevisionError);
	});

	it.each([
		[
			'updateStatus',
			(r: string) => t.backend.updateStatus('1', 'done', { expectedRevision: r }),
			{ state: 'closed' },
		],
		[
			'setDescription',
			(r: string) => t.backend.setDescription('1', 'd', { expectedRevision: r }),
			{ body: 'changed' },
		],
		[
			'setType',
			(r: string) => t.backend.setType('1', 'bug', { expectedRevision: r }),
			{ labels: ['type:feature'] },
		],
		['addLabel', (r: string) => t.backend.addLabel('1', 'x', { expectedRevision: r }), { labels: ['y'] }],
		['setParent', (r: string) => t.backend.setParent('1', '2', { expectedRevision: r }), 'parent'],
		['addLink', (r: string) => t.backend.addLink('1', 'blockedBy', '2', { expectedRevision: r }), 'blocked'],
	] as Array<[string, (revision: string) => Promise<unknown>, IssuePatch | string]>)(
		'%s honours it',
		async (_name, write, change) => {
			fake.addIssue({ title: 'Two' });
			const read = await t.backend.get('1');
			if (change === 'parent') fake.setParent(1, 2);
			else if (change === 'blocked') fake.addBlockedBy(1, 2);
			else fake.updateIssue(1, change as IssuePatch);
			fake.requests.length = 0;

			const error = await failure(() => write(read.revision));

			expect(error).toBeInstanceOf(StaleRevisionError);
			expect(fake.writes()).toEqual([]);
		}
	);

	it('a revision this backend did not issue is stale for every kind of write', async () => {
		const stale = { expectedRevision: 'definitely-not-the-revision' };

		for (const write of [
			() => t.backend.addComment('1', 'note', stale),
			() => t.backend.removeLabel('1', 'x', stale),
			() => t.backend.removeParent('1', stale),
		]) {
			expect(await failure(write)).toBeInstanceOf(StaleRevisionError);
		}
		expect(fake.writes()).toEqual([]);
	});

	it('a comment accepts the revision of before another comment: comments only append', async () => {
		const read = await t.backend.get('1');
		fake.addComment(1, 'a note by someone');

		const added = await t.backend.addComment('1', 'mine', { expectedRevision: read.revision });

		expect(added.task.comments?.map(comment => comment.text)).toEqual(['a note by someone', 'mine']);
	});
});

describe('what a read shows after a write', () => {
	it('is the write, even inside the cache TTL (the write expires what was read)', async () => {
		t = make({ options: { cache: { ttlSeconds: 60 } } });
		await t.backend.list();
		await t.backend.get('1');

		await t.backend.setTitle('1', 'Renamed');

		expect((await t.backend.list())[0]!.title).toBe('Renamed');
		expect((await t.backend.get('1')).title).toBe('Renamed');
	});

	it('is in the history: the status change appears with its instant', async () => {
		await t.backend.updateStatus('1', 'in-progress');
		const record = await t.backend.updateStatus('1', 'done');

		expect(record.history.map(entry => entry.status)).toEqual(['backlog', 'in-progress', 'done']);
	});

	it('is in the activity: labels, title, type, and nothing invented for what GitHub does not record', async () => {
		await t.backend.setTitle('1', 'Renamed');
		await t.backend.addLabel('1', 'urgent');
		await t.backend.setType('1', 'bug');
		const record = await t.backend.removeLabel('1', 'urgent');

		expect(record.activity?.map(entry => entry.kind)).toEqual(['title', 'label-added', 'type', 'label-removed']);
	});

	it('GitHub mirrors a parent and a link on the other issue itself; task adds no entry of its own', async () => {
		fake.addIssue({ title: 'Two' });
		await t.backend.setParent('2', '1');
		await t.backend.addLink('1', 'blockedBy', '2');

		const parent = await t.backend.get('1');

		expect(parent.activity?.filter(entry => entry.kind === 'child-added')).toHaveLength(1);
		expect(parent.activity?.filter(entry => entry.kind === 'link-added')).toHaveLength(1);
		// Written through task: exactly the requests of the operation, none to record an inverse entry.
		expect(fake.writes().map(request => request.path.replace(R, ''))).toEqual([
			'/issues/1/sub_issues',
			'/issues/1/dependencies/blocked_by',
		]);
	});
});

describe('the pace of the writes', () => {
	it('waits the spacing between two writes of one operation (the client is told to), and none before the first', async () => {
		t = make({ client: { writeSpacingMs: 1000 } });

		await t.backend.create({ title: 'Already done', status: 'done' });

		// Two writes (create, close): one wait, the clock being frozen.
		expect(t.waits).toEqual([1000]);
	});

	it('a secondary limit is a RateLimitedError carrying the instant; nothing more is sent', async () => {
		fake.failNext({
			status: 403,
			method: 'PATCH',
			headers: { 'retry-after': '300' },
			body: { message: 'You have exceeded a secondary rate limit.' },
		});

		const error = await failure(() => t.backend.setTitle('1', 'x'));

		expect(error).toBeInstanceOf(RateLimitedError);
		expect((error as RateLimitedError).scope).toBe('secondary');
		expect((error as RateLimitedError).retryAt).toEqual(new Date(t.clock.ms + 300_000));
		expect(fake.writes()).toHaveLength(1);
	});

	it('a token without the write permission says which permission, and writes nothing', async () => {
		const readOnly = await FakeGitHub.start({ repo: 'acme/shop', readOnlyToken: true });
		try {
			readOnly.addIssue({ title: 'One' });
			const own = makeGitHubBackend(readOnly, {
				statuses: WRITE_STATUSES,
				options: { statusMap: WRITE_STATUS_MAP },
			});

			const error = await failure(() => own.backend.setTitle('1', 'x'));

			expect(error).toBeInstanceOf(BackendAuthError);
			expect((error as BackendAuthError).hint).toContain('issues=write');
		} finally {
			await readOnly.stop();
		}
	});
});

describe('capabilities follow the declared fills', () => {
	it('writes are native; meta, delete and duplicateOf are off until a fill is declared', () => {
		expect(GITHUB_CAPABILITIES).toMatchObject({
			writes: 'full',
			meta: false,
			delete: 'no',
			labels: true,
			comments: true,
		});
		expect(GITHUB_CAPABILITIES.linkTypes).toEqual(['blockedBy']);
		expect(t.backend.capabilities).toEqual(GITHUB_CAPABILITIES);
	});

	it('fills.meta makes meta available', () => {
		for (const use of ['labels', 'body-block'] as const) {
			expect(githubCapabilities({ meta: { use, fidelity: 'degrade' } }).meta).toBe(true);
		}
	});

	it('fills.delete: tombstone is close-only, hard is yes', () => {
		expect(githubCapabilities({ delete: { use: 'tombstone', fidelity: 'degrade' } }).delete).toBe('close-only');
		expect(githubCapabilities({ delete: { use: 'hard', fidelity: 'strict' } }).delete).toBe('yes');
	});

	it('the duplicate-marker fill adds duplicateOf to the stored link types', () => {
		expect(
			githubCapabilities({ 'linkTypes.duplicateOf': { use: 'duplicate-marker', fidelity: 'degrade' } }).linkTypes
		).toEqual(['blockedBy', 'duplicateOf']);
	});

	it('the backend reports the capabilities of its fills', () => {
		t = make({
			fills: { meta: { use: 'labels', fidelity: 'strict' }, delete: { use: 'hard', fidelity: 'strict' } },
		});

		expect(t.backend.capabilities).toMatchObject({ meta: true, delete: 'yes', writes: 'full' });
	});

	it('every refusal of an operation a fill would enable is an UnsupportedByBackendError that names that fill', async () => {
		const refusals = await Promise.all([
			failure(() => t.backend.setMeta('1', 'k', 'v')),
			failure(() => t.backend.deleteTask('1')),
			failure(() => t.backend.addLink('1', 'duplicateOf', '1')),
		]);

		for (const error of refusals) {
			expect(error).toBeInstanceOf(UnsupportedByBackendError);
			expect((error as UnsupportedByBackendError).hint).toContain('strategy.options.fills');
		}
	});
});
