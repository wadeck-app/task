import {
	BackendDataError,
	BackendLimitError,
	BackendUnreachableError,
	TaskNotFoundError,
	UnsupportedByBackendError,
} from '@wadeck-app/task-core';

import { FakeGitHub } from './fakeGitHub.testkit.js';
import { makeGitHubBackend } from './githubBackend.testkit.js';
import type { TestBackend } from './githubBackend.testkit.js';

let fake: FakeGitHub;
let t: TestBackend;

beforeEach(async () => {
	fake = await FakeGitHub.start({ repo: 'acme/shop' });
	t = makeGitHubBackend(fake);
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

describe('reads: status, title and description', () => {
	it('maps state, close reason and labels to the statuses, in creation order', async () => {
		fake.addIssue({ title: 'Open one' });
		fake.addIssue({ title: 'Doing', labels: ['status:in-progress'] });
		fake.addIssue({ title: 'Done', state: 'closed' });

		expect((await t.backend.list()).map(task => [task.id, task.status])).toEqual([
			['1', 'backlog'],
			['2', 'in-progress'],
			['3', 'done'],
		]);
	});

	it('reads the body as the description: CRLF as LF, nothing when empty or equal to the title', async () => {
		fake.addIssue({ title: 'With body', body: 'line one\r\nline two' });
		fake.addIssue({ title: 'Same', body: 'Same' });
		fake.addIssue({ title: 'Blank', body: '  \r\n ' });
		fake.addIssue({ title: 'No body' });

		const records = await t.backend.getMany(['1', '2', '3', '4']);

		expect(records[0]!.description).toBe('line one\nline two');
		expect(records.slice(1).map(record => record.description)).toEqual([undefined, undefined, undefined]);
	});

	it('shows the record as the local store would: id, timestamps with milliseconds, no description key when absent', async () => {
		fake.addIssue({ title: 'Shape' });

		const record = await t.backend.get('1');

		expect(Object.keys(record).sort()).toEqual([
			'createdAt',
			'history',
			'id',
			'revision',
			'status',
			'title',
			'updatedAt',
		]);
		expect(record.createdAt).toMatch(/\.000Z$/);
		expect(record.id).toBe('1');
	});

	it('accepts the id as #12 and as 12, and nothing else', async () => {
		fake.addIssue({ title: 'First' });

		expect((await t.backend.findByPrefix('#1')).id).toBe('1');
		for (const bad of ['abc', '1a', '', '1/2']) {
			expect(await failure(() => t.backend.get(bad))).toBeInstanceOf(TaskNotFoundError);
		}
	});

	it('pull requests are not tasks: left out of the list, not found by number', async () => {
		fake.addIssue({ title: 'Issue' });
		fake.addIssue({ title: 'A pull request', pull: true });

		expect((await t.backend.list()).map(task => task.id)).toEqual(['1']);
		expect(await failure(() => t.backend.get('2'))).toBeInstanceOf(TaskNotFoundError);
	});

	it('a deleted issue (410) is not found', async () => {
		fake.addIssue({ title: 'Gone' });
		fake.deleteIssue(1);

		expect(await failure(() => t.backend.get('1'))).toBeInstanceOf(TaskNotFoundError);
	});

	it('an issue in a state no status maps is an error naming it, with the fix; the list fails loudly rather than skipping it', async () => {
		fake.addIssue({ title: 'Odd', state: 'closed', stateReason: 'not_planned' });

		const error = (await failure(() => t.backend.list())) as BackendDataError;

		expect(error).toBeInstanceOf(BackendDataError);
		expect(error.message).toBe('issue #1 is closed as not planned, and no status of the project maps that');
		expect(error.hint).toContain('reason: not_planned');
	});

	it('250 issues come in three pages of at most 100, followed through the Link header', async () => {
		for (let i = 1; i <= 250; i++) fake.addIssue({ title: `Issue ${i}` });

		const tasks = await t.backend.list();

		expect(tasks).toHaveLength(250);
		expect(tasks[0]!.id).toBe('1');
		expect(tasks[249]!.id).toBe('250');
		expect(fake.requestsTo('/repos/acme/shop/issues').filter(r => r.path.endsWith('/issues'))).toHaveLength(3);
		expect(fake.writes()).toEqual([]);
	});
});

describe('reads: labels, types, meta', () => {
	it('labels exclude the status labels and the type labels', async () => {
		fake.addIssue({ title: 'Mixed', labels: ['billing', 'status:in-progress', 'type:bug', 'urgent'] });

		const record = await t.backend.get('1');

		expect(record.labels).toEqual(['billing', 'urgent']);
		expect(record.type).toBe('bug');
		expect(record.status).toBe('in-progress');
	});

	it('listLabels counts the user labels over open and closed issues, whatever the case, most used first', async () => {
		fake.addIssue({ title: 'a', labels: ['billing', 'type:bug'] });
		fake.addIssue({ title: 'b', labels: ['Billing', 'ui'], state: 'closed' });
		fake.addIssue({ title: 'c', labels: ['ui', 'Zeta'] });

		expect(await t.backend.listLabels()).toEqual([
			{ label: 'billing', count: 2 },
			{ label: 'ui', count: 2 },
			{ label: 'Zeta', count: 1 },
		]);
	});

	it('a native issue type is the task type when the project has such a type, or typeMap names it', async () => {
		fake.addIssue({ title: 'Native', type: 'Bug' });
		fake.addIssue({ title: 'Mapped', type: 'Feature' });
		fake.addIssue({ title: 'Unknown', type: 'Epic' });
		const mapped = makeGitHubBackend(fake, {
			projectTypes: ['bug', 'story'],
			options: { typeMap: { story: { issueType: 'Feature' } } },
		});

		const types = (await mapped.backend.getMany(['1', '2', '3'])).map(record => record.type);

		expect(types).toEqual(['bug', 'story', undefined]);
	});

	it('a type label wins over a native type, and two type labels are an error', async () => {
		fake.addIssue({ title: 'Both', type: 'Bug', labels: ['type:chore'] });
		fake.addIssue({ title: 'Twice', labels: ['type:a', 'type:b'] });

		expect((await t.backend.get('1')).type).toBe('chore');
		const error = await failure(() => t.backend.get('2'));
		expect(error).toBeInstanceOf(BackendDataError);
		expect(error.message).toBe('issue #2 carries two type labels (type:a, type:b)');
	});

	it('meta is not read without the fill: meta labels are ordinary labels', async () => {
		fake.addIssue({ title: 'M', labels: ['meta:owner=ann'] });

		const record = await t.backend.get('1');

		expect(record.meta).toBeUndefined();
		expect(record.labels).toEqual(['meta:owner=ann']);
	});

	it('with fills.meta: labels the meta labels are the meta, and leave the labels', async () => {
		fake.addIssue({ title: 'M', labels: ['meta:owner=ann', 'meta:flag', 'billing', 'meta:note=a=b'] });
		const withMeta = makeGitHubBackend(fake, { metaFromLabels: true });

		const record = await withMeta.backend.get('1');

		expect(record.meta).toEqual({ owner: 'ann', flag: '', note: 'a=b' });
		expect(record.labels).toEqual(['billing']);
	});

	it('two meta labels for one key, or a meta label without key, are errors naming the issue', async () => {
		fake.addIssue({ title: 'Dup', labels: ['meta:k=1', 'meta:k=2'] });
		fake.addIssue({ title: 'Keyless', labels: ['meta:=x'] });
		const withMeta = makeGitHubBackend(fake, { metaFromLabels: true });

		expect((await failure(() => withMeta.backend.get('1'))).message).toBe(
			'issue #1 has two meta labels for the key "k"'
		);
		expect((await failure(() => withMeta.backend.get('2'))).message).toContain('without a key');
	});
});

describe('reads: the managed task block in the body', () => {
	it('is removed from the description and gives duplicateOf', async () => {
		fake.addIssue({ title: 'Target' });
		fake.addIssue({
			title: 'Copy',
			body: 'Real text\n\n<!-- task:begin v1 -->{"links":[{"type":"duplicateOf","target":"1"}]}<!-- task:end -->',
		});

		const record = await t.backend.get('2');
		const links = await t.backend.getLinks('2');

		expect(record.description).toBe('Real text');
		expect(record.links).toEqual([{ type: 'duplicateOf', target: '1' }]);
		expect(links.duplicateOf.map(task => task.id)).toEqual(['1']);
	});

	it.each([
		['not JSON', '<!-- task:begin v1 -->{oops<!-- task:end -->', /not valid JSON/],
		['no end marker', 'text <!-- task:begin v1 --> {}', /no end marker/],
		['a newer format', '<!-- task:begin v2 -->{}<!-- task:end -->', /format v2/],
		['not an object', '<!-- task:begin v1 -->[1]<!-- task:end -->', /not a JSON object/],
	])('%s is an error naming the issue and how to repair the block', async (_name, body, message) => {
		fake.addIssue({ title: 'Broken', body });

		const error = (await failure(() => t.backend.get('1'))) as BackendDataError;

		expect(error).toBeInstanceOf(BackendDataError);
		expect(error.message).toMatch(message);
		expect(error.subject).toBe('issue #1');
		expect(error.hint).toMatch(/task:begin|Update task/);
	});

	it('a duplicate target that does not exist is dangling in the lenient read and an error in the strict one', async () => {
		fake.addIssue({
			title: 'Copy',
			body: '<!-- task:begin v1 -->{"links":[{"type":"duplicateOf","target":"99"}]}<!-- task:end -->',
		});

		expect((await t.backend.getLinksLenient('1')).dangling).toEqual([{ type: 'duplicateOf', target: '99' }]);
		expect(await failure(() => t.backend.getLinks('1'))).toBeInstanceOf(BackendDataError);
	});
});

describe('reads: the status history is replayed from the timeline', () => {
	it('starts at the creation, follows label swaps and closes, and ends at the current status', async () => {
		fake.addIssue({ title: 'Journey' });
		fake.updateIssue(1, { labels: ['status:in-progress'] });
		fake.updateIssue(1, { state: 'closed', stateReason: 'completed' });
		fake.updateIssue(1, { state: 'open' });

		const record = await t.backend.get('1');

		expect(record.history.map(entry => entry.status)).toEqual(['backlog', 'in-progress', 'done', 'in-progress']);
		expect(record.history[0]!.timestamp).toBe(record.createdAt);
		expect(record.status).toBe('in-progress');
	});

	it('an issue created with its status label starts in that status', async () => {
		fake.addIssue({ title: 'Born busy', labels: ['status:in-progress'] });

		expect((await t.backend.get('1')).history.map(entry => entry.status)).toEqual(['in-progress']);
	});

	it('a label swap passes through a moment with two labels without breaking the replay', async () => {
		fake.addIssue({ title: 'Swap', labels: ['status:in-progress'] });
		fake.updateIssue(1, { labels: ['status:in-progress', 'status:review'] });
		fake.updateIssue(1, { labels: [] });

		const record = await t.backend.get('1');

		expect(record.history.map(entry => entry.status)).toEqual(['in-progress', 'backlog']);
	});

	it('when the timeline does not explain the current status the present is still the last entry', async () => {
		fake.addIssue({ title: 'Unexplained', state: 'closed' });
		// A timeline that lost its events (a repository transfer): the issue is closed, the timeline says nothing.
		const issue = fake.issues.get(1)!;
		issue.events = [];

		const record = await t.backend.get('1');

		expect(record.history.at(-1)).toMatchObject({ status: 'done' });
	});
});

describe('reads: the activity is the timeline in the vocabulary of the local log', () => {
	it('maps labels, renames, types, sub-issues, parents and dependencies, and leaves status changes and comments out', async () => {
		fake.addIssue({ title: 'Parent' });
		fake.addIssue({ title: 'Child' });
		fake.addIssue({ title: 'Blocker' });
		fake.updateIssue(2, { labels: ['billing'] });
		fake.updateIssue(2, { labels: [] });
		fake.updateIssue(2, { title: 'Child, renamed' });
		fake.updateIssue(2, { type: 'Bug' });
		fake.updateIssue(2, { labels: ['type:chore'] });
		fake.updateIssue(2, { labels: ['status:in-progress'] });
		fake.setParent(2, 1);
		fake.addBlockedBy(2, 3);
		fake.addComment(2, 'a comment');

		const child = await t.backend.get('2');
		const parent = await t.backend.get('1');
		const blocker = await t.backend.get('3');

		expect(child.activity!.map(({ at: _at, ...entry }) => entry)).toEqual([
			{ kind: 'label-added', newValue: 'billing' },
			{ kind: 'label-removed', oldValue: 'billing' },
			{ kind: 'title', oldValue: 'Child', newValue: 'Child, renamed' },
			{ kind: 'type', newValue: 'Bug' },
			{ kind: 'type', newValue: 'chore' },
			// The next update replaces the label set: the type label goes with it.
			{ kind: 'type', oldValue: 'chore' },
			{ kind: 'parent', newValue: '1' },
			{ kind: 'link-added', field: 'blockedBy', target: '3' },
		]);
		expect(parent.activity!.map(({ at: _at, ...entry }) => entry)).toEqual([
			{ kind: 'child-added', target: '2', inverse: true },
		]);
		expect(blocker.activity!.map(({ at: _at, ...entry }) => entry)).toEqual([
			{ kind: 'link-added', field: 'blockedBy', target: '2', inverse: true },
		]);
		expect(child.comments!.map(comment => comment.text)).toEqual(['a comment']);
	});

	it('removals read as removals', async () => {
		fake.addIssue({ title: 'P' });
		fake.addIssue({ title: 'C' });
		fake.addIssue({ title: 'B' });
		fake.setParent(2, 1);
		fake.setParent(2, null);
		fake.addBlockedBy(2, 3);
		fake.removeBlockedBy(2, 3);

		const child = await t.backend.get('2');

		expect(child.activity!.map(entry => [entry.kind, entry.oldValue ?? entry.newValue ?? entry.target])).toEqual([
			['parent', '1'],
			['parent', '1'],
			['link-added', '3'],
			['link-removed', '3'],
		]);
		expect(child.activity![1]).toMatchObject({ oldValue: '1' });
		expect((await t.backend.get('1')).activity!.map(entry => entry.kind)).toEqual(['child-added', 'child-removed']);
	});

	it('an event without a task equivalent that a person wants to see is "other"; GitHub bookkeeping is left out', async () => {
		fake.addIssue({ title: 'Events' });
		fake.addRawEvent(1, 'assigned', { assignee: { login: 'octocat' } });
		fake.addRawEvent(1, 'locked', { lock_reason: 'resolved' });
		fake.addRawEvent(1, 'subscribed');
		fake.addRawEvent(1, 'mentioned');
		fake.addRawEvent(1, 'cross-referenced', { source: { type: 'issue', issue: { number: 9 } } });

		const record = await t.backend.get('1');

		expect(record.activity!.map(({ at: _at, ...entry }) => entry)).toEqual([
			{ kind: 'other', field: 'assigned', newValue: 'octocat' },
			{ kind: 'other', field: 'locked', newValue: 'resolved' },
			{ kind: 'other', field: 'cross-referenced', newValue: '#9' },
		]);
	});

	it('a record without activity has no activity key', async () => {
		fake.addIssue({ title: 'Quiet' });

		expect('activity' in (await t.backend.get('1'))).toBe(false);
	});
});

describe('reads: comments', () => {
	it('come oldest first with their id, author and the instant they were edited', async () => {
		fake.addIssue({ title: 'Talk' });
		const first = fake.addComment(1, 'first', 'ann');
		fake.addComment(1, 'second', 'bob');
		fake.editComment(1, first, 'first, edited');

		const comments = (await t.backend.get('1')).comments!;

		expect(comments.map(comment => [comment.id, comment.text, comment.author])).toEqual([
			[String(first), 'first, edited', 'ann'],
			[String(first + 1), 'second', 'bob'],
		]);
		expect(comments[0]!.editedAt).toBeDefined();
		expect(comments[1]!.editedAt).toBeUndefined();
	});

	it('an issue with none costs no comments request', async () => {
		fake.addIssue({ title: 'Silent' });

		await t.backend.get('1');

		expect(fake.requestsTo('/repos/acme/shop/issues/1/comments')).toEqual([]);
	});
});

describe('reads: revision and staleness', () => {
	it('the revision is stable while nothing changes and changes with every change on GitHub', async () => {
		fake.addIssue({ title: 'Rev' });

		const first = await t.backend.get('1');
		expect((await t.backend.get('1')).revision).toBe(first.revision);

		fake.addComment(1, 'bumps updated_at');
		const second = await t.backend.get('1');
		expect(second.revision).not.toBe(first.revision);
		expect(first.revision).toMatch(/^2026-11-08T\d\d:\d\d:\d\dZ#[0-9a-f]{40}$/);
	});

	it('a record served from the cache after a failure says so: stale and the instant it was read', async () => {
		fake.addIssue({ title: 'Cached' });
		await t.backend.get('1');
		fake.dropNext(5);

		const record = await t.backend.get('1');

		expect(record.stale).toBe(true);
		expect(record.cachedAt).toBe('2026-11-08T12:00:00.000Z');
		expect(record.title).toBe('Cached');
		expect(t.notices.some(notice => notice.kind === 'stale')).toBe(true);
	});

	it('a fresh read has neither flag', async () => {
		fake.addIssue({ title: 'Fresh' });

		const record = await t.backend.get('1');

		expect('stale' in record).toBe(false);
		expect('cachedAt' in record).toBe(false);
	});

	it('without anything cached an unreachable GitHub is the error', async () => {
		fake.addIssue({ title: 'Never read' });
		fake.dropNext(5);

		expect(await failure(() => t.backend.get('1'))).toBeInstanceOf(BackendUnreachableError);
	});
});

describe('reads: hierarchy', () => {
	beforeEach(() => {
		// 1 > 2 > 4, 1 > 3
		for (const title of ['Root', 'Left', 'Right', 'Leaf']) fake.addIssue({ title });
		fake.setParent(2, 1);
		fake.setParent(3, 1);
		fake.setParent(4, 2);
	});

	it('children come from the sub-issues endpoint, only for a parent that has some', async () => {
		expect((await t.backend.getChildren('1')).map(task => task.id)).toEqual(['2', '3']);
		expect(await t.backend.getChildren('4')).toEqual([]);
		expect(fake.requestsTo('/repos/acme/shop/issues/4/sub_issues')).toEqual([]);
	});

	it('the tree walks the sub-issues; a leaf costs no request', async () => {
		const tree = await t.backend.getTree('1');

		expect(tree.children.map(node => node.id)).toEqual(['2', '3']);
		expect(tree.children[0]!.children.map(node => node.id)).toEqual(['4']);
		expect(fake.requestsTo('/repos/acme/shop/issues/4/sub_issues')).toEqual([]);
		expect(fake.requestsTo('/repos/acme/shop/issues/3/sub_issues')).toEqual([]);
	});

	it('ancestors go from the parent up, and the full tree is rooted at the top ancestor with the task selected', async () => {
		expect((await t.backend.getAncestors('4')).map(task => task.id)).toEqual(['2', '1']);

		const full = await t.backend.getFullTree('4');
		expect(full.id).toBe('1');
		expect(full.children[0]!.children[0]).toMatchObject({ id: '4', selected: true });
	});

	it('the forest comes from the one list, with the predicate keeping the ancestors of a match', async () => {
		const requestsBefore = fake.requests.length;
		const forest = await t.backend.getForest({ predicate: task => task.id === '4' });

		expect(forest.map(node => node.id)).toEqual(['1']);
		expect(forest[0]!.children.map(node => node.id)).toEqual(['2']);
		expect(fake.requests.length - requestsBefore).toBe(1);
		await expect(t.backend.getForest({ parentId: '99' })).rejects.toBeInstanceOf(TaskNotFoundError);
	});

	it('a tree deeper than the 8 levels GitHub allows is an error naming the limit', async () => {
		let parent = 4;
		for (let level = 5; level <= 12; level++) {
			fake.addIssue({ title: `Level ${level}` });
			fake.setParent(level, parent);
			parent = level;
		}

		const error = (await failure(() => t.backend.getTree('1'))) as BackendLimitError;

		expect(error).toBeInstanceOf(BackendLimitError);
		expect(error.limit).toBe(8);
		expect(error.limitName).toBe('sub-issue depth');
	});

	it('a loop in the sub-issue data is an error, not an endless walk', async () => {
		// The server says 1 is the child of 4 as well: 1 > 2 > 4 > 1.
		fake.issues.get(1)!.parent = 4;

		const error = await failure(() => t.backend.getTree('1'));

		expect(error).toBeInstanceOf(BackendDataError);
		expect(error.message).toContain('its own ancestor');
	});

	it('a parent in another repository is left out and said once', async () => {
		fake.issues.get(2)!.parent = 1;
		const issue = fake.issues.get(2)!;
		// Rewrite the parent URL of issue 2 to another repository by serving it through a forced answer.
		const body = {
			...JSON.parse(
				JSON.stringify({
					number: 2,
					title: 'Left',
					id: 2,
					state: 'open',
					state_reason: null,
					labels: [],
					comments: 0,
					created_at: '2026-11-08T10:00:03Z',
					updated_at: '2026-11-08T10:00:03Z',
					body: null,
				})
			),
			parent_issue_url: 'https://api.github.com/repos/other/place/issues/7',
		};
		fake.failNext({ status: 200, body, pathPrefix: '/repos/acme/shop/issues/2' }, 1);
		void issue;

		const record = await t.backend.get('2');

		expect(record.parentId).toBeUndefined();
		expect(t.notices.filter(notice => notice.kind === 'ignored').map(notice => notice.text)).toEqual([
			'issue #2 has a parent in another repository (https://api.github.com/repos/other/place/issues/7); it shows as a root task here',
		]);
	});
});

describe('reads: links', () => {
	it('blockedBy and blocks are read from the dependencies endpoints, skipped when the summary says there are none', async () => {
		fake.addIssue({ title: 'Blocker' });
		fake.addIssue({ title: 'Blocked' });
		fake.addIssue({ title: 'Free' });
		fake.addBlockedBy(2, 1);

		const blocked = await t.backend.getLinks('2');
		const free = await t.backend.getLinks('3');

		expect(blocked.blockedBy.map(task => task.id)).toEqual(['1']);
		expect((await t.backend.getLinks('1')).blocks.map(task => task.id)).toEqual(['2']);
		expect(free.blockedBy).toEqual([]);
		expect(blocked.causedBy).toEqual([]);
		expect(blocked.duplicates).toEqual([]);
		expect(fake.requestsTo('/repos/acme/shop/issues/3/dependencies')).toEqual([]);
	});

	it('getUnblockedBy lists the open tasks whose every blocker is now terminal', async () => {
		fake.addIssue({ title: 'A' });
		fake.addIssue({ title: 'B' });
		fake.addIssue({ title: 'Blocked by both' });
		fake.addIssue({ title: 'Blocked by A only' });
		fake.addBlockedBy(3, 1);
		fake.addBlockedBy(3, 2);
		fake.addBlockedBy(4, 1);
		const terminal = (status: string): boolean => status === 'done';

		expect(await t.backend.getUnblockedBy('1', terminal)).toEqual([]);
		fake.updateIssue(1, { state: 'closed' });
		expect((await t.backend.getUnblockedBy('1', terminal)).map(task => task.id)).toEqual(['4']);
	});
});

describe('writes: all refused, before anything is sent', () => {
	it('every write is UnsupportedByBackendError for writes, with the stage and where to make the change', async () => {
		fake.addIssue({ title: 'Read only' });
		const before = fake.requests.length;

		const error = (await failure(() => t.backend.updateStatus('1', 'done'))) as UnsupportedByBackendError;

		expect(error).toBeInstanceOf(UnsupportedByBackendError);
		expect(error.capability).toBe('writes');
		expect(error.operation).toBe('updateStatus');
		expect(error.hint).toContain('The github strategy is read-only in this version (stage 1');
		expect(error.hint).toContain('https://github.com/acme/shop/issues/1');
		const created = (await failure(() =>
			t.backend.create({ title: 'x', status: 'backlog' })
		)) as UnsupportedByBackendError;
		expect(created.hint).toContain('https://github.com/acme/shop/issues/new');
		expect(fake.requests.length).toBe(before);
		expect(fake.writes()).toEqual([]);
	});
});

describe('search and paging', () => {
	it('sends the repo qualifier, the text as one quoted phrase, and never caches the results', async () => {
		fake.addIssue({ title: 'Alpha release' });
		fake.addIssue({ title: 'Beta' });

		const page = await t.backend.listPage({ text: 'label:secret alpha' });
		await t.backend.listPage({ text: 'alpha' });
		await t.backend.listPage({ text: 'alpha' });

		expect(page.items).toEqual([]);
		const searches = fake.requestsTo('/search/issues');
		expect(searches).toHaveLength(3);
		const q = new URLSearchParams(searches[0]!.query).get('q');
		expect(q).toBe('repo:acme/shop is:issue in:title "label:secret alpha"');
	});

	it('finds a task only once the index has caught up (not read-your-writes)', async () => {
		await fake.stop();
		fake = await FakeGitHub.start({ repo: 'acme/shop', searchLagRequests: 2 });
		t = makeGitHubBackend(fake);
		fake.addIssue({ title: 'Fresh alpha' });

		expect((await t.backend.listPage({ text: 'alpha' })).items).toEqual([]);
		expect((await t.backend.listPage({ text: 'alpha' })).items).toEqual([]);
		expect((await t.backend.listPage({ text: 'alpha' })).items.map(task => task.id)).toEqual(['1']);
	});

	it('a cursor that was not issued by this backend is refused with a message that says what to use', async () => {
		const error = await failure(() => t.backend.listPage({ cursor: 'garbage' }));

		expect(error.message).toContain('was not issued by this backend');
	});

	it('a cursor that points outside the configured address is refused (the token would follow it)', async () => {
		const cursor = Buffer.from(
			JSON.stringify({ u: 'https://evil.example.com/repos/acme/shop/issues', s: 0 })
		).toString('base64url');

		const error = await failure(() => t.backend.listPage({ cursor }));

		expect(error.message).toContain('evil.example.com');
	});

	it('limit must be a positive whole number', async () => {
		expect((await failure(() => t.backend.listPage({ limit: 0 }))).message).toContain(
			'limit must be a positive integer'
		);
	});
});
