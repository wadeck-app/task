import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sampleColumns } from '../kanban/boardFixtures.js';
import { VARIANTS } from '../kanban/boardModel.js';
import { resetReported } from '../reportOnce.js';
import { deferred, FakeEventSource, jsonResponse, stubFetch } from '../testHelpers.js';
import { KanbanBoard } from './KanbanBoard.js';

const ALL_IDS = ['aaa11111', 'bbb22222', 'ccc33333', 'ddd44444'];

/** The board of the server after `id` went to `status`. */
function boardWithMove(id: string, status: string, version: string) {
	const columns = sampleColumns();
	const card = columns.flatMap(c => c.cards).find(c => c.id === id)!;
	for (const column of columns) {
		column.cards = column.cards.filter(c => c.id !== id);
	}
	columns.find(c => c.key === status)!.cards.unshift({ ...card, status });
	return { columns, version, hasCards: true };
}

let onAction: ReturnType<typeof vi.fn<(...args: any[]) => unknown>>;

beforeEach(() => {
	FakeEventSource.reset();
	vi.stubGlobal('EventSource', FakeEventSource);
	window.localStorage.clear();
	onAction = vi.fn<(...args: any[]) => unknown>().mockResolvedValue(undefined);
	// Whatever the board asks for, the server still shows the original board.
	stubFetch(() => jsonResponse({ columns: sampleColumns(), version: 'v1' }));
});

