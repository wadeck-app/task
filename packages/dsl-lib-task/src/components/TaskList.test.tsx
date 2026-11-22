import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { GLOBAL_ROWS, NOW, ROWS } from '../tasklist/taskListFixtures.js';
import { TaskList } from './TaskList.js';
import type { TaskListProps } from './TaskList.js';

beforeEach(() => {
	sessionStorage.clear();
	window.history.replaceState(null, '', '/tasks/p/p1');
});

function setup(props: Partial<TaskListProps> = {}) {
	return render(<TaskList rows={ROWS} scope="project" storageKey="p1" now={NOW} emptyMessage="No open tasks yet." {...props} />);
}

/** The ids of the body rows, in display order (the last character of the id is the task number). */
const order = (): string => screen.getAllByTestId('tasklist-row').map(r => r.dataset['id']!.slice(-1)).join('');
const header = (name: RegExp): HTMLElement => screen.getByRole('columnheader', { name });
const count = (): string => screen.getByTestId('tasklist-count').textContent ?? '';

async function openFacet(user: ReturnType<typeof userEvent.setup>, name: string): Promise<HTMLElement> {
	await user.click(screen.getByRole('button', { name: new RegExp(`^${name}`) }));
	return screen.getByRole('group', { name: `${name} filter` });
}

describe('TaskList default view', () => {
	it('orders by last update, most recent first, and says so', () => {
		setup();
		expect(order()).toBe('234165');
		expect(header(/Updated/)).toHaveAttribute('aria-sort', 'descending');
		expect(header(/Title/)).not.toHaveAttribute('aria-sort');
		expect(screen.getByTestId('tasklist-sortstate')).toHaveTextContent('Sorted by Updated, most recent first');
		expect(count()).toBe('6 of 6 tasks');
	});

	it('draws the whole row as a link to the task, with a focusable anchor and its title as tooltip', () => {
		setup();
		const link = screen.getByRole('link', { name: /Bravo billing export/ });
		expect(link).toHaveAttribute('href', '/modules/task/tasks/p/p1/aaaa0002');
		expect(link.className).toContain('after:absolute');
		expect(link.className).toContain('focus-visible:after:ring-2');
		expect(link).toHaveAttribute('title', 'Bravo billing export');
		expect(screen.getAllByRole('link')).toHaveLength(6);
	});

	it('shows the status as a tone pill, the priority muted when it is the default, the lease as the assignee tooltip', () => {
		setup();
		const rows = screen.getAllByTestId('tasklist-row');
		const first = rows[0]!;
		expect(within(first).getByTestId('status-badge')).toHaveAttribute('data-tone', 'info');
		expect(within(first).getByText('high').className).not.toContain('text-muted');
		expect(within(first).getByText('ann')).toHaveAttribute('title', 'held until 14:00 UTC, 2 h left');
		const done = rows[1]!;
		expect(within(done).getByTestId('status-badge')).toHaveAttribute('data-tone', 'success');
		const defaulted = rows[3]!;
		expect(within(defaulted).getByText('medium (default)').className).toContain('text-muted');
	});

	it('shows Updated as relative text with the exact UTC time as tooltip, and a dash with a reason when never updated', () => {
		setup();
		const first = screen.getAllByTestId('tasklist-row')[0]!;
		const updated = within(first).getByTestId('tasklist-updated');
		expect(updated).toHaveTextContent('30 minutes ago');
		expect(updated).toHaveAttribute('title', 'Updated 2026-11-22 11:30 UTC');
		const never = within(screen.getAllByTestId('tasklist-row')[5]!).getByTestId('tasklist-updated');
		expect(never).toHaveTextContent(String.fromCharCode(0x2014));
		expect(never).toHaveAttribute('title', 'No update date recorded');
	});

	it('truncates a long title and keeps the full text as tooltip', () => {
		const long = 'x'.repeat(300);
		setup({ rows: [{ ...ROWS[0]!, title: long, titleText: `${long.slice(0, 90)}...` }] });
		const link = screen.getByRole('link');
		expect(link.className).toContain('truncate');
		expect(link).toHaveAttribute('title', long);
	});
});

