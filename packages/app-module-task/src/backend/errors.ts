import { AmbiguousTaskPrefixError, TaskConflictError, TaskNotFoundError } from '@wadeck-app/task-core';
import {
	AmbiguousDeletePrefixError,
	DanglingParentError,
	InvalidDeleteFilterError,
	InvalidLinkTypeError,
	InvalidStatusError,
	InvalidTaskTypeError,
	TaskServiceError,
} from '@wadeck-app/task-service';

/** A request the route layer itself rejects (project selection, malformed query or body). */
export class RequestError extends Error {
	constructor(
		readonly status: number,
		message: string,
		readonly hint?: string,
		/** Extra fields merged into the JSON error body. */
		readonly extra?: Record<string, unknown>
	) {
		super(message);
		this.name = 'RequestError';
	}
}

export interface HttpErrorResult {
	status: number;
	body: Record<string, unknown>;
}

function withHint(
	error: string,
	hint: string | undefined,
	extra: Record<string, unknown> = {}
): Record<string, unknown> {
	return { error, ...(hint === undefined ? {} : { hint }), ...extra };
}

/**
 * The single place where typed errors become HTTP answers:
 * 400 invalid input, 404 not found, 409 ambiguous prefix / state conflict, 500 everything else (with its message).
 */
export function toHttpError(error: unknown): HttpErrorResult {
	if (error instanceof RequestError) {
		return { status: error.status, body: withHint(error.message, error.hint, error.extra) };
	}
	if (error instanceof TaskNotFoundError) {
		return { status: 404, body: withHint(error.message, undefined) };
	}
	if (error instanceof AmbiguousTaskPrefixError) {
		return {
			status: 409,
			body: withHint(error.message, 'Use a longer id prefix, or one of the full ids in "matches".', {
				matches: error.matches,
			}),
		};
	}
	if (error instanceof AmbiguousDeletePrefixError) {
		return {
			status: 409,
			body: withHint(error.message, 'Use a longer id prefix, or one of the full ids in "matches".', {
				matches: error.matches,
			}),
		};
	}
	if (error instanceof TaskConflictError) {
		return { status: 409, body: withHint(error.message, undefined) };
	}
	if (error instanceof DanglingParentError) {
		return { status: 409, body: withHint(error.message, error.hint) };
	}
	if (error instanceof InvalidStatusError) {
		return {
			status: 400,
			body: withHint(error.message, error.hint, {
				validStatuses: error.validStatuses,
				suggestions: error.suggestions,
			}),
		};
	}
	if (error instanceof InvalidLinkTypeError) {
		return {
			status: 400,
			body: withHint(error.message, error.hint, { validTypes: error.validTypes, suggestions: error.suggestions }),
		};
	}
	if (error instanceof InvalidTaskTypeError || error instanceof InvalidDeleteFilterError) {
		return { status: 400, body: withHint(error.message, error.hint) };
	}
	if (error instanceof TaskServiceError) {
		return { status: 500, body: withHint(error.message, error.hint) };
	}
	return { status: 500, body: withHint(error instanceof Error ? error.message : String(error), undefined) };
}
