// Priority, assignee and claim: the value rules and the claim decision, shared by the store and by every backend.
// Pure: no clock (callers pass `now`), no file.
import { TaskConflictError } from './errors.js';
import { formatDuration } from './formatDuration.js';

/** A priority is at most this many characters (after trimming). */
export const PRIORITY_MAX = 50;
/** An assignee is at most this many characters (after trimming). */
export const ASSIGNEE_MAX = 100;

/** Which input was refused. */
export type TaskFieldName = 'priority' | 'assignee' | 'lease';

/** A priority, assignee or lease the caller gave is not acceptable. Nothing was written. */
export class InvalidTaskFieldError extends Error {
	constructor(
		readonly field: TaskFieldName,
		message: string,
		readonly hint: string
	) {
		super(message);
		this.name = 'InvalidTaskFieldError';
	}
}

/** The priority is not in the list the project allows. `validPriorities` are the allowed ones, in configured order. */
export class UnknownPriorityError extends InvalidTaskFieldError {
	constructor(
		readonly priority: string,
		readonly validPriorities: readonly string[]
	) {
		super(
			'priority',
			`unknown priority "${priority}". Valid priorities: ${validPriorities.join(', ')}`,
			`Use one of: ${validPriorities.join(', ')}.`
		);
		this.name = 'UnknownPriorityError';
	}
}

/**
 * The task is claimed and the claim cannot be taken: by someone else with a live lease (`ownLease` false), or by the same
 * assignee without `renew` (`ownLease` true). `remainingMs` is the time left of the lease at the caller's `now`.
 */
export class TaskClaimedError extends TaskConflictError {
	readonly hint: string;

	constructor(
		readonly taskId: string,
		readonly holder: string,
		readonly leaseUntil: string,
		readonly remainingMs: number,
		readonly ownLease: boolean
	) {
		super(
			`Task "${taskId}" is ${ownLease ? 'already ' : ''}claimed by "${holder}" until ${leaseUntil} (${formatDuration(remainingMs)} left); nothing was written`
		);
		this.name = 'TaskClaimedError';
		this.hint = ownLease
			? 'Extend your own lease with --renew.'
			: `Wait for the lease to end (${formatDuration(remainingMs)}), ask "${holder}" to release the task (task release ${taskId}), or take it over with --force.`;
	}
}

/** `release` of a task nobody holds. */
export class TaskNotClaimedError extends TaskConflictError {
	readonly hint = 'Nothing to release: the task has no assignee. Use task claim to take it.';

	constructor(readonly taskId: string) {
		super(`Task "${taskId}" is not claimed by anyone; nothing was written`);
		this.name = 'TaskNotClaimedError';
	}
}

/** `release` on behalf of an assignee that is not the holder. */
export class TaskReleaseRefusedError extends TaskConflictError {
	readonly hint: string;

	constructor(
		readonly taskId: string,
		readonly holder: string,
		readonly requestedBy: string
	) {
		super(`Task "${taskId}" is held by "${holder}", not by "${requestedBy}"; nothing was written`);
		this.name = 'TaskReleaseRefusedError';
		this.hint = `Release it as "${holder}", or release it anyway with --force.`;
	}
}

function hasControlCharacter(text: string): boolean {
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		if (code < 0x20 || code === 0x7f) return true;
	}
	return false;
}

function normalizeText(field: 'priority' | 'assignee', value: string, max: number): string {
	const trimmed = value.trim();
	if (trimmed === '') {
		throw new InvalidTaskFieldError(field, `a ${field} cannot be blank`, `Give the ${field}.`);
	}
	if (trimmed.length > max) {
		throw new InvalidTaskFieldError(
			field,
			`a ${field} is at most ${max} characters (this one has ${trimmed.length})`,
			`Shorten it to ${max} characters or less.`
		);
	}
	if (hasControlCharacter(trimmed)) {
		throw new InvalidTaskFieldError(
			field,
			`a ${field} cannot contain control characters (newline, tab...)`,
			`Give the ${field} on one line, plain text.`
		);
	}
	return trimmed;
}