afterEach(() => {
	resetReported();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

function setup(extra: Partial<React.ComponentProps<typeof KanbanBoard>> = {}) {
	return render(
		<KanbanBoard
			columns={sampleColumns()}
			version="v1"
			projectParam="p1"
			moveAction="moveCard"
			apiBase="/api/modules/task"
			defaultVariant="columns"
			onAction={onAction}
			{...extra}
		/>
	);
}

const column = (status: string): HTMLElement => screen.getByTestId(`kanban-column-${status}`);
const cardIn = (status: string, id: string): HTMLElement | null =>
	column(status).querySelector(`[data-card-id="${id}"]`);

function dragTo(id: string, target: HTMLElement): void {
	const card = document.querySelector(`[data-card-id="${id}"]`) as HTMLElement;
	const dataTransfer = { setData: vi.fn(), getData: vi.fn(() => id), effectAllowed: '', dropEffect: '' };
	fireEvent.dragStart(card, { dataTransfer });
	fireEvent.dragOver(target, { dataTransfer });
	fireEvent.drop(target, { dataTransfer });
	fireEvent.dragEnd(card, { dataTransfer });
}

describe('KanbanBoard variants', () => {
	it.each(['columns', 'swimlanes', 'compact'] as const)('%s draws every card with id and headline', variant => {
		setup({ defaultVariant: variant });

		for (const id of ALL_IDS) {
			expect(document.querySelector(`[data-card-id="${id}"]`)).not.toBeNull();
		}
		expect(screen.getByRole('link', { name: 'Write the spec' })).toHaveAttribute(
			'href',
			'/modules/task/tasks/p/p1/aaa11111'
		);
		expect(screen.getByText('aaa11111')).toBeInTheDocument();
		expect(screen.getByTestId('kanban-board')).toHaveAttribute('data-variant', variant);
	});

	it('columns: a header per status with label and count, hidden cards named, terminal tinted by its tone', () => {
		setup();

		expect(within(column('todo')).getByText('To do')).toBeInTheDocument();
		expect(within(column('todo')).getByTestId('kanban-count')).toHaveTextContent('2');
		expect(within(column('done')).getByTestId('kanban-count')).toHaveTextContent('5');
		expect(within(column('done')).getByText('+4 hidden')).toBeInTheDocument();
		expect(within(column('todo')).queryByText(/hidden/)).toBeNull();
		expect(column('done')).toHaveAttribute('data-terminal', 'true');
		expect(column('done')).toHaveAttribute('data-tone', 'success');
	});

	it('shows a card with priority, assignee, type and at most 3 labels plus "+n"', () => {
		setup();

		const card = cardIn('todo', 'aaa11111')!;
		expect(within(card).getByText('High')).toBeInTheDocument();
		expect(within(card).getByText('ann')).toBeInTheDocument();
		expect(within(card).getByText('bug')).toBeInTheDocument();
		expect(within(card).getByText('billing')).toBeInTheDocument();
		expect(within(card).getByText('api')).toBeInTheDocument();
		expect(within(card).queryByText('docs')).toBeNull();
		expect(within(card).getByText('+1')).toBeInTheDocument();
	});

	it('an empty column says "No tasks"', () => {
		const columns = sampleColumns();
		columns[1]!.cards = [];
		columns[1]!.count = 0;
		setup({ columns });

		expect(within(column('doing')).getByText('No tasks')).toBeInTheDocument();
	});

	it('swimlanes: one row per effective priority, urgent first, tasks without one last, cells hold the cards', () => {
		setup({ defaultVariant: 'swimlanes' });

		const lanes = screen.getAllByTestId('kanban-lane').map(lane => lane.getAttribute('data-lane'));
		expect(lanes).toEqual(['urgent', 'high', 'medium', 'none']);
		const cell = screen.getByTestId('kanban-cell-urgent-doing');
		expect(cell.querySelector('[data-card-id="ccc33333"]')).not.toBeNull();
		expect(screen.getByTestId('kanban-cell-none-todo').querySelector('[data-card-id="bbb22222"]')).not.toBeNull();
	});

	it('rails: one column open, the others are rails with their count, and a rail opens its column', async () => {
		setup({ defaultVariant: 'rails' });

		expect(cardIn('todo', 'aaa11111')).not.toBeNull();
		expect(document.querySelector('[data-card-id="ccc33333"]')).toBeNull();
		const rail = screen.getByRole('button', { name: /Show In progress \(1\)/ });

		await userEvent.setup().click(rail);

		expect(cardIn('doing', 'ccc33333')).not.toBeNull();
		expect(document.querySelector('[data-card-id="aaa11111"]')).toBeNull();
		expect(screen.getByRole('button', { name: /Show To do \(2\)/ })).toBeInTheDocument();
	});

	it('rails: a collapsed rail opens into a panel with its drop areas while a card is dragged, and the area is the drop target', () => {
		setup({ defaultVariant: 'rails' });
		expect(screen.getByTestId('kanban-rail-doing')).toBeInTheDocument();

		const card = document.querySelector('[data-card-id="aaa11111"]') as HTMLElement;
		const dataTransfer = { setData: vi.fn(), getData: vi.fn(() => 'aaa11111'), effectAllowed: '', dropEffect: '' };
		fireEvent.dragStart(card, { dataTransfer });
		expect(screen.queryByTestId('kanban-rail-doing')).toBeNull();
		const area = screen.getByTestId('kanban-drop-area-doing');
		fireEvent.dragOver(area, { dataTransfer });
		fireEvent.drop(area, { dataTransfer });
		fireEvent.dragEnd(card, { dataTransfer });

		expect(onAction).toHaveBeenCalledWith(
			'moveCard',
			{ projectParam: 'p1', cardId: 'aaa11111', status: 'doing' },
			{ body: { status: 'doing' } }
		);
	});

	it('tabs: status tabs with counts, the list of the selected one, no drag', async () => {
		setup({ defaultVariant: 'tabs' });

		const tabs = screen.getAllByRole('tab');
		expect(tabs.map(t => t.textContent)).toEqual(['To do2', 'In progress1', 'Done5']);
		expect(screen.getByRole('tab', { name: /To do/ })).toHaveAttribute('aria-selected', 'true');
		expect(screen.getByRole('tabpanel')).toContainElement(document.querySelector('[data-card-id="aaa11111"]'));
		expect(document.querySelector('[draggable="true"]')).toBeNull();

		await userEvent.setup().click(screen.getByRole('tab', { name: /In progress/ }));

		expect(document.querySelector('[data-card-id="ccc33333"]')).not.toBeNull();
		expect(document.querySelector('[data-card-id="aaa11111"]')).toBeNull();
	});

	it('an unknown variant is a message naming the valid ones, not a board', () => {
		setup({ defaultVariant: 'kanbanish' as never });

		const alert = screen.getByRole('alert');
		expect(alert).toHaveTextContent('kanbanish');
		for (const name of VARIANTS) {
			expect(alert).toHaveTextContent(name);
		}
		expect(screen.queryByTestId('kanban-board')).toBeNull();
	});

	it('whole board empty shows emptyText', () => {
		const columns = sampleColumns().map(c => ({ ...c, cards: [], count: 0, hiddenCount: 0 }));
		setup({ columns, emptyText: 'Nothing here yet' });

		expect(screen.getByText('Nothing here yet')).toBeInTheDocument();
		expect(document.querySelector('[data-card-id]')).toBeNull();
	});

	it('malformed columns are reported with the cause, not drawn as empty', () => {
		setup({ columns: [{ status: 'x' }] as never });

		expect(screen.getByRole('alert')).toHaveTextContent(/columns/i);
	});
});

describe('KanbanBoard drag and drop', () => {
	it('dropping a card on another column runs the action with the card id, project and status', async () => {
		setup({ params: { extra: 'x' } });

		dragTo('aaa11111', column('doing'));

		expect(onAction).toHaveBeenCalledTimes(1);
		expect(onAction).toHaveBeenCalledWith(
			'moveCard',
			{ extra: 'x', projectParam: 'p1', cardId: 'aaa11111', status: 'doing' },
			{ body: { status: 'doing' } }
		);
		await waitFor(() => expect(cardIn('doing', 'aaa11111')).not.toBeNull());
	});

	it('cards are draggable, and a column that can take the dragged card is highlighted', () => {
		setup();
		const card = document.querySelector('[data-card-id="aaa11111"]') as HTMLElement;
		expect(card).toHaveAttribute('draggable', 'true');

		fireEvent.dragStart(card, { dataTransfer: { setData: vi.fn(), effectAllowed: '' } });
		fireEvent.dragOver(column('doing'), { dataTransfer: { dropEffect: '' } });

		expect(column('doing')).toHaveAttribute('data-drop-target', 'true');
		expect(column('todo')).not.toHaveAttribute('data-drop-target', 'true');
	});

	it('dropping on its own column does nothing', () => {
		setup();

		dragTo('aaa11111', column('todo'));

		expect(onAction).not.toHaveBeenCalled();
	});

	it('readOnly: nothing is draggable, no Move button, a drop does nothing', () => {
		setup({ readOnly: true });

		expect(document.querySelector('[draggable="true"]')).toBeNull();
		expect(screen.queryByRole('button', { name: /Move/ })).toBeNull();
		dragTo('aaa11111', column('doing'));
		expect(onAction).not.toHaveBeenCalled();
	});
});

describe('KanbanBoard keyboard move', () => {
	it('every card has a Move button that opens a list of the other statuses, arrow keys and Enter pick one', async () => {
		const user = userEvent.setup();
		setup();

		await user.click(
			within(cardIn('todo', 'aaa11111')!).getByRole('button', { name: 'Move aaa11111 to another status' })
		);

		const items = screen.getAllByRole('menuitem');
		expect(items.map(i => i.textContent)).toEqual(['doing', 'done']);
		expect(items[0]).toHaveFocus();
		await user.keyboard('{ArrowDown}');
		expect(items[1]).toHaveFocus();
		await user.keyboard('{ArrowDown}');
		expect(items[0]).toHaveFocus();
		await user.keyboard('{ArrowUp}{Enter}');

		expect(onAction).toHaveBeenCalledWith(
			'moveCard',
			{ projectParam: 'p1', cardId: 'aaa11111', status: 'done' },
			{ body: { status: 'done' } }
		);
		expect(screen.queryByRole('menu')).toBeNull();
	});

	it('Escape closes the menu and gives the focus back to its button', async () => {
		const user = userEvent.setup();
		setup();
		const button = within(cardIn('todo', 'bbb22222')!).getByRole('button', {
			name: 'Move bbb22222 to another status',
		});

		await user.click(button);
		await user.keyboard('{Escape}');

		expect(screen.queryByRole('menu')).toBeNull();
		expect(button).toHaveFocus();
		expect(button).toHaveAttribute('aria-expanded', 'false');
	});

	it.each(VARIANTS)('%s: a card can be moved with the menu', async variant => {
		const user = userEvent.setup();
		setup({ defaultVariant: variant });

		await user.click(screen.getByRole('button', { name: 'Move aaa11111 to another status' }));
		await user.click(screen.getByRole('menuitem', { name: 'done' }));

		expect(onAction).toHaveBeenCalledWith(
			'moveCard',
			{ projectParam: 'p1', cardId: 'aaa11111', status: 'done' },
			{ body: { status: 'done' } }
		);
	});
});

describe('KanbanBoard optimistic moves', () => {
	it('shows the card in the target column and busy while the request runs', async () => {
		const pending = deferred<undefined>();
		onAction.mockReturnValue(pending.promise);
		setup();

		dragTo('aaa11111', column('doing'));

		await waitFor(() => expect(cardIn('doing', 'aaa11111')).not.toBeNull());
		expect(cardIn('todo', 'aaa11111')).toBeNull();
		expect(cardIn('doing', 'aaa11111')).toHaveAttribute('aria-busy', 'true');
		expect(within(column('doing')).getByTestId('kanban-count')).toHaveTextContent('2');
		expect(within(column('todo')).getByTestId('kanban-count')).toHaveTextContent('1');
		await act(async () => pending.resolve(undefined));
	});

	it('puts the card back and only marks the failure: the page shows the reason, once', async () => {
		onAction.mockResolvedValue({ error: 'status done needs a resolution', status: 409 });
		setup();

		dragTo('aaa11111', column('done'));

		await waitFor(() => expect(cardIn('todo', 'aaa11111')).not.toBeNull());
		expect(cardIn('done', 'aaa11111')).toBeNull();
		expect(screen.queryByRole('alert')).toBeNull();
		const marker = screen.getByTestId('kanban-move-failed');
		expect(marker).toHaveTextContent('aaa11111');
		expect(marker).toHaveTextContent('went back');
		expect(marker).not.toHaveTextContent('needs a resolution');
		expect(within(column('todo')).getByTestId('kanban-count')).toHaveTextContent('2');
	});

	it('the marker also covers an action that threw', async () => {
		onAction.mockRejectedValue(new Error('Unexpected end of JSON input'));
		setup();

		dragTo('aaa11111', column('done'));

		expect(await screen.findByTestId('kanban-move-failed')).toHaveTextContent(/failed/i);
		expect(screen.queryByRole('alert')).toBeNull();
		expect(cardIn('todo', 'aaa11111')).not.toBeNull();
	});

	it('after a success it refetches the board and shows the server answer', async () => {
		const { calls } = stubFetch(() => jsonResponse(boardWithMove('aaa11111', 'doing', 'v2')));
		setup();

		dragTo('aaa11111', column('doing'));

		await waitFor(() => expect(calls).toHaveLength(1));
		expect(calls[0]!.url.pathname).toBe('/api/modules/task/tasks/board');
		expect(calls[0]!.url.searchParams.get('project')).toBe('p1');
		await waitFor(() => expect(cardIn('doing', 'aaa11111')).not.toBeNull());
		expect(screen.queryByRole('alert')).toBeNull();
	});

	it('goes back and says so when the refetch shows the card elsewhere than where it was moved', async () => {
		stubFetch(() => jsonResponse({ columns: sampleColumns(), version: 'v2' }));
		setup();

		dragTo('aaa11111', column('doing'));

		await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
		expect(screen.getByRole('alert')).toHaveTextContent('aaa11111');
		expect(screen.getByRole('alert')).toHaveTextContent('todo');
		expect(cardIn('todo', 'aaa11111')).not.toBeNull();
	});

	it('ignores a second move of a card whose first move is still running', async () => {
		const pending = deferred<undefined>();
		onAction.mockReturnValue(pending.promise);
		setup();

		dragTo('aaa11111', column('doing'));
		await waitFor(() => expect(cardIn('doing', 'aaa11111')).not.toBeNull());
		dragTo('aaa11111', column('done'));

		expect(onAction).toHaveBeenCalledTimes(1);
		await act(async () => pending.resolve(undefined));
	});
});

describe('KanbanBoard switcher', () => {
	it('is absent and reads no storage when variantSwitcher is off', () => {
		window.localStorage.setItem('task.kanban.variant', 'compact');
		const get = vi.spyOn(Storage.prototype, 'getItem');
		setup({ defaultVariant: 'rails' });

		expect(screen.queryByRole('toolbar')).toBeNull();
		expect(get).not.toHaveBeenCalled();
		expect(screen.getByTestId('kanban-board')).toHaveAttribute('data-variant', 'rails');
	});

	it('is a large fixed bar at the bottom center with the five variants, the active one marked', () => {
		setup({ variantSwitcher: true, defaultVariant: 'swimlanes' });

		const bar = screen.getByRole('toolbar', { name: /variant/i });
		expect(bar.className).toMatch(/fixed/);
		expect(bar.className).toMatch(/bottom-/);
		expect(bar.className).toMatch(/left-1\/2/);
		const buttons = within(bar).getAllByRole('button');
		expect(buttons).toHaveLength(5);
		expect(buttons.map(b => b.textContent)).toEqual(['1 Columns', '2 Swimlanes', '3 Compact', '4 Rails', '5 Tabs']);
		expect(within(bar).getByRole('button', { name: /Swimlanes/ })).toHaveAttribute('aria-pressed', 'true');
		expect(within(bar).getByRole('button', { name: /Columns/ })).toHaveAttribute('aria-pressed', 'false');
	});

	it('switches live and remembers the choice', async () => {
		setup({ variantSwitcher: true });

		await userEvent.setup().click(screen.getByRole('button', { name: /Compact/ }));

		expect(screen.getByTestId('kanban-board')).toHaveAttribute('data-variant', 'compact');
		expect(window.localStorage.getItem('task.kanban.variant')).toBe('compact');
	});

	it('starts from the stored choice, else from defaultVariant', () => {
		window.localStorage.setItem('task.kanban.variant', 'tabs');
		const { unmount } = setup({ variantSwitcher: true, defaultVariant: 'rails' });
		expect(screen.getByTestId('kanban-board')).toHaveAttribute('data-variant', 'tabs');
		unmount();

		window.localStorage.clear();
		setup({ variantSwitcher: true, defaultVariant: 'rails' });
		expect(screen.getByTestId('kanban-board')).toHaveAttribute('data-variant', 'rails');
	});

	it('a stored value that is not a variant is reported, and the default is used', () => {
		window.localStorage.setItem('task.kanban.variant', 'wide');
		setup({ variantSwitcher: true, defaultVariant: 'columns' });

		expect(screen.getByTestId('kanban-board')).toHaveAttribute('data-variant', 'columns');
		expect(screen.getByText(/"wide"/)).toBeInTheDocument();
	});
});
