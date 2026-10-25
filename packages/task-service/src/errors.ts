import type { TaskEvent } from './events.js';

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

/** One registered project an all-projects view could not read, with why. */
export interface ProjectFailure {
	path: string;
	error: string;
}

/**
 * Projects are registered but none can be read. An all-projects view must fail with this (reasons and fix),
 * never answer zeros that would read as "no tasks".
 */
export class NoReadableProjectsError extends TaskServiceError {
	constructor(readonly failures: readonly ProjectFailure[]) {
		super(
			`none of the ${failures.length} registered projects could be read: ${failures.map(f => `${f.path} (${f.error})`).join('; ')}`,
			'Fix the causes above (each names its fix). Projects are registered, moved and removed with the project CLI (project add, project paths move, project remove).'
		);
	}
}

/**
 * A delete failed partway through its plan: the tasks deleted before the failure ARE deleted and cannot be restored.
 * Carries their `onTaskDeleted` events so the caller still delivers them before reporting the failure.
 */
export class PartialDeleteError extends TaskServiceError {
	constructor(
		/** Tasks really deleted before the failure (at least one). */
		readonly deletedCount: number,
		readonly plannedCount: number,
		readonly failedTaskId: string,
		/** One `onTaskDeleted` per task deleted before the failure, in deletion order. */
		readonly events: readonly TaskEvent[],
		cause: unknown
	) {
		super(
			`deleted ${deletedCount} of ${plannedCount} task(s), then failed on task ${failedTaskId}: ${cause instanceof Error ? cause.message : String(cause)}`,
			`The ${deletedCount} deleted task(s) cannot be restored; the others are still there. Fix the cause, then run \`task delete\` again for the remaining tasks.`
		);
		this.cause = cause;
	}
}
