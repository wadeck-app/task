import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { pageActionHandler } from './compat/actions.js';
import { useAction } from './useAction.js';

describe('useAction with a body', () => {
	it('gives the handler the params and, when there is one, the body as third argument', async () => {
		const onAction = vi.fn().mockResolvedValue(undefined);
		const { result } = renderHook(() => useAction('T', 'setParent', onAction, undefined));

		await act(async () => {
			await result.current.run({ id: 't1' }, { target: 'x' });
		});

		expect(onAction).toHaveBeenCalledWith('setParent', { id: 't1' }, { body: { target: 'x' } });
	});

	it('keeps the two-argument call when there is no body', async () => {
		const onAction = vi.fn().mockResolvedValue(undefined);
		const { result } = renderHook(() => useAction('T', 'a', onAction, undefined));

		await act(async () => {
			await result.current.run({ id: 't1' });
		});

		expect(onAction).toHaveBeenCalledWith('a', { id: 't1' });
		expect(onAction.mock.calls[0]).toHaveLength(2);
	});

	it('reports a failure when the handler resolves an error answer (the shell publishes it instead of rejecting)', async () => {
		const onAction = vi.fn().mockResolvedValue({ error: 'not-found', status: 404 });
		const { result } = renderHook(() => useAction('T', 'a', onAction, undefined));
		let ok = true;

		await act(async () => {
			ok = await result.current.run({});
		});

		expect(ok).toBe(false);
	});

	it('treats any other resolved value as success', async () => {
		const onAction = vi.fn().mockResolvedValue({ ok: true });
		const { result } = renderHook(() => useAction('T', 'a', onAction, undefined));
		let ok = false;

		await act(async () => {
			ok = await result.current.run({});
		});

		expect(ok).toBe(true);
	});
});

describe('pageActionHandler with a body', () => {
	it('sends the body through ctx.onAction, which publishes the resultKey and reloads on shells >= 318', async () => {
		const onAction = vi.fn().mockResolvedValue(undefined);
		const named = vi.fn();

		await pageActionHandler({ onAction, setParent: named })!('setParent', { id: 't1' }, { body: { target: 'x' } });

		expect(onAction).toHaveBeenCalledWith('setParent', { id: 't1' }, { body: { target: 'x' } });
		expect(named).not.toHaveBeenCalled();
	});

	it('returns what ctx.onAction answered, so a published error can be seen', async () => {
		const onAction = vi.fn().mockResolvedValue({ error: 'x', status: 400 });

		const result = await pageActionHandler({ onAction })!('a', {}, { body: { v: 1 } });

		expect(result).toEqual({ error: 'x', status: 400 });
	});

	it('falls back to the named handler with the body merged into the data when the page has no onAction', async () => {
		const named = vi.fn().mockResolvedValue(undefined);

		await pageActionHandler({ setParent: named })!('setParent', { id: 't1' }, { body: { target: 'x' } });

		expect(named).toHaveBeenCalledWith({ id: 't1', idEncoded: 't1', target: 'x' });
	});
});
