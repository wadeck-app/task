import { parseGitHubOptions } from './githubOptions.js';
import { createPriorityContext } from './githubPriority.js';
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
		priority: createPriorityContext(parsed.settings.priority, ['urgent', 'high', 'medium', 'low']),
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

describe('the priority and the claim are parts of their own', () => {
	const claimBody = (json: string): string => `Body\n\n<!-- task:begin v1 -->${json}<!-- task:end -->`;

	it('a priority label or field value changes the priority part and nothing else (it is not a user label)', () => {
		// Where the priority lives decides what is a priority label: in labels the label is one, in the field it is an ordinary label.
		const ctx = context();
		ctx.priority.storage = 'label';
		const base = fieldHashes(issue(), ctx);
		const labelled = fieldHashes(issue({ labels: [label('priority:high')] }), ctx);
		ctx.priority.storage = 'field';
		const fielded = fieldHashes(
			issue({
				issue_field_values: [
					{
						issue_field_id: 7,
						data_type: 'single_select',
						issue_field_name: 'Priority',
						value: 1,
						single_select_option: { id: 1, name: 'High' },
					},
				],
			}),
			ctx
		);

		expect(labelled).toEqual({ ...base, priority: expect.not.stringMatching(base.priority) });
		expect(fielded).toEqual({ ...base, priority: expect.not.stringMatching(base.priority) });
		expect(labelled.priority).not.toBe(fielded.priority);
	});

	it('a claim changes the claim part only; a description edit changes body only', () => {
		const ctx = context();
		const base = fieldHashes(issue(), ctx);
		const claimed = fieldHashes(issue({ body: claimBody('{"claim":{"assignee":"w1"}}') }), ctx);
		const other = fieldHashes(issue({ body: claimBody('{"claim":{"assignee":"w2"}}') }), ctx);
		const edited = fieldHashes(issue({ body: 'Other body' }), ctx);

		expect(claimed.claim).not.toBe(base.claim);
		// The managed block is not the text a person edits: the body part hashes the visible text only.
		expect(claimed.body).toBe(base.body);
		expect(other.claim).not.toBe(claimed.claim);
		expect(edited.claim).toBe(base.claim);
		expect(edited.body).not.toBe(base.body);
	});

	it('a claim is compared on the claim part: a description edited meanwhile is no conflict, another claim is', () => {
		const ctx = context();
		const before = revisionOf(issue({ body: claimBody('{"claim":{"assignee":"w1"}}') }), 'e1', ctx);
		const edited = revisionOf(
			issue({ body: `Edited\n\n<!-- task:begin v1 -->{"claim":{"assignee":"w1"}}<!-- task:end -->` }),
			'e2',
			ctx
		);
		const taken = revisionOf(issue({ body: claimBody('{"claim":{"assignee":"w2"}}') }), 'e3', ctx);

		expect(checkRevision(before, edited, ['claim'])).toEqual([]);
		expect(checkRevision(before, taken, ['claim'])).toEqual(['claim']);
		expect(checkRevision(before, edited, ['body'])).toEqual(['body']);
	});

	it('the duplicate marker of the block is part of the dependencies, the visible text is not', () => {
		const ctx = context();
		const plain = fieldHashes(issue({ body: 'Text' }), ctx);
		const marked = fieldHashes(
			issue({
				body: 'Text\n\n<!-- task:begin v1 -->{"links":[{"type":"duplicateOf","target":"12"}]}<!-- task:end -->',
			}),
			ctx
		);

		expect(marked.dependencies).not.toBe(plain.dependencies);
		expect(marked.body).toBe(plain.body);
	});

	it('a corrupt claim block still hashes', () => {
		expect(() =>
			fieldHashes(issue({ body: '<!-- task:begin v1 -->{"claim":[]}<!-- task:end -->' }), context())
		).not.toThrow();
	});

	it('the revision holds one hash per part, ten of them', () => {
		expect(revisionOf(issue(), 'e', context())).toMatch(/#([0-9a-f]{6}\.){9}[0-9a-f]{6}$/);
	});
});
