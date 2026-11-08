import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { CONTROL_H } from '../ui/tokens.js';
import { ControlButton } from './ControlButton.js';

describe('ControlButton', () => {
	it('is a button of the control height with an icon and its label', () => {
		render(<ControlButton label="Delete" icon="trash" variant="danger" />);

		const button = screen.getByRole('button', { name: 'Delete' });
		expect(button.className).toContain(CONTROL_H);
		expect(button.className).toContain('text-danger');
		expect(button.querySelector('svg')).not.toBeNull();
	});

	it('secondary is a bordered neutral button', () => {
		render(<ControlButton label="Cancel" />);

		const button = screen.getByRole('button', { name: 'Cancel' });
		expect(button.className).toContain('border-border');
		expect(button.className).not.toContain('text-danger');
		expect(button.querySelector('svg')).toBeNull();
	});

	it('without an action, the click is left to the container (a Dialog trigger)', async () => {
		const user = userEvent.setup();
		const onContainer = vi.fn();
		render(
			<span onClick={onContainer}>
				<ControlButton label="Delete" />
			</span>
		);

		await user.click(screen.getByRole('button', { name: 'Delete' }));

		expect(onContainer).toHaveBeenCalledTimes(1);
	});

	it('with an action, the click runs it with the params', async () => {
		const user = userEvent.setup();
		const onAction = vi.fn().mockResolvedValue(undefined);
		render(<ControlButton label="Go" action="go" params={{ id: 't1' }} onAction={onAction} />);

		await user.click(screen.getByRole('button', { name: 'Go' }));

		await waitFor(() => expect(onAction).toHaveBeenCalledWith('go', { id: 't1' }));
	});
});
