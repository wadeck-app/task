// The single-writer rule of the task server (design R6) at the level of one process: every write runs alone, in the order it was
// accepted, so two concurrent requests can never interleave their read-modify-write (the local store has no lock by design).
// This is a per-process queue: it protects against concurrent REQUESTS of this server, not against another process writing the same
// files (nothing else may: the server is the single writer, which is why task data has no other lock).

export interface WriteQueue {
	/** Runs `job` once every job accepted before it has finished (whether they succeeded or failed). Resolves/rejects like `job`. */
	run<T>(job: () => Promise<T>): Promise<T>;
	/** Jobs accepted and not finished (running included). */
	pending(): number;
	/** Resolves when every job accepted so far has finished. Never rejects. */
	idle(): Promise<void>;
}

export function createWriteQueue(): WriteQueue {
	let tail: Promise<void> = Promise.resolve();
	let pending = 0;
	return {
		run<T>(job: () => Promise<T>): Promise<T> {
			pending++;
			const result = tail.then(job);
			// The next job waits for this one to settle, not to succeed: one failed write must not block the queue forever.
			tail = result.then(
				() => undefined,
				() => undefined
			);
			return result.finally(() => {
				pending--;
			});
		},
		pending: () => pending,
		idle: () => tail,
	};
}