describe('TaskList sorting', () => {
	it('toggles a column on header click: text ascending first, again descending; dates and priority start descending', async () => {
		const user = userEvent.setup();
		setup();
		await user.click(within(header(/Title/)).getByRole('button'));
		expect(order()).toBe('123456');
		expect(header(/Title/)).toHaveAttribute('aria-sort', 'ascending');
		expect(header(/Updated/)).not.toHaveAttribute('aria-sort');
		await user.click(within(header(/Title/)).getByRole('button'));
		expect(order()).toBe('654321');
		expect(header(/Title/)).toHaveAttribute('aria-sort', 'descending');
		await user.click(within(header(/Priority/)).getByRole('button'));
		expect(header(/Priority/)).toHaveAttribute('aria-sort', 'descending');
		expect(order()).toBe('425163');
		await user.click(within(header(/Created/)).getByRole('button'));
		expect(order()).toBe('654321');
	});

	it('keeps an id tie-break stable when a column is sorted twice', async () => {
		const user = userEvent.setup();
		setup();
		await user.click(within(header(/Status/)).getByRole('button'));
		expect(order()).toBe('532416');
	});

	it('has a Sort by select with a direction button for narrow screens, in step with the headers', async () => {
		const user = userEvent.setup();
		setup();
		const select = screen.getByRole('combobox', { name: 'Sort by' });
		expect(select).toHaveValue('updated');
		await user.selectOptions(select, 'title');
		expect(order()).toBe('123456');
		expect(header(/Title/)).toHaveAttribute('aria-sort', 'ascending');
		await user.click(screen.getByRole('button', { name: /Direction: ascending/ }));
		expect(order()).toBe('654321');
		expect(screen.getByRole('button', { name: /Direction: descending/ })).toBeInTheDocument();
		// The selector lives where the headers are hidden.
		expect(select.closest('[data-testid="tasklist-sortbar"]')!.className).toContain('xl:hidden');
	});

	it('says, while sorted by priority, that the order is alphabetical when the names are not the usual four', async () => {
		const user = userEvent.setup();
		setup({ rows: ROWS.map(r => ({ ...r, priority: r.priority === 'urgent' ? 'p0' : r.priority })) });
		expect(screen.queryByTestId('tasklist-priority-note')).toBeNull();
		await user.click(within(header(/Priority/)).getByRole('button'));
		expect(screen.getByTestId('tasklist-priority-note')).toHaveTextContent('alphabetical');
	});

	it('uses the order the route gives for the priorities', async () => {
		const user = userEvent.setup();
		const rows = ROWS.map(r => ({ ...r, priority: r.priority === 'urgent' ? 'p0' : r.priority }));
		setup({ rows, priorityOrder: ['low', 'medium', 'high', 'p0'] });
		await user.click(within(header(/Priority/)).getByRole('button'));
		expect(order()[0]).toBe('4');
		expect(screen.queryByTestId('tasklist-priority-note')).toBeNull();
	});
});

describe('TaskList filters', () => {
	it('searches id, title, assignee; "/" focuses the field, Esc clears it', async () => {
		const user = userEvent.setup();
		setup();
		await user.keyboard('/');
		const search = screen.getByRole('searchbox', { name: 'Search tasks' });
		expect(search).toHaveFocus();
		await user.keyboard('BILLING');
		expect(order()).toBe('24');
		expect(count()).toBe('2 of 6 tasks');
		await user.keyboard('{Escape}');
		expect(search).toHaveValue('');
		expect(order()).toBe('234165');
	});

	it('does not steal the "/" typed in another field', async () => {
		const user = userEvent.setup();
		setup();
		const search = screen.getByRole('searchbox', { name: 'Search tasks' });
		await user.click(search);
		await user.keyboard('a/b');
		expect(search).toHaveValue('a/b');
	});

	it('filters by status with counts, several values are OR', async () => {
		const user = userEvent.setup();
		setup();
		const group = await openFacet(user, 'Status');
		expect(within(group).getByRole('checkbox', { name: /^in-progress/ })).toHaveAccessibleName('in-progress 2');
		await user.click(within(group).getByRole('checkbox', { name: /^done/ }));
		await user.click(within(group).getByRole('checkbox', { name: /^in-progress/ }));
		expect(order()).toBe('234');
		expect(count()).toBe('3 of 6 tasks');
		expect(screen.getByRole('button', { name: /^Status/ })).toHaveTextContent('2');
	});

	it('filters by priority, assignee (with Unassigned) and the update range, all combined with AND', async () => {
		const user = userEvent.setup();
		setup();
		let group = await openFacet(user, 'Assignee');
		await user.click(within(group).getByRole('checkbox', { name: /^Unassigned/ }));
		expect(order()).toBe('165');
		await user.click(within(group).getByRole('checkbox', { name: /^bob/ }));
		expect(order()).toBe('3165');
		group = await openFacet(user, 'Priority');
		await user.click(within(group).getByRole('checkbox', { name: /^medium/ }));
		expect(order()).toBe('16');
		await user.selectOptions(screen.getByRole('combobox', { name: 'Updated' }), '30d');
		expect(order()).toBe('16');
		await user.selectOptions(screen.getByRole('combobox', { name: 'Updated' }), '24h');
		expect(screen.getByTestId('tasklist-no-match')).toBeInTheDocument();
	});

	it('shows Clear filters only when a filter is active, and clears everything but the sort', async () => {
		const user = userEvent.setup();
		setup();
		expect(screen.queryByRole('button', { name: 'Clear filters' })).toBeNull();
		await user.click(within(header(/Title/)).getByRole('button'));
		expect(screen.queryByRole('button', { name: 'Clear filters' })).toBeNull();
		await user.type(screen.getByRole('searchbox', { name: 'Search tasks' }), 'bob');
		await user.click(screen.getByRole('button', { name: 'Clear filters' }));
		expect(screen.getByRole('searchbox', { name: 'Search tasks' })).toHaveValue('');
		expect(order()).toBe('123456');
		expect(screen.queryByRole('button', { name: 'Clear filters' })).toBeNull();
	});

	it('announces the count in a polite live region', async () => {
		const user = userEvent.setup();
		setup();
		expect(screen.getByTestId('tasklist-count')).toHaveAttribute('aria-live', 'polite');
		await user.type(screen.getByRole('searchbox', { name: 'Search tasks' }), 'bob');
		expect(count()).toBe('1 of 6 tasks');
		expect(screen.getByTestId('tasklist-count')).toHaveTextContent('1 of 6 tasks');
	});

	it('collapses the filters behind a Filters button that shows the active count (below xl)', async () => {
		const user = userEvent.setup();
		setup();
		const toggle = screen.getByRole('button', { name: /^Filters/ });
		expect(toggle.className).toContain('xl:hidden');
		expect(toggle).toHaveAttribute('aria-expanded', 'false');
		const panel = screen.getByTestId('tasklist-filters');
		expect(panel.className).toContain('hidden xl:flex');
		await user.type(screen.getByRole('searchbox', { name: 'Search tasks' }), 'bob');
		const group = await openFacet(user, 'Status');
		await user.click(within(group).getByRole('checkbox', { name: /^done/ }));
		expect(screen.getByRole('button', { name: /^Filters/ })).toHaveTextContent('Filters (2)');
		await user.click(screen.getByRole('button', { name: /^Filters/ }));
		expect(screen.getByRole('button', { name: /^Filters/ })).toHaveAttribute('aria-expanded', 'true');
		expect(screen.getByTestId('tasklist-filters').className).toContain('flex');
		expect(screen.getByTestId('tasklist-filters').className).not.toContain('hidden xl:flex');
	});
});

