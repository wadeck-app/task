import { BackendDataError } from '@wadeck-app/task-core';

import type { ProjectStatus } from '../kinds.js';
import { StatusMapper } from './gitlabStatusMapping.js';
import type { StatusRule } from './gitlabOptions.js';

const STATUSES: ProjectStatus[] = [
	{ name: 'backlog', terminal: false, default: true, outcome: undefined },
	{ name: 'wip', terminal: false, default: false, outcome: undefined },
	{ name: 'done', terminal: true, default: false, outcome: 'positive' },
	{ name: 'cancelled', terminal: true, default: false, outcome: 'negative' },
];

const MAP: Record<string, StatusRule> = {
	backlog: { state: 'open' },
	wip: { state: 'open', label: 'Status:WIP' },
	done: { state: 'closed' },
	cancelled: { state: 'closed', label: 'status:cancelled' },
};

const url = (iid: number): string => `https://gitlab.example/acme/shop/-/issues/${iid}`;
const mapper = (map = MAP): StatusMapper => new StatusMapper(map, STATUSES, url);

function failure(call: () => unknown): BackendDataError {
	try {
		call();
	} catch (error) {
		expect(error).toBeInstanceOf(BackendDataError);
		return error as BackendDataError;
	}
	throw new Error('expected a BackendDataError');
}

describe('StatusMapper.statusOf', () => {
	it('reads the bare status of a state, and the labelled one when its label is held', () => {
		const m = mapper();
		expect(m.statusOf({ iid: 1, state: 'opened', labels: [] })).toBe('backlog');
		expect(m.statusOf({ iid: 1, state: 'opened', labels: ['bug'] })).toBe('backlog');
		expect(m.statusOf({ iid: 1, state: 'opened', labels: ['Status:WIP'] })).toBe('wip');
		// Label names are case sensitive on GitLab: another case is another label, which tells nothing.
		expect(m.statusOf({ iid: 1, state: 'opened', labels: ['status:wip'] })).toBe('backlog');
		expect(m.statusOf({ iid: 1, state: 'closed', labels: [] })).toBe('done');
		expect(m.statusOf({ iid: 1, state: 'closed', labels: ['status:cancelled'] })).toBe('cancelled');
		// Label names are case sensitive on GitLab: another case does not tell the status.
		expect(m.statusOf({ iid: 1, state: 'closed', labels: ['STATUS:CANCELLED'] })).toBe('done');
	});

	it('ignores a status label that belongs to the other state', () => {
		// An open issue holding the closed-only label stays the bare open status.
		expect(mapper().statusOf({ iid: 1, state: 'opened', labels: ['status:cancelled'] })).toBe('backlog');
	});

	it('refuses two status labels, naming the labels and the issue page', () => {
		const m = mapper({ ...MAP, backlog: { state: 'open', label: 'status:backlog' } });
		const error = failure(() => m.statusOf({ iid: 7, state: 'opened', labels: ['status:backlog', 'Status:WIP'] }));
		expect(error.message).toBe('issue #7 carries two status labels (status:backlog, Status:WIP)');
		expect(error.hint).toContain(url(7));
	});

	it('refuses a closed issue when every closed status needs a label it lacks', () => {
		const m = new StatusMapper(
			{ backlog: { state: 'open' }, done: { state: 'closed', label: 'status:done' } },
			[STATUSES[0]!, STATUSES[2]!],
			url
		);
		const error = failure(() => m.statusOf({ iid: 3, state: 'closed', labels: [] }));
		expect(error.message).toMatch(/issue #3 is closed but carries none of the labels.*status:done/);
	});

	it('refuses a state no status maps', () => {
		const m = new StatusMapper({ backlog: { state: 'open' } }, [STATUSES[0]!], url);
		const error = failure(() => m.statusOf({ iid: 3, state: 'closed', labels: [] }));
		expect(error.message).toBe('issue #3 is closed, and no status of the project maps that');
	});

	it('tryStatusOf answers undefined instead of throwing', () => {
		const m = mapper({ ...MAP, backlog: { state: 'open', label: 'a' }, wip: { state: 'open', label: 'b' } });
		expect(m.tryStatusOf({ iid: 1, state: 'opened', labels: ['a', 'b'] })).toBeUndefined();
	});
});

describe('StatusMapper.representation and labels', () => {
	it('gives the state and the label as written in the config', () => {
		const m = mapper();
		expect(m.representation('wip')).toEqual({ state: 'open', label: 'Status:WIP' });
		expect(m.representation('done')).toEqual({ state: 'closed', label: undefined });
	});

	it('refuses a status of the project that is not mapped, and an unknown one', () => {
		expect(() => mapper().representation('nope')).toThrow(/not mapped to GitLab.*backlog, wip, done, cancelled/);
		expect(() => new StatusMapper({ backlog: { state: 'open' } }, STATUSES, url)).toThrow(/no entry for "wip"/);
	});

	it('knows its statuses and recognises its labels exactly', () => {
		const m = mapper();
		expect(m.knows('wip')).toBe(true);
		expect(m.knows('x')).toBe(false);
		expect(m.isStatusLabel('Status:WIP')).toBe(true);
		expect(m.isStatusLabel('status:wip')).toBe(false);
		expect(m.isStatusLabel('status:cancelled')).toBe(true);
		expect(m.isStatusLabel('STATUS:CANCELLED')).toBe(false);
		expect(m.isStatusLabel('bug')).toBe(false);
	});
});
