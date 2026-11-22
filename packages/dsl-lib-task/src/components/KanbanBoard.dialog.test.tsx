import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { groupedColumns, groupedLayout } from '../kanban/boardFixtures.js';
import { FakeEventSource, jsonResponse, stubFetch } from '../testHelpers.js';
import { KanbanBoard } from './KanbanBoard.js';

// "Configure columns" and "Configure cards" are modal dialogs over the board: the board stays drawn and live behind them.

let calls: ReturnType<typeof stubFetch>['calls'];
let putStatus: number;
let layout: { name: string; statuses: string[]; sort?: string }[];
let version: string;
let specTitle: string;

function answer() {
	return {
		columns: groupedColumns().map(column => ({
			...column,
			cards: column.cards.map(card => (card.id === 'aaa11111' ? { ...card, headline: specTitle } : card)),
		})),
		config: { isDefault: false, columns: layout },
		allStatuses: groupedLayout().allStatuses,
		version,
		hasCards: true,
		emptyText: null,
		warning: null,
	};
}

beforeEach(() => {
	FakeEventSource.reset();
	vi.stubGlobal('EventSource', FakeEventSource);
	window.localStorage.clear();
	layout = groupedLayout().columns;
	version = 'g1';
	specTitle = 'Write the spec';
	putStatus = 200;
	calls = stubFetch(call => {
		if (call.method === 'PUT' || call.method === 'DELETE') {
			if (putStatus !== 200) {
				return jsonResponse({ error: 'The server said no', hint: 'Try again' }, putStatus);
			}
			version = 'g2';
		}
		return jsonResponse(answer());
	}).calls;
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

function setup() {
	return render(
		<KanbanBoard
			columns={groupedColumns()}
			config={{ isDefault: false, columns: groupedLayout().columns }}
			allStatuses={groupedLayout().allStatuses}
			version="g1"
			projectParam="p1"
			apiBase="/api/modules/task"
			pollSeconds={3600}
		/>
	);
}

const trigger = (name: 'Configure columns' | 'Configure cards'): HTMLElement => screen.getByRole('button', { name });
const nameField = (index: number): HTMLInputElement =>
	within(screen.getAllByTestId('columns-editor-column')[index]!).getByRole('textbox') as HTMLInputElement;

describe('the editors are dialogs over the board', () => {
	it.each([
		['Configure columns', 'columns-editor'],
		['Configure cards', 'card-editor'],
	] as const)('%s opens a modal dialog with the board still drawn behind it', async (name, testId) => {
		const user = userEvent.setup();
		setup();
		await user.click(trigger(name));
		const dialog = screen.getByRole('dialog', { name });
		expect(dialog).toBe(screen.getByTestId(testId));
		expect(dialog).toHaveAttribute('aria-modal', 'true');
		// drawn on the body, not inside the board
		expect(screen.getByTestId('kanban-board').contains(dialog)).toBe(false);
		expect(screen.getByTestId('kanban-column-Doing')).toBeInTheDocument();
		expect(screen.getByTestId(`${testId}-footer`)).toContainElement(screen.getByRole('button', { name: 'Save' }));
		expect(document.body.style.overflow).toBe('hidden');
	});

	it('the other trigger is inert while a dialog is open, and both come back after', async () => {
		const user = userEvent.setup();
		setup();
		await user.click(trigger('Configure columns'));
		expect(trigger('Configure cards')).toBeDisabled();
		await user.keyboard('{Escape}');
		expect(trigger('Configure cards')).toBeEnabled();
		await user.click(trigger('Configure cards'));
		expect(trigger('Configure columns')).toBeDisabled();
	});

	it.each([
		['Configure columns', 'columns-editor'],
		['Configure cards', 'card-editor'],
	] as const)('%s: Escape with no change closes at once and the focus returns to its button', async (name, testId) => {
		const user = userEvent.setup();
		setup();
		await user.click(trigger(name));
		expect(screen.getByTestId(testId)).toHaveFocus();
		await user.keyboard('{Escape}');
		expect(screen.queryByTestId(testId)).toBeNull();
		expect(trigger(name)).toHaveFocus();
		expect(document.body.style.overflow).toBe('');
	});

	it('columns: a change makes Escape, Cancel, the X and the backdrop ask before discarding; Discard sends nothing', async () => {
		const user = userEvent.setup();
		setup();
		await user.click(trigger('Configure columns'));
		fireEvent.change(nameField(0), { target: { value: 'Queue' } });
		for (const close of [
			() => user.keyboard('{Escape}'),
			() => user.click(screen.getByRole('button', { name: 'Cancel' })),
			() => user.click(screen.getByRole('button', { name: 'Close' })),
			async () => fireEvent.click(screen.getByTestId('columns-editor-backdrop')),
		]) {
			await close();
			expect(screen.getByTestId('columns-editor-discard')).toHaveTextContent('Discard changes?');
			expect(screen.getByRole('button', { name: 'Keep editing' })).toHaveFocus();
			// the draft is still there
			expect(nameField(0).value).toBe('Queue');
			await user.click(screen.getByRole('button', { name: 'Keep editing' }));
			expect(screen.queryByTestId('columns-editor-discard')).toBeNull();
		}
		const before = calls.filter(call => call.method !== 'GET').length;
		await user.keyboard('{Escape}');
		await user.click(screen.getByRole('button', { name: 'Discard' }));
		expect(screen.queryByTestId('columns-editor')).toBeNull();
		expect(calls.filter(call => call.method !== 'GET')).toHaveLength(before);
		expect(trigger('Configure columns')).toHaveFocus();
		// reopened, the draft starts again from the stored columns
		await user.click(trigger('Configure columns'));
		expect(nameField(0).value).toBe('To do');
	});

	it('cards: a change makes Escape ask before discarding', async () => {
		const user = userEvent.setup();
		setup();
		await user.click(trigger('Configure cards'));
		await user.selectOptions(screen.getByRole('combobox', { name: 'Title lines' }), '3');
		await user.keyboard('{Escape}');
		expect(screen.getByTestId('card-editor-discard')).toBeInTheDocument();
		await user.click(screen.getByRole('button', { name: 'Discard' }));
		expect(screen.queryByTestId('card-editor')).toBeNull();
		expect(calls.filter(call => call.method !== 'GET')).toHaveLength(0);
	});

	it('columns: Save closes the dialog and the board shows the saved layout without a reload', async () => {
		const user = userEvent.setup();
		setup();
		await user.click(trigger('Configure columns'));
		fireEvent.change(nameField(0), { target: { value: 'Queue' } });
		layout = layout.map((column, index) => (index === 0 ? { ...column, name: 'Queue' } : column));
		await user.click(screen.getByRole('button', { name: 'Save' }));
		await waitFor(() => expect(screen.queryByTestId('columns-editor')).toBeNull());
		expect(calls.filter(call => call.method === 'PUT')).toHaveLength(1);
		expect(document.body.style.overflow).toBe('');
		expect(trigger('Configure columns')).toHaveFocus();
	});

	it('columns: a failed Save keeps the dialog open with the error next to the footer and the draft intact', async () => {
		const user = userEvent.setup();
		setup();
		await user.click(trigger('Configure columns'));
		fireEvent.change(nameField(0), { target: { value: 'Queue' } });
		putStatus = 400;
		await user.click(screen.getByRole('button', { name: 'Save' }));
		const alert = await screen.findByRole('alert');
		expect(alert).toHaveTextContent('The columns were not saved');
		expect(alert).toHaveTextContent('The server said no');
		expect(screen.getByTestId('columns-editor')).toContainElement(alert);
		expect(screen.getByTestId('columns-editor-body').contains(alert)).toBe(false);
		expect(nameField(0).value).toBe('Queue');
		expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
	});

	it('cards: a failed Save keeps the dialog open with the error', async () => {
		const user = userEvent.setup();
		setup();
		await user.click(trigger('Configure cards'));
		await user.selectOptions(screen.getByRole('combobox', { name: 'Title lines' }), '3');
		putStatus = 400;
		await user.click(screen.getByRole('button', { name: 'Save' }));
		expect(await screen.findByRole('alert')).toHaveTextContent('The cards were not saved');
		expect(screen.getByTestId('card-editor')).toBeInTheDocument();
	});

	it('cards: Save closes the dialog', async () => {
		const user = userEvent.setup();
		setup();
		await user.click(trigger('Configure cards'));
		await user.selectOptions(screen.getByRole('combobox', { name: 'Title lines' }), '3');
		await user.click(screen.getByRole('button', { name: 'Save' }));
		await waitFor(() => expect(screen.queryByTestId('card-editor')).toBeNull());
		expect(calls.filter(call => call.method === 'PUT')).toHaveLength(1);
	});

	it('a live refresh of the board does not reset the draft being edited', async () => {
		const user = userEvent.setup();
		setup();
		act(() => FakeEventSource.last().emit('open'));
		await user.click(trigger('Configure columns'));
		fireEvent.change(nameField(0), { target: { value: 'Queue' } });
		const getsBefore = calls.filter(call => call.method === 'GET').length;
		// another session changed a task and the layout: the board behind is fetched again
		version = 'g9';
		specTitle = 'Write the new spec';
		act(() => FakeEventSource.last().emit('version', 'g9'));
		await waitFor(() => expect(calls.filter(call => call.method === 'GET').length).toBeGreaterThan(getsBefore));
		await waitFor(() => expect(screen.getByText('Write the new spec')).toBeInTheDocument());
		// the draft keeps the user's edit (and the opening snapshot), and closing still asks
		expect(nameField(0).value).toBe('Queue');
		expect(screen.getByTestId('columns-editor')).toBeInTheDocument();
		await user.keyboard('{Escape}');
		expect(screen.getByTestId('columns-editor-discard')).toBeInTheDocument();
	});

	it('removes the scroll lock when the board goes away with a dialog open', async () => {
		const user = userEvent.setup();
		const { unmount } = setup();
		await user.click(trigger('Configure columns'));
		expect(document.body.style.overflow).toBe('hidden');
		unmount();
		expect(document.body.style.overflow).toBe('');
		expect(document.querySelector('[role="dialog"]')).toBeNull();
	});

	it('cards dialog is the wide one, columns dialog the standard one; both are full screen on a phone', async () => {
		const user = userEvent.setup();
		setup();
		await user.click(trigger('Configure columns'));
		expect(screen.getByTestId('columns-editor').className).toMatch(/max-w-4xl/);
		expect(screen.getByTestId('columns-editor').className).toMatch(/\bh-full\b/);
		await user.keyboard('{Escape}');
		await user.click(trigger('Configure cards'));
		expect(screen.getByTestId('card-editor').className).toMatch(/max-w-5xl/);
		expect(screen.getByTestId('card-editor-backdrop').className).toMatch(/\bp-0\b/);
	});
});