describe('TaskList empty states', () => {
	it('shows the page message when there is no row, without filters or table', () => {
		setup({ rows: [] });
		expect(screen.getByTestId('tasklist-empty')).toHaveTextContent('No open tasks yet.');
		expect(screen.queryByRole('searchbox')).toBeNull();
		expect(screen.queryByTestId('tasklist-no-match')).toBeNull();
	});

	it('shows "No task matches" with a Clear filters button when the filters hide everything', async () => {
		const user = userEvent.setup();
		setup();
		await user.type(screen.getByRole('searchbox', { name: 'Search tasks' }), 'nothing like this');
		const empty = screen.getByTestId('tasklist-no-match');
		expect(empty).toHaveTextContent('No task matches the filters');
		expect(screen.queryByTestId('tasklist-empty')).toBeNull();
		expect(count()).toBe('0 of 6 tasks');
		await user.click(within(empty).getByRole('button', { name: 'Clear filters' }));
		expect(order()).toBe('234165');
	});
});

describe('TaskList address and storage', () => {
	it('writes the view in the address (replaceState: no history entry) and keeps the page parameters', async () => {
		const user = userEvent.setup();
		window.history.replaceState({ key: 'router' }, '', '/tasks/p/p1?showAll=true&reload=2');
		const before = window.history.length;
		setup();
		await user.click(within(header(/Title/)).getByRole('button'));
		await user.type(screen.getByRole('searchbox', { name: 'Search tasks' }), 'a b');
		const params = new URLSearchParams(window.location.search);
		expect(params.get('showAll')).toBe('true');
		expect(params.get('reload')).toBe('2');
		expect(params.get('q')).toBe('a b');
		expect(params.get('sort')).toBe('title');
		expect(params.get('dir')).toBe('asc');
		expect(window.history.length).toBe(before);
		expect(window.history.state).toEqual({ key: 'router' });
		expect(window.location.pathname).toBe('/tasks/p/p1');
	});

	it('restores sort and filters from the address on load', () => {
		window.history.replaceState(null, '', '/tasks/p/p1?sort=title&dir=desc&status=in-progress&assignee=ann&q=b');
		setup();
		expect(order()).toBe('42');
		expect(screen.getByRole('searchbox', { name: 'Search tasks' })).toHaveValue('b');
		expect(header(/Title/)).toHaveAttribute('aria-sort', 'descending');
		expect(screen.getByRole('button', { name: /^Status/ })).toHaveTextContent('1');
		expect(count()).toBe('2 of 6 tasks');
	});

	it('leaves the address clean in the default view', async () => {
		const user = userEvent.setup();
		window.history.replaceState(null, '', '/tasks/p/p1?showAll=true');
		setup();
		await user.type(screen.getByRole('searchbox', { name: 'Search tasks' }), 'x');
		await user.clear(screen.getByRole('searchbox', { name: 'Search tasks' }));
		expect(window.location.search).toBe('?showAll=true');
	});

	it('falls back to the last view of this project in sessionStorage when the address has none (a page link drops it)', async () => {
		const user = userEvent.setup();
		const first = setup();
		await user.type(screen.getByRole('searchbox', { name: 'Search tasks' }), 'bob');
		first.unmount();
		window.history.replaceState(null, '', '/tasks/p/p1?showAll=true');
		setup();
		expect(screen.getByRole('searchbox', { name: 'Search tasks' })).toHaveValue('bob');
		expect(new URLSearchParams(window.location.search).get('q')).toBe('bob');
		expect(new URLSearchParams(window.location.search).get('showAll')).toBe('true');
	});

	it('keeps the view of each storageKey apart, and the address wins over the storage', async () => {
		const user = userEvent.setup();
		const first = setup({ storageKey: 'other' });
		await user.type(screen.getByRole('searchbox', { name: 'Search tasks' }), 'bob');
		first.unmount();
		window.history.replaceState(null, '', '/tasks/p/p1');
		setup({ storageKey: 'p1' });
		expect(screen.getByRole('searchbox', { name: 'Search tasks' })).toHaveValue('');
		sessionStorage.setItem('task.list.p1', JSON.stringify({ q: 'stored' }));
		window.history.replaceState(null, '', '/tasks/p/p1?q=address');
		setup({ storageKey: 'p1' });
		expect(screen.getAllByRole('searchbox', { name: 'Search tasks' }).pop()).toHaveValue('address');
	});

	it('warns about an address value it ignores', () => {
		window.history.replaceState(null, '', '/tasks/p/p1?sort=colour');
		setup();
		expect(screen.getByRole('status')).toHaveTextContent('"colour"');
	});

	it('survives a broken storage entry by starting from the default view, and says so', () => {
		sessionStorage.setItem('task.list.p1', '{not json');
		setup();
		expect(order()).toBe('234165');
		expect(screen.getByRole('status')).toHaveTextContent('saved view');
	});
});

