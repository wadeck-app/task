import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
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
});
