import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sampleColumns } from '../kanban/boardFixtures.js';
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
			onAction={onAction}
			{...extra}
		/>
	);
}

const column = (status: string): HTMLElement => screen.getByTestId(`kanban-column-${status}`);
const cardIn = (status: string, id: string): HTMLElement | null =>
	column(status).querySelector(`[data-card-id="${id}"]`);

/** Drags card `id` and drops it on the drop band of `status` (the bands exist only while a card is dragged). */
function dragTo(id: string, status: string): void {
	const card = document.querySelector(`[data-card-id="${id}"]`) as HTMLElement;
	const dataTransfer = { setData: vi.fn(), getData: vi.fn(() => id), effectAllowed: '', dropEffect: '' };
	fireEvent.dragStart(card, { dataTransfer });
	const target = screen.queryByTestId(`kanban-drop-area-${status}`) ?? column(status);
	fireEvent.dragOver(target, { dataTransfer });
	fireEvent.drop(target, { dataTransfer });
	fireEvent.dragEnd(card, { dataTransfer });
}

describe('KanbanBoard columns', () => {
	it('draws every card with id and headline', () => {
		setup();

		for (const id of ALL_IDS) {
			expect(document.querySelector(`[data-card-id="${id}"]`)).not.toBeNull();
		}
		expect(screen.getByRole('link', { name: 'Write the spec' })).toHaveAttribute(
			'href',
			'/modules/task/tasks/p/p1/aaa11111'
		);
		expect(screen.getByText('aaa11111')).toBeInTheDocument();
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

		dragTo('aaa11111', 'doing');

		expect(onAction).toHaveBeenCalledTimes(1);
		expect(onAction).toHaveBeenCalledWith(
			'moveCard',
			{ extra: 'x', projectParam: 'p1', cardId: 'aaa11111', status: 'doing' },
			{ body: { status: 'doing' } }
		);
		await waitFor(() => expect(cardIn('doing', 'aaa11111')).not.toBeNull());
	});

	it('cards are draggable, and the band of a status that can take the dragged card is highlighted', () => {
		setup();
		const card = document.querySelector('[data-card-id="aaa11111"]') as HTMLElement;
		expect(card).toHaveAttribute('draggable', 'true');

		fireEvent.dragStart(card, { dataTransfer: { setData: vi.fn(), effectAllowed: '' } });
		fireEvent.dragOver(screen.getByTestId('kanban-drop-area-doing'), { dataTransfer: { dropEffect: '' } });

		expect(screen.getByTestId('kanban-drop-area-doing')).toHaveAttribute('data-drop-target', 'true');
		expect(screen.getByTestId('kanban-drop-area-todo')).not.toHaveAttribute('data-drop-target', 'true');
	});

	it('the column itself is no drop target: only its bands are', () => {
		setup();
		const card = document.querySelector('[data-card-id="aaa11111"]') as HTMLElement;
		const dataTransfer = { setData: vi.fn(), getData: vi.fn(() => 'aaa11111'), effectAllowed: '', dropEffect: '' };
		fireEvent.dragStart(card, { dataTransfer });
		fireEvent.dragOver(column('doing'), { dataTransfer });
		fireEvent.drop(column('doing'), { dataTransfer });

		expect(column('doing')).not.toHaveAttribute('data-drop-target');
		expect(onAction).not.toHaveBeenCalled();
	});

	it('dropping on its own column does nothing', () => {
		setup();

		dragTo('aaa11111', 'todo');

		expect(onAction).not.toHaveBeenCalled();
	});

	it('readOnly: nothing is draggable, no Move button, a drop does nothing', () => {
		setup({ readOnly: true });

		expect(document.querySelector('[draggable="true"]')).toBeNull();
		expect(screen.queryByRole('button', { name: /Move/ })).toBeNull();
		dragTo('aaa11111', 'doing');
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
});

describe('KanbanBoard optimistic moves', () => {
	it('shows the card in the target column and busy while the request runs', async () => {
		const pending = deferred<undefined>();
		onAction.mockReturnValue(pending.promise);
		setup();

		dragTo('aaa11111', 'doing');

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

		dragTo('aaa11111', 'done');

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

		dragTo('aaa11111', 'done');

		expect(await screen.findByTestId('kanban-move-failed')).toHaveTextContent(/failed/i);
		expect(screen.queryByRole('alert')).toBeNull();
		expect(cardIn('todo', 'aaa11111')).not.toBeNull();
	});

	it('after a success it refetches the board and shows the server answer', async () => {
		const { calls } = stubFetch(() => jsonResponse(boardWithMove('aaa11111', 'doing', 'v2')));
		setup();

		dragTo('aaa11111', 'doing');

		await waitFor(() => expect(calls).toHaveLength(1));
		expect(calls[0]!.url.pathname).toBe('/api/modules/task/tasks/board');
		expect(calls[0]!.url.searchParams.get('project')).toBe('p1');
		await waitFor(() => expect(cardIn('doing', 'aaa11111')).not.toBeNull());
		expect(screen.queryByRole('alert')).toBeNull();
	});

	it('goes back and says so when the refetch shows the card elsewhere than where it was moved', async () => {
		stubFetch(() => jsonResponse({ columns: sampleColumns(), version: 'v2' }));
		setup();

		dragTo('aaa11111', 'doing');

		await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
		expect(screen.getByRole('alert')).toHaveTextContent('aaa11111');
		expect(screen.getByRole('alert')).toHaveTextContent('todo');
		expect(cardIn('todo', 'aaa11111')).not.toBeNull();
	});

	it('ignores a second move of a card whose first move is still running', async () => {
		const pending = deferred<undefined>();
		onAction.mockReturnValue(pending.promise);
		setup();

		dragTo('aaa11111', 'doing');
		await waitFor(() => expect(cardIn('doing', 'aaa11111')).not.toBeNull());
		dragTo('aaa11111', 'done');

		expect(onAction).toHaveBeenCalledTimes(1);
		await act(async () => pending.resolve(undefined));
	});
});
