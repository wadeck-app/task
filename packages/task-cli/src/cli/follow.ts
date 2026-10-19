import { diffAppendOnlyLog, diffSnapshot } from '@wadeck-app/shared-cli/FollowSnapshot';
import type { TaskRecord, TaskStore, TaskSummary } from '@wadeck-app/task-core';

const FOLLOW_POLL_INTERVAL_MS = 500;

/** `task list --follow`: polls the task index and prints newly-created or status-changed tasks. */
export async function runTaskListFollow(store: TaskStore, passesFilter: (task: TaskSummary) => boolean): Promise<void> {
	const initialAll = store.list();
	for (const task of initialAll.filter(passesFilter)) {
		process.stdout.write(JSON.stringify(task) + '\n');
	}
	let snapshot = diffSnapshot(new Map(), initialAll, t => t.id).snapshot;

	process.stderr.write('[task] Following task list -- Ctrl+C to stop\n');
	await new Promise<void>(resolve => {
		const interval = setInterval(() => {
			const { changed, snapshot: next } = diffSnapshot(snapshot, store.list(), t => t.id);
			snapshot = next;
			for (const task of changed.filter(passesFilter)) {
				process.stdout.write(JSON.stringify(task) + '\n');
			}
		}, FOLLOW_POLL_INTERVAL_MS);
		process.on('SIGINT', () => {
			clearInterval(interval);
			resolve();
		});
	});
}

/** `task history <id> --follow`: polls one task's history array and prints newly-appended entries. */
export async function runTaskHistoryFollow(
	store: TaskStore,
	taskId: string,
	initial: TaskRecord['history']
): Promise<void> {
	for (const entry of initial) {
		process.stdout.write(JSON.stringify(entry) + '\n');
	}
	let count = initial.length;

	process.stderr.write(`[task] Following history of ${taskId} -- Ctrl+C to stop\n`);
	await new Promise<void>(resolve => {
		const interval = setInterval(() => {
			const { changed, count: nextCount } = diffAppendOnlyLog(count, store.get(taskId).history);
			count = nextCount;
			for (const entry of changed) {
				process.stdout.write(JSON.stringify(entry) + '\n');
			}
		}, FOLLOW_POLL_INTERVAL_MS);
		process.on('SIGINT', () => {
			clearInterval(interval);
			resolve();
		});
	});
}
