import { listLabels } from './listLabels.js';
import { createTestContext, seedTasks, type TestContext } from './testHelpers.js';

describe('listLabels', () => {
	let t: TestContext;
	beforeEach(() => {
		t = createTestContext();
	});
	afterEach(() => t.cleanup());

	it('is empty for a project without labels', async () => {
		await t.ctx.store.create({ title: 'a', status: 'backlog' });

		expect(await listLabels(t.ctx)).toEqual([]);
	});

	it('counts the tasks carrying each label, sorted by count (desc) then name', async () => {
		const a = await t.ctx.store.create({ title: 'a', status: 'backlog' });
		const b = await t.ctx.store.create({ title: 'b', status: 'backlog' });
		const c = await t.ctx.store.create({ title: 'c', status: 'backlog' });
		for (const [task, label] of [
			[a, 'zeta'],
			[b, 'zeta'],
			[c, 'zeta'],
			[a, 'beta'],
			[b, 'beta'],
			[a, 'alpha'],
			[c, 'omega'],
		] as const) {
			await t.ctx.store.addLabel(task.id, label);
		}

		expect(await listLabels(t.ctx)).toEqual([
			{ label: 'zeta', count: 3 },
			{ label: 'beta', count: 2 },
			{ label: 'alpha', count: 1 },
			{ label: 'omega', count: 1 },
		]);
	});

	it('counts closed tasks too', async () => {
		const a = await t.ctx.store.create({ title: 'a', status: 'backlog' });
		await t.ctx.store.addLabel(a.id, 'old');
		await t.ctx.store.updateStatus(a.id, 'done');

		expect(await listLabels(t.ctx)).toEqual([{ label: 'old', count: 1 }]);
	});

	it('is case-sensitive: labels are distinct strings', async () => {
		const a = await t.ctx.store.create({ title: 'a', status: 'backlog' });
		await t.ctx.store.addLabel(a.id, 'Bug');
		await t.ctx.store.addLabel(a.id, 'bug');

		expect((await listLabels(t.ctx)).map(entry => entry.label)).toEqual(['Bug', 'bug']);
	});

	it('measured on 1 000 tasks (cold call, then median of 9 warm calls, printed)', async () => {
		seedTasks(t, 1000);
		const timed = async (): Promise<number> => {
			const start = performance.now();
			await listLabels(t.ctx);
			return performance.now() - start;
		};
		const cold = await timed();
		const warm: number[] = [];
		for (let run = 0; run < 9; run++) {
			warm.push(await timed());
		}
		warm.sort((x, y) => x - y);
		console.info(
			`listLabels over 1000 tasks: cold ${cold.toFixed(1)} ms, warm min ${warm[0]!.toFixed(1)} / median ${warm[4]!.toFixed(1)} / max ${warm[8]!.toFixed(1)} ms`
		);

		const labels = await listLabels(t.ctx);
		expect(labels[0]).toEqual({ label: 'common', count: 1000 });
		expect(labels).toHaveLength(1 + 20 + 1000);
	});
});
