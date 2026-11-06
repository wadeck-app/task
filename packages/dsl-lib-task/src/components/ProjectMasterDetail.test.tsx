import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { SAMPLE } from '../projectTree.fixtures.js';
import { ProjectMasterDetail } from './ProjectMasterDetail.js';

beforeEach(() => {
	localStorage.clear();
	window.history.replaceState(null, '', '/');
});

const option = (name: string): HTMLElement => screen.getByRole('option', { name: new RegExp(`^${name}\\b`) });

describe('ProjectMasterDetail', () => {
	it('lists every project on the left with its counts, unreadable ones flagged', () => {
		render(<ProjectMasterDetail projects={SAMPLE} />);

		expect(screen.getAllByRole('option')).toHaveLength(4);
		expect(option('alpha')).toHaveTextContent('2 open of 4');
		expect(option('broken')).toHaveTextContent('unreadable');
	});

	it('selects the first readable project and shows its tree on the right', () => {
		render(<ProjectMasterDetail projects={SAMPLE} />);

		expect(option('alpha')).toHaveAttribute('aria-selected', 'true');
		expect(within(screen.getByTestId('master-detail-detail')).getByText('Task alpha-1')).toBeInTheDocument();
		expect(screen.getByRole('link', { name: /open the whole tree/i })).toHaveAttribute(
			'href',
			'/modules/task/tree/p/id-alpha'
		);
	});

	it('choosing another project shows its tree and remembers the choice', async () => {
		const user = userEvent.setup();
		const first = render(<ProjectMasterDetail projects={SAMPLE} />);

		await user.click(option('beta'));
		expect(screen.getByText('Task beta-1')).toBeInTheDocument();
		expect(screen.queryByText('Task alpha-1')).toBeNull();
		expect(window.location.search).toContain('treeProject=id-beta');
		first.unmount();

		render(<ProjectMasterDetail projects={SAMPLE} />);
		expect(option('beta')).toHaveAttribute('aria-selected', 'true');
	});

	it('the URL parameter wins over the remembered choice', () => {
		localStorage.setItem('task.tree.selected', 'id-alpha');
		window.history.replaceState(null, '', '/?treeProject=id-beta');
		render(<ProjectMasterDetail projects={SAMPLE} />);

		expect(option('beta')).toHaveAttribute('aria-selected', 'true');
	});

	it('a remembered project that is gone says so instead of silently showing another', () => {
		localStorage.setItem('task.tree.selected', 'id-gone');
		render(<ProjectMasterDetail projects={SAMPLE} />);

		expect(screen.getByTestId('master-detail-missing')).toHaveTextContent('id-gone');
		expect(option('alpha')).toHaveAttribute('aria-selected', 'true');
	});

	it('the arrow keys move the selection in the list', async () => {
		const user = userEvent.setup();
		render(<ProjectMasterDetail projects={SAMPLE} />);

		option('alpha').focus();
		await user.keyboard('{ArrowDown}');
		expect(option('beta')).toHaveAttribute('aria-selected', 'true');
		await user.keyboard('{ArrowUp}');
		expect(option('alpha')).toHaveAttribute('aria-selected', 'true');
	});

	it('the search narrows the list; the selected project stays selected when filtered out', async () => {
		const user = userEvent.setup();
		render(<ProjectMasterDetail projects={SAMPLE} />);

		await user.type(screen.getByRole('searchbox', { name: /search projects/i }), 'be');
		expect(screen.getAllByRole('option')).toHaveLength(1);
		expect(screen.getByText('Task alpha-1')).toBeInTheDocument();
	});

	it('an unreadable project selected shows the reason and the fix', async () => {
		const user = userEvent.setup();
		render(<ProjectMasterDetail projects={SAMPLE} />);

		await user.click(option('broken'));
		expect(screen.getByTestId('project-problem')).toHaveTextContent('not valid YAML');
	});

	it('only unreadable projects: the first one is shown with its problem', () => {
		render(<ProjectMasterDetail projects={[SAMPLE[2]!]} />);

		expect(screen.getByTestId('project-problem')).toBeInTheDocument();
	});

	it('says what to do when no project is registered', () => {
		render(<ProjectMasterDetail projects={[]} />);

		expect(screen.getByTestId('master-detail-empty')).toHaveTextContent(/project add/);
	});
});
