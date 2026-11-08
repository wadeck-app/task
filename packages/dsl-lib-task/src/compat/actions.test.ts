import { describe, expect, it, vi } from 'vitest';
import { pageActionHandler } from './actions.js';

/*
 * The installed shell (dsl-renderer 175) has two ways to run a `$actions` entry:
 *  - `ctx.onAction(name, row)`: the table-row path. It runs the request and reloads the sources but does NOT publish
 *    the answer under the action's `resultKey`, so a view cannot show `errorText` / `undeliveredText` next to the control.
 *  - `ctx.<name>(data)`: the handler a Form's `onSubmit: $ctx.<name>` calls. It publishes the `resultKey` and reloads.
 * A component must use the second whenever it exists. It fills the `{placeholders}` of the url from `data` WITHOUT
 * encoding them, so every string value is also offered percent-encoded as `<key>Encoded`.
 */
describe('pageActionHandler', () => {
	it('runs the named handler of the page with the params, plus the encoded copies', async () => {
		const setStatusTo = vi.fn().mockResolvedValue(undefined);
		const onAction = vi.fn();
		const handler = pageActionHandler({ setStatusTo, onAction });

		await handler!('setStatusTo', { id: 'abc', status: 'in progress/1' });

		expect(setStatusTo).toHaveBeenCalledWith({
			id: 'abc',
			status: 'in progress/1',
			idEncoded: 'abc',
			statusEncoded: 'in%20progress%2F1',
		});
		expect(onAction).not.toHaveBeenCalled();
	});

	it('does not encode what is not a string', async () => {
		const run = vi.fn();
		await pageActionHandler({ run })!('run', { count: 3, flag: true });

		expect(run).toHaveBeenCalledWith({ count: 3, flag: true });
	});

	it('falls back to ctx.onAction when the page has no handler of that name', async () => {
		const onAction = vi.fn().mockResolvedValue(undefined);

		await pageActionHandler({ onAction })!('unknown', { a: 'b' });

		expect(onAction).toHaveBeenCalledWith('unknown', { a: 'b' });
	});

	it('is undefined without a page (no handler at all)', () => {
		expect(pageActionHandler({})).toBeUndefined();
	});

	it('hands back what the handler rejects with, so the control can roll back', async () => {
		const failing = vi.fn().mockRejectedValue(new Error('boom'));

		await expect(pageActionHandler({ failing })!('failing', {})).rejects.toThrow('boom');
	});
});

/*
 * `ctx.onAction` (the path that carries a body) never rejects and never resolves the answer: on a failed request it
 * publishes `{ error, status }` under the action's `resultKey`, shows a toast and resolves undefined. A route answering
 * `?inlineErrors=true` fails with a 200 `{ failed: true, httpStatus, errorText }`, published the same way. A control that
 * clears its field "when the action did not fail" would therefore lose the user's text on every failure. The handler reads
 * the answer the shell published (the next render of the page) and reports a failure as `{ error, status }`.
 */
describe('pageActionHandler: failures published by the shell', () => {
	// What the page does: the action runs, the page renders again with the answer under the result key.
	function page(published: Record<string, unknown>, delayMs = 0) {
		const before = { onAction: undefined as unknown, subtaskResult: { task: { id: 'old' } } };
		const onAction = vi.fn(async () => {
			setTimeout(() => pageActionHandler({ onAction, ...published }), delayMs);
			return undefined;
		});
		before.onAction = onAction;
		return { handler: pageActionHandler(before as never)!, onAction };
	}

	it('reports a published { error, status } as the failure of the action', async () => {
		const { handler } = page({ subtaskResult: { error: "Failed to execute 'json'", status: undefined } });

		const answer = await handler('createSubtask', {}, { body: { title: 'x' } });

		expect(answer).toEqual({ error: "Failed to execute 'json'", status: undefined });
	});

	it('reports an inline error answer (200 with failed: true) with its text and status', async () => {
		const { handler } = page({
			subtaskResult: {
				error: 'Task not found: t',
				failed: true,
				httpStatus: 404,
				errorText: 'Task not found: t. Try x',
			},
		});

		const answer = await handler('createSubtask', {}, { body: { title: 'x' } });

		expect(answer).toEqual({ error: 'Task not found: t. Try x', status: 404 });
	});

	it('waits for the render that carries the answer', async () => {
		const { handler } = page({ subtaskResult: { error: 'late', status: 500 } }, 40);

		const answer = await handler('createSubtask', {}, { body: { title: 'x' } });

		expect(answer).toEqual({ error: 'late', status: 500 });
	});

	it('leaves a successful answer alone', async () => {
		const { handler } = page({ subtaskResult: { task: { id: 'new' }, message: 'Created' } });

		expect(await handler('createSubtask', {}, { body: { title: 'x' } })).toBeUndefined();
	});

	it('does not report a failure that was already there before the call', async () => {
		const stale = { error: 'old failure', status: 400 };
		const ctx: Record<string, unknown> = { subtaskResult: stale };
		ctx['onAction'] = vi.fn(async () => {
			setTimeout(() => pageActionHandler({ ...ctx }), 0);
			return undefined;
		});

		expect(await pageActionHandler(ctx)!('createSubtask', {}, { body: { title: 'x' } })).toBeUndefined();
	});

	it('gives the original answer when the page never renders again', async () => {
		const onAction = vi.fn().mockResolvedValue('kept');

		expect(await pageActionHandler({ onAction })!('a', {}, { body: {} })).toBe('kept');
	});
});
