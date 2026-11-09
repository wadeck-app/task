import { parseGitHubOptions } from './githubOptions.js';
import { checkRevision, fieldHashes, revisionOf } from './githubRevision.js';
import type { ApiIssue, MapContext } from './issueMapping.js';
import { StatusMapper } from './statusMapping.js';
import { TEST_STATUSES, TEST_STATUS_MAP } from './githubBackend.testkit.js';

function context(extra: Partial<MapContext> = {}): MapContext {
	const parsed = parseGitHubOptions({
		repo: 'acme/shop',
		tokenEnv: 'GITHUB_TOKEN',
		statusMap: TEST_STATUS_MAP,
	});
	if ('problem' in parsed) throw new Error(parsed.problem);
	const issueUrl = (number: number): string => `https://github.com/acme/shop/issues/${number}`;
	return {
		settings: parsed.settings,
		mapper: new StatusMapper(parsed.settings.statusMap, TEST_STATUSES, issueUrl),
		metaFromLabels: true,
		metaFromBlock: false,
		projectTypes: [],
		notice: () => undefined,
		issueUrl,
		...extra,
	};
}

function issue(extra: Partial<ApiIssue> = {}): ApiIssue {
	return {
		id: 1001,
		number: 1,
		title: 'Title',
		body: 'Body',
		state: 'open',
		state_reason: null,
		labels: [],
		created_at: '2026-11-08T10:00:00Z',
		updated_at: '2026-11-08T10:00:00Z',
		comments: 0,
		...extra,
	};
}

const label = (name: string): { name: string } => ({ name });

describe('fieldHashes: one hash per part of the issue a write can change', () => {
	it('changes only the hash of the part that changed', () => {
		const ctx = context();
		const base = fieldHashes(issue(), ctx);

		expect(fieldHashes(issue({ title: 'Other' }), ctx)).toEqual({
			...base,
			title: expect.not.stringMatching(base.title),
		});
		expect(fieldHashes(issue({ body: 'Other' }), ctx).body).not.toBe(base.body);
		expect(fieldHashes(issue({ body: 'Other' }), ctx).title).toBe(base.title);
		expect(fieldHashes(issue({ labels: [label('urgent')] }), ctx).labels).not.toBe(base.labels);
		expect(fieldHashes(issue({ labels: [label('urgent')] }), ctx).status).toBe(base.status);
		expect(fieldHashes(issue({ labels: [label('status:in-progress')] }), ctx).status).not.toBe(base.status);
		expect(fieldHashes(issue({ labels: [label('status:in-progress')] }), ctx).labels).toBe(base.labels);
		expect(fieldHashes(issue({ labels: [label('type:bug')] }), ctx).type).not.toBe(base.type);
		expect(fieldHashes(issue({ labels: [label('meta:owner=ann')] }), ctx).meta).not.toBe(base.meta);
		expect(fieldHashes(issue({ state: 'closed', state_reason: 'completed' }), ctx).status).not.toBe(base.status);
		expect(
			fieldHashes(issue({ parent_issue_url: 'https://api.github.com/repos/acme/shop/issues/9' }), ctx).parent
		).not.toBe(base.parent);
		expect(
			fieldHashes(issue({ issue_dependencies_summary: { total_blocked_by: 1, total_blocking: 0 } }), ctx)
				.dependencies
		).not.toBe(base.dependencies);
	});

	it('ignores what a person does not call a change of the task: the order of the labels, the case of a label, comments, updated_at', () => {
		const ctx = context();
		const a = fieldHashes(issue({ labels: [label('b'), label('A')] }), ctx);
		const b = fieldHashes(
			issue({ labels: [label('a'), label('B')], comments: 5, updated_at: '2026-11-08T11:00:00Z' }),
			ctx
		);

		expect(b).toEqual(a);
	});

	it('hashes the meta of the managed block when meta lives there', () => {
		const ctx = context({ metaFromLabels: false, metaFromBlock: true });
		const none = fieldHashes(issue(), ctx);
		const some = fieldHashes(
			issue({ body: 'Body\n\n<!-- task:begin v1 -->{"meta":{"owner":"ann"}}<!-- task:end -->' }),
			ctx
		);

		expect(some.meta).not.toBe(none.meta);
	});

	it('a block that cannot be read still hashes (the write that reads it reports the error)', () => {
		const ctx = context({ metaFromLabels: false, metaFromBlock: true });

		expect(() => fieldHashes(issue({ body: '<!-- task:begin v1 -->{nope<!-- task:end -->' }), ctx)).not.toThrow();
	});
});

describe('revisionOf and checkRevision', () => {
	const ctx = context();

	it('is stable for the same issue and ETag, and changes with the ETag', () => {
		expect(revisionOf(issue(), 'abc', ctx)).toBe(revisionOf(issue(), 'abc', ctx));
		expect(revisionOf(issue(), 'abc', ctx)).not.toBe(revisionOf(issue(), 'def', ctx));
		expect(revisionOf(issue(), 'W/"abc"', ctx)).toBe(revisionOf(issue(), 'abc', ctx));
	});

	it('the same revision is never stale, whatever the groups', () => {
		const revision = revisionOf(issue(), 'abc', ctx);

		expect(checkRevision(revision, revision, ['title', 'body'])).toEqual([]);
	});

	it('a change in a part the write does not touch is not stale (a comment or a label bumped updated_at)', () => {
		const before = revisionOf(issue(), 'e1', ctx);
		const after = revisionOf(
			issue({ comments: 3, updated_at: '2026-11-08T10:05:00Z', labels: [label('urgent')] }),
			'e2',
			ctx
		);

		expect(checkRevision(before, after, ['title'])).toEqual([]);
		expect(checkRevision(before, after, ['status'])).toEqual([]);
	});

	it('a change in a part the write touches is stale and names it', () => {
		const before = revisionOf(issue(), 'e1', ctx);
		const after = revisionOf(issue({ title: 'Someone renamed it', updated_at: '2026-11-08T10:05:00Z' }), 'e2', ctx);

		expect(checkRevision(before, after, ['title', 'body'])).toEqual(['title']);
	});

	it('two changes inside one second (same updated_at) are still told apart by the parts', () => {
		const before = revisionOf(issue(), 'e1', ctx);
		const after = revisionOf(issue({ labels: [label('status:in-progress')] }), 'e2', ctx);

		expect(checkRevision(before, after, ['status'])).toEqual(['status']);
	});

	it('a revision this backend did not issue is stale for any write', () => {
		const actual = revisionOf(issue(), 'e1', ctx);

		expect(checkRevision('definitely-not-the-revision', actual, [])).toEqual(['revision']);
		expect(checkRevision('', actual, ['title'])).toEqual(['revision']);
	});

	it('the revision does not leak the text of the issue', () => {
		const revision = revisionOf(issue({ title: 'secret title', body: 'secret body' }), 'e1', ctx);

		expect(revision).not.toContain('secret');
	});
});