/**
 * Trimmed priority. Throws {@link InvalidTaskFieldError} when blank, over {@link PRIORITY_MAX} or holding a control
 * character, and {@link UnknownPriorityError} when `allowed` is given and does not list it (exact match).
 */
export function normalizePriority(value: string, allowed?: readonly string[]): string {
	const priority = normalizeText('priority', value, PRIORITY_MAX);
	if (allowed !== undefined && !allowed.includes(priority)) {
		throw new UnknownPriorityError(priority, allowed);
	}
	return priority;
}

/** Trimmed assignee (free text, 1 to {@link ASSIGNEE_MAX} characters, no control character). */
export function normalizeAssignee(value: string): string {
	return normalizeText('assignee', value, ASSIGNEE_MAX);
}

/** Epoch ms of an ISO instant; throws {@link InvalidTaskFieldError} naming `what` when it is not one. */
export function parseInstant(value: string, what: string): number {
	const time = Date.parse(value);
	if (Number.isNaN(time)) {
		throw new InvalidTaskFieldError(
			'lease',
			`${what} "${value}" is not an ISO 8601 instant`,
			'Use a date-time such as 2026-11-14T10:30:00.000Z.'
		);
	}
	return time;
}

/** What a caller asks for when it claims a task. The clock is the caller's: `now` is the instant the rules are judged at. */
export interface ClaimRequest {
	assignee: string;
	/** ISO instant the lease ends; must be after `now`. */
	leaseUntil: string;
	/** ISO instant of the claim. */
	now: string;
	/** Take the task even when someone else holds a live lease. */
	force?: boolean;
	/** The assignee already holds the task: extend the lease instead of refusing. */
	renew?: boolean;
}

export type ClaimOutcome = 'claimed' | 'renewed' | 'takeover';

export interface ClaimDecision {
	outcome: ClaimOutcome;
	previousAssignee?: string;
}

/**
 * The claim rules, judged at `request.now` against what the task holds. Throws {@link TaskClaimedError} when the claim is
 * refused. The request must already be normalized (see `normalizeClaimRequest`).
 */
export function decideClaim(
	taskId: string,
	current: { assignee?: string; leaseUntil?: string },
	request: ClaimRequest
): ClaimDecision {
	const holder = current.assignee;
	if (holder === undefined) {
		return { outcome: 'claimed' };
	}
	const now = Date.parse(request.now);
	const leaseEnd = current.leaseUntil === undefined ? undefined : Date.parse(current.leaseUntil);
	const live = leaseEnd !== undefined && !Number.isNaN(leaseEnd) && leaseEnd > now;
	if (holder === request.assignee) {
		if (request.renew === true) {
			return { outcome: 'renewed' };
		}
		if (live) {
			throw new TaskClaimedError(taskId, holder, current.leaseUntil!, leaseEnd - now, true);
		}
		// Same name, lease over (or none): a fresh claim.
		return { outcome: 'claimed' };
	}
	if (live && request.force !== true) {
		throw new TaskClaimedError(taskId, holder, current.leaseUntil!, leaseEnd - now, false);
	}
	return { outcome: 'takeover', previousAssignee: holder };
}

/** The request with a trimmed assignee and ISO instants rewritten canonically; throws {@link InvalidTaskFieldError} on bad input. */
export function normalizeClaimRequest(request: ClaimRequest): ClaimRequest {
	const assignee = normalizeAssignee(request.assignee);
	const now = parseInstant(request.now, 'now');
	const leaseUntil = parseInstant(request.leaseUntil, 'leaseUntil');
	if (leaseUntil <= now) {
		throw new InvalidTaskFieldError(
			'lease',
			`leaseUntil ${request.leaseUntil} is not after the claim instant ${request.now}`,
			'Give a lease that ends in the future (for example --lease 30m).'
		);
	}
	return {
		...request,
		assignee,
		now: new Date(now).toISOString(),
		leaseUntil: new Date(leaseUntil).toISOString(),
	};
}
