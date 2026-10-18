/**
 * Base class of the domain errors raised by task-service operations.
 * `hint` is an optional actionable follow-up line for the user (valid values, "Did you mean", a fix command).
 * Errors raised by task-core (TaskNotFoundError, AmbiguousTaskPrefixError, cycle/duplicate-link errors, ...)
 * propagate unchanged.
 */
export class TaskServiceError extends Error {
	constructor(
		message: string,
		readonly hint?: string
	) {
		super(message);
		this.name = new.target.name;
	}
}

/** The requested status is not in the project's configured `statuses`. */
export class InvalidStatusError extends TaskServiceError {
	constructor(
		readonly status: string,
		readonly validStatuses: string[],
		/** Closest valid statuses (zero or one entry today). */
		readonly suggestions: string[]
	) {
		super(
			`unknown status "${status}"`,
			`Valid statuses: ${validStatuses.join(', ')}${suggestions.length > 0 ? `\nDid you mean: ${suggestions[0]}?` : ''}`
		);
	}
}

/** The link type is neither a stored type (blockedBy, ...) nor an inverse name (blocks, ...). */
export class InvalidLinkTypeError extends TaskServiceError {
	constructor(
		readonly linkType: string,
		readonly validTypes: string[],
		readonly suggestions: string[]
	) {
		super(
			`unknown link type "${linkType}"`,
			`Valid types: ${validTypes.join(', ')}${suggestions.length > 0 ? `\nDid you mean: ${suggestions[0]}?` : ''}`
		);
	}
}

/** The task type is rejected by the project's type validation strategy (message comes from the strategy). */
export class InvalidTaskTypeError extends TaskServiceError {
	constructor(
		readonly taskType: string,
		message: string
	) {
		super(message);
	}
}

/** A `--filter <field>=<value>` expression is malformed or targets a non-filterable field. */
export class InvalidDeleteFilterError extends TaskServiceError {
	constructor(
		message: string,
		readonly validFields: readonly string[]
	) {
		super(message, `Valid fields: ${validFields.join(', ')}`);
	}
}

/** A delete id prefix matches several tasks. */
export class AmbiguousDeletePrefixError extends TaskServiceError {
	constructor(
		readonly prefix: string,
		readonly matches: string[]
	) {
		super(`ambiguous prefix "${prefix}" matches: ${matches.join(', ')}`);
	}
}

/** A task references a parentId that no longer exists (corrupted hierarchy). */
export class DanglingParentError extends TaskServiceError {
	constructor(
		readonly taskId: string,
		readonly parentId: string
	) {
		super(`parent "${parentId}" of task "${taskId}" does not exist`, `Fix with: task remove-parent ${taskId}`);
	}
}

/** `<configDir>/projects.json` is unreadable, corrupt, or the directory to register is invalid. Never auto-repaired. */
export class ProjectsRegistryError extends TaskServiceError {}
