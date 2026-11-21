import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AbExperiments } from '@wadeck-app/dsl-ui';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sampleColumns, sortedColumns, sortedLayout } from '../kanban/boardFixtures.js';
import { FakeEventSource, jsonResponse, stubFetch } from '../testHelpers.js';
import { KanbanBoard } from './KanbanBoard.js';

// The one A/B row of the board (the sort control) lives in the shell's shared dock (dsl-ui `AbExperiments`), never in a dock
// of the board. The layout and the group style rows were decided (D24: columns, pill) and are gone.

const SORT_ROW = 'Board columns: sort control';

beforeEach(() => {
	FakeEventSource.reset();
	vi.stubGlobal('EventSource', FakeEventSource);
	window.localStorage.clear();
	stubFetch(() => jsonResponse({ columns: sortedColumns(), version: 's1' }));
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	window.localStorage.clear();
});

function board(extra: Partial<React.ComponentProps<typeof KanbanBoard>> = {}): React.ReactElement {
	return (
		<KanbanBoard
			columns={sortedColumns()}
			config={{ isDefault: false, columns: sortedLayout().columns }}
			allStatuses={sortedLayout().allStatuses}
			version="s1"
			projectParam="p1"
			apiBase="/api/modules/task"
			{...extra}
		/>
	);
}

const root = (): HTMLElement => screen.getByTestId('kanban-board');
const row = (label: string): HTMLElement => screen.getByRole('group', { name: label });
const options = (label: string): string[] =>
	within(row(label))
		.getAllByRole('button')
		.map(button => button.textContent ?? '');

describe('KanbanBoard A/B row in the shared dock', () => {
	it('registers ONE row, the sort control, with its five options and the initial one pressed', () => {
		render(<AbExperiments enabled>{board()}</AbExperiments>);

		expect(options(SORT_ROW)).toEqual(['Header menu', 'Toolbar select', 'Chips', 'Editor only', 'Segmented']);
		expect(within(row(SORT_ROW)).getByRole('button', { name: 'Header menu' })).toHaveAttribute(
			'aria-pressed',
			'true'
		);
		expect(screen.queryByRole('group', { name: 'Board layout' })).toBeNull();
		expect(screen.queryByRole('group', { name: 'Board columns: group style' })).toBeNull();
	});

	it('the board has no layout and no group style attribute: one layout, one group style', () => {
		render(<AbExperiments enabled>{board()}</AbExperiments>);

		expect(root()).not.toHaveAttribute('data-variant');
		expect(root()).not.toHaveAttribute('data-group-style');
	});

	it('the board draws no dock of its own and leaves no room for one', () => {
		render(<AbExperiments enabled>{board()}</AbExperiments>);

		expect(screen.queryByRole('toolbar', { name: 'Kanban variant' })).toBeNull();
		expect(screen.queryByRole('toolbar', { name: /sort and groups/ })).toBeNull();
		expect(root().className).not.toMatch(/\bpb-/);
	});

	it('a pick switches live and is kept for the next mount (through useAbTest)', async () => {
		const user = userEvent.setup();
		const first = render(<AbExperiments enabled>{board()}</AbExperiments>);

		await user.click(within(row(SORT_ROW)).getByRole('button', { name: 'Chips' }));

		expect(root()).toHaveAttribute('data-sort-variant', 'chips');
		first.unmount();

		render(<AbExperiments enabled>{board()}</AbExperiments>);
		expect(root()).toHaveAttribute('data-sort-variant', 'chips');
	});

	it('a choice stored by an older build for the removed rows changes nothing', () => {
		window.localStorage.setItem('ab.board-layout', 'tabs');
		window.localStorage.setItem('ab.board-group-style', 'boxed');
		render(<AbExperiments enabled>{board()}</AbExperiments>);

		expect(screen.queryByRole('tablist')).toBeNull();
		expect(screen.getByTestId('kanban-column-Doing')).toBeInTheDocument();
		expect(screen.queryAllByTestId('kanban-group')).toHaveLength(0);
	});

	it('without a host dock nothing crashes, no row is shown and the initial value applies (a stored choice is not used)', () => {
		window.localStorage.setItem('ab.board-sort-control', 'chips');
		render(board());

		expect(root()).toHaveAttribute('data-sort-variant', 'header-menu');
		expect(screen.queryByRole('group', { name: SORT_ROW })).toBeNull();
	});

	it('with the host dock turned off (shell without --ab-tests) the initial value applies too', () => {
		window.localStorage.setItem('ab.board-sort-control', 'chips');
		render(<AbExperiments enabled={false}>{board()}</AbExperiments>);

		expect(root()).toHaveAttribute('data-sort-variant', 'header-menu');
		expect(screen.queryByRole('group', { name: SORT_ROW })).toBeNull();
	});

	it('the abSwitcher of an older answer is ignored: no private bar', async () => {
		stubFetch(() => jsonResponse({ columns: sampleColumns(), version: 'v1', abSwitcher: true }));
		render(<KanbanBoard projectParam="p1" apiBase="/api/modules/task" />);

		await screen.findByTestId('kanban-column-todo');
		expect(screen.queryByRole('toolbar')).toBeNull();
	});
});
