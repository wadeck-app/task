import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TaskChecklist } from './TaskChecklist.js';

const ROWS = [
	{ id: 't1', title: 'one', status: 'done', terminal: true },
	{ id: 't2', title: 'two', status: 'todo', terminal: false },
];

describe('TaskChecklist progress', () => {
	it('draws a ring by default', () => {
		render(<TaskChecklist rows={ROWS} />);

		expect(screen.getByTestId('progress-summary').querySelector('svg')).not.toBeNull();
	});

	it('bar: a bar with the text "done of total"', () => {
		render(<TaskChecklist rows={ROWS} progress="bar" />);

		const progress = screen.getByTestId('progress-summary');
		expect(progress.querySelector('svg')).toBeNull();
		expect(progress).toHaveTextContent('1 of 2 done');
		expect(screen.getByRole('progressbar')).toBeInTheDocument();
	});

	it('none: no progress at all', () => {
		render(<TaskChecklist rows={ROWS} progress="none" />);

		expect(screen.queryByTestId('progress-summary')).toBeNull();
		expect(screen.getAllByTestId('checklist-row')).toHaveLength(2);
	});

	it('no rows and no emptyText: only the add row', () => {
		const { container } = render(
			<TaskChecklist rows={[]} addAction="addChild" progress="none" onAction={vi.fn()} />
		);

		expect(screen.getByRole('textbox', { name: 'Add sub-task' })).toBeInTheDocument();
		expect(container.querySelector('p')).toBeNull();
		expect(screen.queryByTestId('progress-summary')).toBeNull();
	});
});
