import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetReported } from '../reportOnce.js';
import { CONTROL_H } from '../ui/tokens.js';
import { StatusSelect } from './StatusSelect.js';
import type { StatusSelectOption } from './StatusSelect.js';

afterEach(() => {
	resetReported();
	vi.restoreAllMocks();
});

const OPTIONS: StatusSelectOption[] = [
	{ value: 'todo', label: 'To do', tone: 'neutral' },
	{ value: 'doing', label: 'In progress', tone: 'info' },
	{ value: 'done', label: 'Done', tone: 'success', terminal: true },
];

function setup(extra: Partial<React.ComponentProps<typeof StatusSelect>> = {}) {
	const onAction = vi.fn().mockResolvedValue(undefined);
	const view = render(
		<StatusSelect
			options={OPTIONS}
			current="doing"
			action="setStatus"
			params={{ id: 't1' }}
			onAction={onAction}
			{...extra}
		/>
	);
	return { onAction, ...view };
}

describe('StatusSelect', () => {
	it('is one compact pill showing the current status, the list of statuses stays hidden', () => {
		setup();

		const pill = screen.getByRole('button', { name: 'Status: In progress' });
		expect(pill).toHaveTextContent('In progress');
		expect(pill.className).toContain(CONTROL_H);
		expect(pill.className).toContain('rounded-full');
		expect(screen.queryByRole('listbox')).toBeNull();
		expect(screen.queryByRole('option')).toBeNull();
	});

	it('is tinted by the tone of the current status', () => {
		setup({ current: 'done' });

		expect(screen.getByTestId('property-popover')).toHaveAttribute('data-tone', 'success');
	});

	it('a negative terminal status (tone danger) is a RED pill and a red dot in the list', async () => {
		const user = userEvent.setup();
		setup({
			current: 'rejected',
			options: [
				...OPTIONS,
				{ value: 'rejected', label: 'rejected', tone: 'danger', terminal: true, outcome: 'negative' },
			],
		});

		const pill = screen.getByRole('button', { name: 'Status: rejected' });
		expect(screen.getByTestId('property-popover')).toHaveAttribute('data-tone', 'danger');
		expect(pill.className).toContain('bg-danger-bg');
		await user.click(pill);
		const dot = screen.getByRole('option', { name: /rejected/ }).querySelector('span[aria-hidden="true"]')!;
		expect(dot.className).toContain('bg-danger');
		expect(screen.getByRole('option', { name: /rejected/ })).not.toHaveTextContent(/terminal/i);
	});

	it('lists the statuses with tone dots only when opened and marks the current one: no word "terminal"', async () => {
		const user = userEvent.setup();
		setup();

		await user.click(screen.getByRole('button', { name: 'Status: In progress' }));

		const options = screen.getAllByRole('option');
		expect(options.map(o => o.textContent)).toEqual(['To do', 'In progress', 'Done']);
		expect(screen.getByRole('option', { name: /In progress/ })).toHaveAttribute('aria-selected', 'true');
	});

	it('picking a status runs the action with the value, in the params by default', async () => {
		const user = userEvent.setup();
		const { onAction } = setup();

		await user.click(screen.getByRole('button', { name: 'Status: In progress' }));
		await user.click(screen.getByRole('option', { name: /Done/ }));

		await waitFor(() => expect(onAction).toHaveBeenCalledWith('setStatus', { id: 't1', status: 'done' }));
		await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
	});

	it('can send the value in the JSON body (bodyKey)', async () => {
		const user = userEvent.setup();
		const { onAction } = setup({ bodyKey: 'status' });

		await user.click(screen.getByRole('button', { name: 'Status: In progress' }));
		await user.click(screen.getByRole('option', { name: /To do/ }));

		await waitFor(() =>
			expect(onAction).toHaveBeenCalledWith('setStatus', { id: 't1' }, { body: { status: 'todo' } })
		);
	});

	it('shows an unknown current value as is, and a custom label', () => {
		setup({ current: 'weird', label: 'Type' });

		expect(screen.getByRole('button', { name: 'Type: weird' })).toBeInTheDocument();
	});

	it('is read-only when there is no action: the pill cannot open', () => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		render(<StatusSelect options={OPTIONS} current="todo" action="" />);

		expect(screen.getByRole('button', { name: 'Status: To do' })).toBeDisabled();
		expect(error).not.toHaveBeenCalled();
	});
});

describe('StatusSelect appearance', () => {
	it('button: a rectangular tinted button of the same height', () => {
		setup({ appearance: 'button' });

		const trigger = screen.getByRole('button', { name: 'Status: In progress' });
		expect(trigger.className).toContain(CONTROL_H);
		expect(trigger.className).toContain('rounded-md');
		expect(trigger.className).not.toContain('rounded-full');
	});
});
