import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { project, row, SAMPLE } from '../projectTree.fixtures.js';
import { ProjectFlatTree } from './ProjectFlatTree.js';

const many = (name: string, count: number) =>
	project(name, { rows: Array.from({ length: count }, (_, i) => row(`${name}-${i}`, 0)), rowCount: count });

describe('ProjectFlatTree', () => {
	it('one list: a sticky header per project, then its rows with the project column', () => {
		render(<ProjectFlatTree projects={SAMPLE} />);

		const headers = screen.getAllByTestId('flat-group-header');
		expect(headers).toHaveLength(4);
		expect(headers[0]).toHaveClass('sticky');
		expect(headers[0]).toHaveTextContent('alpha');
		expect(screen.getAllByTestId('flat-row')[0]).toHaveTextContent('alpha');
	});

	it('shows at most rowsPerProject rows of a project, then a "N more" link to its tree', () => {
		render(<ProjectFlatTree projects={[many('big', 12)]} rowsPerProject={5} />);

		expect(screen.getAllByTestId('flat-row')).toHaveLength(5);
		expect(screen.getByRole('link', { name: /7 more/ })).toHaveAttribute('href', '/modules/task/tree/p/id-big');
	});

	it('counts the rows the route left out too in the "N more" link', () => {
		const capped = { ...many('big', 5), rowCount: 100, hiddenCount: 95 };
		render(<ProjectFlatTree projects={[capped]} rowsPerProject={5} />);

		expect(screen.getByRole('link', { name: /95 more/ })).toBeInTheDocument();
	});

	it('the project filter narrows the groups and says so when none matches', async () => {
		const user = userEvent.setup();
		render(<ProjectFlatTree projects={SAMPLE} />);

		await user.type(screen.getByRole('searchbox', { name: /filter by project/i }), 'beta');
		expect(screen.getAllByTestId('flat-group-header')).toHaveLength(1);

		await user.clear(screen.getByRole('searchbox'));
		await user.type(screen.getByRole('searchbox'), 'zzz');
		expect(screen.getByTestId('flat-no-match')).toHaveTextContent('zzz');
	});

	it('the status filter keeps the rows with that status and hides groups left without a row', async () => {
		const user = userEvent.setup();
		const mixed = project('mixed', { rows: [row('m1', 0, 'backlog'), row('m2', 0, 'done')] });
		const onlyOpen = project('onlyopen', { rows: [row('o1', 0, 'backlog')] });
		render(<ProjectFlatTree projects={[mixed, onlyOpen]} />);

		await user.selectOptions(screen.getByRole('combobox', { name: /status/i }), 'done');
		expect(screen.getAllByTestId('flat-row')).toHaveLength(1);
		expect(screen.getAllByTestId('flat-group-header')).toHaveLength(1);
		expect(screen.getByTestId('flat-row')).toHaveTextContent('m2');
	});

	it('an unreadable project keeps its header and shows its problem; an empty one says no tasks', () => {
		render(<ProjectFlatTree projects={SAMPLE} />);

		expect(screen.getByTestId('project-problem')).toHaveTextContent('not valid YAML');
		expect(screen.getByTestId('flat-empty-group')).toHaveTextContent('No tasks');
	});

	it('caps the number of projects drawn and loads the next ones on request', async () => {
		const user = userEvent.setup();
		const projects = Array.from({ length: 7 }, (_, i) => many(`p${i}`, 1));
		render(<ProjectFlatTree projects={projects} projectsPerPage={3} />);

		expect(screen.getAllByTestId('flat-group-header')).toHaveLength(3);
		expect(screen.getByTestId('flat-page-note')).toHaveTextContent('3 of 7');
		await user.click(screen.getByRole('button', { name: /show more projects/i }));
		expect(screen.getAllByTestId('flat-group-header')).toHaveLength(6);
		await user.click(screen.getByRole('button', { name: /show more projects/i }));
		expect(screen.getAllByTestId('flat-group-header')).toHaveLength(7);
		expect(screen.queryByRole('button', { name: /show more projects/i })).toBeNull();
	});

	it('a filter applies before the cap on projects', async () => {
		const user = userEvent.setup();
		const projects = Array.from({ length: 7 }, (_, i) => many(`p${i}`, 1));
		render(<ProjectFlatTree projects={projects} projectsPerPage={3} />);

		await user.type(screen.getByRole('searchbox'), 'p6');
		const group = screen.getAllByTestId('flat-group-header');
		expect(group).toHaveLength(1);
		expect(within(group[0]!).getByText('p6')).toBeInTheDocument();
	});

	it('says what to do when no project is registered', () => {
		render(<ProjectFlatTree projects={[]} />);

		expect(screen.getByTestId('flat-empty')).toHaveTextContent(/project add/);
	});
});
