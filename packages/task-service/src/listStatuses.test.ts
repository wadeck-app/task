import { listStatuses } from './listStatuses.js';
import { createTestContext } from './testHelpers.js';
import type { TestContext } from './testHelpers.js';

describe('listStatuses', () => {
	let t: TestContext;

	afterEach(() => t.cleanup());

	it('gives the valid statuses in config order, with the default and the terminal ones', () => {
		t = createTestContext({
			statuses: ['backlog', 'doing', 'done', 'dropped'],
			defaultStatus: 'doing',
			terminalStatuses: ['done', 'dropped'],
		});

		expect(listStatuses(t.ctx)).toEqual([
			{ name: 'backlog', default: false, terminal: false },
			{ name: 'doing', default: true, terminal: false },
			{ name: 'done', default: false, terminal: true, outcome: 'positive' },
			{ name: 'dropped', default: false, terminal: true, outcome: 'positive' },
		]);
	});

	it('gives the outcome of the terminal statuses only (positive unless the config says negative)', () => {
		t = createTestContext({
			statuses: ['todo', 'done', 'rejected'],
			defaultStatus: 'todo',
			terminalStatuses: ['done', 'rejected'],
			negativeStatuses: ['rejected'],
		});

		expect(listStatuses(t.ctx)).toEqual([
			{ name: 'todo', default: true, terminal: false },
			{ name: 'done', default: false, terminal: true, outcome: 'positive' },
			{ name: 'rejected', default: false, terminal: true, outcome: 'negative' },
		]);
	});

	it('answers from the same config as the validation of set-status', () => {
		t = createTestContext({ statuses: ['todo', 'done'], defaultStatus: 'todo', terminalStatuses: ['done'] });

		const names = listStatuses(t.ctx).map(status => status.name);

		expect(names).toEqual(t.ctx.config.statuses);
	});
});
