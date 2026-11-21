import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AbExperiments } from '@wadeck-app/dsl-ui';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sortedColumns, sortedLayout } from '../kanban/boardFixtures.js';
import { GROUP_STYLES } from '../kanban/boardModel.js';
import type { BoardColumnData, GroupStyle, LayoutColumn } from '../kanban/boardModel.js';
import { FakeEventSource, jsonResponse, stubFetch } from '../testHelpers.js';
import { KanbanBoard } from './KanbanBoard.js';

// The eight styles of the chrome that opens a group of cards (a column sorted by status, priority or assignee).

/** sortedColumns() with the group style `style` on "Doing" (the column sorted by assignee: ann x2, bob x1). */
function styled(style: GroupStyle | undefined): BoardColumnData[] {
	return sortedColumns().map(column =>
		column.key === 'Doing' && style !== undefined ? { ...column, groupStyle: style } : column
	);
}

function layoutWith(style: GroupStyle | undefined): LayoutColumn[] {
	return sortedLayout().columns.map(column =>
		column.name === 'Doing' && style !== undefined ? { ...column, groupStyle: style } : column
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

function setup(style: GroupStyle | undefined, extra: Partial<React.ComponentProps<typeof KanbanBoard>> = {}) {
	return render(
		<AbExperiments enabled>
			<KanbanBoard
				columns={styled(style)}
				config={{ isDefault: false, columns: layoutWith(style) }}
				allStatuses={sortedLayout().allStatuses}
				version="s1"
				projectParam="p1"
				apiBase="/api/modules/task"
				{...extra}
			/>
		</AbExperiments>
	);
}

const column = (key: string): HTMLElement => screen.getByTestId(`kanban-column-${key}`);
const separators = (key: string): HTMLElement[] => within(column(key)).queryAllByRole('separator');
const groups = (key: string): HTMLElement[] => Array.from(column(key).querySelectorAll('[data-testid="kanban-group"]'));
const cardIds = (element: HTMLElement): string[] =>
	Array.from(element.querySelectorAll('[data-testid="kanban-card"]')).map(card => card.getAttribute('data-card-id')!);

describe('group styles on the board', () => {
	it('offers eight styles, label first (the default)', () => {
		expect(GROUP_STYLES.map(style => style.value)).toEqual([
			'label',
			'bar',
			'gap',
			'tint',
			'border',
			'boxed',
			'pill',
			'divider',
		]);
	});

	it('no style set = label: a thin rule with the group name; the separator says name and count', () => {
		setup(undefined);
		const doing = separators('Doing');
		expect(doing.map(entry => entry.getAttribute('aria-label'))).toEqual(['ann, 2 cards', 'bob, 1 card']);
		expect(doing.every(entry => entry.getAttribute('data-style') === 'label')).toBe(true);
		expect(doing[0]).toHaveTextContent('ann');
		expect(doing[0]!.querySelector('.h-px')).not.toBeNull();
	});

	it('bar: a full-width tinted bar with the name and the count', () => {
		setup('bar');
		const [first] = separators('Doing');
		expect(first).toHaveAttribute('data-style', 'bar');
		expect(first!.className).toMatch(/\bw-full\b/);
		expect(first!.className).toMatch(/\bbg-[a-z-]+\b/);
		expect(within(first!).getByTestId('kanban-group-count')).toHaveTextContent('2');
		expect(first).toHaveTextContent('ann');
	});

	it('gap: a large gap before every group but the first, a small bold caption, no rule', () => {
		setup('gap');
		const [first, second] = separators('Doing');
		expect(first).toHaveAttribute('data-style', 'gap');
		expect(first!.className).toMatch(/\btext-xs\b/);
		expect(first!.className).not.toMatch(/uppercase/);
		expect(first!.className).not.toMatch(/\bmt-6\b/);
		expect(second!.className).toMatch(/\bmt-6\b/);
		expect(first!.querySelector('.h-px')).toBeNull();
		expect(first!.className).not.toMatch(/border/);
	});

	it('tint: the cards of a group sit on a tinted panel with the caption inside', () => {
		setup('tint');
		const [ann, bob] = groups('Doing');
		expect(ann).toHaveAttribute('data-style', 'tint');
		expect(ann!.className).toMatch(/\bbg-[a-z-]+-(bg|light)\b/);
		expect(cardIds(ann!)).toEqual(['ccc33333', 'eee55555']);
		expect(cardIds(bob!)).toEqual(['fff66666']);
		expect(within(ann!).getByRole('separator')).toHaveAccessibleName('ann, 2 cards');
	});

	it('border: a coloured left border runs along the cards of the group, with the caption', () => {
		setup('border');
		const [ann] = groups('Doing');
		expect(ann).toHaveAttribute('data-style', 'border');
		expect(ann!.className).toMatch(/\bborder-l-4\b/);
		expect(ann!.className).toMatch(/\bborder-(muted|info-text|success|warning-text|danger|primary)\b/);
		expect(cardIds(ann!)).toEqual(['ccc33333', 'eee55555']);
		expect(within(ann!).getByRole('separator')).toHaveTextContent('ann');
	});

	it('boxed: each group is a bordered rounded box with a header, a labelled group (no separator)', () => {
		setup('boxed');
		const box = within(column('Doing')).getByRole('group', { name: 'ann, 2 cards' });
		expect(box).toHaveAttribute('data-style', 'boxed');
		expect(box.className).toMatch(/\bborder\b/);
		expect(box.className).toMatch(/\brounded-md\b/);
		expect(within(box).getByTestId('kanban-group-header')).toHaveTextContent('ann');
		expect(cardIds(box)).toEqual(['ccc33333', 'eee55555']);
		expect(separators('Doing')).toHaveLength(0);
	});

	it('pill: a rule with the name in a pill in its middle', () => {
		setup('pill');
		const [first] = separators('Doing');
		expect(first).toHaveAttribute('data-style', 'pill');
		const pill = within(first!).getByText('ann');
		expect(pill.className).toMatch(/\brounded-full\b/);
		expect(first!.querySelectorAll('.h-px')).toHaveLength(2);
	});

	it('divider: a thick dashed rule with no text; the name is only its title and accessible name', () => {
		setup('divider');
		const [first] = separators('Doing');
		expect(first).toHaveAttribute('data-style', 'divider');
		expect(first!.className).toMatch(/\bborder-dashed\b/);
		expect(first!.className).toMatch(/\bborder-t-2\b/);
		expect(first!.textContent).toBe('');
		expect(first).toHaveAttribute('title', 'ann, 2 cards');
		expect(first).toHaveAccessibleName('ann, 2 cards');
	});

	it('a group takes a stable tone from its name; a status group takes the tone of its status', () => {
		const byStatus = sortedColumns().map(entry =>
			entry.key === 'Doing'
				? {
						...entry,
						sort: 'status' as const,
						groupStyle: 'bar' as const,
						cards: entry.cards.map(card => ({ ...card, group: card.status })),
					}
				: entry
		);
		const first = setup(undefined, { columns: byStatus });
		const tones = separators('Doing').map(entry => entry.getAttribute('data-tone'));
		// doing (info), review (warning), doing again for fff66666: the groups follow the cards of the answer
		expect(tones).toEqual(['info', 'warning', 'info']);
		first.unmount();

		const second = setup('bar');
		const once = separators('Doing').map(entry => entry.getAttribute('data-tone'));
		expect(once.every(tone => ['neutral', 'info', 'success', 'warning', 'danger', 'purple'].includes(tone!))).toBe(
			true
		);
		second.unmount();
		setup('bar');
		expect(separators('Doing').map(entry => entry.getAttribute('data-tone'))).toEqual(once);
	});

	it('no group chrome at all on a column whose cards carry no group, whatever the style', () => {
		setup('boxed');
		for (const key of ['To do', 'Closed']) {
			expect(separators(key)).toHaveLength(0);
			expect(groups(key)).toHaveLength(0);
		}
	});
});

describe('the "Board columns: group style" row overrides every column', () => {
	it('"As configured" uses the style of each column; another option draws that style on every grouped column', async () => {
		const user = userEvent.setup();
		setup('boxed');
		expect(groups('Doing')[0]).toHaveAttribute('data-style', 'boxed');

		const row = screen.getByRole('group', { name: 'Board columns: group style' });
		await user.click(within(row).getByRole('button', { name: 'Pill' }));

		expect(groups('Doing')).toHaveLength(0);
		expect(separators('Doing').every(entry => entry.getAttribute('data-style') === 'pill')).toBe(true);
		// still no chrome where there is no group
		expect(separators('To do')).toHaveLength(0);
		// the preview is not saved
		expect(calls.some(call => call.method === 'PUT')).toBe(false);

		await user.click(within(row).getByRole('button', { name: 'As configured' }));
		expect(groups('Doing')[0]).toHaveAttribute('data-style', 'boxed');
	});
});

describe('group style in Configure columns', () => {
	async function openEditor(style: GroupStyle | undefined) {
		const user = userEvent.setup();
		setup(style);
		await user.click(screen.getByTestId('kanban-configure'));
		return user;
	}
	const select = (name: string): HTMLSelectElement =>
		screen.getByRole('combobox', { name: `Group style of column ${name}` }) as HTMLSelectElement;
	const putBody = (): unknown => JSON.parse(calls.find(call => call.method === 'PUT')!.body!);

	it('a column whose sort forms groups has a Group style select with the eight styles, starting from the stored one', async () => {
		await openEditor('bar');
		expect(select('Doing')).toHaveValue('bar');
		expect(select('Doing')).toBeEnabled();
		expect(
			within(select('Doing'))
				.getAllByRole('option')
				.map(option => option.textContent)
		).toEqual(['Label', 'Bar', 'Gap', 'Tint', 'Border', 'Boxed', 'Pill', 'Divider']);
	});

	it('is off with a short hint for a sort without groups, and comes on when the sort forms groups', async () => {
		const user = await openEditor(undefined);
		expect(select('To do')).toBeDisabled();
		expect(select('To do')).toHaveAccessibleDescription(/status, priority or assignee/i);
		expect(select('Closed')).toBeDisabled();

		await user.selectOptions(screen.getByRole('combobox', { name: 'Sort of column To do' }), 'priority');
		expect(select('To do')).toBeEnabled();
	});

	it('Save sends groupStyle, and leaves it out for label (the default)', async () => {
		const user = await openEditor('bar');
		await user.selectOptions(select('Doing'), 'tint');
		await user.click(screen.getByRole('button', { name: 'Save' }));
		await waitFor(() => expect(calls.some(call => call.method === 'PUT')).toBe(true));
		expect(putBody()).toEqual({
			columns: [
				{ name: 'To do', statuses: ['todo'] },
				{ name: 'Doing', statuses: ['doing', 'review'], sort: 'assignee', groupStyle: 'tint' },
				{ name: 'Closed', statuses: ['done', 'rejected'], sort: 'newest' },
			],
		});
	});

	it('label is not sent', async () => {
		const user = await openEditor('bar');
		await user.selectOptions(select('Doing'), 'label');
		await user.click(screen.getByRole('button', { name: 'Save' }));
		await waitFor(() => expect(calls.some(call => call.method === 'PUT')).toBe(true));
		const body = putBody() as { columns: Array<Record<string, unknown>> };
		expect(body.columns[1]).toEqual({ name: 'Doing', statuses: ['doing', 'review'], sort: 'assignee' });
	});

	it('a sort picked on the board keeps the stored group style of the column', async () => {
		const user = userEvent.setup();
		setup('boxed');
		await user.click(screen.getByRole('button', { name: 'Sort column Doing' }));
		await user.click(screen.getByRole('menuitemradio', { name: 'Priority' }));
		await waitFor(() => expect(calls.some(call => call.method === 'PUT')).toBe(true));
		const body = putBody() as { columns: Array<Record<string, unknown>> };
		expect(body.columns[1]).toEqual({
			name: 'Doing',
			statuses: ['doing', 'review'],
			sort: 'priority',
			groupStyle: 'boxed',
		});
	});
});
