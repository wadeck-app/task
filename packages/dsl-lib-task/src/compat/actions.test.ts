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
