import { BackendDataError } from '@wadeck-app/task-core';

import type { ProjectStatus, ReadNotice } from '../kinds.js';
import {
	activityOf,
	commentsOf,
	composeBody,
	isTombstone,
	linksOf,
	metaLabelName,
	metaLabelProblem,
	metaOf,
	parseMetaLabel,
	replayHistory,
	splitBody,
	statusOfIssue,
	timelineOf,
	toSummary,
	typeOf,
	userLabels,
} from './gitlabMapping.js';
import type { MapContext } from './gitlabMapping.js';
import { parseGitLabOptions } from './gitlabOptions.js';
import { StatusMapper } from './gitlabStatusMapping.js';
import type { ApiIssue, ApiLabelEvent, ApiNote, ApiStateEvent } from './gitlabTypes.js';

const STATUSES: ProjectStatus[] = [
	{ name: 'backlog', terminal: false, default: true, outcome: undefined },
	{ name: 'wip', terminal: false, default: false, outcome: undefined },
	{ name: 'done', terminal: true, default: false, outcome: 'positive' },
	{ name: 'cancelled', terminal: true, default: false, outcome: 'negative' },
];

function contextOf(
	options: { tier?: string; meta?: 'labels' | 'block' | 'none'; typeMap?: Record<string, unknown> } = {}
): MapContext {
	const tier = options.tier ?? 'free';
	const scoped = tier !== 'free';
	const status = (name: string): string => `status${scoped ? '::' : ':'}${name}`;
	const parsed = parseGitLabOptions({
		project: 'acme/shop',
		tokenEnv: 'T',
		tier,
		statusMap: {
			backlog: { state: 'open' },
			wip: { state: 'open', label: status('wip') },
			done: { state: 'closed' },
			cancelled: { state: 'closed', label: status('cancelled') },
		},
		...(options.typeMap === undefined ? {} : { typeMap: options.typeMap }),
	});
	if ('problem' in parsed) throw new Error(parsed.problem);
	const issueUrl = (iid: number): string => `https://gitlab.example/acme/shop/-/issues/${iid}`;
	return {
		settings: parsed.settings,
		mapper: new StatusMapper(parsed.settings.statusMap, STATUSES, issueUrl),
		metaFromLabels: options.meta === 'labels',
		metaFromBlock: options.meta === 'block',
		projectTypes: [],
		notice: (_notice: ReadNotice) => undefined,
		issueUrl,
	};
}

function issue(extra: Partial<ApiIssue> = {}): ApiIssue {
	return {
		id: 900,
		iid: 5,
		project_id: 1,
		title: 'Fix it',
		description: null,
		state: 'opened',
		labels: [],
		created_at: '2026-11-08T10:00:00.000Z',
		updated_at: '2026-11-08T11:00:00.000Z',
		...extra,
	};
}

function failure(call: () => unknown): BackendDataError {
	try {
		call();
	} catch (error) {
		expect(error).toBeInstanceOf(BackendDataError);
		return error as BackendDataError;
	}
	throw new Error('expected a BackendDataError');
}

describe('summaries and status', () => {
	it('uses the iid as the id, ISO dates, and the status from state and labels', () => {
		const ctx = contextOf();
		expect(toSummary(issue({ labels: ['status:wip'] }), ctx)).toEqual({
			id: '5',
			title: 'Fix it',
			status: 'wip',
			createdAt: '2026-11-08T10:00:00.000Z',
		});
		expect(statusOfIssue(issue({ state: 'closed', labels: [{ name: 'STATUS:CANCELLED' }] }), contextOf())).toBe(
			'cancelled'
		);
	});

	it('knows a tombstone whatever the case', () => {
		expect(isTombstone(issue({ labels: ['Task:Deleted'] }))).toBe(true);
		expect(isTombstone(issue({ labels: ['task'] }))).toBe(false);
	});
});

