// The built-in ordering `priority-then-oldest` (plugins.ordering.default, alias priority-then-oldest): the order a dispatcher wants
// by default. Highest priority first (the index in the project's `priorities`), then the older task, then the id, so the order is
// total and does not depend on the order the backend answered in.
import type { OrderingFacts, OrderingInstance, OrderingPlugin, OrderingRow } from '../kinds.js';

function rank(priority: string, facts: OrderingFacts): number {
	const index = facts.priorities.indexOf(priority);
	// A priority outside the project's list (a hand edited file, a changed config) sorts after every listed one.
	return index === -1 ? facts.priorities.length : index;
}

function compareText(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

export function comparePriorityThenOldest(a: OrderingRow, b: OrderingRow, facts: OrderingFacts): number {
	return (
		rank(a.priority, facts) - rank(b.priority, facts) ||
		// ISO instants of the same shape compare as text; Date.parse would hide a malformed one as NaN.
		compareText(a.createdAt, b.createdAt) ||
		compareText(a.id, b.id)
	);
}

export const orderingPlugin: OrderingPlugin = {
	extensionPoint: 'ordering',
	validate(options) {
		const keys = Object.keys(options);
		return keys.length === 0 ? undefined : `${keys[0]}: unknown option (this ordering takes none)`;
	},
	create(): Promise<OrderingInstance> {
		return Promise.resolve({
			compare: comparePriorityThenOldest,
			dispose: () => Promise.resolve(),
		});
	},
	describe() {
		return {
			summary: 'Highest priority first (the order of the project priorities), then the oldest task, then the id.',
			options: {},
			snippet: 'task list --order priority-then-oldest',
		};
	},
};
