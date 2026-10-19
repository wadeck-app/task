import type { TaskServiceContext } from './context.js';

export interface StatusCount {
	status: string;
	count: number;
	/** The status is terminal in the project config (the tasks in it are closed). */
	terminal: boolean;
}

/**
 * Number of tasks per status: the configured statuses first, in config order (zero included), then any other status
 * still held by a task (removed from config.yml) so no task is lost from the total.
 */
export function countTasksByStatus(ctx: TaskServiceContext): StatusCount[] {
	const counts = new Map<string, StatusCount>(
		ctx.config.statuses.map(status => [
			status,
			{ status, count: 0, terminal: ctx.config.terminalStatuses.includes(status) },
		])
	);
	for (const task of ctx.store.list()) {
		const entry = counts.get(task.status) ?? { status: task.status, count: 0, terminal: false };
		entry.count++;
		counts.set(task.status, entry);
	}
	return [...counts.values()];
}