describe('splitBody and composeBody', () => {
	it('reads the description as LF text, absent when empty or equal to the title', () => {
		const ctx = contextOf();
		expect(splitBody(issue({ description: 'a\r\nb\r\n' }), ctx).description).toBe('a\nb');
		expect(splitBody(issue({ description: '  \n' }), ctx).description).toBeUndefined();
		expect(splitBody(issue({ description: 'Fix it' }), ctx).description).toBeUndefined();
		expect(splitBody(issue({ description: null }), ctx).description).toBeUndefined();
	});

	it('removes the managed block from the description and reads its links and meta', () => {
		const block =
			'<!-- task:begin v1 -->{"meta":{"k":"v"},"links":[{"type":"duplicateOf","target":"3"},{"type":"causedBy","target":4},{"type":"blockedBy","target":"9"}]}<!-- task:end -->';
		const parts = splitBody(issue({ description: `Text\r\n\r\n${block}` }), contextOf());
		expect(parts.description).toBe('Text');
		expect(parts.visibleText).toBe('Text');
		expect(parts.blockMeta).toEqual({ k: 'v' });
		// Only the types the block may hold (blockedBy is native, never read from the block).
		expect(parts.blockLinks).toEqual([
			{ type: 'duplicateOf', target: '3' },
			{ type: 'causedBy', target: '4' },
		]);
	});

	it('refuses a block without end marker, with bad JSON, a wrong version or a wrong shape, naming the fix', () => {
		const ctx = contextOf();
		const read = (description: string) => failure(() => splitBody(issue({ description }), ctx));
		expect(read('x <!-- task:begin v1 -->{}').message).toMatch(/has no end marker/);
		expect(read('<!-- task:begin v1 -->{nope<!-- task:end -->').message).toMatch(/not valid JSON/);
		expect(read('<!-- task:begin v2 -->{}<!-- task:end -->').message).toMatch(/format v2/);
		expect(read('<!-- task:begin v1 -->[]<!-- task:end -->').message).toMatch(/not a JSON object/);
		expect(read('<!-- task:begin v1 -->{"meta":[]}<!-- task:end -->').message).toMatch(
			/"meta" that is not an object/
		);
		expect(read('<!-- task:begin v1 -->{"meta":{"a":1}}<!-- task:end -->').message).toMatch(
			/meta value that is not a text \(a\)/
		);
		const bad = read('<!-- task:begin v1 -->{"links":{}}<!-- task:end -->');
		expect(bad.message).toMatch(/"links" that is not a list/);
		expect(bad.hint).toContain('https://gitlab.example/acme/shop/-/issues/5');
	});

	it('composes the visible text then the block, dropping an empty block', () => {
		expect(composeBody('Text', undefined)).toBe('Text');
		expect(composeBody('Text', {})).toBe('Text');
		expect(composeBody('Text', { meta: { a: 'b' } })).toBe(
			'Text\n\n<!-- task:begin v1 -->{"meta":{"a":"b"}}<!-- task:end -->'
		);
		expect(composeBody('', { meta: { a: 'b' } })).toBe('<!-- task:begin v1 -->{"meta":{"a":"b"}}<!-- task:end -->');
		// Round trip.
		const body = composeBody('Text', { meta: { a: 'b' } });
		expect(splitBody(issue({ description: body }), contextOf()).blockMeta).toEqual({ a: 'b' });
	});
});

