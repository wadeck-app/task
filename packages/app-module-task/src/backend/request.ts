import { RequestError } from './errors.js';

/** The parts of a Fastify request the routes read (the SDK types them loosely). */
export interface RouteRequest {
	params?: Record<string, string>;
	query?: Record<string, string | string[] | undefined>;
	body?: unknown;
}

/** What a route returns: the HTTP status and the JSON body. */
export interface RouteAnswer {
	status: number;
	body: unknown;
}

/** A query parameter given at most once. */
export function queryValue(query: RouteRequest['query'], name: string): string | undefined {
	const value = query?.[name];
	if (Array.isArray(value)) {
		throw new RequestError(400, `${name} must be given once, got ${value.length} values`);
	}
	if (value !== undefined && typeof value !== 'string') {
		throw new RequestError(400, `${name} must be a string`);
	}
	return value;
}

/** A query parameter that may be empty: a cleared filter field sends `?name=`, which means "no filter". */
export function optionalQueryValue(query: RouteRequest['query'], name: string): string | undefined {
	const value = queryValue(query, name);
	return value === '' ? undefined : value;
}

/** A boolean query parameter ("true" / "false"; absent or empty is false). */
export function booleanFlag(query: RouteRequest['query'], name: string, hint: string): boolean {
	const value = optionalQueryValue(query, name);
	if (value === undefined || value === 'false') return false;
	if (value === 'true') return true;
	throw new RequestError(400, `${name} must be "true" or "false", got "${value}"`, hint);
}

/** `?showAll=true` includes the tasks in a terminal status. */
export function showAllFlag(query: RouteRequest['query']): boolean {
	return booleanFlag(query, 'showAll', 'Use ?showAll=true to include terminal statuses.');
}

/** The JSON object body of a request; `usage` is the hint of the 400 when it is something else. */
export function bodyObject(body: unknown, usage: string): Record<string, unknown> {
	if (body === null || body === undefined || typeof body !== 'object' || Array.isArray(body)) {
		throw new RequestError(400, `expected a JSON object body, got: ${JSON.stringify(body) ?? 'nothing'}`, usage);
	}
	return body as Record<string, unknown>;
}

export function requiredString(source: Record<string, unknown>, field: string, usage: string): string {
	const value = source[field];
	if (typeof value !== 'string' || value === '') {
		throw new RequestError(400, `${field} must be a non-empty string`, usage);
	}
	return value;
}

export function optionalString(source: Record<string, unknown>, field: string, usage: string): string | undefined {
	const value = source[field];
	if (value === undefined) return undefined;
	if (typeof value !== 'string' || value === '') {
		throw new RequestError(400, `${field} must be a non-empty string when given`, usage);
	}
	return value;
}

/** What `?blank=true` answers: nothing, so a view replaces the data of its previous scope (see {@link isBlankRequest}). */
export const BLANK_ANSWER: RouteAnswer = { status: 200, body: { blank: true } };

/**
 * `?blank=true`: the caller is a view whose scope has no data (unknown or unreadable project, nothing registered).
 * The shell keeps the last answer of a source it skips, so the view asks for this empty answer instead, which
 * replaces the stale data of the previous scope.
 */
export function isBlankRequest(query: RouteRequest['query']): boolean {
	return booleanFlag(query, 'blank', 'Use ?blank=true for an empty answer.');
}

/**
 * `?allProjects=true`: the answer covers every registered project. One scope at a time, so it refuses `?project`.
 * `what` completes the hint ("the tasks", "the types"...).
 */
export function allProjectsFlag(query: RouteRequest['query'], what: string): boolean {
	if (!booleanFlag(query, 'allProjects', `Use ?allProjects=true for ${what} of every registered project.`)) {
		return false;
	}
	if (queryValue(query, 'project') !== undefined) {
		throw new RequestError(
			400,
			'allProjects and project cannot be combined',
			'Use ?allProjects=true for every registered project, or ?project=<id|name|alias> for one.'
		);
	}
	return true;
}
