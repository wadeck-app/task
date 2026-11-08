import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { deferred } from '../testHelpers.js';
import { resetReported } from '../reportOnce.js';
import { PropertyPopover } from './PropertyPopover.js';

// @formatter:off
const OPTIONS = [
	{ value: 'backlog', label: 'Backlog' },
	{ value: 'doing', label: 'In progress', tone: 'info' as const },
	{ value: 'done', label: 'Done', tone: 'success' as const },
];
// @formatter:on

afterEach(() => {
	resetReported();
	vi.restoreAllMocks();
});

function setup(extra: Partial<React.ComponentProps<typeof PropertyPopover>> = {}) {
	const onAction = vi.fn().mockResolvedValue(undefined);
	const view = render(
		<PropertyPopover
			label="Status"
			valueText="In progress"
			value="doing"
			options={OPTIONS}
			action="setStatusTo"
			valueParam="status"
			params={{ id: 't1' }}
			onAction={onAction}
			{...extra}
		/>
	);
	return { onAction, ...view };
}

describe('PropertyPopover', () => {
	it('shows a trigger named "label: value" that is closed', () => {
		setup();

		const trigger = screen.getByRole('button', { name: 'Status: In progress' });
		expect(trigger).toHaveAttribute('aria-haspopup', 'listbox');
		expect(trigger).toHaveAttribute('aria-expanded', 'false');
		expect(screen.queryByRole('listbox')).toBeNull();
	});

	it('shows the empty text when there is no value', () => {
		setup({ valueText: '', empty: 'none' });

		expect(screen.getByRole('button', { name: 'Status: none' })).toBeInTheDocument();
	});

	it('colours the pill by tone', () => {
		setup({ tone: 'success' });

		expect(screen.getByTestId('property-popover')).toHaveAttribute('data-tone', 'success');
	});

	it('opens with Enter and with Space, and the current option is the active one', async () => {
		const user = userEvent.setup();
		setup();

		screen.getByRole('button', { name: /Status/ }).focus();
		await user.keyboard('{Enter}');
		const listbox = screen.getByRole('listbox', { name: 'Status' });
		expect(screen.getByRole('button', { name: /Status/ })).toHaveAttribute('aria-expanded', 'true');
		expect(screen.getAllByRole('option')).toHaveLength(3);
		expect(screen.getByRole('option', { name: 'In progress' })).toHaveAttribute('aria-selected', 'true');
		expect(listbox).toHaveAttribute(
			'aria-activedescendant',
			screen.getByRole('option', { name: 'In progress' }).id
		);

		await user.keyboard('{Escape}');
		screen.getByRole('button', { name: /Status/ }).focus();
		await user.keyboard(' ');
		expect(screen.getByRole('listbox')).toBeInTheDocument();
	});

	it('moves with the arrows, Home and End, and picks with Enter: the value travels in the params', async () => {
		const user = userEvent.setup();
		const { onAction } = setup();

		await user.click(screen.getByRole('button', { name: /Status/ }));
		await user.keyboard('{ArrowDown}');
		expect(screen.getByRole('listbox')).toHaveAttribute(
			'aria-activedescendant',
			screen.getByRole('option', { name: 'Done' }).id
		);
		await user.keyboard('{Home}');
		expect(screen.getByRole('listbox')).toHaveAttribute(
			'aria-activedescendant',
			screen.getByRole('option', { name: 'Backlog' }).id
		);
		await user.keyboard('{End}{Enter}');

		await waitFor(() => expect(onAction).toHaveBeenCalledTimes(1));
		expect(onAction).toHaveBeenCalledWith('setStatusTo', { id: 't1', status: 'done' });
	});

	it('sends the value in the body under bodyKey when asked', async () => {
		const user = userEvent.setup();
		const { onAction } = setup({ bodyKey: 'status' });

		await user.click(screen.getByRole('button', { name: /Status/ }));
		await user.click(screen.getByRole('option', { name: 'Done' }));

		expect(onAction).toHaveBeenCalledWith('setStatusTo', { id: 't1' }, { body: { status: 'done' } });
	});

	it('closes only after the action has been awaited, and returns the focus to the trigger', async () => {
		const user = userEvent.setup();
		const pending = deferred<undefined>();
		const onAction = vi.fn().mockReturnValue(pending.promise);
		setup({ onAction });

		await user.click(screen.getByRole('button', { name: /Status/ }));
		await user.click(screen.getByRole('option', { name: 'Done' }));

		expect(screen.getByRole('listbox')).toHaveAttribute('aria-busy', 'true');
		pending.resolve(undefined);
		await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
		expect(screen.getByRole('button', { name: /Status/ })).toHaveFocus();
	});

	it('ignores a second pick while the first runs', async () => {
		const user = userEvent.setup();
		const pending = deferred<undefined>();
		const onAction = vi.fn().mockReturnValue(pending.promise);
		setup({ onAction });

		await user.click(screen.getByRole('button', { name: /Status/ }));
		await user.click(screen.getByRole('option', { name: 'Done' }));
		await user.click(screen.getByRole('option', { name: 'Backlog' }));
		pending.resolve(undefined);

		await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
		expect(onAction).toHaveBeenCalledTimes(1);
	});

	it('picking the current value only closes', async () => {
		const user = userEvent.setup();
		const { onAction } = setup();

		await user.click(screen.getByRole('button', { name: /Status/ }));
		await user.click(screen.getByRole('option', { name: 'In progress' }));

		expect(onAction).not.toHaveBeenCalled();
		expect(screen.queryByRole('listbox')).toBeNull();
	});

	it('stays open when the action fails, so the choice can be retried', async () => {
		const user = userEvent.setup();
		const onAction = vi.fn().mockResolvedValue({ error: 'nope', status: 400 });
		setup({ onAction });

		await user.click(screen.getByRole('button', { name: /Status/ }));
		await user.click(screen.getByRole('option', { name: 'Done' }));

		await waitFor(() => expect(onAction).toHaveBeenCalled());
		expect(screen.getByRole('listbox')).not.toHaveAttribute('aria-busy', 'true');
	});

	it('closes with Escape and gives the focus back to the trigger', async () => {
		const user = userEvent.setup();
		setup();

		await user.click(screen.getByRole('button', { name: /Status/ }));
		await user.keyboard('{Escape}');

		expect(screen.queryByRole('listbox')).toBeNull();
		expect(screen.getByRole('button', { name: /Status/ })).toHaveFocus();
	});

	it('closes on a click outside', async () => {
		const user = userEvent.setup();
		render(<button>elsewhere</button>);
		setup();

		await user.click(screen.getAllByRole('button', { name: /Status/ })[0]!);
		await user.click(screen.getByRole('button', { name: 'elsewhere' }));

		expect(screen.queryByRole('listbox')).toBeNull();
	});

	it('is a sheet below 640px: full-width classes and a backdrop', async () => {
		const user = userEvent.setup();
		setup();

		await user.click(screen.getByRole('button', { name: /Status/ }));

		expect(screen.getByTestId('property-popover-panel').className).toMatch(/max-sm:fixed/);
		expect(screen.getByTestId('property-popover-panel').className).toMatch(/max-sm:inset-x-0/);
		expect(screen.getByTestId('property-popover-backdrop').className).toMatch(/sm:hidden/);
	});

	it('a panel that holds content (a picker) is wide enough for it; a list of choices stays compact', async () => {
		const user = userEvent.setup();
		const { unmount } = render(
			<PropertyPopover label="Parent" valueText="none" items={<span>picker here</span>} />
		);
		await user.click(screen.getByRole('button', { name: 'Parent: none' }));
		expect(screen.getByTestId('property-popover-panel').className).toContain('w-80');
		unmount();

		render(
			<PropertyPopover
				label="Status"
				valueText="todo"
				options={[{ value: 'a', label: 'a' }]}
				action="x"
				onAction={() => undefined}
			/>
		);
		await user.click(screen.getByRole('button', { name: 'Status: todo' }));
		expect(screen.getByTestId('property-popover-panel').className).not.toContain('w-80');
	});

	it('shows the items slot instead of options and closes when a named action finished', async () => {
		const user = userEvent.setup();
		const view = render(
			<PropertyPopover
				label="Parent"
				valueText="none"
				items={<span>picker here</span>}
				closeOnActions={['setParent']}
				actionPending={{ setParent: false }}
			/>
		);

		await user.click(screen.getByRole('button', { name: 'Parent: none' }));
		expect(screen.getByText('picker here')).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Parent: none' })).toHaveAttribute('aria-haspopup', 'dialog');

		view.rerender(
			<PropertyPopover
				label="Parent"
				valueText="none"
				items={<span>picker here</span>}
				closeOnActions={['setParent']}
				actionPending={{ setParent: true }}
			/>
		);
		expect(screen.getByText('picker here')).toBeInTheDocument();
		view.rerender(
			<PropertyPopover
				label="Parent"
				valueText="none"
				items={<span>picker here</span>}
				closeOnActions={['setParent']}
				actionPending={{ setParent: false }}
			/>
		);
		await waitFor(() => expect(screen.queryByText('picker here')).toBeNull());
	});

	it('is disabled with a reason when options have an action but the page gives no handler', () => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		render(<PropertyPopover label="Status" valueText="x" options={OPTIONS} action="a" />);

		expect(screen.getByRole('button', { name: /Status/ })).toBeDisabled();
		expect(error).toHaveBeenCalledTimes(1);
	});

	it('does not open when disabled', async () => {
		const user = userEvent.setup();
		setup({ disabled: true });

		await user.click(screen.getByRole('button', { name: /Status/ }));

		expect(screen.queryByRole('listbox')).toBeNull();
	});
});

