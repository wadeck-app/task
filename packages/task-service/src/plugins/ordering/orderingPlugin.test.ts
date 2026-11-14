import { createBuiltinRegistry } from '../builtinPlugins.js';
import type { OrderingRow } from '../kinds.js';
import { comparePriorityThenOldest, orderingPlugin } from './orderingPlugin.js';

const facts = { priorities: ['urgent', 'high', 'medium', 'low'] };
const row = (id: string, priority: string, createdAt: string): OrderingRow => ({
	id,
	status: 'backlog',
	createdAt,
	priority,
});

describe('the ordering plugin kind and its built-in', () => {
	it('is registered as plugins.ordering.default with the alias priority-then-oldest', () => {
		const registry = createBuiltinRegistry();

		expect(registry.list('ordering').map(entry => [entry.ref, entry.aliases])).toEqual([
			['plugins.ordering.default', ['priority-then-oldest']],
		]);
		expect(registry.lookup('priority-then-oldest', 'ordering')).toBe(orderingPlugin);
		expect(() => registry.lookup('priority-then-oldest', 'strategy')).toThrow(
			'is an ordering plugin, not a strategy one'
		);
	});

	it('is option-less: any option is a problem naming it', () => {
		expect(orderingPlugin.validate({}, { slot: 'order' })).toBeUndefined();
		expect(orderingPlugin.validate({ reverse: true }, { slot: 'order' })).toBe(
			'reverse: unknown option (this ordering takes none)'
		);
		expect(orderingPlugin.describe().snippet).not.toBe('');
	});

	it('ranks by the index in the project priorities, then older first, then id', async () => {
		const instance = await orderingPlugin.create({}, {});

		expect(instance.compare(row('b', 'urgent', '2026-02'), row('a', 'high', '2026-01'), facts)).toBeLessThan(0);
		expect(instance.compare(row('b', 'high', '2026-01'), row('a', 'high', '2026-02'), facts)).toBeLessThan(0);
		expect(instance.compare(row('a', 'high', '2026-01'), row('b', 'high', '2026-01'), facts)).toBeLessThan(0);
		expect(instance.compare(row('a', 'high', '2026-01'), row('a', 'high', '2026-01'), facts)).toBe(0);
		await instance.dispose();
	});

	it('uses the order of THIS project: another scale reverses the ranks', () => {
		const custom = { priorities: ['p3', 'p2', 'p1'] };
		expect(comparePriorityThenOldest(row('a', 'p3', '2026'), row('b', 'p1', '2026'), custom)).toBeLessThan(0);
	});

	it('a priority outside the list sorts after every listed one', () => {
		expect(comparePriorityThenOldest(row('a', 'low', '2026'), row('b', 'legacy', '2020'), facts)).toBeLessThan(0);
	});
});
