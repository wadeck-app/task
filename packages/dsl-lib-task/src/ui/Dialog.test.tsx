import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React, { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Dialog } from './Dialog.js';

interface HarnessProps {
	dirty?: boolean;
	busy?: boolean;
	onClose?: () => void;
	alert?: React.ReactNode;
	size?: 'md' | 'lg';
}

/** A trigger that opens the dialog, as the board does. */
function Harness({ dirty = false, busy = false, onClose = () => undefined, alert, size }: HarnessProps) {
	const [open, setOpen] = useState(false);
	return (
		<div>
			<button type="button" onClick={() => setOpen(true)}>
				Open it
			</button>
			<p>Board behind</p>
			{open ? (
				<Dialog
					title="Configure things"
					testId="thing-dialog"
					dirty={dirty}
					busy={busy}
					alert={alert}
					size={size}
					onClose={() => {
						onClose();
						setOpen(false);
					}}
					footer={({ requestClose }) => (
						<>
							<button type="button" onClick={requestClose}>
								Cancel
							</button>
							<button type="button">Save</button>
						</>
					)}
				>
					<input aria-label="First field" />
					<input aria-label="Second field" />
				</Dialog>
			) : null}
		</div>
	);
}

async function open(user = userEvent.setup()) {
	await user.click(screen.getByRole('button', { name: 'Open it' }));
	return user;
}

