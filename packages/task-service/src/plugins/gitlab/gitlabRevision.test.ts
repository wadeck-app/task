// The revision of a gitlab issue: one short hash per part, the managed block of the description covered by its own parts (meta, links,
// claim) so the `body` part is the visible text alone, and a priority label covered by `priority`.
import { composeBody } from '../forge-common/managedBlock.js';
import type { ProjectStatus } from '../kinds.js';
import type { MapContext } from './gitlabMapping.js';
import { parseGitLabOptions } from './gitlabOptions.js';
import { createPriorityContext } from './gitlabPriority.js';
import { FIELD_GROUPS, checkRevision, fieldHashes, revisionOf } from './gitlabRevision.js';
import { StatusMapper } from './gitlabStatusMapping.js';
import type { ApiIssue } from './gitlabTypes.js';

const STATUSES: ProjectStatus[] = [
	{ name: 'backlog', terminal: false, default: true, outcome: undefined },
	{ name: 'done', terminal: true, default: false, outcome: 'positive' },
];

function context(extra: Record<string, unknown> = {}, meta: 'block' | 'labels' | 'none' = 'block'): MapContext {
	const parsed = parseGitLabOptions({
		project: 'acme/shop',
		tokenEnv: 'T',
		statusMap: { backlog: { state: 'open' }, done: { state: 'closed' } },
		...extra,
	});
	if ('problem' in parsed) throw new Error(parsed.problem);
	const issueUrl = (iid: number): string => `https://gitlab.example/acme/shop/-/issues/${iid}`;
	return {
		settings: parsed.settings,
		mapper: new StatusMapper(parsed.settings.statusMap, STATUSES, issueUrl),
		metaFromLabels: meta === 'labels',
		metaFromBlock: meta === 'block',
		projectTypes: [],
		priority: createPriorityContext(parsed.settings, ['urgent', 'high', 'medium', 'low']),
		notice: () => undefined,
		issueUrl,
	};
}

function issue(extra: Partial<ApiIssue> = {}): ApiIssue {
	return {
		id: 900,
		iid: 5,
		project_id: 1,
		title: 'Title',
		description: 'Body',
		state: 'opened',
		labels: [],
		created_at: '2026-11-08T10:00:00.000Z',
		updated_at: '2026-11-08T10:00:00.000Z',
		...extra,
	};
}

const block = (data: Record<string, unknown>): string => composeBody('Body', data);

describe('fieldHashes: the parts', () => {
	it('lists priority, claim and links next to the former parts, and a revision carries one hash per part', () => {
		expect(FIELD_GROUPS).toEqual([
			'title',
			'body',
			'status',
			'type',
			'labels',
			'meta',
			'links',
			'priority',
			'claim',
		]);
		expect(revisionOf(issue(), context()).split('#')[1]!.split('.')).toHaveLength(9);
	});

	it('a priority label changes the priority part and nothing else (it is not a user label)', () => {
		const ctx = context();
		const base = fieldHashes(issue(), ctx);
		const changed = fieldHashes(issue({ labels: ['priority:high'] }), ctx);

		const differing = FIELD_GROUPS.filter(group => base[group] !== changed[group]);

		expect(differing).toEqual(['priority']);
		expect(fieldHashes(issue({ labels: ['priority:high'] }), ctx).priority).not.toBe(
			fieldHashes(issue({ labels: ['priority:low'] }), ctx).priority
		);
	});

	it('a claim changes the claim part only: not the body, the meta nor the links', () => {
		const ctx = context();
		const plain = fieldHashes(issue(), ctx);
		const claimed = fieldHashes(issue({ description: block({ claim: { assignee: 'w1' } }) }), ctx);
		const renewed = fieldHashes(
			issue({ description: block({ claim: { assignee: 'w1', claimedAt: '2026-11-14T10:00:00.000Z' } }) }),
			ctx
		);

		expect(FIELD_GROUPS.filter(group => plain[group] !== claimed[group])).toEqual(['claim']);
		expect(claimed.claim).not.toBe(renewed.claim);
	});

	it('meta in the block changes the meta part only; a duplicateOf marker changes the links part only', () => {
		const ctx = context();
		const plain = fieldHashes(issue(), ctx);

		const withMeta = fieldHashes(issue({ description: block({ meta: { owner: 'ann' } }) }), ctx);
		const withLink = fieldHashes(
			issue({ description: block({ links: [{ type: 'duplicateOf', target: '7' }] }) }),
			ctx
		);

		expect(FIELD_GROUPS.filter(group => plain[group] !== withMeta[group])).toEqual(['meta']);
		expect(FIELD_GROUPS.filter(group => plain[group] !== withLink[group])).toEqual(['links']);
	});

	it('the visible text changes the body part only; CRLF is read as LF', () => {
		const ctx = context();
		const plain = fieldHashes(issue(), ctx);

		expect(
			FIELD_GROUPS.filter(group => plain[group] !== fieldHashes(issue({ description: 'Other' }), ctx)[group])
		).toEqual(['body']);
		expect(fieldHashes(issue({ description: 'a\r\nb' }), ctx).body).toBe(
			fieldHashes(issue({ description: 'a\nb' }), ctx).body
		);
	});

	it('a block that cannot be read has stable hashes of its own (the write that reads it reports the problem)', () => {
		const ctx = context();
		const broken = issue({ description: 'Text <!-- task:begin v1 -->{nope<!-- task:end -->' });

		expect(() => fieldHashes(broken, ctx)).not.toThrow();
		expect(fieldHashes(broken, ctx).claim).toBe(fieldHashes(broken, ctx).claim);
		expect(fieldHashes(broken, ctx).body).not.toBe(fieldHashes(issue(), ctx).body);
	});
});

describe('checkRevision', () => {
	it('compares only the parts a write changes; a revision this backend did not issue is stale for any write', () => {
		const ctx = context();
		const read = revisionOf(issue(), ctx);
		const claimedMeanwhile = revisionOf(issue({ description: block({ claim: { assignee: 'w9' } }) }), ctx);

		expect(checkRevision(read, claimedMeanwhile, ['body'])).toEqual([]);
		expect(checkRevision(read, claimedMeanwhile, ['claim'])).toEqual(['claim']);
		expect(checkRevision(read, read, ['claim', 'priority'])).toEqual([]);
		expect(checkRevision('whatever', read, ['body'])).toEqual(['revision']);
	});
});
