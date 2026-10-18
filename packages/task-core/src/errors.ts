/** Thrown when a task id (or id prefix) does not match any stored task. */
export class TaskNotFoundError extends Error {
	constructor(readonly taskId: string) {
		super(`Task not found: ${taskId}`);
		this.name = 'TaskNotFoundError';
	}
}

/** Thrown when an id prefix matches more than one task. */
export class AmbiguousTaskPrefixError extends Error {
	constructor(
		readonly prefix: string,
		readonly matches: string[]
	) {
		super(`Ambiguous prefix "${prefix}" matches: ${matches.join(', ')}`);
		this.name = 'AmbiguousTaskPrefixError';
	}
}

/**
 * Thrown when a requested change conflicts with the current state of the tasks (self-parent, parent/link cycle,
 * duplicate link, second duplicateOf, removing a link or parent that does not exist, setting the current status).
 * The caller can resolve it by changing the request or the state; it is not a malformed input.
 */
export class TaskConflictError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'TaskConflictError';
	}
}
