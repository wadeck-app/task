import type { TaskSummary } from '@wadeck-app/task-core';

/**
 * Diffs a fresh `TaskStore.list()` snapshot against a prior one for `task list --follow`.
 * A task can change after it first appears (status transitions), so "changed" means new OR
 * mutated, not just new -- a plain id-presence check would miss status changes.
 */
export function diffTaskListSnapshot(
	previous: Map<string, string>,
	current: TaskSummary[]
): { changed: TaskSummary[]; snapshot: Map<string, string> } {
	const snapshot = new Map<string, string>();
	const changed: TaskSummary[] = [];

	for (const task of current) {
		const signature = JSON.stringify(task);
		snapshot.set(task.id, signature);
		if (previous.get(task.id) !== signature) {
			changed.push(task);
		}
	}

	return { changed, snapshot };
}

/**
 * Diffs a fresh `TaskRecord.history` array against a prior length for `task history --follow`.
 * History is append-only (TaskStore.updateStatus only ever pushes new entries, never mutates
 * past ones), so unlike the task-list diff above, a simple length comparison is sufficient --
 * no signature map needed.
 */
export function diffHistoryEntries<T>(previousCount: number, current: T[]): { changed: T[]; count: number } {
	return { changed: current.slice(previousCount), count: current.length };
}
