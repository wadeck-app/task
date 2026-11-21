import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { groupedColumns, groupedLayout, sampleColumns } from '../kanban/boardFixtures.js';
import { FakeEventSource, jsonResponse, stubFetch } from '../testHelpers.js';
import { KanbanBoard } from './KanbanBoard.js';

// Columns that GROUP statuses (config.yml `board`), one drop area per status while a card is dragged, and the editor of the layout.

type OnAction = ReturnType<typeof vi.fn<(...args: any[]) => unknown>>;
let onAction: OnAction;

function grouped(extra: Record<string, unknown> = {}) {
	return {
		columns: groupedColumns(),
		config: { isDefault: false, columns: groupedLayout().columns },
		allStatuses: groupedLayout().allStatuses,
		version: 'g1',
		hasCards: true,
		emptyText: null,
		warning: null,
		...extra,
	};
}

beforeEach(() => {
	FakeEventSource.reset();
	vi.stubGlobal('EventSource', FakeEventSource);
	window.localStorage.clear();
	onAction = vi.fn<(...args: any[]) => unknown>().mockResolvedValue(undefined);
	stubFetch(() => jsonResponse(grouped()));
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

function setup(extra: Partial<React.ComponentProps<typeof KanbanBoard>> = {}) {
	return render(
		<KanbanBoard
			columns={groupedColumns()}
			version="g1"
			projectParam="p1"
			moveAction="moveCard"
			apiBase="/api/modules/task"
			defaultVariant="columns"
			onAction={onAction}
			{...extra}
		/>
	);
}

const column = (key: string): HTMLElement => screen.getByTestId(`kanban-column-${key}`);
const card = (id: string): HTMLElement => document.querySelector(`[data-card-id="${id}"]`) as HTMLElement;

function dataTransfer(id: string) {
	return { setData: vi.fn(), getData: vi.fn(() => id), effectAllowed: '', dropEffect: '' };
}

describe('grouped columns', () => {
	it('the header shows the column name and the count of all its statuses', () => {
		setup();
		const header = within(column('Doing')).getByRole('banner');
		expect(header).toHaveTextContent('Doing');
		expect(within(header).getByTestId('kanban-count')).toHaveTextContent('2');
	});

	it('cards of a grouped column show their status; the card of a one-status column does not', () => {
		setup();
		const pills = within(column('Doing')).getAllByTestId('kanban-card-status');
		expect(pills.map(pill => pill.textContent)).toEqual(['doing', 'review']);
		expect(within(column('To do')).queryByTestId('kanban-card-status')).toBeNull();
		expect(within(column('Closed')).getByTestId('kanban-card-status')).toHaveTextContent('done');
	});

	it('the implicit Unmapped column is drawn after the configured columns', () => {
		setup();
		expect(column('__unmapped__')).toHaveAttribute('aria-label', 'Unmapped');
	});

	it('compact and swimlanes also name the status of a card in a grouped column', () => {
		const first = setup({ defaultVariant: 'compact' });
		expect(within(column('Doing')).getAllByTestId('kanban-card-status')).toHaveLength(2);
		first.unmount();
		setup({ defaultVariant: 'swimlanes' });
		expect(screen.getAllByTestId('kanban-card-status').length).toBeGreaterThanOrEqual(3);
	});

	it('tabs: a tab per column with its count, the status pill on the cards of a grouped one, no drag', async () => {
		setup({ defaultVariant: 'tabs' });
		const tabs = screen.getAllByRole('tab').map(tab => tab.textContent);
		expect(tabs).toEqual(['To do1', 'Doing2', 'Closed1', 'Unmapped0']);
		await userEvent.setup().click(screen.getByRole('tab', { name: /Doing/ }));
		expect(screen.getAllByTestId('kanban-card-status')).toHaveLength(2);
		expect(document.querySelector('[draggable="true"]')).toBeNull();
	});
});

describe('drop areas', () => {
	it('there is none until a card is dragged', () => {
		setup();
		expect(screen.queryByTestId('kanban-drop-areas')).toBeNull();
	});

	it('while a card is dragged every column shows one labelled area per status, in order, with the current one marked', () => {
		setup();

		fireEvent.dragStart(card('ccc33333'), { dataTransfer: dataTransfer('ccc33333') });

		const names = (key: string): string[] =>
			Array.from(column(key).querySelectorAll('[data-testid^="kanban-drop-area-"]')).map(
				area => area.getAttribute('data-status') ?? ''
			);
		expect(names('To do')).toEqual(['todo']);
		expect(names('Doing')).toEqual(['doing', 'review']);
		expect(names('Closed')).toEqual(['done', 'rejected']);
		expect(names('__unmapped__')).toEqual(['parked']);
		const current = screen.getByTestId('kanban-drop-area-doing');
		expect(current).toHaveAttribute('data-current', 'true');
		expect(current).toHaveTextContent('current');
		expect(screen.getByTestId('kanban-drop-area-review')).not.toHaveAttribute('data-current');
		expect(screen.getByTestId('kanban-drop-area-review')).toHaveAccessibleName('Drop here to set status review');

		fireEvent.dragEnd(card('ccc33333'), { dataTransfer: dataTransfer('ccc33333') });
		expect(screen.queryByTestId('kanban-drop-areas')).toBeNull();
	});

	it('dropping on an area sets EXACTLY that status (a status of a grouped column, not the first one)', () => {
		setup();
		const transfer = dataTransfer('aaa11111');

		fireEvent.dragStart(card('aaa11111'), { dataTransfer: transfer });
		const area = screen.getByTestId('kanban-drop-area-review');
		fireEvent.dragOver(area, { dataTransfer: transfer });
		expect(area).toHaveAttribute('data-drop-target', 'true');
		fireEvent.drop(area, { dataTransfer: transfer });

		expect(onAction).toHaveBeenCalledTimes(1);
		expect(onAction).toHaveBeenCalledWith(
			'moveCard',
			{ projectParam: 'p1', cardId: 'aaa11111', status: 'review' },
			{ body: { status: 'review' } }
		);
	});

	it('the second status of a closed group and an Unmapped status are targets too', () => {
		setup();
		const transfer = dataTransfer('aaa11111');
		fireEvent.dragStart(card('aaa11111'), { dataTransfer: transfer });
		fireEvent.drop(screen.getByTestId('kanban-drop-area-rejected'), { dataTransfer: transfer });
		expect(onAction).toHaveBeenLastCalledWith(
			'moveCard',
			{ projectParam: 'p1', cardId: 'aaa11111', status: 'rejected' },
			{ body: { status: 'rejected' } }
		);
	});

	it('dropping on the area of the current status, or on the body of a grouped column, does nothing', () => {
		setup();
		const transfer = dataTransfer('ccc33333');
		fireEvent.dragStart(card('ccc33333'), { dataTransfer: transfer });

		fireEvent.dragOver(screen.getByTestId('kanban-drop-area-doing'), { dataTransfer: transfer });
		fireEvent.drop(screen.getByTestId('kanban-drop-area-doing'), { dataTransfer: transfer });
		// the column "Closed" holds two statuses: its body is no target, only its areas
		fireEvent.dragOver(column('Closed'), { dataTransfer: transfer });
		fireEvent.drop(column('Closed'), { dataTransfer: transfer });

		expect(onAction).not.toHaveBeenCalled();
	});

	it('a column holding ONE status still takes a drop on its body, and the area inside does not move the card twice', () => {
		setup();
		const transfer = dataTransfer('ccc33333');
		fireEvent.dragStart(card('ccc33333'), { dataTransfer: transfer });

		fireEvent.drop(column('To do'), { dataTransfer: transfer });
		expect(onAction).toHaveBeenCalledTimes(1);
		expect(onAction).toHaveBeenLastCalledWith(
			'moveCard',
			{ projectParam: 'p1', cardId: 'ccc33333', status: 'todo' },
			{ body: { status: 'todo' } }
		);
	});

	it('a drop on the area inside a one-status column moves once (the column does not handle it again)', () => {
		setup();
		const transfer = dataTransfer('ccc33333');
		fireEvent.dragStart(card('ccc33333'), { dataTransfer: transfer });
		fireEvent.drop(screen.getByTestId('kanban-drop-area-todo'), { dataTransfer: transfer });
		expect(onAction).toHaveBeenCalledTimes(1);
	});

	it('the moved card is drawn at once in the column of its new status, with its new status', async () => {
		setup();
		const transfer = dataTransfer('aaa11111');
		fireEvent.dragStart(card('aaa11111'), { dataTransfer: transfer });
		fireEvent.drop(screen.getByTestId('kanban-drop-area-review'), { dataTransfer: transfer });
		fireEvent.dragEnd(card('aaa11111'), { dataTransfer: transfer });

		await waitFor(() => expect(within(column('Doing')).queryByText('Write the spec')).not.toBeNull());
		const pills = within(column('Doing')).getAllByTestId('kanban-card-status');
		expect(pills.map(pill => pill.textContent)).toContain('review');
	});

	it.each(['compact', 'rails'] as const)('%s shows the areas while dragging', variant => {
		setup({ defaultVariant: variant });
		fireEvent.dragStart(card('aaa11111'), { dataTransfer: dataTransfer('aaa11111') });
		expect(screen.getByTestId('kanban-drop-area-review')).toBeInTheDocument();
		expect(screen.getByTestId('kanban-drop-area-rejected')).toBeInTheDocument();
		expect(screen.getByTestId('kanban-drop-area-parked')).toBeInTheDocument();
	});

	it('swimlanes show the areas under the column headers while dragging, and drop on one moves the card', () => {
		setup({ defaultVariant: 'swimlanes' });
		const transfer = dataTransfer('aaa11111');
		fireEvent.dragStart(card('aaa11111'), { dataTransfer: transfer });
		fireEvent.drop(screen.getByTestId('kanban-drop-area-review'), { dataTransfer: transfer });
		expect(onAction).toHaveBeenCalledWith(
			'moveCard',
			{ projectParam: 'p1', cardId: 'aaa11111', status: 'review' },
			{ body: { status: 'review' } }
		);
	});

	it('readOnly: no drag, no area', () => {
		setup({ readOnly: true });
		expect(document.querySelector('[draggable="true"]')).toBeNull();
		fireEvent.dragStart(card('aaa11111'), { dataTransfer: dataTransfer('aaa11111') });
		expect(screen.queryByTestId('kanban-drop-areas')).toBeNull();
	});
});

describe('the Move to menu', () => {
	it('lists every other status grouped by column: a heading for a grouped column, none for a one-status column of the same name', async () => {
		const user = userEvent.setup();
		setup({ columns: sampleColumns() });
		await user.click(screen.getByRole('button', { name: 'Move aaa11111 to another status' }));
		expect(screen.queryAllByTestId('kanban-move-group')).toHaveLength(2);
		// one-status columns whose label differs from the status keep a heading: "In progress" > doing
		expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual(['doing', 'done']);
	});

	it('shows the column heading, then its statuses; the current status is left out', async () => {
		const user = userEvent.setup();
		setup();
		await user.click(screen.getByRole('button', { name: 'Move ccc33333 to another status' }));
		const menu = screen.getByRole('menu');
		expect(
			within(menu)
				.getAllByTestId('kanban-move-group')
				.map(h => h.textContent)
		).toEqual(['To do', 'Doing', 'Closed', 'Unmapped']);
		expect(
			within(menu)
				.getAllByRole('menuitem')
				.map(item => item.textContent)
		).toEqual(['todo', 'review', 'done', 'rejected', 'parked']);
	});

	it('arrow keys cross the groups and Enter picks an exact status', async () => {
		const user = userEvent.setup();
		setup();
		await user.click(screen.getByRole('button', { name: 'Move aaa11111 to another status' }));
		// first item is "doing"; ArrowDown goes to "review"
		await user.keyboard('{ArrowDown}{Enter}');
		expect(onAction).toHaveBeenCalledWith(
			'moveCard',
			{ projectParam: 'p1', cardId: 'aaa11111', status: 'review' },
			{ body: { status: 'review' } }
		);
	});
});

describe('Configure columns', () => {
	const answerAfterSave = (): Response => jsonResponse(grouped({ version: 'g2' }));

	it('is offered with the layout, not in readOnly and not when the answer has no layout', async () => {
		setup({ columns: undefined });
		await screen.findByTestId('kanban-column-Doing');
		expect(screen.getByRole('button', { name: /Configure columns/ })).toBeInTheDocument();
	});

	it('is not offered for a read only board', () => {
		setup({ readOnly: true });
		expect(screen.queryByTestId('kanban-configure')).toBeNull();
	});

	it('is not offered when the answer does not carry the layout (an older module)', async () => {
		stubFetch(() => jsonResponse({ columns: groupedColumns(), version: 'g1', hasCards: true }));
		setup({ columns: undefined });
		await screen.findByTestId('kanban-column-Doing');
		expect(screen.queryByTestId('kanban-configure')).toBeNull();
	});

	async function open() {
		const user = userEvent.setup();
		setup({ columns: undefined });
		await screen.findByTestId('kanban-column-Doing');
		await user.click(screen.getByTestId('kanban-configure'));
		return user;
	}

	it('opens the editor with the stored columns, their statuses and the Unmapped statuses', async () => {
		await open();
		const editor = screen.getByTestId('columns-editor');
		const rows = within(editor).getAllByTestId('columns-editor-column');
		expect(rows.map(row => (within(row).getByRole('textbox') as HTMLInputElement).value)).toEqual([
			'To do',
			'Doing',
			'Closed',
		]);
		expect(within(rows[1]!).getByTestId('columns-editor-chip-review')).toBeInTheDocument();
		expect(
			within(screen.getByTestId('columns-editor-unmapped')).getByTestId('columns-editor-chip-parked')
		).toBeInTheDocument();
		// the board itself is hidden while editing
		expect(screen.queryByTestId('kanban-column-Doing')).toBeNull();
	});

	it('Cancel closes the editor and sends nothing', async () => {
		const { calls } = stubFetch(() => jsonResponse(grouped()));
		const user = await open();
		const before = calls.length;
		await user.click(screen.getByRole('button', { name: 'Cancel' }));
		expect(screen.queryByTestId('columns-editor')).toBeNull();
		expect(screen.getByTestId('kanban-column-Doing')).toBeInTheDocument();
		expect(calls.filter(call => call.method !== 'GET')).toHaveLength(0);
		expect(calls.length).toBe(before);
	});

	it('add, rename, reorder with the buttons, delete, assign with the select: Save sends the whole layout and reloads the board', async () => {
		const { calls } = stubFetch(call => (call.method === 'PUT' ? answerAfterSave() : jsonResponse(grouped())));
		const user = await open();

		await user.click(screen.getByRole('button', { name: 'Add column' }));
		const rows = (): HTMLElement[] => screen.getAllByTestId('columns-editor-column');
		expect(rows()).toHaveLength(4);
		const fresh = within(rows()[3]!).getByRole('textbox') as HTMLInputElement;
		expect(fresh.value).toBe('New column');
		await user.clear(fresh);
		await user.type(fresh, 'Waiting');
		// put "parked" (Unmapped) in the new column with the select of its chip
		await user.selectOptions(screen.getByLabelText('Column of status parked'), 'Waiting');
		// move the new column up twice: it ends second
		await user.click(screen.getByRole('button', { name: 'Move column Waiting up' }));
		await user.click(screen.getByRole('button', { name: 'Move column Waiting up' }));
		expect(rows().map(row => (within(row).getByRole('textbox') as HTMLInputElement).value)).toEqual([
			'To do',
			'Waiting',
			'Doing',
			'Closed',
		]);
		// delete "To do": its status becomes Unmapped
		await user.click(screen.getByRole('button', { name: 'Delete column To do' }));
		expect(
			within(screen.getByTestId('columns-editor-unmapped')).getByTestId('columns-editor-chip-todo')
		).toBeInTheDocument();

		await user.click(screen.getByRole('button', { name: 'Save' }));

		await waitFor(() => expect(screen.queryByTestId('columns-editor')).toBeNull());
		const put = calls.find(call => call.method === 'PUT')!;
		expect(put.url.pathname).toBe('/api/modules/task/board/config');
		expect(put.url.searchParams.get('project')).toBe('p1');
		expect(JSON.parse(put.body!)).toEqual({
			columns: [
				{ name: 'Waiting', statuses: ['parked'] },
				{ name: 'Doing', statuses: ['doing', 'review'] },
				{ name: 'Closed', statuses: ['done', 'rejected'] },
			],
		});
		// the board was fetched again after the save
		expect(calls.filter(call => call.method === 'GET').length).toBeGreaterThanOrEqual(2);
		expect(screen.getByTestId('kanban-column-Doing')).toBeInTheDocument();
	});

	it('a status chip dragged onto another column moves there, and onto Unmapped leaves every column', async () => {
		const user = await open();
		const rows = screen.getAllByTestId('columns-editor-column');
		const chip = within(rows[1]!).getByTestId('columns-editor-chip-review');
		const transfer = { setData: vi.fn(), effectAllowed: '' };

		fireEvent.dragStart(chip, { dataTransfer: transfer });
		fireEvent.dragOver(rows[0]!, { dataTransfer: transfer });
		fireEvent.drop(rows[0]!, { dataTransfer: transfer });
		expect(
			within(screen.getAllByTestId('columns-editor-column')[0]!).getByTestId('columns-editor-chip-review')
		).toBeInTheDocument();
		expect(
			within(screen.getAllByTestId('columns-editor-column')[1]!).queryByTestId('columns-editor-chip-review')
		).toBeNull();

		const again = within(screen.getAllByTestId('columns-editor-column')[0]!).getByTestId(
			'columns-editor-chip-review'
		);
		const unmapped = screen.getByTestId('columns-editor-unmapped');
		fireEvent.dragStart(again, { dataTransfer: transfer });
		fireEvent.dragOver(unmapped, { dataTransfer: transfer });
		fireEvent.drop(unmapped, { dataTransfer: transfer });
		expect(within(unmapped).getByTestId('columns-editor-chip-review')).toBeInTheDocument();
		void user;
	});

	it('a column dragged by its handle onto another column is reordered', async () => {
		await open();
		const rows = screen.getAllByTestId('columns-editor-column');
		const handle = within(rows[2]!).getByTestId('columns-editor-handle');
		const transfer = { setData: vi.fn(), effectAllowed: '' };

		fireEvent.dragStart(handle, { dataTransfer: transfer });
		fireEvent.dragOver(rows[0]!, { dataTransfer: transfer });
		fireEvent.drop(rows[0]!, { dataTransfer: transfer });

		expect(
			screen
				.getAllByTestId('columns-editor-column')
				.map(row => (within(row).getByRole('textbox') as HTMLInputElement).value)
		).toEqual(['Closed', 'To do', 'Doing']);
	});

	it('the first column cannot move up, the last cannot move down', async () => {
		await open();
		expect(screen.getByRole('button', { name: 'Move column To do up' })).toBeDisabled();
		expect(screen.getByRole('button', { name: 'Move column Closed down' })).toBeDisabled();
		expect(screen.getByRole('button', { name: 'Move column Doing up' })).toBeEnabled();
	});

	it('a column with no status cannot be saved: Save is off and the editor names the column BEFORE any request (the route refuses it)', async () => {
		const { calls } = stubFetch(call => (call.method === 'PUT' ? answerAfterSave() : jsonResponse(grouped())));
		const user = await open();
		await user.click(screen.getByRole('button', { name: 'Add column' }));
		const name = within(screen.getAllByTestId('columns-editor-column')[3]!).getByRole('textbox');
		await user.clear(name);
		await user.type(name, 'planned');

		expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
		expect(screen.getByTestId('columns-editor-empty')).toHaveTextContent(
			'Column "planned" has no status: drag a status onto it, or delete the column.'
		);
		expect(calls.some(call => call.method === 'PUT')).toBe(false);

		// a status in it lifts the block, the message goes away
		await user.selectOptions(screen.getByLabelText('Column of status parked'), 'planned');
		expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
		expect(screen.queryByTestId('columns-editor-empty')).toBeNull();
	});

	it('a new column is focused with its name selected, so the user types the name at once', async () => {
		const user = await open();
		await user.click(screen.getByRole('button', { name: 'Add column' }));

		const name = within(screen.getAllByTestId('columns-editor-column')[3]!).getByRole('textbox') as HTMLInputElement;
		expect(name).toHaveFocus();
		expect(name.selectionStart).toBe(0);
		expect(name.selectionEnd).toBe(name.value.length);
	});

	it('the empty column itself says it, where the user looks (not only a message at the bottom), and Save says why it is off', async () => {
		const user = await open();
		await user.click(screen.getByRole('button', { name: 'Add column' }));

		const row = screen.getAllByTestId('columns-editor-column')[3]!;
		expect(within(row).getByTestId('columns-editor-column-empty')).toHaveTextContent(
			'No status yet: drag one here or pick this column in a status list.'
		);
		expect(row).toHaveAttribute('data-empty', 'true');
		expect(screen.getByRole('button', { name: 'Save' })).toHaveAccessibleDescription(
			'1 column has no status: fill or delete it to save'
		);
		// a filled column is not marked
		expect(screen.getAllByTestId('columns-editor-column')[0]).not.toHaveAttribute('data-empty');
	});

	it('a status chip never grows wider than its column: a long column name is cut, not overflowing', async () => {
		const user = await open();
		await user.click(screen.getByRole('button', { name: 'Add column' }));
		const name = within(screen.getAllByTestId('columns-editor-column')[3]!).getByRole('textbox');
		await user.clear(name);
		await user.type(name, 'A very long column name that goes on and on');

		const chip = screen.getByTestId('columns-editor-chip-todo');
		expect(chip.className).toContain('max-w-full');
		expect(within(chip).getByRole('combobox').className).toContain('truncate');
	});

	it('several empty columns are all named; deleting them lifts the block', async () => {
		const user = await open();
		await user.click(screen.getByRole('button', { name: 'Add column' }));
		await user.click(screen.getByRole('button', { name: 'Add column' }));

		expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
		const text = screen.getByTestId('columns-editor-empty').textContent ?? '';
		expect(text).toContain('Column "New column" has no status');
		expect(text).toContain('Column "New column 2" has no status');

		await user.click(screen.getByRole('button', { name: 'Delete column New column 2' }));
		await user.click(screen.getByRole('button', { name: 'Delete column New column' }));
		expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
	});

	it('a refused save keeps the editor open, shows the route message and hint in an alert, and the draft is kept', async () => {
		stubFetch(call =>
			call.method === 'PUT'
				? jsonResponse(
						{
							error: '/x/config.yml: board.columns[3].name: "Doing" is already the name of board.columns[1].',
							hint: 'Give each column its own name.',
						},
						400
					)
				: jsonResponse(grouped())
		);
		const user = await open();
		await user.click(screen.getByRole('button', { name: 'Add column' }));
		const rows = screen.getAllByTestId('columns-editor-column');
		const name = within(rows[3]!).getByRole('textbox') as HTMLInputElement;
		await user.clear(name);
		await user.type(name, 'Doing');
		// a column must hold a status to be saved: put "parked" in it, the duplicate name is what the route refuses
		// (by option value: two columns are now both called "Doing"; the new column has the id after the three stored ones)
		await user.selectOptions(screen.getByLabelText('Column of status parked'), '4');

		await user.click(screen.getByRole('button', { name: 'Save' }));

		const alert = await screen.findByRole('alert');
		expect(alert).toHaveTextContent('The columns were not saved');
		expect(alert).toHaveTextContent('board.columns[3].name');
		expect(alert).toHaveTextContent('Give each column its own name.');
		expect(screen.getByTestId('columns-editor')).toBeInTheDocument();
		expect(
			(within(screen.getAllByTestId('columns-editor-column')[3]!).getByRole('textbox') as HTMLInputElement).value
		).toBe('Doing');
		expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
	});

	it('Reset to default sends DELETE, reloads and closes; it is off when the board already is the default', async () => {
		const { calls } = stubFetch(call => (call.method === 'DELETE' ? answerAfterSave() : jsonResponse(grouped())));
		const user = await open();

		await user.click(screen.getByRole('button', { name: 'Reset to default' }));

		await waitFor(() => expect(screen.queryByTestId('columns-editor')).toBeNull());
		const del = calls.find(call => call.method === 'DELETE')!;
		expect(del.url.pathname).toBe('/api/modules/task/board/config');
		expect(del.body).toBeUndefined();
	});

	it('Reset is off on the default layout', async () => {
		stubFetch(() =>
			jsonResponse({
				columns: sampleColumns(),
				config: { isDefault: true, columns: [{ name: 'todo', statuses: ['todo'] }] },
				allStatuses: [{ name: 'todo' }],
				version: 'd1',
				hasCards: true,
			})
		);
		const user = userEvent.setup();
		setup({ columns: undefined });
		await screen.findByTestId('kanban-column-todo');
		await user.click(screen.getByTestId('kanban-configure'));
		expect(screen.getByRole('button', { name: 'Reset to default' })).toBeDisabled();
	});

	it('page mode (moveAction) configures the same way: the layout is saved by the component itself, not by a page action', async () => {
		const { calls } = stubFetch(call => (call.method === 'PUT' ? answerAfterSave() : jsonResponse(grouped())));
		const user = userEvent.setup();
		// the page gives the layout with its first columns (no first fetch is needed to configure)
		setup({
			config: { isDefault: false, columns: groupedLayout().columns },
			allStatuses: groupedLayout().allStatuses,
		});
		await user.click(screen.getByTestId('kanban-configure'));
		await user.click(screen.getByRole('button', { name: 'Save' }));
		await waitFor(() => expect(calls.some(call => call.method === 'PUT')).toBe(true));
		expect(onAction).not.toHaveBeenCalled();
	});
});
