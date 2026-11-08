import { diffAppendOnlyLog, diffSnapshot } from '@wadeck-app/shared-cli/FollowSnapshot';
import type { TaskBackend, TaskRecord, TaskSummary } from '@wadeck-app/task-core';

const FOLLOW_POLL_INTERVAL_MS = 500;

/** What the follow loops can be told (tests inject both; the CLI uses the defaults). */
export interface FollowOptions {
	/** Pause between the end of a poll and the start of the next. Default 500 ms. */
	intervalMs?: number;
	/** Stops the loop. Default: aborted by the first SIGINT (Ctrl+C). */
	signal?: AbortSignal;
}

/** A signal aborted by the first SIGINT; `release()` removes the listener. */
function sigintSignal(): { signal: AbortSignal; release: () => void } {
	const controller = new AbortController();
	const onInterrupt = (): void => controller.abort();
	process.once('SIGINT', onInterrupt);
	return { signal: controller.signal, release: () => process.off('SIGINT', onInterrupt) };
}

/** Resolves after `ms`, or as soon as `signal` aborts. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise(resolve => {
		if (signal.aborted) return resolve();
		const done = (): void => {
			clearTimeout(timer);
			signal.removeEventListener('abort', done);
			resolve();
		};
		const timer = setTimeout(done, ms);
		signal.addEventListener('abort', done, { once: true });
	});
}

/**
 * Runs `poll` over and over until `signal` aborts: pause, poll, pause... The next pause starts when the previous poll has
 * ENDED, so a backend slower than the interval never gets two polls at once (no duplicated or reordered output). A poll
 * that throws ends the loop with its error (the command fails loudly, never a silent stop); after an abort the poll in
 * flight is abandoned (`poll` must not print once `signal.aborted`) so Ctrl+C is never held up by a slow backend.
 */
export async function pollUntilAborted(
	poll: () => Promise<void>,
	intervalMs: number,
	signal: AbortSignal
): Promise<void> {
	const aborted = new Promise<void>(resolve => {
		if (signal.aborted) return resolve();
		signal.addEventListener('abort', () => resolve(), { once: true });
	});
	while (!signal.aborted) {
		await pause(intervalMs, signal);
		if (signal.aborted) return;
		const running = poll();
		// If the loop leaves because of an abort, this poll's late failure must not become an unhandled rejection.
		running.catch(() => undefined);
		await Promise.race([running, aborted]);
	}
}

/** `task list --follow`: polls the task index and prints newly-created or status-changed tasks. */
export async function runTaskListFollow(
	store: TaskBackend,
	passesFilter: (task: TaskSummary) => boolean,
	options: FollowOptions = {}
): Promise<void> {
	const initialAll = await store.list();
	for (const task of initialAll.filter(passesFilter)) {
		process.stdout.write(JSON.stringify(task) + '\n');
	}
	let snapshot = diffSnapshot(new Map(), initialAll, t => t.id).snapshot;

	process.stderr.write('[task] Following task list -- Ctrl+C to stop\n');
	const interrupt = options.signal === undefined ? sigintSignal() : undefined;
	const signal = options.signal ?? interrupt!.signal;
	try {
		await pollUntilAborted(
			async () => {
				const current = await store.list();
				if (signal.aborted) return;
				const { changed, snapshot: next } = diffSnapshot(snapshot, current, t => t.id);
				snapshot = next;
				for (const task of changed.filter(passesFilter)) {
					process.stdout.write(JSON.stringify(task) + '\n');
				}
			},
			options.intervalMs ?? FOLLOW_POLL_INTERVAL_MS,
			signal
		);
	} finally {
		interrupt?.release();
	}
}

/** `task history <id> --follow`: polls one task's history array and prints newly-appended entries. */
export async function runTaskHistoryFollow(
	store: TaskBackend,
	taskId: string,
	initial: TaskRecord['history'],
	options: FollowOptions = {}
): Promise<void> {
	for (const entry of initial) {
		process.stdout.write(JSON.stringify(entry) + '\n');
	}
	let count = initial.length;

	process.stderr.write(`[task] Following history of ${taskId} -- Ctrl+C to stop\n`);
	const interrupt = options.signal === undefined ? sigintSignal() : undefined;
	const signal = options.signal ?? interrupt!.signal;
	try {
		await pollUntilAborted(
			async () => {
				const { history } = await store.get(taskId);
				if (signal.aborted) return;
				const { changed, count: nextCount } = diffAppendOnlyLog(count, history);
				count = nextCount;
				for (const entry of changed) {
					process.stdout.write(JSON.stringify(entry) + '\n');
				}
			},
			options.intervalMs ?? FOLLOW_POLL_INTERVAL_MS,
			signal
		);
	} finally {
		interrupt?.release();
	}
}
