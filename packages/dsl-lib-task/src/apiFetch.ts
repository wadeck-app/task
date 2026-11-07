import { getApiBase } from './runtime-config.js';

/** A failed call to the module's API, with the route's own hint when it gave one. */
export class ApiProblem extends Error {
	readonly hint: string | undefined;
	readonly status: number | undefined;

	constructor(message: string, hint?: string, status?: number) {
		super(message);
		this.name = 'ApiProblem';
		this.hint = hint;
		this.status = status;
	}
}

export interface GetJsonOptions {
	signal?: AbortSignal;
	/** Overrides the api base set by `configureTaskUi`. */
	apiBase?: string;
}

/** Whether an error is the cancellation of a request (the caller started a newer one): not a problem to show. */
export function isAbort(error: unknown): boolean {
	// A DOMException is not always an Error of this realm (jsdom), so only the name is trusted.
	return typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'AbortError';
}

/** The text to show for any error: the message, then the hint of the route when there is one. */
export function problemText(error: unknown): string {
	if (error instanceof ApiProblem) {
		return error.hint ? `${error.message}. ${error.hint}` : error.message;
	}
	return error instanceof Error ? error.message : String(error);
}

async function failureOf(response: Response): Promise<ApiProblem> {
	const text = await response.text().catch(() => '');
	try {
		const body = JSON.parse(text) as { error?: unknown; hint?: unknown; errorText?: unknown };
		const message = typeof body.error === 'string' ? body.error : body.errorText;
		if (typeof message === 'string' && message !== '') {
			return new ApiProblem(message, typeof body.hint === 'string' ? body.hint : undefined, response.status);
		}
	} catch {
		// Not JSON: the status and the start of the body are all there is.
	}
	const detail = text.trim().slice(0, 200);
	return new ApiProblem(
		`The task module answered ${response.status}${detail ? `: ${detail}` : ''}`,
		undefined,
		response.status
	);
}

/**
 * GET on the module's API (`apiBase` + path) and parse the JSON answer. Query values that are undefined are left out
 * (an empty string is sent). Rejects with the cancellation untouched (see `isAbort`), else with an `ApiProblem`.
 */
export async function getJson(
	path: string,
	query: Record<string, string | number | undefined>,
	options: GetJsonOptions = {}
): Promise<unknown> {
	const params = new URLSearchParams();
	for (const [key, value] of Object.entries(query)) {
		if (value !== undefined) {
			params.set(key, String(value));
		}
	}
	const search = params.toString();
	const url = `${options.apiBase ?? getApiBase()}${path}${search ? `?${search}` : ''}`;
	let response: Response;
	try {
		response = await fetch(url, { signal: options.signal, headers: { accept: 'application/json' } });
	} catch (error) {
		if (isAbort(error)) {
			throw error;
		}
		throw new ApiProblem(
			`Could not reach the task module (${error instanceof Error ? error.message : String(error)})`,
			'Check that app-core is running, then reload the page.'
		);
	}
	if (!response.ok) {
		throw await failureOf(response);
	}
	try {
		return await response.json();
	} catch {
		throw new ApiProblem(
			'The task module answered something that is not JSON',
			'Reload the page; if it persists, update the task module.',
			response.status
		);
	}
}
