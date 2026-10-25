import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetReported } from '../reportOnce.js';
import { LabelChips } from './LabelChips.js';

afterEach(() => {
	resetReported();
	vi.restoreAllMocks();
});

describe('LabelChips', () => {
	it('shows one chip per label', () => {
		render(<LabelChips labels={['bug', 'ui']} readOnly />);

		expect(screen.getAllByTestId('label-chip')).toHaveLength(2);
		expect(screen.getByText('bug')).toBeInTheDocument();
	});

	it('gives the same label the same colour every time, from the palette', () => {
		const { unmount } = render(<LabelChips labels={['bug']} readOnly />);
		const first = screen.getByTestId('label-chip').className;
		unmount();
		render(<LabelChips labels={['bug']} readOnly />);

		expect(screen.getByTestId('label-chip').className).toBe(first);
		expect(first).toMatch(/task-chip-[1-6]/);
	});

	it('uses the colour given for a label', () => {
		render(<LabelChips labels={['bug']} colors={{ bug: 'danger' }} readOnly />);

		expect(screen.getByTestId('label-chip')).toHaveClass('bg-danger-bg');
	});

	it('is read-only without actions: no remove button, no input', () => {
		render(<LabelChips labels={['bug']} />);

		expect(screen.queryByRole('button')).toBeNull();
		expect(screen.queryByRole('textbox')).toBeNull();
	});

	it('removes a label through the action, with the label next to the params', async () => {
		const onAction = vi.fn().mockResolvedValue(undefined);
		render(
			<LabelChips
				labels={['bug', 'ui']}
				removeAction="removeLabel"
				params={{ id: 't1', projectParam: 'p1' }}
				onAction={onAction}
			/>
		);

		await userEvent.setup().click(screen.getByRole('button', { name: 'Remove label bug' }));

		expect(onAction).toHaveBeenCalledWith('removeLabel', { id: 't1', projectParam: 'p1', label: 'bug' });
	});

	it('adds a label on Enter, trimmed, and clears the field once saved', async () => {
		const onAction = vi.fn().mockResolvedValue(undefined);
		render(<LabelChips labels={['bug']} addAction="addLabel" params={{ id: 't1' }} onAction={onAction} />);
		const user = userEvent.setup();

		await user.type(screen.getByRole('textbox', { name: 'Add a label' }), '  urgent {Enter}');

		expect(onAction).toHaveBeenCalledWith('addLabel', { id: 't1', label: 'urgent' });
		await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue(''));
	});

	it('uses labelParam as the parameter name', async () => {
		const onAction = vi.fn().mockResolvedValue(undefined);
		render(<LabelChips labels={[]} addAction="a" labelParam="name" onAction={onAction} />);

		await userEvent.setup().type(screen.getByRole('textbox'), 'x{Enter}');

		expect(onAction).toHaveBeenCalledWith('a', { name: 'x' });
	});

	it('adds the typed label when the field loses focus', async () => {
		const onAction = vi.fn().mockResolvedValue(undefined);
		render(<LabelChips labels={[]} addAction="a" onAction={onAction} />);
		const user = userEvent.setup();

		await user.type(screen.getByRole('textbox'), 'late');
		await user.tab();

		expect(onAction).toHaveBeenCalledWith('a', { label: 'late' });
	});

	it('ignores an empty entry and a label the task already has, and says so', async () => {
		const onAction = vi.fn().mockResolvedValue(undefined);
		render(<LabelChips labels={['bug']} addAction="a" onAction={onAction} />);
		const user = userEvent.setup();

		await user.type(screen.getByRole('textbox'), '   {Enter}');
		await user.clear(screen.getByRole('textbox'));
		await user.type(screen.getByRole('textbox'), 'bug{Enter}');

		expect(onAction).not.toHaveBeenCalled();
		expect(screen.getByRole('alert')).toHaveTextContent('already');
	});

	it('keeps the typed text when the handler rejects', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const onAction = vi.fn().mockRejectedValue(new Error('no'));
		render(<LabelChips labels={[]} addAction="a" onAction={onAction} />);

		await userEvent.setup().type(screen.getByRole('textbox'), 'keep{Enter}');

		await waitFor(() => expect(onAction).toHaveBeenCalled());
		expect(screen.getByRole('textbox')).toHaveValue('keep');
	});

	it('is disabled, with the reason, when it has an action and no page to run it', () => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		render(<LabelChips labels={['bug']} addAction="addLabel" removeAction="removeLabel" />);

		expect(screen.getByRole('textbox')).toBeDisabled();
		expect(screen.getByRole('button', { name: 'Remove label bug' })).toBeDisabled();
		expect(error).toHaveBeenCalledWith(expect.stringContaining('addLabel'));
	});

	it('disables the controls while an action runs', async () => {
		let finish: () => void = () => {};
		const onAction = vi.fn(() => new Promise<void>(resolve => (finish = resolve)));
		render(<LabelChips labels={['bug']} removeAction="r" onAction={onAction} />);

		await userEvent.setup().click(screen.getByRole('button', { name: 'Remove label bug' }));

		expect(screen.getByRole('button', { name: 'Remove label bug' })).toBeDisabled();
		finish();
		await waitFor(() => expect(screen.getByRole('button', { name: 'Remove label bug' })).toBeEnabled());
	});

	it('says there is no label when there is none and it is read-only', () => {
		render(<LabelChips labels={[]} readOnly emptyText="No labels" />);

		expect(screen.getByText('No labels')).toBeInTheDocument();
	});
});