describe('TaskList global scope', () => {
	it('shows the Project column and filter, and no priority or assignee column or filter', async () => {
		const user = userEvent.setup();
		setup({ rows: GLOBAL_ROWS, scope: 'all', storageKey: 'all' });
		expect(header(/Project/)).toBeInTheDocument();
		expect(screen.queryByRole('columnheader', { name: /Priority/ })).toBeNull();
		expect(screen.queryByRole('columnheader', { name: /Assignee/ })).toBeNull();
		expect(screen.queryByRole('button', { name: /^Priority/ })).toBeNull();
		const group = await openFacet(user, 'Project');
		await user.click(within(group).getByRole('checkbox', { name: /^beta/ }));
		expect(order()).toBe('246');
		expect(screen.getAllByTestId('tasklist-row')[0]).toHaveTextContent('beta');
		expect(new URLSearchParams(window.location.search).get('projectIn')).toBe('beta');
	});

	it('searches the project name', async () => {
		const user = userEvent.setup();
		setup({ rows: GLOBAL_ROWS, scope: 'all', storageKey: 'all' });
		await user.type(screen.getByRole('searchbox', { name: 'Search tasks' }), 'alpha');
		expect(order()).toBe('315');
	});
});

describe('TaskList narrow layout', () => {
	it('stacks each row as a card below xl and as a table row from xl; the header only from xl', () => {
		setup();
		const table = screen.getByRole('table');
		expect(table).toHaveAccessibleName('Tasks');
		const head = screen.getAllByRole('row')[0]!;
		expect(head.className).toContain('hidden');
		expect(head.className).toContain('xl:grid');
		expect(head.className).toContain('sticky');
		const row = screen.getAllByTestId('tasklist-row')[0]!;
		expect(row.className).toContain('grid');
		expect(row.className).toContain('xl:grid-cols-');
		expect(row.className).toContain('relative');
		// A cell never forces a width: it can shrink and wrap its text.
		expect(row.className).toContain('min-w-0');
	});

	it('never lets the list overflow its column', () => {
		setup();
		expect(screen.getByTestId('tasklist').className).toContain('min-w-0');
		expect(screen.getByRole('table').className).toContain('min-w-0');
	});
});
