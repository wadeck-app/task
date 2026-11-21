import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sortedColumns, sortedLayout } from '../kanban/boardFixtures.js';
import type { BoardColumnData, LayoutColumn } from '../kanban/boardModel.js';
import { FakeEventSource, jsonResponse, stubFetch } from '../testHelpers.js';
import { KanbanBoard } from './KanbanBoard.js';

// The one look of a group of cards (a column sorted by status, priority or assignee): a rule with the group name in a pill
// centred on it (D24). A `groupStyle` an older build saved is ignored on the board and never sent again.

/** sortedColumns() where "Doing" (sorted by assignee: ann x2, bob x1) carries a legacy `groupStyle` key, as an old answer could. */
function legacyColumns(): BoardColumnData[] {
	return sortedColumns().map(column =>
		column.key === 'Doing' ? ({ ...column, groupStyle: 'boxed' } as unknown as BoardColumnData) : column
	);
}

function legacyLayout(): LayoutColumn[] {
	return sortedLayout().columns.map(column =>
		column.name === 'Doing' ? ({ ...column, groupStyle: 'boxed' } as unknown as LayoutColumn) : column
	);
}

let calls: ReturnType<typeof stubFetch>['calls'];

beforeEach(() => {
	FakeEventSource.reset();
	vi.stubGlobal('EventSource', FakeEventSource);
	window.localStorage.clear();
	calls = stubFetch(() => jsonResponse({ columns: sortedColumns(), version: 's1' })).calls;
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	window.localStorage.clear();
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
			{...extra}
		/>
	);
}

const column = (key: string): HTMLElement => screen.getByTestId(`kanban-column-${key}`);
const separators = (key: string): HTMLElement[] => within(column(key)).queryAllByRole('separator');
const putBody = (): { columns: Array<Record<string, unknown>> } =>
	JSON.parse(calls.find(call => call.method === 'PUT')!.body!);

describe('groups on the board: a rule with a centred pill', () => {
	it('every group opens with a separator named by the group and its count', () => {
		setup();
		const doing = separators('Doing');
		expect(doing.map(entry => entry.getAttribute('aria-label'))).toEqual(['ann, 2 cards', 'bob, 1 card']);
	});

	it('the separator is a rule on both sides of the name, the name in a rounded pill', () => {
		setup();
		const [first] = separators('Doing');
		const pill = within(first!).getByText('ann');
		expect(pill.className).toMatch(/\brounded-full\b/);
		expect(first!.querySelectorAll('.h-px')).toHaveLength(2);
	});

	it('a legacy groupStyle in the answer changes nothing: still the pill, no box, no tinted panel', () => {
		setup({ columns: legacyColumns(), config: { isDefault: false, columns: legacyLayout() } });
		const [first] = separators('Doing');
		expect(within(first!).getByText('ann').className).toMatch(/\brounded-full\b/);
		expect(screen.queryAllByTestId('kanban-group')).toHaveLength(0);
	});

	it('a group takes a stable tone from its name; a status group takes the tone of its status', () => {
		const byStatus = sortedColumns().map(entry =>
			entry.key === 'Doing'
				? {
						...entry,
						sort: 'status' as const,
						cards: entry.cards.map(card => ({ ...card, group: card.status })),
					}
				: entry
		);
		const first = setup({ columns: byStatus });
		// doing (info) then review (warning): the groups follow the status order of the column
		expect(separators('Doing').map(entry => entry.getAttribute('data-tone'))).toEqual(['info', 'warning']);
		first.unmount();

		const second = setup();
		const once = separators('Doing').map(entry => entry.getAttribute('data-tone'));
		expect(once.every(tone => ['neutral', 'info', 'success', 'warning', 'danger', 'purple'].includes(tone!))).toBe(
			true
		);
		second.unmount();
		setup();
		expect(separators('Doing').map(entry => entry.getAttribute('data-tone'))).toEqual(once);
	});

	it('no group chrome at all on a column whose cards carry no group', () => {
		setup();
		for (const key of ['To do', 'Closed']) {
			expect(separators(key)).toHaveLength(0);
		}
	});
});

describe('Configure columns has no group style', () => {
	it('no "Group style" select on any column', async () => {
		const user = userEvent.setup();
		setup();
		await user.click(screen.getByTestId('kanban-configure'));
		expect(screen.queryByRole('combobox', { name: /^Group style of column/ })).toBeNull();
		expect(screen.queryByText('Group style')).toBeNull();
	});

	it('Save never sends groupStyle, even when the stored layout still has one', async () => {
		const user = userEvent.setup();
		setup({ config: { isDefault: false, columns: legacyLayout() } });
		await user.click(screen.getByTestId('kanban-configure'));
		await user.click(screen.getByRole('button', { name: 'Save' }));
		await waitFor(() => expect(calls.some(call => call.method === 'PUT')).toBe(true));
		expect(putBody()).toEqual({
			columns: [
				{ name: 'To do', statuses: ['todo'] },
				{ name: 'Doing', statuses: ['doing', 'review'], sort: 'assignee' },
				{ name: 'Closed', statuses: ['done', 'rejected'], sort: 'newest' },
			],
		});
	});

	it('a sort picked on the board drops a legacy groupStyle of the stored layout (page prop)', async () => {
		const user = userEvent.setup();
		setup({ config: { isDefault: false, columns: legacyLayout() } });
		await user.click(screen.getByRole('button', { name: 'Sort column Doing' }));
		await user.click(screen.getByRole('menuitemradio', { name: 'Priority' }));
		await waitFor(() => expect(calls.some(call => call.method === 'PUT')).toBe(true));
		expect(putBody().columns[1]).toEqual({ name: 'Doing', statuses: ['doing', 'review'], sort: 'priority' });
	});

	it('a sort picked on the board drops a legacy groupStyle of a fetched answer too', async () => {
		calls = stubFetch(() =>
			jsonResponse({
				columns: legacyColumns(),
				config: { isDefault: false, columns: legacyLayout() },
				allStatuses: sortedLayout().allStatuses,
				version: 's1',
			})
		).calls;
		const user = userEvent.setup();
		render(<KanbanBoard projectParam="p1" apiBase="/api/modules/task" />);
		await screen.findByTestId('kanban-column-Doing');
		await user.click(screen.getByRole('button', { name: 'Sort column Doing' }));
		await user.click(screen.getByRole('menuitemradio', { name: 'Priority' }));
		await waitFor(() => expect(calls.some(call => call.method === 'PUT')).toBe(true));
		expect(putBody().columns[1]).toEqual({ name: 'Doing', statuses: ['doing', 'review'], sort: 'priority' });
	});
});
