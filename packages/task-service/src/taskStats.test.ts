import { countTasksByStatus } from './taskStats.js';
import { createTestContext, type TestContext } from './testHelpers.js';

describe('countTasksByStatus', () => {
	let t: TestContext;
	beforeEach(() => {
		t = createTestContext();
	});
	afterEach(() => t.cleanup());

	it('lists every configured status in config order, with zero for the empty ones', async () => {
		expect(await countTasksByStatus(t.ctx)).toEqual([
			{ status: 'backlog', count: 0, terminal: false },
			{ status: 'in-progress', count: 0, terminal: false },
			{ status: 'done', count: 0, terminal: true },
		]);
	});

	it('counts the tasks of each status', async () => {
		await t.ctx.store.create({ title: 'a', status: 'backlog' });
		await t.ctx.store.create({ title: 'b', status: 'backlog' });
		await t.ctx.store.create({ title: 'c', status: 'done' });
		const counts = Object.fromEntries((await countTasksByStatus(t.ctx)).map(entry => [entry.status, entry.count]));
		expect(counts).toEqual({ backlog: 2, 'in-progress': 0, done: 1 });
	});

	it('keeps tasks whose status was removed from the config, as a non-terminal entry after the configured ones', async () => {
		await t.ctx.store.create({ title: 'legacy', status: 'archived' });
		const counts = await countTasksByStatus(t.ctx);
		expect(counts[counts.length - 1]).toEqual({ status: 'archived', count: 1, terminal: false });
		expect(counts.reduce((sum, entry) => sum + entry.count, 0)).toBe(1);
	});
});
