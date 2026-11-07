import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { deferred } from '../testHelpers.js';
import { resetReported } from '../reportOnce.js';
import { TaskChecklist } from './TaskChecklist.js';

afterEach(() => {
	resetReported();
	vi.restoreAllMocks();
});

const ROWS = [
	{
		id: 'aaa11111',
		title: 'Write the spec',
		status: 'done',
		tone: 'success' as const,
		terminal: true,
		href: '/t/aaa',
	},
	{ id: 'bbb22222', title: 'Build it', status: 'in-progress', statusText: 'In progress', terminal: false },
	{ id: 'ccc33333', headline: 'Ship it', title: 'Ship it long', status: 'todo', terminal: false },
];

function setup(extra: Partial<React.ComponentProps<typeof TaskChecklist>> = {}) {
	const onAction = vi.fn().mockResolvedValue(undefined);
	render(
		<TaskChecklist
			rows={ROWS}
			doneAction="setStatusTo"
			reopenAction="setStatusTo"
			terminalStatus="done"
			reopenStatus="todo"
			addAction="createChild"
			parentId="t1"
			params={{ id: 't1', projectParam: 'p1' }}
			onAction={onAction}
			{...extra}
		/>
	);
	return onAction;
}

describe('TaskChecklist', () => {
	it('lists the tasks with id, headline and status, checked when terminal', () => {
		setup();

		expect(screen.getAllByRole('checkbox')).toHaveLength(3);
		expect(screen.getByRole('checkbox', { name: /aaa11111/ })).toBeChecked();
		expect(screen.getByRole('checkbox', { name: /bbb22222/ })).not.toBeChecked();
		expect(screen.getByText('Ship it')).toBeInTheDocument();
		expect(screen.getByText('In progress')).toBeInTheDocument();
		expect(screen.getByRole('link', { name: 'aaa11111' })).toHaveAttribute('href', '/t/aaa');
	});

	it('shows the progress as done of total', () => {
		setup();

		expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '1');
		expect(screen.getByText('1 of 3 done')).toBeInTheDocument();
	});

	it('checking runs doneAction with the row id, the status in params and in the body', async () => {
		const onAction = setup();

		await userEvent.setup().click(screen.getByRole('checkbox', { name: /bbb22222/ }));

		expect(onAction).toHaveBeenCalledWith(
			'setStatusTo',
			{ id: 'bbb22222', projectParam: 'p1', status: 'done' },
			{ body: { status: 'done' } }
		);
	});

	it('unchecking runs reopenAction with reopenStatus', async () => {
		const onAction = setup({ reopenAction: 'reopen' });

		await userEvent.setup().click(screen.getByRole('checkbox', { name: /aaa11111/ }));

		expect(onAction).toHaveBeenCalledWith(
			'reopen',
			{ id: 'aaa11111', projectParam: 'p1', status: 'todo' },
			{ body: { status: 'todo' } }
		);
	});

	it('omits the status on reopen when reopenStatus is not given', async () => {
		const onAction = setup({ reopenStatus: undefined, reopenAction: 'reopen' });

		await userEvent.setup().click(screen.getByRole('checkbox', { name: /aaa11111/ }));

		expect(onAction).toHaveBeenCalledWith('reopen', { id: 'aaa11111', projectParam: 'p1' });
	});

	it('uses idParam and statusParam', async () => {
		const onAction = setup({ idParam: 'taskId', statusParam: 'newStatus' });

		await userEvent.setup().click(screen.getByRole('checkbox', { name: /bbb22222/ }));

		expect(onAction).toHaveBeenCalledWith(
			'setStatusTo',
			{ id: 't1', projectParam: 'p1', taskId: 'bbb22222', newStatus: 'done' },
			{ body: { newStatus: 'done' } }
		);
	});

	it('disables the row being changed, and ignores a second click', async () => {
		const pending = deferred<undefined>();
		const onAction = vi.fn().mockReturnValue(pending.promise);
		render(<TaskChecklist rows={ROWS} doneAction="d" terminalStatus="done" onAction={onAction} />);
		const user = userEvent.setup();
		const box = screen.getByRole('checkbox', { name: /bbb22222/ });

		await user.click(box);
		fireEvent.click(box);

		expect(box).toBeDisabled();
		expect(screen.getByRole('checkbox', { name: /ccc33333/ })).toBeEnabled();
		expect(onAction).toHaveBeenCalledTimes(1);
		pending.resolve(undefined);
		await waitFor(() => expect(box).toBeEnabled());
	});

	it('disables checkboxes without an action', () => {
		render(<TaskChecklist rows={ROWS} />);

		for (const box of screen.getAllByRole('checkbox')) {
			expect(box).toBeDisabled();
		}
	});

	it('shows the empty message with no rows', () => {
		render(<TaskChecklist rows={[]} emptyText="No sub-tasks yet" />);

		expect(screen.getByText('No sub-tasks yet')).toBeInTheDocument();
		expect(screen.queryByRole('progressbar')).toBeNull();
	});

	it('adds a sub-task: Enter sends the title and the parent in the body, then clears the field', async () => {
		const onAction = setup();
		const user = userEvent.setup();
		const input = screen.getByRole('textbox', { name: 'Add sub-task' });

		await user.type(input, 'New step{Enter}');

		await waitFor(() =>
			expect(onAction).toHaveBeenCalledWith(
				'createChild',
				{ id: 't1', projectParam: 'p1' },
				{ body: { description: 'New step', parent: 't1' } }
			)
		);
		await waitFor(() => expect(input).toHaveValue(''));
	});

	it('uses titleKey and parentKey, and omits the parent without parentId', async () => {
		const onAction = setup({ titleKey: 'title', parentKey: 'parentId', parentId: undefined });

		await userEvent.setup().type(screen.getByRole('textbox', { name: 'Add sub-task' }), 'x{Enter}');

		await waitFor(() =>
			expect(onAction).toHaveBeenCalledWith('createChild', expect.anything(), { body: { title: 'x' } })
		);
	});

	it('does nothing for an empty title', async () => {
		const onAction = setup();

		await userEvent.setup().type(screen.getByRole('textbox', { name: 'Add sub-task' }), '   {Enter}');

		expect(onAction).not.toHaveBeenCalled();
	});

	it('keeps the title when the creation fails', async () => {
		const onAction = vi.fn().mockResolvedValue({ error: 'bad', status: 400 });
		setup({ onAction });
		const input = screen.getByRole('textbox', { name: 'Add sub-task' });

		await userEvent.setup().type(input, 'keep me{Enter}');

		await waitFor(() => expect(onAction).toHaveBeenCalled());
		expect(input).toHaveValue('keep me');
	});

	it('creates once when Enter is repeated or followed by a blur while it runs', async () => {
		const pending = deferred<undefined>();
		const onAction = vi.fn().mockReturnValue(pending.promise);
		setup({ onAction, rows: [] });
		const input = screen.getByRole('textbox', { name: 'Add sub-task' });

		fireEvent.change(input, { target: { value: 'once' } });
		fireEvent.keyDown(input, { key: 'Enter' });
		fireEvent.keyDown(input, { key: 'Enter' });
		fireEvent.blur(input);

		expect(onAction).toHaveBeenCalledTimes(1);
		pending.resolve(undefined);
		await waitFor(() => expect(input).toHaveValue(''));
	});

	it('has no add row without addAction', () => {
		render(<TaskChecklist rows={ROWS} doneAction="d" />);

		expect(screen.queryByRole('textbox')).toBeNull();
	});

	it('keeps long headlines on one line with a tooltip', () => {
		render(<TaskChecklist rows={ROWS} />);

		const headline = screen.getByText('Write the spec');
		expect(headline).toHaveClass('truncate');
		expect(headline).toHaveAttribute('title', 'Write the spec');
	});
});
