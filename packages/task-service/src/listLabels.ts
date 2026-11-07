import type { TaskServiceContext } from './context.js';

export interface LabelCount {
	label: string;
	/** Number of tasks (open or closed) carrying the label. */
	count: number;
}

/**
 * Every label in use with the number of tasks carrying it, most used first, then by name.
 * Labels live in the task files, not in the index: this reads every task file (cost O(tasks), measured in listLabels.test.ts).
 */
export function listLabels(ctx: TaskServiceContext): LabelCount[] {
	const counts = new Map<string, number>();
	for (const summary of ctx.store.list()) {
		for (const label of new Set(ctx.store.get(summary.id).labels ?? [])) {
			counts.set(label, (counts.get(label) ?? 0) + 1);
		}
	}
	return [...counts]
		.map(([label, count]) => ({ label, count }))
		.sort((a, b) => b.count - a.count || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
}
