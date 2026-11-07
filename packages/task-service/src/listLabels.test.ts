import { listLabels } from './listLabels.js';
import { createTestContext, seedTasks, type TestContext } from './testHelpers.js';

describe('listLabels', () => {
	let t: TestContext;
	beforeEach(() => {
		t = createTestContext();
	});
	afterEach(() => t.cleanup());

	it('is empty for a project without labels', () => {
		t.ctx.store.create('a', 'backlog');

		expect(listLabels(t.ctx)).toEqual([]);
	});

	it('counts the tasks carrying each label, sorted by count (desc) then name', () => {
		const a = t.ctx.store.create('a', 'backlog');
		const b = t.ctx.store.create('b', 'backlog');
		const c = t.ctx.store.create('c', 'backlog');
		for (const [task, label] of [
			[a, 'zeta'],
			[b, 'zeta'],
			[c, 'zeta'],
			[a, 'beta'],
			[b, 'beta'],
			[a, 'alpha'],
			[c, 'omega'],
		] as const) {
			t.ctx.store.addLabel(task.id, label);
		}

		expect(listLabels(t.ctx)).toEqual([
			{ label: 'zeta', count: 3 },
			{ label: 'beta', count: 2 },
			{ label: 'alpha', count: 1 },
			{ label: 'omega', count: 1 },
		]);
	});

	it('counts closed tasks too', () => {
		const a = t.ctx.store.create('a', 'backlog');
		t.ctx.store.addLabel(a.id, 'old');
		t.ctx.store.updateStatus(a.id, 'done');

		expect(listLabels(t.ctx)).toEqual([{ label: 'old', count: 1 }]);
	});

	it('is case-sensitive: labels are distinct strings', () => {
		const a = t.ctx.store.create('a', 'backlog');
		t.ctx.store.addLabel(a.id, 'Bug');
		t.ctx.store.addLabel(a.id, 'bug');

		expect(listLabels(t.ctx).map(entry => entry.label)).toEqual(['Bug', 'bug']);
	});

	it('measured on 1 000 tasks (cold call, then median of 9 warm calls, printed)', () => {
		seedTasks(t, 1000);
		const timed = (): number => {
			const start = performance.now();
			listLabels(t.ctx);
			return performance.now() - start;
		};
		const cold = timed();
		const warm = Array.from({ length: 9 }, timed).sort((x, y) => x - y);
		console.info(
			`listLabels over 1000 tasks: cold ${cold.toFixed(1)} ms, warm min ${warm[0]!.toFixed(1)} / median ${warm[4]!.toFixed(1)} / max ${warm[8]!.toFixed(1)} ms`
		);

		const labels = listLabels(t.ctx);
		expect(labels[0]).toEqual({ label: 'common', count: 1000 });
		expect(labels).toHaveLength(1 + 20 + 1000);
	});
});
