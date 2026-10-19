import { describeError } from '@wadeck-app/task-service';
import type { ErrorKind } from '@wadeck-app/task-service';

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

const STATUS_BY_KIND: Record<ErrorKind, number> = {
	'not-found': 404,
	ambiguous: 409,
	conflict: 409,
	invalid: 400,
	internal: 500,
};

const AMBIGUOUS_HINT = 'Use a longer id prefix, or one of the full ids in "matches".';

/**
 * The single place where errors become HTTP answers: task-service classifies them (describeError), this maps the
 * kind to a status: 400 invalid input, 404 not found, 409 ambiguous prefix / state conflict, 500 everything else
 * (with its message). Structured data of the error (matches, valid values, suggestions) goes into the body.
 */
export function toHttpError(error: unknown): HttpErrorResult {
	if (error instanceof RequestError) {
		return { status: error.status, body: withHint(error.message, error.hint, error.extra) };
	}
	const described = describeError(error);
	const hint = described.kind === 'ambiguous' ? AMBIGUOUS_HINT : described.hint;
	return { status: STATUS_BY_KIND[described.kind], body: withHint(described.message, hint, described.details) };
}