describe('labels and type', () => {
	it('hides status, type and (with the fill) meta labels from the user labels', () => {
		const labels = ['status:wip', 'type:bug', 'meta:owner=ann', 'urgent'];
		expect(userLabels(issue({ labels }), contextOf())).toEqual(['meta:owner=ann', 'urgent']);
		expect(userLabels(issue({ labels }), contextOf({ meta: 'labels' }))).toEqual(['urgent']);
	});

	it('reads the type from a label, case-insensitively, keeping the case of the rest', () => {
		expect(typeOf(issue({ labels: ['TYPE:Bug'] }), contextOf())).toBe('Bug');
		expect(typeOf(issue(), contextOf())).toBeUndefined();
	});

	it('prefers typeMap labels and refuses two type labels', () => {
		const ctx = contextOf({ typeMap: { feature: { label: 'kind:feat' } } });
		expect(typeOf(issue({ labels: ['kind:FEAT'] }), ctx)).toBe('feature');
		const error = failure(() => typeOf(issue({ labels: ['type:bug', 'kind:feat'] }), ctx));
		expect(error.message).toBe('issue #5 carries two type labels (type:bug, kind:feat)');
	});

	it('reads a native incident / test_case through typeMap, ignores issue and task and unmapped ones', () => {
		const ctx = contextOf({ typeMap: { bug: { issueType: 'incident' } } });
		expect(typeOf(issue({ issue_type: 'incident' }), ctx)).toBe('bug');
		expect(typeOf(issue({ issue_type: 'issue' }), ctx)).toBeUndefined();
		expect(typeOf(issue({ issue_type: 'task' }), ctx)).toBeUndefined();
		expect(typeOf(issue({ issue_type: 'test_case' }), ctx)).toBeUndefined();
		// A type label wins over a native type.
		expect(typeOf(issue({ issue_type: 'incident', labels: ['type:other'] }), ctx)).toBe('other');
	});
});

describe('meta labels', () => {
	it('writes the plain style meta:key=value on free and the scoped meta::key::value on premium', () => {
		expect(metaLabelName('owner', 'ann', contextOf())).toBe('meta:owner=ann');
		expect(metaLabelName('owner', 'ann', contextOf({ tier: 'premium' }))).toBe('meta::owner::ann');
	});

	it('reads the plain style; no "=" is an empty value, the first "=" splits, the rest is the value', () => {
		const ctx = contextOf({ meta: 'labels' });
		expect(parseMetaLabel('meta:a=b=c', ctx, 5)).toEqual({ key: 'a', value: 'b=c' });
		expect(parseMetaLabel('meta:flag', ctx, 5)).toEqual({ key: 'flag', value: '' });
		expect(parseMetaLabel('META:a=1', ctx, 5)).toEqual({ key: 'a', value: '1' });
		expect(parseMetaLabel('bug', ctx, 5)).toBeUndefined();
		expect(failure(() => parseMetaLabel('meta:=x', ctx, 5)).message).toMatch(/without a key/);
	});

	it('reads the scoped style splitting at the LAST "::"', () => {
		const ctx = contextOf({ tier: 'ultimate', meta: 'labels' });
		expect(parseMetaLabel('meta::owner::ann', ctx, 5)).toEqual({ key: 'owner', value: 'ann' });
		expect(parseMetaLabel('meta::a::b::c', ctx, 5)).toEqual({ key: 'a::b', value: 'c' });
		for (const bad of ['meta::owner', 'meta::owner::', 'meta::::x']) {
			expect(failure(() => parseMetaLabel(bad, ctx, 5)).message).toMatch(/not of the form meta::<key>::<value>/);
		}
	});

	it('does not read meta labels without the fill', () => {
		expect(parseMetaLabel('meta:a=b', contextOf(), 5)).toBeUndefined();
		expect(metaOf(issue({ labels: ['meta:a=b'] }), contextOf())).toBeUndefined();
	});

	it('builds the meta of an issue and refuses two labels for one key', () => {
		const ctx = contextOf({ meta: 'labels' });
		expect(metaOf(issue({ labels: ['meta:a=1', 'meta:b=2', 'x'] }), ctx)).toEqual({ a: '1', b: '2' });
		expect(metaOf(issue({ labels: ['x'] }), ctx)).toBeUndefined();
		expect(failure(() => metaOf(issue({ labels: ['meta:a=1', 'meta:a=2'] }), ctx)).message).toMatch(
			/two meta labels for the key "a"/
		);
	});

	it('reads the meta of the managed block with the block fill', () => {
		const ctx = contextOf({ meta: 'block' });
		const description = composeBody('t', { meta: { k: 'v' } });
		expect(metaOf(issue({ description }), ctx)).toEqual({ k: 'v' });
		expect(metaOf(issue({ description: composeBody('t', { meta: {} }) }), ctx)).toBeUndefined();
		expect(metaOf(issue({ description: 'plain' }), ctx)).toBeUndefined();
	});

	it('says what a label cannot hold', () => {
		const free = contextOf();
		const scoped = contextOf({ tier: 'premium' });
		expect(metaLabelProblem('a', 'b', free)).toBeUndefined();
		expect(metaLabelProblem('a', '', free)).toBeUndefined();
		expect(metaLabelProblem('', 'b', free)).toMatch(/key cannot be empty/);
		expect(metaLabelProblem('a,b', 'x', free)).toMatch(/comma/);
		expect(metaLabelProblem('a', 'x,y', free)).toMatch(/comma/);
		expect(metaLabelProblem('a', ' x', free)).toMatch(/space/);
		expect(metaLabelProblem('a=b', 'x', free)).toMatch(/contains "="/);
		expect(metaLabelProblem('a', 'x=y', free)).toBeUndefined();
		expect(metaLabelProblem('a', 'b', scoped)).toBeUndefined();
		expect(metaLabelProblem('a::b', 'c', scoped)).toMatch(/"::"/);
		expect(metaLabelProblem('a', 'b::c', scoped)).toMatch(/"::"/);
		expect(metaLabelProblem('a', '', scoped)).toMatch(/empty/);
		// "=" is only special in the plain style.
		expect(metaLabelProblem('a=b', 'c', scoped)).toBeUndefined();
	});
});