describe('Dialog', () => {
	it('is a modal dialog labelled by its title, drawn in a portal on the body', async () => {
		render(<Harness />);
		await open();
		const dialog = screen.getByRole('dialog', { name: 'Configure things' });
		expect(dialog).toHaveAttribute('aria-modal', 'true');
		expect(dialog).toHaveAttribute('data-testid', 'thing-dialog');
		const title = screen.getByRole('heading', { name: 'Configure things' });
		expect(dialog.getAttribute('aria-labelledby')).toBe(title.id);
		expect(dialog.closest('body')).toBe(document.body);
		expect(screen.getByRole('button', { name: 'Open it' }).parentElement?.contains(dialog)).toBe(false);
	});

	it('draws a header with a close button, a scrollable body and a sticky footer', async () => {
		render(<Harness />);
		await open();
		const dialog = screen.getByRole('dialog');
		expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument();
		expect(screen.getByTestId('thing-dialog-body').className).toMatch(/overflow-y-auto/);
		const footer = screen.getByTestId('thing-dialog-footer');
		expect(dialog.contains(footer)).toBe(true);
		expect(footer).toContainElement(screen.getByRole('button', { name: 'Save' }));
		// The footer is not inside the scrolling body: it stays visible whatever the content height.
		expect(screen.getByTestId('thing-dialog-body').contains(footer)).toBe(false);
	});

	it('shows the alert between the body and the footer, outside the scroll', async () => {
		render(<Harness alert={<p role="alert">It broke</p>} />);
		await open();
		const alert = screen.getByRole('alert');
		expect(screen.getByTestId('thing-dialog-body').contains(alert)).toBe(false);
		expect(screen.getByRole('dialog')).toContainElement(alert);
	});

	it('is full screen below 640 px (no inset, no rounded corners) and bounded above', async () => {
		render(<Harness />);
		await open();
		const backdrop = screen.getByTestId('thing-dialog-backdrop');
		const panel = screen.getByRole('dialog');
		expect(backdrop.className).toMatch(/fixed inset-0/);
		expect(backdrop.className).toMatch(/\bp-0\b/);
		expect(backdrop.className).toMatch(/sm:p-4/);
		expect(panel.className).toMatch(/\bh-full\b/);
		expect(panel.className).toMatch(/sm:rounded-lg/);
		expect(panel.className).not.toMatch(/(^|\s)rounded-lg/);
		expect(panel.className).toMatch(/sm:max-h-\[90vh\]/);
	});

	it('is 56rem wide by default and 64rem for the large size', async () => {
		const { unmount } = render(<Harness />);
		await open();
		expect(screen.getByRole('dialog').className).toMatch(/max-w-4xl/);
		unmount();
		render(<Harness size="lg" />);
		await open();
		expect(screen.getByRole('dialog').className).toMatch(/max-w-5xl/);
	});

	it('puts the focus on the dialog itself and gives it back to the trigger on close', async () => {
		render(<Harness />);
		const user = userEvent.setup();
		const trigger = screen.getByRole('button', { name: 'Open it' });
		trigger.focus();
		await user.click(trigger);
		expect(screen.getByRole('dialog')).toHaveFocus();
		await user.keyboard('{Escape}');
		expect(screen.queryByRole('dialog')).toBeNull();
		expect(trigger).toHaveFocus();
	});

	it('closes with Escape at once when nothing changed', async () => {
		const onClose = vi.fn();
		render(<Harness onClose={onClose} />);
		const user = await open();
		await user.keyboard('{Escape}');
		expect(onClose).toHaveBeenCalledTimes(1);
		expect(screen.queryByRole('dialog')).toBeNull();
	});

	it('closes by the close button, Cancel and the backdrop at once when nothing changed', async () => {
		const onClose = vi.fn();
		render(<Harness onClose={onClose} />);
		const user = await open();
		await user.click(screen.getByRole('button', { name: 'Close' }));
		expect(onClose).toHaveBeenCalledTimes(1);
		await user.click(screen.getByRole('button', { name: 'Open it' }));
		await user.click(screen.getByRole('button', { name: 'Cancel' }));
		expect(onClose).toHaveBeenCalledTimes(2);
		await user.click(screen.getByRole('button', { name: 'Open it' }));
		fireEvent.click(screen.getByTestId('thing-dialog-backdrop'));
		expect(onClose).toHaveBeenCalledTimes(3);
	});

	it.each([
		['Escape', async (user: ReturnType<typeof userEvent.setup>) => user.keyboard('{Escape}')],
		['the close button', async () => fireEvent.click(screen.getByRole('button', { name: 'Close' }))],
		['Cancel', async () => fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))],
		['the backdrop', async () => fireEvent.click(screen.getByTestId('thing-dialog-backdrop'))],
	])('asks "Discard changes?" instead of closing with %s when something changed', async (_name, close) => {
		const onClose = vi.fn();
		render(<Harness dirty onClose={onClose} />);
		const user = await open();
		await close(user);
		expect(onClose).not.toHaveBeenCalled();
		const confirm = screen.getByTestId('thing-dialog-discard');
		expect(confirm).toHaveTextContent('Discard changes?');
		expect(screen.getByRole('button', { name: 'Keep editing' })).toHaveFocus();
		// Still open, still editable.
		expect(screen.getByRole('dialog')).toBeInTheDocument();
		expect(screen.getByRole('textbox', { name: 'First field' })).toBeInTheDocument();
	});

	it('Keep editing puts the confirm away and the focus back in the dialog; Discard closes', async () => {
		const onClose = vi.fn();
		render(<Harness dirty onClose={onClose} />);
		const user = await open();
		await user.keyboard('{Escape}');
		await user.click(screen.getByRole('button', { name: 'Keep editing' }));
		expect(screen.queryByTestId('thing-dialog-discard')).toBeNull();
		expect(screen.getByRole('dialog')).toContainElement(document.activeElement as HTMLElement);
		expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
		// Esc on the confirm itself means keep editing.
		await user.keyboard('{Escape}');
		expect(screen.getByTestId('thing-dialog-discard')).toBeInTheDocument();
		await user.keyboard('{Escape}');
		expect(screen.queryByTestId('thing-dialog-discard')).toBeNull();
		expect(onClose).not.toHaveBeenCalled();
		await user.keyboard('{Escape}');
		await user.click(screen.getByRole('button', { name: 'Discard' }));
		expect(onClose).toHaveBeenCalledTimes(1);
		expect(screen.queryByRole('dialog')).toBeNull();
	});

	it('ignores every way out while busy', async () => {
		const onClose = vi.fn();
		render(<Harness busy onClose={onClose} />);
		const user = await open();
		await user.keyboard('{Escape}');
		fireEvent.click(screen.getByTestId('thing-dialog-backdrop'));
		expect(onClose).not.toHaveBeenCalled();
		expect(screen.getByRole('button', { name: 'Close' })).toBeDisabled();
	});

	it('does not close when a click that began inside ends on the backdrop (text selection)', async () => {
		const onClose = vi.fn();
		render(<Harness onClose={onClose} />);
		await open();
		fireEvent.mouseDown(screen.getByRole('textbox', { name: 'First field' }));
		fireEvent.click(screen.getByTestId('thing-dialog-backdrop'));
		expect(onClose).not.toHaveBeenCalled();
	});

	it('a click inside the panel does not close it', async () => {
		const onClose = vi.fn();
		render(<Harness onClose={onClose} />);
		const user = await open();
		await user.click(screen.getByRole('textbox', { name: 'First field' }));
		expect(onClose).not.toHaveBeenCalled();
	});

	it('traps Tab and Shift+Tab inside the dialog', async () => {
		render(<Harness />);
		const user = await open();
		const close = screen.getByRole('button', { name: 'Close' });
		const save = screen.getByRole('button', { name: 'Save' });
		save.focus();
		await user.tab();
		expect(close).toHaveFocus();
		await user.tab({ shift: true });
		expect(save).toHaveFocus();
		// From the dialog itself, Shift+Tab goes to the last control, Tab to the first.
		screen.getByRole('dialog').focus();
		await user.tab({ shift: true });
		expect(save).toHaveFocus();
	});

	it('pulls the focus back when it escapes to the page behind', async () => {
		render(<Harness />);
		await open();
		const behind = document.createElement('button');
		document.body.appendChild(behind);
		behind.focus();
		expect(screen.getByRole('dialog')).toContainElement(document.activeElement as HTMLElement);
		behind.remove();
	});

	it('locks the scroll of the page while open and restores it on close', async () => {
		document.body.style.overflow = 'auto';
		render(<Harness />);
		const user = await open();
		expect(document.body.style.overflow).toBe('hidden');
		await user.keyboard('{Escape}');
		expect(document.body.style.overflow).toBe('auto');
		document.body.style.overflow = '';
	});

	it('restores the scroll of the page when unmounted while open', async () => {
		document.body.style.overflow = '';
		const { unmount } = render(<Harness />);
		await open();
		expect(document.body.style.overflow).toBe('hidden');
		unmount();
		expect(document.body.style.overflow).toBe('');
		expect(document.querySelector('[role="dialog"]')).toBeNull();
	});
});
