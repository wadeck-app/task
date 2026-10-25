import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetReported } from '../reportOnce.js';
import { ActionSelect } from './ActionSelect.js';

// @formatter:off
const OPTIONS = [
	{ value: 'todo', label: 'To do' },
	{ value: 'done', label: 'Done', tone: 'success' as const },
];
// @formatter:on

afterEach(() => {
	resetReported();
	vi.restoreAllMocks();
});

describe('ActionSelect', () => {
	it('is a select showing the current value, named by ariaLabel', () => {
		render(<ActionSelect options={OPTIONS} value="done" action="a" onAction={vi.fn()} ariaLabel="Status" />);

		const select = screen.getByRole('combobox', { name: 'Status' });
		expect(select).toHaveValue('done');
	});

	it('runs the action on change, with no Save button', async () => {
		const onAction = vi.fn().mockResolvedValue(undefined);
		render(
			<ActionSelect
				options={OPTIONS}
				value="todo"
				action="setStatusTo"
				valueParam="status"
				params={{ id: 't1', projectParam: 'p1' }}
				onAction={onAction}
				ariaLabel="Status"
			/>
		);

		await userEvent.setup().selectOptions(screen.getByRole('combobox'), 'done');

		expect(onAction).toHaveBeenCalledWith('setStatusTo', { id: 't1', projectParam: 'p1', status: 'done' });
		expect(screen.queryByRole('button')).toBeNull();
	});

	it('shows the chosen value while the request runs, then what the page says', async () => {
		let finish: () => void = () => {};
		const onAction = vi.fn(() => new Promise<void>(resolve => (finish = resolve)));
		render(<ActionSelect options={OPTIONS} value="todo" action="a" onAction={onAction} />);

		await userEvent.setup().selectOptions(screen.getByRole('combobox'), 'done');
		expect(screen.getByRole('combobox')).toHaveValue('done');
		expect(screen.getByRole('combobox')).toBeDisabled();

		finish();
		await waitFor(() => expect(screen.getByRole('combobox')).toHaveValue('todo'));
		expect(screen.getByRole('combobox')).toBeEnabled();
	});

	it('goes back to the page value and logs when the handler rejects', async () => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		const onAction = vi.fn().mockRejectedValue(new Error('refused'));
		render(<ActionSelect options={OPTIONS} value="todo" action="a" onAction={onAction} />);

		await userEvent.setup().selectOptions(screen.getByRole('combobox'), 'done');

		await waitFor(() => expect(screen.getByRole('combobox')).toHaveValue('todo'));
		expect(error).toHaveBeenCalledWith(expect.stringContaining('refused'));
	});

	it('offers a placeholder when nothing is selected', () => {
		render(<ActionSelect options={OPTIONS} value="" placeholder="No type" action="a" onAction={vi.fn()} />);

		expect(screen.getByRole('option', { name: 'No type' })).toBeInTheDocument();
		expect(screen.getByRole('combobox')).toHaveValue('');
	});

	it('lets the user clear the value with allowEmpty, sending an empty string', async () => {
		const onAction = vi.fn().mockResolvedValue(undefined);
		render(
			<ActionSelect
				options={OPTIONS}
				value="done"
				placeholder="No type"
				allowEmpty
				action="a"
				valueParam="type"
				onAction={onAction}
			/>
		);

		await userEvent.setup().selectOptions(screen.getByRole('combobox'), '');

		expect(onAction).toHaveBeenCalledWith('a', { type: '' });
	});

	it('does not offer the empty choice without allowEmpty once a value is chosen', () => {
		render(<ActionSelect options={OPTIONS} value="done" placeholder="No type" action="a" onAction={vi.fn()} />);

		expect(screen.getByRole('option', { name: 'No type' })).toBeDisabled();
	});

	it('shows the tone of the current option', () => {
		render(<ActionSelect options={OPTIONS} value="done" action="a" onAction={vi.fn()} appearance="pill" />);

		expect(screen.getByTestId('action-select')).toHaveAttribute('data-tone', 'success');
		expect(screen.getByTestId('action-select')).toHaveAttribute('data-appearance', 'pill');
	});

	it('is disabled, with the reason as a tooltip, without a page to run the action', () => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		render(<ActionSelect options={OPTIONS} value="todo" action="setStatusTo" />);

		expect(screen.getByRole('combobox')).toBeDisabled();
		expect(screen.getByTestId('action-select')).toHaveAttribute('title', expect.stringContaining('page'));
		expect(error).toHaveBeenCalledTimes(1);
	});

	it('is disabled while the page says the action runs, and when disabled is set', () => {
		const { rerender } = render(
			<ActionSelect options={OPTIONS} value="todo" action="a" onAction={vi.fn()} actionPending={{ a: true }} />
		);
		expect(screen.getByRole('combobox')).toBeDisabled();

		rerender(<ActionSelect options={OPTIONS} value="todo" action="a" onAction={vi.fn()} disabled />);
		expect(screen.getByRole('combobox')).toBeDisabled();
	});

	it('keeps an unknown current value visible instead of showing the first option', () => {
		render(<ActionSelect options={OPTIONS} value="legacy" action="a" onAction={vi.fn()} />);

		expect(screen.getByRole('combobox')).toHaveValue('legacy');
		expect(screen.getByRole('option', { name: 'legacy' })).toBeInTheDocument();
	});
});
