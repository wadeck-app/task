import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { groupedColumns, groupedLayout } from '../kanban/boardFixtures.js';
import { FakeEventSource, jsonResponse, stubFetch } from '../testHelpers.js';
import { KanbanBoard } from './KanbanBoard.js';

// The layout of the cards (`config.card`): drawn by the board, edited with "Configure cards" (PUT / DELETE /board/card).

let calls: ReturnType<typeof stubFetch>['calls'];
let stored: Record<string, unknown> | undefined;

function answer() {
	return {
		columns: groupedColumns().map(column => ({
			...column,
			cards: column.cards.map(card => ({ ...card, assignee: 'Ada Lovelace', priority: 'high', priorityText: 'High' })),
		})),
		config: { isDefault: false, columns: groupedLayout().columns, ...(stored === undefined ? {} : { card: stored }) },
		allStatuses: groupedLayout().allStatuses,
		version: stored === undefined ? 'v1' : 'v2',
	};
}

beforeEach(() => {
	stored = undefined;
	FakeEventSource.reset();
	vi.stubGlobal('EventSource', FakeEventSource);
	window.localStorage.clear();
	calls = stubFetch(call => {
		if (call.method === 'PUT' && call.url.pathname.endsWith('/board/card')) {
			stored = JSON.parse(call.body ?? '{}') as Record<string, unknown>;
			return jsonResponse(answer());
		}
		if (call.method === 'DELETE' && call.url.pathname.endsWith('/board/card')) {
			stored = undefined;
			return jsonResponse(answer());
		}
		return jsonResponse(answer());
	}).calls;
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

function setup(card?: unknown, extra: Partial<React.ComponentProps<typeof KanbanBoard>> = {}) {
	return render(
		<KanbanBoard
			columns={answer().columns}
			config={{ isDefault: false, columns: groupedLayout().columns, ...(card === undefined ? {} : { card }) } as never}
			allStatuses={groupedLayout().allStatuses}
			version="v1"
			projectParam="p1"
			apiBase="/api/modules/task"
			{...extra}
		/>
	);
}

const cards = (): HTMLElement[] => screen.getAllByTestId('kanban-card');

describe('the board draws the saved card layout', () => {
	it('without a layout the cards look as before (priority pill, assignee text, id)', () => {
		setup();
		const first = cards()[0]!;
		expect(within(first).getByText('aaa11111')).toBeInTheDocument();
		expect(within(first).getByText('High')).toBeInTheDocument();
		expect(within(first).queryByTestId('card-meta')).toBeNull();
	});

	it('with a layout the cards draw its fields in order', () => {
		setup({
			titleLines: 3,
			fields: [{ field: 'assignee', style: 'initials' }, { field: 'priority', style: 'dot' }],
		});
		const first = cards()[0]!;
		expect(
			within(first)
				.getAllByTestId(/^card-field-/)
				.map(el => el.getAttribute('data-testid'))
		).toEqual(['card-field-assignee', 'card-field-priority']);
		expect(within(first).getByTestId('card-field-assignee')).toHaveTextContent('AL');
		expect(within(first).getByTestId('kanban-card-title')).toHaveClass('line-clamp-3');
	});

	it('status auto follows the column: shown in the column that groups statuses only', () => {
		setup({ fields: [{ field: 'status' }] });
		const doing = screen.getByTestId('kanban-column-Doing');
		expect(within(doing).getAllByTestId('card-field-status')).toHaveLength(2);
		expect(within(screen.getByTestId('kanban-column-To do')).queryByTestId('card-field-status')).toBeNull();
	});
});

describe('Configure cards', () => {
	it('is a button next to Configure columns, with the same look', () => {
		setup();
		const cardsButton = screen.getByRole('button', { name: 'Configure cards' });
		const columnsButton = screen.getByRole('button', { name: 'Configure columns' });
		expect(cardsButton.className).toBe(columnsButton.className);
		expect(cardsButton.nextElementSibling === columnsButton || columnsButton.nextElementSibling === cardsButton).toBe(true);
	});

	it('is absent on a read-only board', () => {
		setup(undefined, { readOnly: true });
		expect(screen.queryByRole('button', { name: 'Configure cards' })).toBeNull();
	});

	it('opens the editor in place of the board, with a preview of three cards', async () => {
		setup();
		await userEvent.setup().click(screen.getByRole('button', { name: 'Configure cards' }));
		expect(screen.getByTestId('card-editor')).toBeInTheDocument();
		expect(screen.queryByTestId('kanban-column-Doing')).toBeNull();
		expect(screen.getAllByTestId('kanban-card-preview')).toHaveLength(3);
		expect(screen.queryByRole('button', { name: 'Configure columns' })).toBeNull();
	});

	it('Cancel goes back to the board without a request', async () => {
		setup();
		const user = userEvent.setup();
		await user.click(screen.getByRole('button', { name: 'Configure cards' }));
		const before = calls.length;
		await user.click(screen.getByRole('button', { name: 'Cancel' }));
		expect(screen.queryByTestId('card-editor')).toBeNull();
		expect(screen.getByTestId('kanban-column-Doing')).toBeInTheDocument();
		expect(calls.length).toBe(before);
	});

	it('Save sends PUT /board/card with the project and the layout, then the board shows it without a reload', async () => {
		setup();
		const user = userEvent.setup();
		await user.click(screen.getByRole('button', { name: 'Configure cards' }));
		await user.click(screen.getByRole('checkbox', { name: 'Show priority' }));
		await user.selectOptions(screen.getByRole('combobox', { name: 'Title lines' }), '1');
		await user.click(screen.getByRole('button', { name: 'Save' }));
		await waitFor(() => expect(screen.queryByTestId('card-editor')).toBeNull());
		const put = calls.find(call => call.method === 'PUT')!;
		expect(put.url.pathname).toBe('/api/modules/task/board/card');
		expect(put.url.searchParams.get('project')).toBe('p1');
		expect(JSON.parse(put.body!)).toEqual({
			titleLines: 1,
			fields: [{ field: 'id' }, { field: 'assignee' }, { field: 'status' }],
		});
		// The board is drawn from the saved layout: no priority, one title line.
		await waitFor(() => expect(within(cards()[0]!).getByTestId('kanban-card-title')).toHaveClass('line-clamp-1'));
		expect(within(cards()[0]!).queryByTestId('card-field-priority')).toBeNull();
		expect(within(cards()[0]!).getByTestId('card-field-assignee')).toHaveTextContent('Ada Lovelace');
	});

	it('Reset to the usual card sends DELETE /board/card and the board is back to the usual card', async () => {
		stored = { titleLines: 1, fields: [{ field: 'priority' }] };
		setup(stored);
		const user = userEvent.setup();
		expect(within(cards()[0]!).queryByText('aaa11111')).toBeNull();
		await user.click(screen.getByRole('button', { name: 'Configure cards' }));
		await user.click(screen.getByRole('button', { name: 'Reset to the usual card' }));
		await waitFor(() => expect(screen.queryByTestId('card-editor')).toBeNull());
		const del = calls.find(call => call.method === 'DELETE')!;
		expect(del.url.pathname).toBe('/api/modules/task/board/card');
		expect(del.url.searchParams.get('project')).toBe('p1');
		await waitFor(() => expect(within(cards()[0]!).getByText('aaa11111')).toBeInTheDocument());
	});

	it('a refused save stays in the editor with the message and hint of the server', async () => {
		stubFetch(call => {
			if (call.method === 'PUT') {
				return jsonResponse(
					{ error: 'board.card.fields[0].style: "huge" is not a style of priority.', hint: 'Valid styles: pill, text, dot.' },
					400
				);
			}
			return jsonResponse(answer());
		});
		setup();
		const user = userEvent.setup();
		await user.click(screen.getByRole('button', { name: 'Configure cards' }));
		await user.click(screen.getByRole('checkbox', { name: 'Show created' }));
		await user.click(screen.getByRole('button', { name: 'Save' }));
		const alert = await screen.findByRole('alert');
		expect(alert).toHaveTextContent('The cards were not saved');
		expect(alert).toHaveTextContent('"huge" is not a style of priority');
		expect(alert).toHaveTextContent('Valid styles: pill, text, dot.');
		expect(screen.getByTestId('card-editor')).toBeInTheDocument();
		// The draft is kept.
		expect(screen.getByRole('checkbox', { name: 'Show created' })).toBeChecked();
	});

	it('a refused reset says so', async () => {
		stubFetch(call =>
			call.method === 'DELETE'
				? jsonResponse({ error: 'The board config could not be written.', hint: 'Check the folder is writable.' }, 500)
				: jsonResponse(answer())
		);
		setup({ titleLines: 1 });
		const user = userEvent.setup();
		await user.click(screen.getByRole('button', { name: 'Configure cards' }));
		await user.click(screen.getByRole('button', { name: 'Reset to the usual card' }));
		expect(await screen.findByRole('alert')).toHaveTextContent('The cards were not reset');
	});

	it('picks up a layout saved elsewhere through the live refresh', async () => {
		setup();
		stored = { fields: [{ field: 'created' }] };
		const source = FakeEventSource.instances[0]!;
		source.emit('version', 'v2');
		await waitFor(() => expect(within(cards()[0]!).queryByText('High')).toBeNull());
	});
});
