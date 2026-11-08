import type { TaskServiceContext } from './context.js';

export interface LabelCount {
	label: string;
	/** Number of tasks (open or closed) carrying the label. */
	count: number;
}

/**
 * Every label in use with the number of tasks carrying it, most used first, then by name.
 * Labels live in the task files, not in the index: the local backend reads every task file (cost O(tasks), measured in
 * listLabels.test.ts); a remote backend answers from its own label listing.
 */
export async function listLabels(ctx: TaskServiceContext): Promise<LabelCount[]> {
	return ctx.store.listLabels();
}
