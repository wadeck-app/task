import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { TaskRowList } from './TaskRowList.js';

const ROWS = [
	{
		id: 'ab12cd34',
		title: 'First task',
		status: 'done',
		tone: 'success' as const,
		href: '/modules/task/tasks/p/x/ab12cd34',
	},
	{ id: 'ef56gh78', title: 'A very long title '.repeat(10), titleText: 'A very long title...', status: 'todo' },
];

describe('TaskRowList', () => {
	it('shows one row per task with its id, title and status', () => {
		render(<TaskRowList rows={ROWS} />);

		expect(screen.getAllByTestId('task-row')).toHaveLength(2);
		expect(screen.getByText('ab12cd34')).toHaveClass('font-mono', 'whitespace-nowrap');
		expect(screen.getByText('First task')).toBeInTheDocument();
		expect(screen.getByText('done')).toBeInTheDocument();
	});

	it('links a row that has an href and leaves the others as plain rows', () => {
		render(<TaskRowList rows={ROWS} />);

		const rows = screen.getAllByTestId('task-row');
		expect(rows[0]!.querySelector('a')).toHaveAttribute('href', '/modules/task/tasks/p/x/ab12cd34');
		expect(rows[1]!.querySelector('a')).toBeNull();
	});

	it('truncates a long title to titleText and keeps the full title as the tooltip', () => {
		render(<TaskRowList rows={ROWS} />);

		const shown = screen.getByText('A very long title...');
		expect(shown).toHaveClass('truncate');
		expect(shown).toHaveAttribute('title', ROWS[1]!.title);
	});

	it('hides the id and the status on request', () => {
		render(<TaskRowList rows={ROWS} showId={false} showStatus={false} />);

		expect(screen.queryByText('ab12cd34')).toBeNull();
		expect(screen.queryByText('done')).toBeNull();
	});

	it('says so when there is no row', () => {
		render(<TaskRowList rows={[]} emptyText="No children" />);

		expect(screen.getByText('No children')).toBeInTheDocument();
	});

	it('shows the first maxRows and how many are left out', () => {
		const many = Array.from({ length: 5 }, (_, i) => ({ id: `id${i}`, title: `T${i}`, status: 'todo' }));
		render(<TaskRowList rows={many} maxRows={2} />);

		expect(screen.getAllByTestId('task-row')).toHaveLength(2);
		expect(screen.getByText('+3 more')).toBeInTheDocument();
	});

	it('takes its container from appearance', () => {
		const { rerender } = render(<TaskRowList rows={ROWS} />);
		expect(screen.getByTestId('task-row-list')).toHaveAttribute('data-appearance', 'list');

		rerender(<TaskRowList rows={ROWS} appearance="table" />);
		expect(screen.getByTestId('task-row-list')).toHaveAttribute('data-appearance', 'table');

		rerender(<TaskRowList rows={ROWS} appearance="cards" />);
		expect(screen.getByTestId('task-row-list')).toHaveAttribute('data-appearance', 'cards');
	});

	it('draws the meta text of a row', () => {
		render(<TaskRowList rows={[{ id: 'a', title: 'T', status: 'todo', meta: 'blocks 2' }]} />);

		expect(screen.getByText('blocks 2')).toBeInTheDocument();
	});

	describe('removeAction (a button per row, beside the link, never inside it)', () => {
		const withParams = [
			{ ...ROWS[0]!, removeParams: { id: 'holder', type: 'blockedBy', target: 'ab12cd34' } },
			{ id: 'gone0001', title: 'missing task gone0001', status: 'missing', removeParams: { target: 'gone0001' } },
		];

		it('draws no button without removeAction, whatever the rows carry', () => {
			render(<TaskRowList rows={withParams} />);

			expect(screen.queryAllByRole('button')).toHaveLength(0);
		});

		it('runs the action with the params of the clicked row, and keeps the task link a separate element', async () => {
			const onAction = vi.fn().mockResolvedValue(undefined);
			render(<TaskRowList rows={withParams} removeAction="removeLinkRow" onAction={onAction} />);

			const buttons = screen.getAllByRole('button', { name: /^Remove link/ });
			expect(buttons).toHaveLength(2);
			expect(buttons[0]!.closest('a')).toBeNull();
			await userEvent.click(buttons[0]!);

			expect(onAction).toHaveBeenCalledTimes(1);
			expect(onAction).toHaveBeenCalledWith('removeLinkRow', {
				id: 'holder',
				type: 'blockedBy',
				target: 'ab12cd34',
			});
		});

		it('names the row in the button label so a screen reader tells them apart', () => {
			render(<TaskRowList rows={withParams} removeAction="removeLinkRow" onAction={vi.fn()} />);

			expect(screen.getByRole('button', { name: 'Remove link ab12cd34' })).toBeInTheDocument();
			expect(screen.getByRole('button', { name: 'Remove link gone0001' })).toBeInTheDocument();
		});

		it('disables the buttons, with the reason, when no page provides onAction', () => {
			render(<TaskRowList rows={withParams} removeAction="removeLinkRow" />);

			const button = screen.getByRole('button', { name: 'Remove link ab12cd34' });
			expect(button).toBeDisabled();
			expect(button).toHaveAttribute('title', expect.stringContaining('must be rendered inside a page'));
		});

		it('omits the button of a row that has no removeParams', () => {
			render(<TaskRowList rows={[ROWS[1]!, withParams[0]!]} removeAction="r" onAction={vi.fn()} />);

			expect(screen.getAllByRole('button')).toHaveLength(1);
		});
	});
});

describe('TaskRowList in a narrow column', () => {
	const rows = [{ id: 'dyj503et', title: 'Fix login redirect', status: 'in-progress', href: '/x/dyj503et' }];

	// Seen in the github-b design at 390 px: id, status chip and remove button took the whole row and the title was cut to "F".
	it('wraps the row instead of squeezing the title: the title keeps a minimum width and the row may wrap', () => {
		render(<TaskRowList rows={rows} />);

		const row = screen.getByRole('link');
		expect(row).toHaveClass('flex-wrap');
		expect(screen.getByText('Fix login redirect')).toHaveClass('min-w-[6rem]');
	});

	it('keeps the title on one truncated line when it is long', () => {
		render(<TaskRowList rows={rows} />);

		expect(screen.getByText('Fix login redirect')).toHaveClass('truncate');
	});
});
