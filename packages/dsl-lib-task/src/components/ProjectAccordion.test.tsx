import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { SAMPLE } from '../projectTree.fixtures.js';
import { ProjectAccordion } from './ProjectAccordion.js';

beforeEach(() => localStorage.clear());

const header = (name: string): HTMLElement => screen.getByRole('button', { name: new RegExp(`^${name}\\b`) });
const openHeaders = (): HTMLElement[] =>
	screen
		.queryAllByRole('button', { expanded: true })
		.filter(button => button.getAttribute('data-testid') === 'accordion-header');

describe('ProjectAccordion', () => {
	it('lists every project on one line: name, summary; an unreadable one is flagged, an empty one is not expandable', () => {
		render(<ProjectAccordion projects={SAMPLE} />);

		expect(screen.getAllByTestId('accordion-item')).toHaveLength(4);
		expect(header('alpha')).toHaveTextContent('2 open of 4');
		expect(header('broken')).toHaveTextContent('cannot be read');
		const kind = (name: string): HTMLElement =>
			screen.getAllByTestId('accordion-item').find(item => item.dataset['kind'] === name)!;
		expect(kind('flagged')).toHaveTextContent('broken');
		const empty = kind('empty');
		expect(empty).toHaveTextContent('void');
		expect(empty).toHaveTextContent('No tasks');
		expect(within(empty).queryByRole('button')).toBeNull();
	});

	it('opens nothing at the first visit: dozens of projects must not start with one wall of rows', () => {
		render(<ProjectAccordion projects={SAMPLE} />);

		expect(openHeaders()).toHaveLength(0);
		expect(screen.queryByText('Task alpha-1')).toBeNull();
	});

	it('only an open project renders its rows', async () => {
		const user = userEvent.setup();
		render(<ProjectAccordion projects={SAMPLE} />);

		await user.click(header('alpha'));
		expect(screen.getByText('Task alpha-1')).toBeInTheDocument();
		expect(screen.queryByText('Task beta-1')).toBeNull();
	});

	it('reopens the project opened last time, and only that one', async () => {
		const user = userEvent.setup();
		const first = render(<ProjectAccordion projects={SAMPLE} />);
		await user.click(header('alpha'));
		await user.click(header('beta'));
		first.unmount();

		render(<ProjectAccordion projects={SAMPLE} />);
		expect(header('beta')).toHaveAttribute('aria-expanded', 'true');
		expect(header('alpha')).toHaveAttribute('aria-expanded', 'false');
	});

	it('a remembered project that no longer exists opens nothing (no guess)', () => {
		localStorage.setItem('task.tree.accordion.last', 'gone');
		render(<ProjectAccordion projects={SAMPLE} />);

		expect(openHeaders()).toHaveLength(0);
	});

	it('closing the remembered project is kept for the visit but does not forget which one was opened last', async () => {
		const user = userEvent.setup();
		localStorage.setItem('task.tree.accordion.last', 'id-alpha');
		render(<ProjectAccordion projects={SAMPLE} />);
		expect(header('alpha')).toHaveAttribute('aria-expanded', 'true');

		await user.click(header('alpha'));
		expect(header('alpha')).toHaveAttribute('aria-expanded', 'false');
		expect(localStorage.getItem('task.tree.accordion.last')).toBe('id-alpha');
	});

	it('an unreadable project, once open, shows why and the fix', async () => {
		const user = userEvent.setup();
		render(<ProjectAccordion projects={SAMPLE} />);

		await user.click(header('broken'));
		expect(screen.getByTestId('project-problem')).toHaveTextContent('not valid YAML');
	});

	it('the filter keeps the projects whose name matches and says so when none does', async () => {
		const user = userEvent.setup();
		render(<ProjectAccordion projects={SAMPLE} />);

		await user.type(screen.getByRole('searchbox', { name: /filter projects/i }), 'BET');
		expect(screen.getAllByTestId('accordion-item')).toHaveLength(1);
		expect(screen.getByText('1 of 4 projects')).toBeInTheDocument();

		await user.clear(screen.getByRole('searchbox'));
		await user.type(screen.getByRole('searchbox'), 'zzz');
		expect(screen.queryAllByTestId('accordion-item')).toHaveLength(0);
		expect(screen.getByTestId('accordion-no-match')).toHaveTextContent('zzz');
	});

	it('expand all opens every project with something to show (the unreadable ones included), collapse all closes them', async () => {
		const user = userEvent.setup();
		render(<ProjectAccordion projects={SAMPLE} />);

		await user.click(screen.getByRole('button', { name: 'Expand all' }));
		expect(header('alpha')).toHaveAttribute('aria-expanded', 'true');
		expect(header('beta')).toHaveAttribute('aria-expanded', 'true');
		expect(header('broken')).toHaveAttribute('aria-expanded', 'true');

		await user.click(screen.getByRole('button', { name: 'Collapse all' }));
		expect(openHeaders()).toHaveLength(0);
	});

	it('links every row to its task and the "more" line to the project tree', async () => {
		const user = userEvent.setup();
		localStorage.setItem('task.tree.accordion.last', 'id-alpha');
		const projects = [{ ...SAMPLE[0]!, hiddenCount: 5, moreText: '5 more tasks: open the tree of alpha' }];
		render(<ProjectAccordion projects={projects} />);

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