describe('comments', () => {
	const note = (extra: Partial<ApiNote>): ApiNote => ({
		id: 1,
		body: 'hello',
		author: { username: 'ann' },
		created_at: '2026-11-08T10:00:00.000Z',
		updated_at: '2026-11-08T10:00:00.000Z',
		system: false,
		...extra,
	});

	it('leaves system notes out, marks an edit, tolerates a missing author', () => {
		const comments = commentsOf([
			note({ id: 1 }),
			note({ id: 2, system: true, body: 'added ~bug label' }),
			note({ id: 3, updated_at: '2026-11-08T12:00:00.000Z', author: null }),
		]);
		expect(comments).toEqual([
			{ id: '1', at: '2026-11-08T10:00:00.000Z', text: 'hello', author: 'ann' },
			{ id: '3', at: '2026-11-08T10:00:00.000Z', text: 'hello', editedAt: '2026-11-08T12:00:00.000Z' },
		]);
	});
});

describe('history', () => {
	const T0 = Date.parse('2026-11-08T10:00:00.000Z');
	const at = (seconds: number): string => new Date(T0 + seconds * 1000).toISOString();
	const label = (id: number, seconds: number, name: string, action: 'add' | 'remove'): ApiLabelEvent => ({
		id,
		created_at: at(seconds),
		label: { name },
		action,
	});
	const state = (id: number, seconds: number, value: string): ApiStateEvent => ({
		id,
		created_at: at(seconds),
		state: value,
	});

	it('starts with the creation status and replays label and state events', () => {
		const ctx = contextOf();
		const current = issue({ state: 'closed', labels: [], updated_at: at(600) });
		const history = replayHistory(
			current,
			[label(1, 60, 'status:wip', 'add'), label(2, 300, 'status:wip', 'remove')],
			[state(1, 300, 'closed')],
			ctx,
			'done'
		);
		// The removal of the label and the close are one change: no 'backlog' step in between.
		expect(history).toEqual([
			{ status: 'backlog', timestamp: at(0) },
			{ status: 'wip', timestamp: at(60) },
			{ status: 'done', timestamp: at(300) },
		]);
	});

	it('takes label events inside the creation window as the creation status', () => {
		const history = replayHistory(
			issue({ labels: ['status:wip'] }),
			[label(1, 1, 'status:wip', 'add')],
			[],
			contextOf(),
			'wip'
		);
		expect(history).toEqual([{ status: 'wip', timestamp: at(0) }]);
	});

	it('does not take a label event after the window as creation', () => {
		const history = replayHistory(
			issue({ labels: ['status:wip'] }),
			[label(1, 3, 'status:wip', 'add')],
			[],
			contextOf(),
			'wip'
		);
		expect(history.map(entry => entry.status)).toEqual(['backlog', 'wip']);
	});

	it('skips the passage through two status labels (a swap) and a repeated status', () => {
		const events = [
			label(1, 10, 'status:wip', 'add'),
			label(2, 20, 'status:cancelled', 'add'),
			label(3, 20, 'status:wip', 'remove'),
			label(4, 30, 'urgent', 'add'),
		];
		const history = replayHistory(issue({ labels: ['status:cancelled'] }), events, [], contextOf(), 'backlog');
		// status:cancelled on an OPEN issue still reads as backlog; the final entry is the current status.
		expect(history.map(entry => entry.status)).toEqual(['backlog', 'wip', 'backlog']);
	});

	it('always ends with the current status, stamped with updated_at', () => {
		const history = replayHistory(issue({ updated_at: at(99) }), [], [], contextOf(), 'wip');
		expect(history).toEqual([
			{ status: 'backlog', timestamp: at(0) },
			{ status: 'wip', timestamp: at(99) },
		]);
	});

	it('reads reopened as open and ignores a label event whose label is gone', () => {
		const events: ApiLabelEvent[] = [{ id: 9, created_at: at(5), label: null, action: 'add' }];
		const history = replayHistory(
			issue(),
			events,
			[state(1, 60, 'closed'), state(2, 120, 'reopened')],
			contextOf(),
			'backlog'
		);
		expect(history.map(entry => entry.status)).toEqual(['backlog', 'done', 'backlog']);
	});

	it('merges both lists by time, labels before states at one instant', () => {
		const events = timelineOf([label(1, 10, 'a', 'add'), label(2, 5, 'b', 'add')], [state(1, 10, 'closed')]);
		expect(events.map(event => event.kind + String(event.id))).toEqual(['label2', 'label1', 'state1']);
	});
});

