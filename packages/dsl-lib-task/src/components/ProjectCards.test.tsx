import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { SAMPLE } from '../projectTree.fixtures.js';
import { ProjectCards } from './ProjectCards.js';

const names = (): string[] => screen.getAllByTestId('project-card').map(card => card.getAttribute('data-name') ?? '');

describe('ProjectCards', () => {
	it('one card per project: name, summary, progress, last added; the title links to the project tree', () => {
		render(<ProjectCards projects={SAMPLE} />);

		expect(screen.getAllByTestId('project-card')).toHaveLength(4);
		const alpha = screen.getAllByTestId('project-card').find(card => card.getAttribute('data-name') === 'alpha')!;
		expect(within(alpha).getByRole('link', { name: 'alpha' })).toHaveAttribute(
			'href',
			'/modules/task/tree/p/id-alpha'
		);
		expect(alpha).toHaveTextContent('2 open of 4');
		expect(alpha).toHaveTextContent('2026-11-05');
		expect(within(alpha).getByRole('progressbar')).toHaveAttribute('aria-valuenow', '50');
	});

	it('lists the root tasks with their child progress', () => {
		render(<ProjectCards projects={SAMPLE} />);

		const root = screen.getByRole('link', { name: /Alpha root/ });
		expect(root).toHaveAttribute('href', '/modules/task/tasks/p/x/alpha-1');
		expect(root).toHaveTextContent('1/3');
	});

	it('an unreadable project is a card with the reason, an empty one says no tasks', () => {
		render(<ProjectCards projects={SAMPLE} />);

		expect(screen.getByTestId('project-problem')).toHaveTextContent('not valid YAML');
		const empty = screen.getAllByTestId('project-card').find(card => card.getAttribute('data-name') === 'void')!;
		expect(empty).toHaveTextContent('No tasks');
	});

	it('sorts by last added by default, then by name or by open count on request; unreadable stay last', async () => {
		const user = userEvent.setup();
		render(<ProjectCards projects={SAMPLE} />);
		expect(names()).toEqual(['alpha', 'beta', 'void', 'broken']);

		await user.click(screen.getByRole('button', { name: 'Open tasks' }));
		expect(names()).toEqual(['beta', 'alpha', 'void', 'broken']);

		await user.click(screen.getByRole('button', { name: 'Name' }));
		expect(names()).toEqual(['alpha', 'beta', 'void', 'broken']);
	});

	it('the sort prop sets the first order and the pressed button says which is active', () => {
		render(<ProjectCards projects={SAMPLE} sort="open" />);

		expect(names()[0]).toBe('beta');
		expect(screen.getByRole('button', { name: 'Open tasks' })).toHaveAttribute('aria-pressed', 'true');
	});

	it('a new sort prop (the option of the experiment) replaces the order the buttons chose', async () => {
		const user = userEvent.setup();
		const { rerender } = render(<ProjectCards projects={SAMPLE} sort="activity" />);
		await user.click(screen.getByRole('button', { name: 'Name' }));
		expect(screen.getByRole('button', { name: 'Name' })).toHaveAttribute('aria-pressed', 'true');

		rerender(<ProjectCards projects={SAMPLE} sort="open" />);
		expect(screen.getByRole('button', { name: 'Open tasks' })).toHaveAttribute('aria-pressed', 'true');
		expect(names()[0]).toBe('beta');
	});

	it('says what to do when no project is registered', () => {
		render(<ProjectCards projects={[]} />);

		expect(screen.getByTestId('cards-empty')).toHaveTextContent(/project add/);
	});
});
