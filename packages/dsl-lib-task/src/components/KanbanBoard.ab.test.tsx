import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AbExperiments } from '@wadeck-app/dsl-ui';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sampleColumns, sortedColumns, sortedLayout } from '../kanban/boardFixtures.js';
import { FakeEventSource, jsonResponse, stubFetch } from '../testHelpers.js';
import { KanbanBoard } from './KanbanBoard.js';

// The three A/B rows of the board live in the shell's shared dock (dsl-ui `AbExperiments`), never in a dock of the board.

const LAYOUT_ROW = 'Board layout';
const SORT_ROW = 'Board columns: sort control';
const GROUP_ROW = 'Board columns: group style';

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

describe('KanbanBoard A/B rows in the shared dock', () => {
	it('registers three rows with the host dock, each with its options and the initial one pressed', () => {
		render(<AbExperiments enabled>{board()}</AbExperiments>);

		expect(options(LAYOUT_ROW)).toEqual(['Columns', 'Swimlanes', 'Compact', 'Rails', 'Tabs']);
		expect(options(SORT_ROW)).toEqual(['Header menu', 'Toolbar select', 'Chips', 'Editor only', 'Segmented']);
		expect(options(GROUP_ROW)).toEqual([
			'As configured',
			'Label',
			'Bar',
			'Gap',
			'Tint',
			'Border',
			'Boxed',
			'Pill',
			'Divider',
		]);
		expect(within(row(LAYOUT_ROW)).getByRole('button', { name: 'Columns' })).toHaveAttribute('aria-pressed', 'true');
		expect(within(row(SORT_ROW)).getByRole('button', { name: 'Header menu' })).toHaveAttribute(
			'aria-pressed',
			'true'
		);
		expect(within(row(GROUP_ROW)).getByRole('button', { name: 'As configured' })).toHaveAttribute(
			'aria-pressed',
			'true'
		);
		// every option says in a few words what it is
		for (const button of within(row(GROUP_ROW)).getAllByRole('button')) {
			expect(button.getAttribute('title')?.length ?? 0).toBeGreaterThan(0);
		}
	});

	it('the board draws no dock of its own and leaves no room for one', () => {
		render(<AbExperiments enabled>{board()}</AbExperiments>);

		expect(screen.queryByRole('toolbar', { name: 'Kanban variant' })).toBeNull();
		expect(screen.queryByRole('toolbar', { name: /sort and groups/ })).toBeNull();
		expect(root().className).not.toMatch(/\bpb-/);
	});

	it('the initial layout is defaultVariant', () => {
		render(<AbExperiments enabled>{board({ defaultVariant: 'rails' })}</AbExperiments>);

		expect(root()).toHaveAttribute('data-variant', 'rails');
		expect(within(row(LAYOUT_ROW)).getByRole('button', { name: 'Rails' })).toHaveAttribute('aria-pressed', 'true');
	});

	it('a pick switches live and is kept for the next mount (through useAbTest)', async () => {
		const user = userEvent.setup();
		const first = render(<AbExperiments enabled>{board()}</AbExperiments>);

		await user.click(within(row(LAYOUT_ROW)).getByRole('button', { name: 'Compact' }));
		await user.click(within(row(SORT_ROW)).getByRole('button', { name: 'Chips' }));
		await user.click(within(row(GROUP_ROW)).getByRole('button', { name: 'Bar' }));

		expect(root()).toHaveAttribute('data-variant', 'compact');
		expect(root()).toHaveAttribute('data-sort-variant', 'chips');
		expect(root()).toHaveAttribute('data-group-style', 'bar');
		first.unmount();

		render(<AbExperiments enabled>{board()}</AbExperiments>);
		expect(root()).toHaveAttribute('data-variant', 'compact');
		expect(root()).toHaveAttribute('data-sort-variant', 'chips');
		expect(root()).toHaveAttribute('data-group-style', 'bar');
	});

	it('without a host dock nothing crashes, no row is shown and the initial values apply (a stored choice is not used)', () => {
		window.localStorage.setItem('ab.board-layout', 'tabs');
		window.localStorage.setItem('ab.board-sort-control', 'chips');
		window.localStorage.setItem('ab.board-group-style', 'divider');
		render(board({ defaultVariant: 'swimlanes' }));

		expect(root()).toHaveAttribute('data-variant', 'swimlanes');
		expect(root()).toHaveAttribute('data-sort-variant', 'header-menu');
		expect(root()).toHaveAttribute('data-group-style', 'config');
		expect(screen.queryByRole('group', { name: LAYOUT_ROW })).toBeNull();
	});

	it('with the host dock turned off (shell without --ab-tests) the initial values apply too', () => {
		window.localStorage.setItem('ab.board-layout', 'tabs');
		render(<AbExperiments enabled={false}>{board()}</AbExperiments>);

		expect(root()).toHaveAttribute('data-variant', 'columns');
		expect(screen.queryByRole('group', { name: LAYOUT_ROW })).toBeNull();
	});

	it('the abSwitcher of an older answer is ignored: no private bar', async () => {
		stubFetch(() => jsonResponse({ columns: sampleColumns(), version: 'v1', abSwitcher: true }));
		render(<KanbanBoard projectParam="p1" apiBase="/api/modules/task" />);

		await screen.findByTestId('kanban-column-todo');
		expect(screen.queryByRole('toolbar')).toBeNull();
	});
});