describe('activity', () => {
	const event = (name: string, action: 'add' | 'remove', id = 1): ApiLabelEvent => ({
		id,
		created_at: '2026-11-08T10:00:00.000Z',
		label: { name },
		action,
	});
	const at = '2026-11-08T10:00:00.000Z';

	it('maps type, meta and plain labels, and skips status labels', () => {
		const ctx = contextOf({ meta: 'labels' });
		const rows = activityOf(
			[
				event('status:wip', 'add'),
				event('type:bug', 'add'),
				event('type:bug', 'remove'),
				event('meta:owner=ann', 'add'),
				event('meta:owner=ann', 'remove'),
				event('urgent', 'add'),
				event('urgent', 'remove'),
			],
			ctx,
			5
		);
		expect(rows).toEqual([
			{ at, kind: 'type', newValue: 'bug' },
			{ at, kind: 'type', oldValue: 'bug' },
			{ at, kind: 'meta-set', field: 'owner', newValue: 'ann' },
			{ at, kind: 'meta-removed', field: 'owner', oldValue: 'ann' },
			{ at, kind: 'label-added', newValue: 'urgent' },
			{ at, kind: 'label-removed', oldValue: 'urgent' },
		]);
	});

	it('leaves a malformed scoped meta label out instead of failing the whole read', () => {
		const ctx = contextOf({ tier: 'premium', meta: 'labels' });
		expect(activityOf([event('meta::broken', 'add')], ctx, 5)).toEqual([]);
		expect(activityOf([{ id: 1, created_at: at, label: null, action: 'add' }], ctx, 5)).toEqual([]);
	});
});

describe('linksOf', () => {
	it('lists the blockers then the block links, as strings', () => {
		expect(linksOf([3, 4], [{ type: 'duplicateOf', target: '9' }])).toEqual([
			{ type: 'blockedBy', target: '3' },
			{ type: 'blockedBy', target: '4' },
			{ type: 'duplicateOf', target: '9' },
		]);
		expect(linksOf([], [])).toEqual([]);
	});
});
