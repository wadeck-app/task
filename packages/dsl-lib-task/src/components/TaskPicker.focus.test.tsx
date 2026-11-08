import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deferred, jsonResponse, stubFetch } from '../testHelpers.js';
import { resetReported } from '../reportOnce.js';
import { configureTaskUi, resetTaskUiConfig } from '../runtime-config.js';
import { TaskPicker } from './TaskPicker.js';

const ROWS = [
	{ id: 'aaaa1111', headline: 'Fix login loop', status: 'todo', statusText: 'todo', tone: 'neutral' },
	{ id: 'bbbb2222', headline: 'Write docs', status: 'todo', statusText: 'todo', tone: 'neutral' },
];

beforeEach(() => configureTaskUi({ apiBase: '/api/modules/task' }));
afterEach(() => {
	resetTaskUiConfig();
	resetReported();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

// A link or a parent picked in the picker: the search field is where the next one is typed, so it keeps (or gets back) the focus
// after a successful pick, and never takes it from where the user went meanwhile.
describe('TaskPicker: focus after a pick', () => {
	it('keeps the focus in the search field after a successful pick, ready for the next link', async () => {
		stubFetch(() => jsonResponse(ROWS));
		const onAction = vi.fn().mockResolvedValue(undefined);
		render(<TaskPicker action="addLink" onAction={onAction} ariaLabel="Task to link" debounceMs={0} />);
		const user = userEvent.setup();
		const input = screen.getByRole('combobox', { name: 'Task to link' });

		await user.click(input);
		await user.click(await screen.findByRole('option', { name: /Fix login loop/ }));

		await waitFor(() => expect(onAction).toHaveBeenCalledTimes(1));
		await waitFor(() => expect(screen.queryByRole('listbox', { hidden: true })).toBeNull());
		expect(input).toHaveFocus();
		expect(input).toHaveValue('');
	});

	it('takes the focus back when it fell to the page while the pick ran', async () => {
		stubFetch(() => jsonResponse(ROWS));
		const pending = deferred<undefined>();
		const onAction = vi.fn().mockReturnValue(pending.promise);
		render(<TaskPicker action="addLink" onAction={onAction} ariaLabel="Task to link" debounceMs={0} />);
		const user = userEvent.setup();
		const input = screen.getByRole('combobox', { name: 'Task to link' });

		await user.click(input);
		await user.click(await screen.findByRole('option', { name: /Fix login loop/ }));
		act(() => (document.activeElement as HTMLElement | null)?.blur());
		await act(async () => {
			pending.resolve(undefined);
			await pending.promise;
		});

		await waitFor(() => expect(input).toHaveFocus());
	});

	it('does not take the focus from another field the user went to, and not after a failure', async () => {
		stubFetch(() => jsonResponse(ROWS));
		const pending = deferred<unknown>();
		const onAction = vi.fn().mockReturnValue(pending.promise);
		render(
			<div>
				<TaskPicker action="addLink" onAction={onAction} ariaLabel="Task to link" debounceMs={0} />
				<input aria-label="Elsewhere" />
			</div>
		);
		const user = userEvent.setup();

		await user.click(screen.getByRole('combobox', { name: 'Task to link' }));
		await user.click(await screen.findByRole('option', { name: /Fix login loop/ }));
		await user.click(screen.getByRole('textbox', { name: 'Elsewhere' }));
		await act(async () => {
			pending.resolve({ error: 'refused', status: 400 });
			await pending.promise;
		});

		expect(screen.getByRole('textbox', { name: 'Elsewhere' })).toHaveFocus();
	});
});
