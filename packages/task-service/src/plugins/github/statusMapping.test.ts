import { BackendDataError } from '@wadeck-app/task-core';

import type { ProjectStatus } from '../kinds.js';
import type { StatusRule } from './githubOptions.js';
import { StatusMapper } from './statusMapping.js';

const STATUSES: ProjectStatus[] = [
	{ name: 'todo', terminal: false, default: true, outcome: undefined },
	{ name: 'doing', terminal: false, default: false, outcome: undefined },
	{ name: 'review', terminal: false, default: false, outcome: undefined },
	{ name: 'done', terminal: true, default: false, outcome: 'positive' },
	{ name: 'shipped', terminal: true, default: false, outcome: 'positive' },
	{ name: 'wontfix', terminal: true, default: false, outcome: 'negative' },
	{ name: 'dupe', terminal: true, default: false, outcome: 'negative' },
];

const MAP: Record<string, StatusRule> = {
	todo: { state: 'open' },
	doing: { state: 'open', label: 'status:doing' },
	review: { state: 'open', label: 'Status:Review' },
	done: { state: 'closed' },
	shipped: { state: 'closed', label: 'status:shipped' },
	wontfix: { state: 'closed' },
	dupe: { state: 'closed', reason: 'duplicate' },
};

const mapper = (): StatusMapper => new StatusMapper(MAP, STATUSES, issue => `https://github.com/o/r/issues/${issue}`);
const issue = (state: 'open' | 'closed', stateReason: string | null, labels: string[] = [], number = 12) => ({
	number,
	state,
	stateReason,
	labels,
});

function failure(call: () => unknown): BackendDataError {
	try {
		call();
	} catch (error) {
		expect(error).toBeInstanceOf(BackendDataError);
		return error as BackendDataError;
	}
	throw new Error('expected a BackendDataError');
}

describe('StatusMapper.statusOf: open issues', () => {
	it('an open issue with no status label is the open status that has none', () => {
		expect(mapper().statusOf(issue('open', null))).toBe('todo');
	});

	it('an open issue with a status label is that status, whatever the case of the label', () => {
		expect(mapper().statusOf(issue('open', null, ['status:doing']))).toBe('doing');
		expect(mapper().statusOf(issue('open', null, ['STATUS:DOING']))).toBe('doing');
		expect(mapper().statusOf(issue('open', 'reopened', ['status:review']))).toBe('review');
	});

	it('other labels do not matter', () => {
		expect(mapper().statusOf(issue('open', null, ['bug', 'status:doing', 'billing']))).toBe('doing');
	});

	it('the label of a closed status on an open issue is not a status (a reopened issue keeps it until someone removes it)', () => {
		expect(mapper().statusOf(issue('open', 'reopened', ['status:shipped']))).toBe('todo');
	});

	it('two status labels are an error naming the issue and the fix', () => {
		const error = failure(() => mapper().statusOf(issue('open', null, ['status:doing', 'status:review'])));

		expect(error.subject).toBe('issue #12');
		expect(error.message).toBe('issue #12 carries two status labels (status:doing, status:review)');
		expect(error.hint).toBe(
			'Remove one of them on https://github.com/o/r/issues/12; the task status is the one that stays'
		);
	});
});

describe('StatusMapper.statusOf: closed issues', () => {
	it('a closed issue maps by its close reason; no reason reads as completed', () => {
		expect(mapper().statusOf(issue('closed', 'completed'))).toBe('done');
		expect(mapper().statusOf(issue('closed', null))).toBe('done');
		expect(mapper().statusOf(issue('closed', 'not_planned'))).toBe('wontfix');
		expect(mapper().statusOf(issue('closed', 'duplicate'))).toBe('dupe');
	});

	it('a label tells apart two statuses that close the same way', () => {
		expect(mapper().statusOf(issue('closed', 'completed', ['status:shipped']))).toBe('shipped');
		expect(mapper().statusOf(issue('closed', 'completed', ['bug']))).toBe('done');
	});

	it('a close reason no status maps is an error that says which status to add', () => {
		const partial = new StatusMapper(
			{ todo: { state: 'open' }, done: { state: 'closed' } },
			STATUSES.filter(status => ['todo', 'done'].includes(status.name)),
			n => `https://github.com/o/r/issues/${n}`
		);

		const error = failure(() => partial.statusOf(issue('closed', 'not_planned', [], 7)));
		expect(error.message).toBe('issue #7 is closed as not planned, and no status of the project maps that');
		expect(error.hint).toContain('statusMap');
		expect(error.hint).toContain('reason: not_planned');
	});

	it('closed statuses that all need a label, none present, is an error listing the labels', () => {
		const labelled = new StatusMapper(
			{ todo: { state: 'open' }, a: { state: 'closed', label: 'x:a' }, b: { state: 'closed', label: 'x:b' } },
			[
				{ name: 'todo', terminal: false, default: true, outcome: undefined },
				{ name: 'a', terminal: true, default: false, outcome: 'positive' },
				{ name: 'b', terminal: true, default: false, outcome: 'positive' },
			],
			n => `https://github.com/o/r/issues/${n}`
		);

		const error = failure(() => labelled.statusOf(issue('closed', 'completed')));
		expect(error.message).toBe(
			'issue #12 is closed as completed but carries none of the labels that tell the statuses apart (x:a, x:b)'
		);
	});
});

describe('StatusMapper.statusLabels and tryStatusOf', () => {
	it('lists the labels that mean a status (lower case), for the code that hides them from the task labels', () => {
		expect([...mapper().statusLabels].sort()).toEqual(['status:doing', 'status:review', 'status:shipped']);
		expect(mapper().isStatusLabel('Status:Doing')).toBe(true);
		expect(mapper().isStatusLabel('bug')).toBe(false);
	});

	it('tryStatusOf answers undefined where statusOf would throw (a replay passes through such states)', () => {
		expect(mapper().tryStatusOf(issue('open', null, ['status:doing', 'status:review']))).toBeUndefined();
		expect(mapper().tryStatusOf(issue('closed', 'not_planned', []))).toBe('wontfix');
	});
});
