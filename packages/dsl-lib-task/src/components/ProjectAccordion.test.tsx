import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { SAMPLE } from '../projectTree.fixtures.js';
import { ProjectAccordion } from './ProjectAccordion.js';

beforeEach(() => localStorage.clear());

const header = (name: string): HTMLElement => screen.getByRole('button', { name: new RegExp(`^${name}\\b`) });

describe('ProjectAccordion', () => {
	it('shows one header per project with its name and summary, unreadable ones flagged', () => {
		render(<ProjectAccordion projects={SAMPLE} defaultOpen="none" />);

		expect(screen.getAllByTestId('accordion-item')).toHaveLength(4);
		expect(header('alpha')).toHaveTextContent('2 open of 4');
		expect(header('broken')).toHaveTextContent('unreadable');
		expect(header('void')).toHaveTextContent('No tasks');
	});

	it('defaultOpen "first" opens only the first project, "none" opens nothing', () => {
		const { unmount } = render(<ProjectAccordion projects={SAMPLE} defaultOpen="first" />);
		expect(header('alpha')).toHaveAttribute('aria-expanded', 'true');
		expect(header('beta')).toHaveAttribute('aria-expanded', 'false');
		unmount();

		render(<ProjectAccordion projects={SAMPLE} defaultOpen="none" />);
		expect(
			screen
				.queryAllByRole('button', { expanded: true })
				.filter(b => b.getAttribute('data-testid') === 'accordion-header')
		).toHaveLength(0);
	});

	it('only the open project renders its rows', async () => {
		const user = userEvent.setup();
		render(<ProjectAccordion projects={SAMPLE} defaultOpen="none" />);
		expect(screen.queryByText('Task alpha-1')).toBeNull();

		await user.click(header('alpha'));
		expect(screen.getByText('Task alpha-1')).toBeInTheDocument();
		expect(screen.queryByText('Task beta-1')).toBeNull();
	});

	it('"last" reopens the project opened last time, else the first one', async () => {
		const user = userEvent.setup();
		const first = render(<ProjectAccordion projects={SAMPLE} defaultOpen="last" />);
		expect(header('alpha')).toHaveAttribute('aria-expanded', 'true');

		await user.click(header('beta'));
		first.unmount();

		render(<ProjectAccordion projects={SAMPLE} defaultOpen="last" />);
		expect(header('beta')).toHaveAttribute('aria-expanded', 'true');
		expect(header('alpha')).toHaveAttribute('aria-expanded', 'false');
	});

	it('a remembered project that no longer exists falls back to the first one', () => {
		localStorage.setItem('task.tree.accordion.last', 'gone');
		render(<ProjectAccordion projects={SAMPLE} defaultOpen="last" />);

		expect(header('alpha')).toHaveAttribute('aria-expanded', 'true');
	});

	it('a new defaultOpen (the option of the experiment) starts over', () => {
		const { rerender } = render(<ProjectAccordion projects={SAMPLE} defaultOpen="first" />);
		expect(header('alpha')).toHaveAttribute('aria-expanded', 'true');

		rerender(<ProjectAccordion projects={SAMPLE} defaultOpen="none" />);
		expect(header('alpha')).toHaveAttribute('aria-expanded', 'false');
	});

	it('an unreadable project, once open, shows why and the fix', async () => {
		const user = userEvent.setup();
		render(<ProjectAccordion projects={SAMPLE} defaultOpen="none" />);

		await user.click(header('broken'));
		expect(screen.getByTestId('project-problem')).toHaveTextContent('not valid YAML');
	});

	it('an empty project says so when opened', async () => {
		const user = userEvent.setup();
		render(<ProjectAccordion projects={SAMPLE} defaultOpen="none" />);

		await user.click(header('void'));
		expect(screen.getByTestId('project-empty')).toHaveTextContent('No tasks');
	});

	it('the filter keeps the projects whose name matches and says so when none does', async () => {
		const user = userEvent.setup();
		render(<ProjectAccordion projects={SAMPLE} defaultOpen="none" />);

		await user.type(screen.getByRole('searchbox', { name: /filter projects/i }), 'BET');
		expect(screen.getAllByTestId('accordion-item')).toHaveLength(1);

		await user.clear(screen.getByRole('searchbox'));
		await user.type(screen.getByRole('searchbox'), 'zzz');
		expect(screen.queryAllByTestId('accordion-item')).toHaveLength(0);
		expect(screen.getByTestId('accordion-no-match')).toHaveTextContent('zzz');
	});

	it('expand all opens every readable project shown, collapse all closes them', async () => {
		const user = userEvent.setup();
		render(<ProjectAccordion projects={SAMPLE} defaultOpen="none" />);

		await user.click(screen.getByRole('button', { name: 'Expand all' }));
		expect(header('alpha')).toHaveAttribute('aria-expanded', 'true');
		expect(header('beta')).toHaveAttribute('aria-expanded', 'true');

		await user.click(screen.getByRole('button', { name: 'Collapse all' }));
		expect(header('alpha')).toHaveAttribute('aria-expanded', 'false');
	});

	it('links every row to its task and the "more" line to the project tree', async () => {
		const user = userEvent.setup();
		const projects = [{ ...SAMPLE[0]!, hiddenCount: 5, moreText: '5 more tasks: open the tree of alpha' }];
		render(<ProjectAccordion projects={projects} defaultOpen="first" />);

		const item = screen.getByTestId('accordion-item');
		expect(within(item).getByText('Task alpha-1').closest('a')).toHaveAttribute(
			'href',
			'/modules/task/tasks/p/x/alpha-1'
		);
		expect(within(item).getByText(/5 more tasks/)).toHaveAttribute('href', '/modules/task/tree/p/id-alpha');
		await user.click(header('alpha'));
		expect(header('alpha')).toHaveAttribute('aria-expanded', 'false');
	});

	it('says what to do when no project is registered', () => {
		render(<ProjectAccordion projects={[]} />);

		expect(screen.getByTestId('accordion-empty')).toHaveTextContent(/project add/);
	});
});
