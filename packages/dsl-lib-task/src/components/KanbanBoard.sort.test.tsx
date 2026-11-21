import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { groupedColumns, groupedLayout, sortedColumns, sortedLayout } from '../kanban/boardFixtures.js';
import { normalizeColumns, SORT_OPTIONS } from '../kanban/boardModel.js';
import { deferred, FakeEventSource, jsonResponse, stubFetch } from '../testHelpers.js';
import { KanbanBoard } from './KanbanBoard.js';

// Sort inside a column, the separators between groups of cards, and the five A/B variants of the sort controls.

function sortedAnswer(extra: Record<string, unknown> = {}) {
	return {
		columns: sortedColumns(),
		config: { isDefault: false, columns: sortedLayout().columns },
		allStatuses: sortedLayout().allStatuses,
		version: 's1',
		hasCards: true,
		emptyText: null,
		warning: null,
		...extra,
	};
}

let calls: ReturnType<typeof stubFetch>['calls'];

beforeEach(() => {
	FakeEventSource.reset();
	vi.stubGlobal('EventSource', FakeEventSource);
	window.localStorage.clear();
	calls = stubFetch(() => jsonResponse(sortedAnswer())).calls;
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

function setup(extra: Partial<React.ComponentProps<typeof KanbanBoard>> = {}) {
	return render(
		<KanbanBoard
			columns={sortedColumns()}
			config={{ isDefault: false, columns: sortedLayout().columns }}
			allStatuses={sortedLayout().allStatuses}
			version="s1"
			projectParam="p1"
			apiBase="/api/modules/task"
			defaultVariant="columns"
			{...extra}
		/>
	);
}

/** Mounts the board with the dev switcher on and the sort variant `id` stored. */
function setupVariant(id: string, extra: Partial<React.ComponentProps<typeof KanbanBoard>> = {}) {
	window.localStorage.setItem('task.board.sortVariant', id);
	return setup({ variantSwitcher: true, ...extra });
}

const column = (key: string): HTMLElement => screen.getByTestId(`kanban-column-${key}`);
const separators = (key: string): HTMLElement[] => within(column(key)).queryAllByRole('separator');
const putBody = (): unknown => JSON.parse(calls.find(call => call.method === 'PUT')!.body!);

const LAYOUT_WITH = (sorts: Array<string | undefined>) =>
	sortedLayout().columns.map((entry, index) => {
		const { sort: _drop, ...rest } = entry;
		return sorts[index] === undefined ? rest : { ...rest, sort: sorts[index] };
	});

describe('board model', () => {
	it('keeps the sort of a column and the group of a card', () => {
		const [, doing] = normalizeColumns(sortedColumns());
		expect(doing!.sort).toBe('assignee');
		expect(doing!.cards.map(card => card.group)).toEqual(['ann', 'ann', 'bob']);
	});

	it('drops an unknown sort value without failing', () => {
		const raw = groupedColumns().map(entry => ({ ...entry, sort: 'random' }));
		const columns = normalizeColumns(raw);
		expect(columns.every(entry => entry.sort === undefined)).toBe(true);
	});

	it('offers the default order and the five sorts, saying which ones form groups', () => {
		expect(SORT_OPTIONS.map(option => option.label)).toEqual([
			'Default order',
			'Status',
			'Priority',
			'Assignee',
			'Oldest first',
			'Newest first',
		]);
		expect(SORT_OPTIONS.filter(option => option.groups).map(option => option.value)).toEqual([
			'status',
			'priority',
			'assignee',
		]);
	});
});

describe('separators between groups', () => {
	it('none when no card carries a group', () => {
		setup({ columns: groupedColumns(), config: { isDefault: false, columns: groupedLayout().columns } });
		expect(screen.queryAllByRole('separator')).toHaveLength(0);
	});

	it('one before the first card of every group, the first one included, named by the group (rule by default)', () => {
		setup();
		const doing = separators('Doing');
		expect(doing.map(entry => entry.getAttribute('aria-label'))).toEqual(['ann', 'bob']);
		expect(doing.every(entry => entry.getAttribute('data-style') === 'rule')).toBe(true);
		const order = Array.from(
			column('Doing').querySelectorAll('[role="separator"], [data-testid="kanban-card"]')
		).map(element => element.getAttribute('data-card-id') ?? element.getAttribute('aria-label'));
		expect(order).toEqual(['ann', 'ccc33333', 'eee55555', 'bob', 'fff66666']);
		// a sort that forms no group (newest) and no sort: no separator
		expect(separators('Closed')).toHaveLength(0);
		expect(separators('To do')).toHaveLength(0);
	});

	it('the band style shows the number of cards of the group in the column', () => {
		setupVariant('c');
		const doing = separators('Doing');
		expect(doing.every(entry => entry.getAttribute('data-style') === 'band')).toBe(true);
		expect(doing.map(entry => within(entry).getByTestId('kanban-group-count').textContent)).toEqual(['2', '1']);
		expect(doing[0]).toHaveTextContent('ann');
	});

	it('compact and tabs draw them too; swimlanes do not (lanes are groups already)', async () => {
		const compact = setup({ defaultVariant: 'compact' });
		expect(separators('Doing')).toHaveLength(2);
		compact.unmount();

		const tabs = setup({ defaultVariant: 'tabs' });
		await userEvent.setup().click(screen.getByRole('tab', { name: /Doing/ }));
		expect(separators('Doing')).toHaveLength(2);
		tabs.unmount();

		setup({ defaultVariant: 'swimlanes' });
		expect(screen.queryAllByRole('separator')).toHaveLength(0);
	});
});

describe('variant a: header menu (the default, also without the dev switcher)', () => {
	it('a sort button in the header of each configured column, none on the implicit Unmapped column', () => {
		setup();
		expect(screen.getByTestId('kanban-board')).toHaveAttribute('data-sort-variant', 'a');
		for (const name of ['To do', 'Doing', 'Closed']) {
			expect(screen.getByRole('button', { name: `Sort column ${name}` })).toHaveAttribute(
				'aria-haspopup',
				'menu'
			);
		}
		expect(screen.queryByRole('button', { name: 'Sort column Unmapped' })).toBeNull();
	});

	it('opens a menu of radio items with the current sort checked and focused', async () => {
		setup();
		await userEvent.setup().click(screen.getByRole('button', { name: 'Sort column Doing' }));
		const menu = screen.getByRole('menu', { name: 'Sort cards of Doing' });
		const items = within(menu).getAllByRole('menuitemradio');
		expect(items.map(item => item.textContent)).toEqual(SORT_OPTIONS.map(option => option.label));
		const checked = within(menu).getByRole('menuitemradio', { name: 'Assignee' });
		expect(checked).toHaveAttribute('aria-checked', 'true');
		expect(checked).toHaveFocus();
	});

	it('keyboard: arrows move, Enter picks and saves the whole layout with the changed sort', async () => {
		const user = userEvent.setup();
		setup();
		await user.click(screen.getByRole('button', { name: 'Sort column Doing' }));
		// Assignee -> Oldest first
		await user.keyboard('{ArrowDown}{Enter}');

		await waitFor(() => expect(calls.some(call => call.method === 'PUT')).toBe(true));
		const put = calls.find(call => call.method === 'PUT')!;
		expect(put.url.pathname).toBe('/api/modules/task/board/config');
		expect(put.url.searchParams.get('project')).toBe('p1');
		expect(putBody()).toEqual({ columns: LAYOUT_WITH([undefined, 'oldest', 'newest']) });
		expect(screen.queryByRole('menu')).toBeNull();
	});

	it('Escape closes the menu, gives the focus back to the button, and saves nothing', async () => {
		const user = userEvent.setup();
		setup();
		const button = screen.getByRole('button', { name: 'Sort column Doing' });
		await user.click(button);
		await user.keyboard('{ArrowUp}{Escape}');
		expect(screen.queryByRole('menu')).toBeNull();
		expect(button).toHaveFocus();
		expect(calls.some(call => call.method === 'PUT')).toBe(false);
	});

	it('Default order removes the sort of that column only', async () => {
		const user = userEvent.setup();
		setup();
		await user.click(screen.getByRole('button', { name: 'Sort column Closed' }));
		await user.click(screen.getByRole('menuitemradio', { name: 'Default order' }));
		await waitFor(() => expect(calls.some(call => call.method === 'PUT')).toBe(true));
		expect(putBody()).toEqual({ columns: LAYOUT_WITH([undefined, 'assignee', undefined]) });
	});

	it('shows a pending state while saving, and a refused save shows the route message', async () => {
		const pending = deferred<Response>();
		stubFetch(call => (call.method === 'PUT' ? pending.promise : jsonResponse(sortedAnswer())));
		const user = userEvent.setup();
		setup();
		await user.click(screen.getByRole('button', { name: 'Sort column To do' }));
		await user.click(screen.getByRole('menuitemradio', { name: 'Priority' }));

		expect(screen.getByRole('button', { name: 'Sort column To do' })).toBeDisabled();
		expect(screen.getByTestId('kanban-sort-pending')).toHaveTextContent('Saving the sort');

		pending.resolve(
			jsonResponse(
				{ error: 'board.columns[0].sort: "priority" is not allowed', hint: 'Use one of status, ...' },
				400
			)
		);
		const alert = await screen.findByText(/The sort was not saved/);
		expect(alert).toHaveTextContent('board.columns[0].sort');
		expect(alert).toHaveTextContent('Use one of status');
		expect(screen.queryByTestId('kanban-sort-pending')).toBeNull();
		expect(screen.getByRole('button', { name: 'Sort column To do' })).toBeEnabled();
	});

	it('a read only board has no sort control', () => {
		setup({ readOnly: true });
		expect(screen.queryByRole('button', { name: /^Sort column/ })).toBeNull();
	});
});

describe('variant b: toolbar select', () => {
	it('one select for every column, no header control; picking saves the same sort on every column', async () => {
		const user = userEvent.setup();
		setupVariant('b');
		expect(screen.queryByRole('button', { name: /^Sort column/ })).toBeNull();
		const select = screen.getByRole('combobox', { name: 'Sort cards by' });
		expect(
			within(select)
				.getAllByRole('option')
				.map(option => option.textContent)
		).toEqual(['Per column (as configured)', ...SORT_OPTIONS.map(option => option.label)]);
		// the columns differ: the select says so
		expect(select).toHaveValue('*');

		await user.selectOptions(select, 'priority');
		await waitFor(() => expect(calls.some(call => call.method === 'PUT')).toBe(true));
		expect(putBody()).toEqual({ columns: LAYOUT_WITH(['priority', 'priority', 'priority']) });
		expect(separators('Doing').every(entry => entry.getAttribute('data-style') === 'rule')).toBe(true);
	});
});

describe('variant c: chips', () => {
	it('a chip per option under each column header, the active one pressed; a click saves that column', async () => {
		const user = userEvent.setup();
		setupVariant('c');
		const chips = within(column('Doing')).getByRole('group', { name: 'Sort cards of Doing' });
		expect(within(chips).getAllByRole('button')).toHaveLength(SORT_OPTIONS.length);
		expect(within(chips).getByRole('button', { name: 'Assignee' })).toHaveAttribute('aria-pressed', 'true');
		expect(within(chips).getByRole('button', { name: 'Priority' })).toHaveAttribute('aria-pressed', 'false');
		expect(screen.queryByRole('button', { name: /^Sort column/ })).toBeNull();

		const todo = within(column('To do')).getByRole('group', { name: 'Sort cards of To do' });
		expect(within(todo).getByRole('button', { name: 'Default' })).toHaveAttribute('aria-pressed', 'true');
		await user.click(within(todo).getByRole('button', { name: 'Status' }));
		await waitFor(() => expect(calls.some(call => call.method === 'PUT')).toBe(true));
		expect(putBody()).toEqual({ columns: LAYOUT_WITH(['status', 'assignee', 'newest']) });
	});
});

describe('variant d: editor only', () => {
	it('no control on the board, a read-only badge naming the sort where one is set', () => {
		setupVariant('d');
		expect(screen.queryByRole('button', { name: /^Sort column/ })).toBeNull();
		expect(screen.queryByRole('combobox', { name: 'Sort cards by' })).toBeNull();
		expect(screen.queryByRole('group', { name: /^Sort cards/ })).toBeNull();
		expect(within(column('Doing')).getByTestId('kanban-sort-badge')).toHaveTextContent('by assignee');
		expect(within(column('Closed')).getByTestId('kanban-sort-badge')).toHaveTextContent('newest first');
		expect(within(column('To do')).queryByTestId('kanban-sort-badge')).toBeNull();
		expect(separators('Doing').every(entry => entry.getAttribute('data-style') === 'rule')).toBe(true);
	});
});

describe('variant e: segmented toolbar', () => {
	it('one segmented control for every column; picking saves it on every column; band separators', async () => {
		const user = userEvent.setup();
		setupVariant('e');
		const group = screen.getByRole('group', { name: 'Sort cards of every column' });
		expect(
			within(group)
				.getAllByRole('button')
				.map(button => button.textContent)
		).toEqual(['Default', 'Status', 'Priority', 'Assignee', 'Oldest', 'Newest']);
		// the columns differ: none is pressed
		expect(within(group).queryAllByRole('button', { pressed: true })).toHaveLength(0);
		// on a narrow screen the bar scrolls inside itself instead of being cut by the page (seen at 390 px: Assignee out of view)
		expect(group.className).toContain('overflow-x-auto');
		expect(group.className).toContain('max-w-[calc(100vw-6rem)]');
		expect(separators('Doing').every(entry => entry.getAttribute('data-style') === 'band')).toBe(true);

		await user.click(within(group).getByRole('button', { name: 'Oldest' }));
		await waitFor(() => expect(calls.some(call => call.method === 'PUT')).toBe(true));
		expect(putBody()).toEqual({ columns: LAYOUT_WITH(['oldest', 'oldest', 'oldest']) });
	});

	it('Default removes the sort of every column', async () => {
		const user = userEvent.setup();
		setupVariant('e');
		await user.click(screen.getByRole('button', { name: 'Default' }));
		await waitFor(() => expect(calls.some(call => call.method === 'PUT')).toBe(true));
		expect(putBody()).toEqual({ columns: LAYOUT_WITH([undefined, undefined, undefined]) });
	});
});

describe('the sort variant dock', () => {
	it('is absent without the dev switcher, and the stored sort variant is not read', () => {
		window.localStorage.setItem('task.board.sortVariant', 'c');
		const get = vi.spyOn(Storage.prototype, 'getItem');
		setup();
		expect(screen.queryByRole('toolbar', { name: 'Board columns: sort and groups' })).toBeNull();
		expect(get).not.toHaveBeenCalledWith('task.board.sortVariant');
		expect(screen.getByTestId('kanban-board')).toHaveAttribute('data-sort-variant', 'a');
	});

	it('is a second floating bar above the layout switcher, titled, with the five variants and the active one pressed', () => {
		setup({ variantSwitcher: true });
		const dock = screen.getByRole('toolbar', { name: 'Board columns: sort and groups' });
		expect(dock.className).toMatch(/fixed/);
		expect(dock.className).toMatch(/bottom-20/);
		expect(within(dock).getByText('Board columns: sort and groups')).toBeVisible();
		expect(
			within(dock)
				.getAllByRole('button')
				.map(button => button.textContent)
		).toEqual(['1 Header menu', '2 Toolbar select', '3 Chips', '4 Editor only', '5 Segmented toolbar']);
		expect(within(dock).getByRole('button', { name: '1 Header menu' })).toHaveAttribute('aria-pressed', 'true');
		// the layout switcher is still there
		expect(screen.getByRole('toolbar', { name: 'Kanban variant' })).toBeInTheDocument();
	});

	it('switches live and remembers the choice', async () => {
		const first = setup({ variantSwitcher: true });
		await userEvent.setup().click(screen.getByRole('button', { name: '3 Chips' }));
		expect(screen.getByTestId('kanban-board')).toHaveAttribute('data-sort-variant', 'c');
		expect(window.localStorage.getItem('task.board.sortVariant')).toBe('c');
		first.unmount();

		setup({ variantSwitcher: true });
		expect(screen.getByTestId('kanban-board')).toHaveAttribute('data-sort-variant', 'c');
	});

	it('a stored value that is not a sort variant is reported, and a is used', () => {
		window.localStorage.setItem('task.board.sortVariant', 'z');
		setup({ variantSwitcher: true });
		expect(screen.getByTestId('kanban-board')).toHaveAttribute('data-sort-variant', 'a');
		expect(screen.getByText(/The saved sort variant "z" is not known/)).toBeInTheDocument();
	});
});
