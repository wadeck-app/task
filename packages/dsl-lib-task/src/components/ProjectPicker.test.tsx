import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { SAMPLE } from '../projectTree.fixtures.js';
import { ProjectPicker } from './ProjectPicker.js';

beforeEach(() => {
	localStorage.clear();
	window.history.replaceState(null, '', '/');
});

describe('ProjectPicker', () => {
	it('starts on the overview: one compact summary row per project, with progress', () => {
		render(<ProjectPicker projects={SAMPLE} />);

		expect(screen.getAllByTestId('picker-overview-row')).toHaveLength(4);
		expect(screen.getByTestId('picker-overview')).toHaveTextContent('2 open of 4');
		expect(screen.getByRole('button', { name: /^broken\b/ })).toHaveTextContent('unreadable');
	});

	it('choosing a row shows that project tree, "All projects" goes back, the choice is in the URL', async () => {
		const user = userEvent.setup();
		render(<ProjectPicker projects={SAMPLE} />);

		await user.click(screen.getByRole('button', { name: /^beta\b/ }));
		expect(screen.getByText('Task beta-1')).toBeInTheDocument();
		expect(window.location.search).toContain('treePicked=id-beta');
		expect(screen.queryByTestId('picker-overview')).toBeNull();

		await user.click(screen.getByRole('button', { name: 'All projects' }));
		expect(screen.getByTestId('picker-overview')).toBeInTheDocument();
		expect(window.location.search).toContain('treePicked=all');
	});

	it('the combobox filters the choices by name and picks with the keyboard', async () => {
		const user = userEvent.setup();
		render(<ProjectPicker projects={SAMPLE} />);

		const box = screen.getByRole('combobox', { name: /project/i });
		await user.type(box, 'bet');
		expect(screen.getAllByRole('option')).toHaveLength(1);
		await user.keyboard('{Enter}');
		expect(screen.getByText('Task beta-1')).toBeInTheDocument();
	});

	it('a combobox filter without match says so', async () => {
		const user = userEvent.setup();
		render(<ProjectPicker projects={SAMPLE} />);

		await user.type(screen.getByRole('combobox'), 'zzz');
		expect(screen.getByTestId('picker-no-match')).toHaveTextContent('zzz');
	});

	it('deep link: the URL parameter opens the project directly', () => {
		window.history.replaceState(null, '', '/?treePicked=id-alpha');
		render(<ProjectPicker projects={SAMPLE} />);

		expect(screen.getByText('Task alpha-1')).toBeInTheDocument();
	});

	it('a deep link to a project that does not exist says so and shows the overview', () => {
		window.history.replaceState(null, '', '/?treePicked=id-gone');
		render(<ProjectPicker projects={SAMPLE} />);

		expect(screen.getByTestId('picker-missing')).toHaveTextContent('id-gone');
		expect(screen.getByTestId('picker-overview')).toBeInTheDocument();
	});

	it('start "first" opens the first readable project when nothing is chosen', () => {
		render(<ProjectPicker projects={SAMPLE} start="first" />);

		expect(screen.getByText('Task alpha-1')).toBeInTheDocument();
	});

	it('an unreadable project chosen shows the reason', async () => {
		const user = userEvent.setup();
		render(<ProjectPicker projects={SAMPLE} />);

		await user.click(screen.getByRole('button', { name: /^broken\b/ }));
		expect(screen.getByTestId('project-problem')).toHaveTextContent('not valid YAML');
	});

	it('says what to do when no project is registered', () => {
		render(<ProjectPicker projects={[]} />);

		expect(screen.getByTestId('picker-empty')).toHaveTextContent(/project add/);
	});
});
