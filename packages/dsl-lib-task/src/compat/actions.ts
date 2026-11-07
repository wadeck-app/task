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
	const onAction = typeof ctx['onAction'] === 'function' ? (ctx['onAction'] as ActionHandler) : undefined;
	const hasNamed = Object.values(ctx).some(value => typeof value === 'function');
	if (!onAction && !hasNamed) {
		return undefined;
	}
	return async (action, params, options) => {
		const named = ctx[action];
		// A body travels through ctx.onAction (dsl-ui >= 318: sends it as JSON, publishes the resultKey, reloads).
		if (options?.body !== undefined && onAction) {
			return onAction(action, params, options);
		}
		if (typeof named === 'function' && action !== 'onAction') {
			const body = options?.body;
			const merged =
				typeof body === 'object' && body !== null
					? { ...withEncodedCopies(params), ...body }
					: withEncodedCopies(params);
			await (named as NamedHandler)(merged);
			return undefined;
		}
		if (!onAction) {
			throw new Error(`the page has no action "${action}" (declare it under $actions)`);
		}
		return options === undefined ? onAction(action, params) : onAction(action, params, options);
	};
}