describe('PropertyPopover field and button appearances', () => {
	it('field: value and chevron, full width, label only as the accessible name', () => {
		setup({ appearance: 'field' });

		const trigger = screen.getByRole('button', { name: 'Status: In progress' });
		expect(trigger.className).toContain('h-8');
		expect(trigger.className).toContain('w-full');
		expect(trigger.className).toContain('border-transparent');
		expect(trigger.className).toContain('hover:border-border');
		expect(trigger).toHaveTextContent('In progress');
		expect(trigger).not.toHaveTextContent('Status');
		expect(trigger.querySelector('svg')).not.toBeNull();
	});

	it('field with actionLabel: the text replaces the chevron, muted and right aligned', () => {
		setup({ appearance: 'field', actionLabel: 'Edit' });

		const trigger = screen.getByRole('button', { name: 'Status: In progress' });
		expect(trigger.querySelector('svg')).toBeNull();
		const action = screen.getByText('Edit');
		expect(action.className).toContain('text-muted');
		expect(action.className).toContain('ml-auto');
	});

	it('field: the panel aligns left and is at least as wide as the trigger', async () => {
		const user = userEvent.setup();
		setup({ appearance: 'field', options: undefined, items: <span>content</span> });

		await user.click(screen.getByRole('button', { name: 'Status: In progress' }));

		const panel = screen.getByTestId('property-popover-panel');
		expect(panel.className).toContain('left-0');
		expect(panel.className).toContain('min-w-[max(100%,12rem)]');
		expect(panel.className).toContain('w-80');
	});

	// A popover at the right edge of a header (the Actions menu) must open towards the left, or it leaves the screen.
	it('align end: the panel is anchored to the right edge of the trigger', async () => {
		const user = userEvent.setup();
		setup({ align: 'end', options: undefined, items: <span>content</span> });

		await user.click(screen.getByRole('button', { name: 'Status: In progress' }));

		const panel = screen.getByTestId('property-popover-panel');
		expect(panel.className).toContain('right-0');
		expect(panel.className).not.toContain('left-0');
	});

	it('button: tinted by tone, rectangular, px-3 semibold, same height', () => {
		setup({ appearance: 'button', tone: 'success' });

		const trigger = screen.getByRole('button', { name: 'Status: In progress' });
		expect(trigger.className).toContain('h-8');
		expect(trigger.className).toContain('rounded-md');
		expect(trigger.className).not.toContain('rounded-full');
		expect(trigger.className).toContain('px-3');
		expect(trigger.className).toContain('font-semibold');
		expect(trigger.className).toContain('text-success-text');
	});
});
