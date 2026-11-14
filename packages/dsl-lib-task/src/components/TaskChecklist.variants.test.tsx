import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { CONTROL_H } from '../ui/tokens.js';
import { TaskChecklist } from './TaskChecklist.js';

const ROWS = [
	{ id: 'aaa11111', title: 'Write the spec', status: 'done', tone: 'success' as const, terminal: true },
	{ id: 'bbb22222', title: 'Build it', status: 'todo', terminal: false, href: '/t/bbb' },
];

function setup(extra: Partial<React.ComponentProps<typeof TaskChecklist>> = {}) {
	const onAction = vi.fn().mockResolvedValue(undefined);
	render(
		<TaskChecklist
			rows={ROWS}
			doneAction="setChildStatus"
			terminalStatus="done"
			reopenStatus="todo"
			addAction="createSubtask"
			detachAction="detachChild"
			parentId="p1"
			params={{ id: 'p1', projectParam: 'proj' }}
			onAction={onAction}
			{...extra}
		/>
	);
	return onAction;
}

describe('TaskChecklist detach', () => {
	it('every row has an icon button "Detach from parent" that runs the action with the id of THAT row', async () => {
		const onAction = setup();

		const buttons = screen.getAllByTestId('checklist-detach');
		expect(buttons).toHaveLength(2);
		expect(buttons[1]).toHaveAttribute('title', 'Detach from parent');
		expect(buttons[1]).toHaveAccessibleName('Detach from parent bbb22222');
		expect(buttons[1]!.className).toContain('h-8');
		expect(buttons[1]!.querySelector('svg')).not.toBeNull();
		await userEvent.setup().click(buttons[1]!);

		await waitFor(() =>
			expect(onAction).toHaveBeenCalledWith('detachChild', { id: 'bbb22222', projectParam: 'proj' })
		);
		expect(onAction).toHaveBeenCalledTimes(1);
	});

	it('detachIdParam names the parameter that carries the row id (a page whose own task is {id} uses another name)', async () => {
		const onAction = setup({ detachIdParam: 'childId' });

		await userEvent.setup().click(screen.getAllByTestId('checklist-detach')[1]!);

		await waitFor(() =>
			expect(onAction).toHaveBeenCalledWith('detachChild', {
				id: 'p1',
				projectParam: 'proj',
				childId: 'bbb22222',
			})
		);
	});

	it('has no button without detachAction', () => {
		setup({ detachAction: undefined });

		expect(screen.queryByTestId('checklist-detach')).toBeNull();
	});

	it('the detach label is configurable', () => {
		setup({ detachLabel: 'Remove from epic' });

		expect(screen.getAllByTestId('checklist-detach')[0]).toHaveAttribute('title', 'Remove from epic');
	});

	it('is disabled without a page (no onAction), with the reason as the tooltip', () => {
		render(<TaskChecklist rows={ROWS} detachAction="detachChild" />);

		const button = screen.getAllByTestId('checklist-detach')[0]!;
		expect(button).toBeDisabled();
		expect(button.getAttribute('title')).toMatch(/page/);
	});
});

describe('TaskChecklist add row', () => {
	it('the add field is the LAST row of the list, with a plus icon, same row height as the others', async () => {
		const onAction = setup();

		const rows = screen.getAllByTestId('checklist-row');
		const last = screen.getByTestId('checklist-add-row');
		expect(last.previousElementSibling).toBe(rows[rows.length - 1]);
		expect(last.querySelector('svg')).not.toBeNull();
		const input = within(last).getByRole('textbox', { name: 'Add sub-task' });
		expect(input.className).toContain(CONTROL_H);

		await userEvent.setup().type(input, 'Next{Enter}');

		await waitFor(() =>
			expect(onAction).toHaveBeenCalledWith(
				'createSubtask',
				{ id: 'p1', projectParam: 'proj' },
				{ body: { description: 'Next', parent: 'p1' } }
			)
		);
	});

	it('with no sub-task: the add row alone', () => {
		setup({ rows: [] });

		expect(screen.getByTestId('checklist-add-row')).toBeInTheDocument();
		expect(screen.queryAllByTestId('checklist-row')).toHaveLength(0);
	});
});
