import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetReported } from '../reportOnce.js';
import { SegmentedControl } from './SegmentedControl.js';

// @formatter:off
const OPTIONS = [
	{ value: 'todo', label: 'To do' },
	{ value: 'doing', label: 'Doing', tone: 'info' as const },
	{ value: 'done', label: 'Done', tone: 'success' as const },
	{ value: 'held', label: 'Held', disabled: true },
];
// @formatter:on

afterEach(() => {
	resetReported();
	vi.restoreAllMocks();
});

describe('SegmentedControl', () => {
	it('is a radio group with the current value checked', () => {
		render(<SegmentedControl options={OPTIONS} value="doing" ariaLabel="Status" />);

		expect(screen.getByRole('radiogroup', { name: 'Status' })).toBeInTheDocument();
		expect(screen.getByRole('radio', { name: 'Doing' })).toBeChecked();
		expect(screen.getByRole('radio', { name: 'To do' })).not.toBeChecked();
	});

	it('runs the action with the chosen value under valueParam, next to the given params', async () => {
		const onAction = vi.fn().mockResolvedValue(undefined);
		render(
			<SegmentedControl
				options={OPTIONS}
				value="todo"
				action="setStatusTo"
				valueParam="status"
				params={{ id: 't1', projectParam: 'p1' }}
				onAction={onAction}
			/>
		);

		await userEvent.setup().click(screen.getByRole('radio', { name: 'Done' }));

		expect(onAction).toHaveBeenCalledWith('setStatusTo', { id: 't1', projectParam: 'p1', status: 'done' });
	});

	it('uses "value" as the parameter name by default', async () => {
		const onAction = vi.fn().mockResolvedValue(undefined);
		render(<SegmentedControl options={OPTIONS} value="todo" action="a" onAction={onAction} />);

		await userEvent.setup().click(screen.getByRole('radio', { name: 'Done' }));

		expect(onAction).toHaveBeenCalledWith('a', { value: 'done' });
	});

	it('selects the clicked option while the request is in flight, then shows what the page says', async () => {
		let finish: () => void = () => {};
		const onAction = vi.fn(() => new Promise<void>(resolve => (finish = resolve)));
		render(<SegmentedControl options={OPTIONS} value="todo" action="a" onAction={onAction} />);

		await userEvent.setup().click(screen.getByRole('radio', { name: 'Done' }));
		expect(screen.getByRole('radio', { name: 'Done' })).toBeChecked();
		expect(screen.getByTestId('segmented-control')).toHaveAttribute('aria-busy', 'true');

		await act(async () => finish());
		await waitFor(() => expect(screen.getByRole('radio', { name: 'To do' })).toBeChecked());
	});

	it('keeps the value when the handler rejects, and says why in the console', async () => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		const onAction = vi.fn().mockRejectedValue(new Error('boom'));
		render(<SegmentedControl options={OPTIONS} value="todo" action="a" onAction={onAction} />);

		await userEvent.setup().click(screen.getByRole('radio', { name: 'Done' }));

		await waitFor(() => expect(screen.getByRole('radio', { name: 'To do' })).toBeChecked());
		expect(error).toHaveBeenCalledWith(expect.stringContaining('boom'));
	});

	it('does nothing when the current value is clicked, or a disabled option', async () => {
		const onAction = vi.fn().mockResolvedValue(undefined);
		render(<SegmentedControl options={OPTIONS} value="todo" action="a" onAction={onAction} />);
		const user = userEvent.setup();

		await user.click(screen.getByRole('radio', { name: 'To do' }));
		await user.click(screen.getByRole('radio', { name: 'Held' }));

		expect(onAction).not.toHaveBeenCalled();
	});

	it('is display-only without an action', async () => {
		const onAction = vi.fn();
		render(<SegmentedControl options={OPTIONS} value="todo" onAction={onAction} />);

		await userEvent.setup().click(screen.getByRole('radio', { name: 'Done' }));

		expect(onAction).not.toHaveBeenCalled();
		expect(screen.getByRole('radio', { name: 'To do' })).toBeChecked();
	});

	it('is disabled, with the reason as a tooltip, when it has an action but no page to run it', () => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		render(<SegmentedControl options={OPTIONS} value="todo" action="setStatusTo" />);

		expect(screen.getByRole('radio', { name: 'Done' })).toBeDisabled();
		expect(screen.getByTestId('segmented-control')).toHaveAttribute('title', expect.stringContaining('page'));
		expect(error).toHaveBeenCalledWith(expect.stringContaining('setStatusTo'));
	});

	it('is busy and disabled while the page says the action runs', () => {
		render(
			<SegmentedControl
				options={OPTIONS}
				value="todo"
				action="a"
				onAction={vi.fn()}
				actionPending={{ a: true }}
			/>
		);

		expect(screen.getByRole('radio', { name: 'Done' })).toBeDisabled();
	});

	it('moves with the arrow keys, running the action for the option reached', async () => {
		const onAction = vi.fn().mockResolvedValue(undefined);
		render(<SegmentedControl options={OPTIONS} value="todo" action="a" onAction={onAction} />);
		const user = userEvent.setup();

		screen.getByRole('radio', { name: 'To do' }).focus();
		await user.keyboard('{ArrowRight}');

		expect(onAction).toHaveBeenCalledWith('a', { value: 'doing' });
	});

	it('shows the hint of an option as its tooltip', () => {
		render(<SegmentedControl options={[{ value: 'a', label: 'A', hint: 'The first' }]} value="a" />);

		expect(screen.getByRole('radio', { name: 'A' }).closest('label')).toHaveAttribute('title', 'The first');
	});

	it('takes its look from appearance and size', () => {
		const { rerender } = render(<SegmentedControl options={OPTIONS} value="todo" />);
		expect(screen.getByTestId('segmented-control')).toHaveAttribute('data-appearance', 'segmented');

		rerender(<SegmentedControl options={OPTIONS} value="todo" appearance="pills" size="md" fullWidth />);
		expect(screen.getByTestId('segmented-control')).toHaveAttribute('data-appearance', 'pills');
		expect(screen.getByTestId('segmented-control')).toHaveClass('w-full');
	});
});
