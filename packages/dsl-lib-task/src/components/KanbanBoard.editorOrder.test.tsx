import { act, createEvent, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { groupedColumns, groupedLayout } from '../kanban/boardFixtures.js';
import { FakeEventSource, jsonResponse, stubFetch } from '../testHelpers.js';
import { KanbanBoard } from './KanbanBoard.js';

// "Configure columns": the order of the statuses inside a column (it IS the order on the board), the insertion indicator while
// a chip is dragged, the keyboard way to reorder, and where a moved status landed (highlight, live text, board preview).

let calls: ReturnType<typeof stubFetch>['calls'];

beforeEach(() => {
	FakeEventSource.reset();
	vi.stubGlobal('EventSource', FakeEventSource);
	window.localStorage.clear();
	calls = stubFetch(() =>
		jsonResponse({
			columns: groupedColumns(),
			config: { isDefault: false, columns: groupedLayout().columns },
			allStatuses: groupedLayout().allStatuses,
			version: 'g1',
		})
	).calls;
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

/** The editor opened on the grouped layout: To do [todo], Doing [doing, review], Closed [done, rejected]; parked is hidden. */
function open(): void {
	render(
		<KanbanBoard
			columns={groupedColumns()}
			config={{ isDefault: false, columns: groupedLayout().columns }}
			allStatuses={groupedLayout().allStatuses}
			version="g1"
			projectParam="p1"
			apiBase="/api/modules/task"
		/>
	);
	fireEvent.click(screen.getByTestId('kanban-configure'));
}

const rows = (): HTMLElement[] => screen.getAllByTestId('columns-editor-column');
const chipsOf = (index: number): string[] =>
	Array.from(rows()[index]!.querySelectorAll('[data-testid^="columns-editor-chip-"]')).map(chip =>
		chip.getAttribute('data-testid')!.replace('columns-editor-chip-', '')
	);
const chip = (status: string): HTMLElement => screen.getByTestId(`columns-editor-chip-${status}`);
const announce = (): HTMLElement => screen.getByTestId('columns-editor-announce');
const transfer = () => ({ setData: vi.fn(), effectAllowed: '', dropEffect: '' });

/** A dragover at `clientX` (jsdom has no DragEvent, so the coordinate is set on the event by hand). */
function dragOverAt(target: HTMLElement, clientX: number, dataTransfer: ReturnType<typeof transfer>): void {
	const event = createEvent.dragOver(target, { dataTransfer });
	Object.defineProperty(event, 'clientX', { value: clientX });
	// jsdom lays nothing out: a chip is 100 px wide from 0, so its middle is at 50
	vi.spyOn(target, 'getBoundingClientRect').mockReturnValue({
		left: 0,
		right: 100,
		width: 100,
		top: 0,
		bottom: 32,
		height: 32,
		x: 0,
		y: 0,
		toJSON: () => ({}),
	});
	fireEvent(target, event);
}

async function savedColumns(): Promise<Array<{ name: string; statuses: string[] }>> {
	fireEvent.click(screen.getByRole('button', { name: 'Save' }));
	await waitFor(() => expect(calls.some(call => call.method === 'PUT')).toBe(true));
	return (
		JSON.parse(calls.find(call => call.method === 'PUT')!.body!) as {
			columns: Array<{ name: string; statuses: string[] }>;
		}
	).columns;
}

describe('the editor keeps and sends the order of the statuses', () => {
	it('starts from the stored order, and Save sends the order the user arranged', async () => {
		open();
		expect(chipsOf(1)).toEqual(['doing', 'review']);
		fireEvent.click(screen.getByRole('button', { name: 'Move review earlier in Doing' }));
		expect(chipsOf(1)).toEqual(['review', 'doing']);

		const columns = await savedColumns();
		expect(columns[1]).toEqual({ name: 'Doing', statuses: ['review', 'doing'] });
	});
});

describe('reorder with the buttons and the keyboard', () => {
	it('each chip has "earlier" and "later" buttons; the first cannot go earlier, the last cannot go later', () => {
		open();
		expect(screen.getByRole('button', { name: 'Move doing earlier in Doing' })).toBeDisabled();
		expect(screen.getByRole('button', { name: 'Move doing later in Doing' })).toBeEnabled();
		expect(screen.getByRole('button', { name: 'Move review later in Doing' })).toBeDisabled();
		// a one-status column: both off
		expect(screen.getByRole('button', { name: 'Move todo earlier in To do' })).toBeDisabled();
		expect(screen.getByRole('button', { name: 'Move todo later in To do' })).toBeDisabled();
	});

	it('Right and Left arrows on a focused chip move it later and earlier; the focus stays on the chip', async () => {
		const user = userEvent.setup();
		open();
		chip('doing').focus();
		expect(chip('doing')).toHaveFocus();

		await user.keyboard('{ArrowRight}');
		expect(chipsOf(1)).toEqual(['review', 'doing']);
		expect(chip('doing')).toHaveFocus();

		await user.keyboard('{ArrowLeft}');
		expect(chipsOf(1)).toEqual(['doing', 'review']);
		expect(chip('doing')).toHaveFocus();
	});

	it('an arrow at the end of the column does nothing', async () => {
		const user = userEvent.setup();
		open();
		chip('review').focus();
		await user.keyboard('{ArrowRight}');
		expect(chipsOf(1)).toEqual(['doing', 'review']);
	});

	it('arrows inside the column select of a chip do not reorder', () => {
		open();
		const select = within(chip('doing')).getByRole('combobox', { name: 'Column of status doing' });
		fireEvent.keyDown(select, { key: 'ArrowRight' });
		expect(chipsOf(1)).toEqual(['doing', 'review']);
	});
});

describe('drag a chip to an exact place', () => {
	it('over the left half of a chip: an accent bar shows BEFORE it, and the drop lands there (same column)', () => {
		open();
		const data = transfer();
		fireEvent.dragStart(chip('review'), { dataTransfer: data });
		dragOverAt(chip('doing'), 10, data);

		const bar = within(chip('doing')).getByTestId('columns-editor-insert');
		expect(bar).toHaveAttribute('data-side', 'before');
		expect(bar.className).toMatch(/\bbg-primary\b/);
		expect(bar.className).toMatch(/\babsolute\b/);
		expect(screen.getAllByTestId('columns-editor-insert')).toHaveLength(1);

		fireEvent.drop(chip('doing'), { dataTransfer: data });
		expect(chipsOf(1)).toEqual(['review', 'doing']);
		expect(screen.queryByTestId('columns-editor-insert')).toBeNull();
	});

	it('over the right half of a chip of ANOTHER column: the bar shows AFTER it, and the status lands after it', () => {
		open();
		const data = transfer();
		fireEvent.dragStart(chip('todo'), { dataTransfer: data });
		dragOverAt(chip('done'), 90, data);

		expect(within(chip('done')).getByTestId('columns-editor-insert')).toHaveAttribute('data-side', 'after');
		fireEvent.drop(chip('done'), { dataTransfer: data });
		expect(chipsOf(2)).toEqual(['done', 'todo', 'rejected']);
		expect(chipsOf(0)).toEqual([]);
	});

	it('before the first chip of another column', () => {
		open();
		const data = transfer();
		fireEvent.dragStart(chip('review'), { dataTransfer: data });
		dragOverAt(chip('done'), 5, data);
		fireEvent.drop(chip('done'), { dataTransfer: data });
		expect(chipsOf(2)).toEqual(['review', 'done', 'rejected']);
		expect(chipsOf(1)).toEqual(['doing']);
	});

	it('over the body of a column (not a chip): the bar shows after the last chip and the drop appends', () => {
		open();
		const data = transfer();
		fireEvent.dragStart(chip('todo'), { dataTransfer: data });
		fireEvent.dragOver(rows()[1]!, { dataTransfer: data });

		const bar = within(chip('review')).getByTestId('columns-editor-insert');
		expect(bar).toHaveAttribute('data-side', 'after');
		fireEvent.drop(rows()[1]!, { dataTransfer: data });
		expect(chipsOf(1)).toEqual(['doing', 'review', 'todo']);
	});

	it('the bar goes away when the drag ends without a drop', () => {
		open();
		const data = transfer();
		fireEvent.dragStart(chip('review'), { dataTransfer: data });
		dragOverAt(chip('doing'), 10, data);
		fireEvent.dragEnd(chip('review'), { dataTransfer: data });
		expect(screen.queryByTestId('columns-editor-insert')).toBeNull();
		expect(chipsOf(1)).toEqual(['doing', 'review']);
	});

	it('a column dragged by its handle over a chip still reorders the columns (no insertion bar)', () => {
		open();
		const data = transfer();
		fireEvent.dragStart(within(rows()[2]!).getByTestId('columns-editor-handle'), { dataTransfer: data });
		dragOverAt(chip('todo'), 10, data);
		expect(screen.queryByTestId('columns-editor-insert')).toBeNull();
		fireEvent.drop(chip('todo'), { dataTransfer: data });
		expect(rows().map(row => (within(row).getByRole('textbox') as HTMLInputElement).value)).toEqual([
			'Closed',
			'To do',
			'Doing',
		]);
	});
});

describe('where a moved status landed', () => {
	it('the moved chip is ringed in the accent for about 1.5 s, with no layout shift (a ring, not a border)', () => {
		vi.useFakeTimers();
		open();
		fireEvent.click(screen.getByRole('button', { name: 'Move review earlier in Doing' }));

		expect(chip('review')).toHaveAttribute('data-recent', 'true');
		// a plain ring (not the focus-visible one every chip has): box-shadow, so nothing moves
		const plain = (name: string): RegExp => new RegExp(`(^|\\s)${name}(\\s|$)`);
		expect(chip('review').className).toMatch(plain('ring-2'));
		expect(chip('review').className).toMatch(plain('ring-primary'));
		expect(chip('review').className).not.toMatch(plain('border-2'));
		expect(chip('doing')).not.toHaveAttribute('data-recent');

		act(() => {
			vi.advanceTimersByTime(1600);
		});
		expect(chip('review')).not.toHaveAttribute('data-recent');
		expect(chip('review').className).not.toMatch(plain('ring-primary'));
	});

	it('a polite live region says where it is: column and position', () => {
		open();
		const region = announce();
		expect(region).toHaveAttribute('role', 'status');
		expect(region.className).toMatch(/\bsr-only\b/);
		expect(region).toHaveTextContent('');

		fireEvent.click(screen.getByRole('button', { name: 'Move review earlier in Doing' }));
		expect(announce()).toHaveTextContent('review is now in column Doing, position 1 of 2');
	});

	it('after a pick in the column select of a chip', () => {
		open();
		const select = screen.getByRole('combobox', { name: 'Column of status review' });
		fireEvent.change(select, {
			target: { value: within(select).getByRole<HTMLOptionElement>('option', { name: 'Closed' }).value },
		});
		expect(announce()).toHaveTextContent('review is now in column Closed, position 3 of 3');
		expect(chip('review')).toHaveAttribute('data-recent', 'true');
	});

	it('after "Add status"', () => {
		open();
		fireEvent.change(screen.getByRole('combobox', { name: 'Add a status to column To do' }), {
			target: { value: 'parked' },
		});
		expect(announce()).toHaveTextContent('parked is now in column To do, position 2 of 2');
		expect(chip('parked')).toHaveAttribute('data-recent', 'true');
	});

	it('after a drag', () => {
		open();
		const data = transfer();
		fireEvent.dragStart(chip('todo'), { dataTransfer: data });
		dragOverAt(chip('done'), 90, data);
		fireEvent.drop(chip('done'), { dataTransfer: data });
		expect(announce()).toHaveTextContent('todo is now in column Closed, position 2 of 3');
		expect(chip('todo')).toHaveAttribute('data-recent', 'true');
	});

	it('after "Hide (no column)"', () => {
		open();
		fireEvent.change(screen.getByRole('combobox', { name: 'Column of status review' }), {
			target: { value: '__hide__' },
		});
		expect(announce()).toHaveTextContent('review is now hidden (no column)');
	});
});

describe('the board preview', () => {
	const preview = (): HTMLElement => screen.getByRole('group', { name: 'Board preview' });
	const boxes = (): HTMLElement[] => within(preview()).getAllByTestId('columns-editor-preview-column');
	const chipsIn = (box: HTMLElement): string[] =>
		within(box)
			.queryAllByTestId('columns-editor-preview-status')
			.map(element => element.textContent ?? '');

	it('stacks on a narrow width (no sideways scroll, boxes full width) and scrolls in a row from sm up', () => {
		open();
		const list = boxes()[0]!.parentElement!;
		expect(list).toHaveClass('flex-col', 'sm:flex-row', 'sm:overflow-x-auto');
		expect(list).not.toHaveClass('overflow-x-auto');
		for (const box of boxes()) {
			expect(box).toHaveClass('w-full', 'sm:w-36');
		}
	});

	it('a status chip of the editor wraps on a narrow width (name readable, column select on its own line) and keeps one line from sm up', () => {
		open();
		const chip = screen.getByRole('combobox', { name: 'Column of status review' }).parentElement!;
		expect(chip).toHaveClass('flex-wrap', 'sm:flex-nowrap', 'sm:h-8');
		expect(screen.getByRole('combobox', { name: 'Column of status review' })).toHaveClass('w-full', 'sm:w-auto');
	});

	it('sits at the top of the editor: one box per column in order, with its name, its sort and its statuses in order', () => {
		open();
		const editor = screen.getByTestId('columns-editor');
		const first = editor.querySelector(
			'[data-testid="columns-editor-preview"], [data-testid="columns-editor-column"]'
		);
		expect(first).toHaveAttribute('data-testid', 'columns-editor-preview');

		expect(boxes().map(box => within(box).getByTestId('columns-editor-preview-name').textContent)).toEqual([
			'To do',
			'Doing',
			'Closed',
		]);
		expect(chipsIn(boxes()[1]!)).toEqual(['doing', 'review']);
		expect(within(boxes()[1]!).getByTestId('columns-editor-preview-sort')).toHaveTextContent('Default order');
	});

	it('hidden statuses are in a muted "Hidden" box at the end', () => {
		open();
		const hidden = within(preview()).getByTestId('columns-editor-preview-hidden');
		expect(hidden).toHaveTextContent('Hidden');
		expect(chipsIn(hidden)).toEqual(['parked']);
		expect(hidden.className).toMatch(/\btext-muted\b/);
		const all = Array.from(preview().querySelectorAll('[data-testid^="columns-editor-preview-"]')).filter(element =>
			['columns-editor-preview-column', 'columns-editor-preview-hidden'].includes(
				element.getAttribute('data-testid')!
			)
		);
		expect(all[all.length - 1]).toBe(hidden);
	});

	it('follows every change at once: reorder, move, sort, rename, new column', () => {
		open();
		fireEvent.click(screen.getByRole('button', { name: 'Move review earlier in Doing' }));
		expect(chipsIn(boxes()[1]!)).toEqual(['review', 'doing']);

		fireEvent.change(screen.getByRole('combobox', { name: 'Sort of column Doing' }), {
			target: { value: 'priority' },
		});
		expect(within(boxes()[1]!).getByTestId('columns-editor-preview-sort')).toHaveTextContent('Priority');

		fireEvent.change(within(rows()[0]!).getByRole('textbox'), { target: { value: 'Backlog' } });
		expect(within(boxes()[0]!).getByTestId('columns-editor-preview-name')).toHaveTextContent('Backlog');

		fireEvent.click(screen.getByRole('button', { name: 'Add column' }));
		expect(boxes()).toHaveLength(4);
		expect(chipsIn(boxes()[3]!)).toEqual([]);
	});

	it('no hidden box when every status is in a column', () => {
		open();
		fireEvent.change(screen.getByRole('combobox', { name: 'Add a status to column To do' }), {
			target: { value: 'parked' },
		});
		expect(within(preview()).queryByTestId('columns-editor-preview-hidden')).toBeNull();
	});
});
