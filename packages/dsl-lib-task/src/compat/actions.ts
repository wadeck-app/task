import type { ActionHandler } from '../useAction.js';

type Ctx = Record<string, unknown>;
type NamedHandler = (data: Record<string, unknown>) => Promise<unknown> | unknown;

/** Every string value also as `<key>Encoded` (percent-encoded), for the `{placeholders}` the shell does not encode. */
function withEncodedCopies(params: Record<string, unknown>): Record<string, unknown> {
	const data: Record<string, unknown> = { ...params };
	for (const [key, value] of Object.entries(params)) {
		if (typeof value === 'string') {
			data[`${key}Encoded`] = encodeURIComponent(value);
		}
	}
	return data;
}

/** The page context of the latest render: the answer of an action is published there, after the action resolved. */
let latestCtx: Ctx | undefined;
/** How long a handler waits for the render that carries the answer, and the step of the wait. */
const RENDER_WAIT_MS = 150;
const RENDER_STEP_MS = 10;

const isObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The failure the shell published under some `resultKey` since `before`: `{ error, status }` (a rejected request) or the
 * 200 answer of a route called with `?inlineErrors=true` (`failed: true`, `httpStatus`, `errorText`).
 */
function publishedFailure(before: Ctx, after: Ctx): { error: string; status: number | undefined } | undefined {
	for (const [key, value] of Object.entries(after)) {
		if (value === before[key] || !isObject(value)) {
			continue;
		}
		const status = (n: unknown): number | undefined => (typeof n === 'number' ? n : undefined);
		if (value['failed'] === true) {
			const text = [value['errorText'], value['error']].find(t => typeof t === 'string' && t !== '');
			return {
				error: typeof text === 'string' ? text : 'The request failed',
				status: status(value['httpStatus']),
			};
		}
		if (typeof value['error'] === 'string' && Object.keys(value).every(k => k === 'error' || k === 'status')) {
			return { error: value['error'], status: status(value['status']) };
		}
	}
	return undefined;
}

/**
 * Runs an action of the shell and tells its outcome. `ctx.onAction` (and a named handler whose answer is a 200 with
 * `failed: true`) resolve undefined whatever happened: a failed request is only published under the action's `resultKey`
 * and shown as a toast. A control that clears its field once "nothing failed" would lose the user's text on every failure,
 * so the answer the shell published (the next render of the page) is read and a failure is returned as `{ error, status }`.
 */
async function outcomeOf(ctx: Ctx, run: () => Promise<unknown>): Promise<unknown> {
	const result = await run();
	for (let waited = 0; latestCtx === ctx && waited < RENDER_WAIT_MS; waited += RENDER_STEP_MS) {
		await new Promise(resolve => setTimeout(resolve, RENDER_STEP_MS));
	}
	return (latestCtx === undefined ? undefined : publishedFailure(ctx, latestCtx)) ?? result;
}

/**
 * The handler a component uses to run a page action.
 *
 * The page gives two: `ctx.onAction(name, row)` (the table-row path: it runs the request and reloads the sources but,
 * in the installed shell, does not publish the answer under the action's `resultKey`) and `ctx.<name>(data)` (what a
 * Form's `onSubmit: $ctx.<name>` calls: it publishes the `resultKey`, so the `errorText` and `undeliveredText` badges of
 * the view work, and reloads). The named handler is used when the page has one; `onAction` is the fallback.
 *
 * The named handler fills the url `{placeholders}` from `data` without encoding them: each string is offered as
 * `<key>Encoded` as well, so an action url can say `/labels/{labelEncoded}`.
 */
export function pageActionHandler(ctx: Ctx): ActionHandler | undefined {
	latestCtx = ctx;
	const onAction = typeof ctx['onAction'] === 'function' ? (ctx['onAction'] as ActionHandler) : undefined;
	const hasNamed = Object.values(ctx).some(value => typeof value === 'function');
	if (!onAction && !hasNamed) {
		return undefined;
	}
	return async (action, params, options) => {
		const named = ctx[action];
		// A body travels through ctx.onAction (dsl-ui >= 318: sends it as JSON, publishes the resultKey, reloads).
		if (options?.body !== undefined && onAction) {
			return outcomeOf(ctx, () => Promise.resolve(onAction(action, params, options)));
		}
		if (typeof named === 'function' && action !== 'onAction') {
			const body = options?.body;
			const merged =
				typeof body === 'object' && body !== null
					? { ...withEncodedCopies(params), ...body }
					: withEncodedCopies(params);
			return outcomeOf(ctx, async () => {
				await (named as NamedHandler)(merged);
				return undefined;
			});
		}
		if (!onAction) {
			throw new Error(`the page has no action "${action}" (declare it under $actions)`);
		}
		return outcomeOf(ctx, () =>
			Promise.resolve(options === undefined ? onAction(action, params) : onAction(action, params, options))
		);
	};
}
