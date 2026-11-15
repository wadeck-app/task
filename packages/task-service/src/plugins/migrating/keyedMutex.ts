// One operation at a time per key (a task), in the order they were asked, inside ONE process. Different keys run together. A failure
// goes to the caller of that operation only and never blocks the next one.
//
// Limit, said plainly: this is a promise chain in memory, so it does not exist for a second process. The worker that moves tasks and a
// command of a person are two processes; between them the protection is the routing index (a row change refuses a stale version, see
// RoutingIndex.mutateRow) and the write-ahead log, not this lock.
export class KeyedMutex {
	private readonly tails = new Map<string, Promise<unknown>>();

	/** Keys with an operation running or waiting (0 when idle). */
	get size(): number {
		return this.tails.size;
	}

	run<T>(key: string, operation: () => Promise<T>): Promise<T> {
		const previous = this.tails.get(key) ?? Promise.resolve();
		const result = previous.then(operation, operation);
		// The chain must not carry the failure to the next waiter, and an idle key must disappear (before the caller goes on: this
		// handler is registered on `result` before the caller's own).
		const release = (): void => {
			if (this.tails.get(key) === tail) this.tails.delete(key);
		};
		const tail: Promise<void> = result.then(release, release);
		this.tails.set(key, tail);
		return result;
	}
}
