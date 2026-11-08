import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ActivityFeed, HISTORY_KINDS, relativeTime } from './ActivityFeed.js';
import type { ActivityRow } from './ActivityFeed.js';

const NOW = '2026-11-08T12:00:00.000Z';

function row(extra: Partial<ActivityRow> & { kind: string }, n = 0): ActivityRow {
	return {
		at: new Date(Date.parse(NOW) - n * 60_000).toISOString(),
		icon: 'circle',
		tone: 'neutral',
		text: `row ${n}`,
		group: 'Today',
		...extra,
	};
}

const MIXED: ActivityRow[] = [
	row({ kind: 'status', text: 'Status: todo to done', details: { old: 'todo', new: 'done' } }, 1),
	row({ kind: 'description', text: 'Edited the description' }, 2),
	row({ kind: 'label', text: 'Added label billing' }, 3),
	row({ kind: 'created', text: 'Created the task', group: 'Yesterday' }, 60 * 24),
	row({ kind: 'mystery', text: 'Something odd', group: 'Yesterday' }, 60 * 25),
];

describe('relativeTime', () => {
	it.each([
		[0, 'just now'],
		[30_000, 'just now'],
		[5 * 60_000, '5 minutes ago'],
		[60_000, '1 minute ago'],
		[3 * 3_600_000, '3 hours ago'],
		[3_600_000, '1 hour ago'],
		[2 * 86_400_000, '2 days ago'],
		[86_400_000, '1 day ago'],
	])('%i ms before now reads %s', (ms, expected) => {
		expect(relativeTime(new Date(Date.parse(NOW) - ms).toISOString(), Date.parse(NOW))).toBe(expected);
	});

	it('falls back to the UTC date beyond 30 days and to the raw text for an invalid instant', () => {
		expect(relativeTime('2026-09-01T10:00:00.000Z', Date.parse(NOW))).toBe('2026-09-01');
		expect(relativeTime('not a date', Date.parse(NOW))).toBe('not a date');
	});

	it('does not read the future as "ago"', () => {
		expect(relativeTime('2026-11-08T12:10:00.000Z', Date.parse(NOW))).toBe('just now');
	});
});

describe('ActivityFeed', () => {
	it('draws the rows with their text, one icon per kind, newest first as given', () => {
		render(<ActivityFeed rows={MIXED} now={NOW} />);

		const items = screen.getAllByTestId('activity-row');
		expect(items).toHaveLength(5);
		expect(items[0]).toHaveTextContent('Status: todo to done');
		expect(items[0]).toHaveAttribute('data-kind', 'status');
		expect(items[0]!.querySelector('svg')).not.toBeNull();
	});

	it('an unknown kind gets a neutral dot, not a broken icon', () => {
		render(<ActivityFeed rows={[row({ kind: 'mystery' })]} now={NOW} />);

		const item = screen.getByTestId('activity-row');
		expect(item.querySelector('[data-testid="activity-dot"]')).not.toBeNull();
		expect(item.querySelector('svg')).toBeNull();
	});

	it('the icon takes the tone of the row, else the tone of its kind', () => {
		render(
			<ActivityFeed
				rows={[row({ kind: 'status', tone: 'danger' }), row({ kind: 'created', tone: undefined as never }, 1)]}
				now={NOW}
			/>
		);

		const icons = screen.getAllByTestId('activity-icon');
		expect(icons[0]!.className).toContain('text-danger');
		expect(icons[1]!.className).toContain('text-info-text');
	});

	it('groups under day headings, one heading per run of the same group', () => {
		render(<ActivityFeed rows={MIXED} now={NOW} />);

		expect(screen.getAllByRole('heading', { level: 4 }).map(h => h.textContent)).toEqual(['Today', 'Yesterday']);
	});

	it('shows the relative time, with the absolute UTC instant in the tooltip and dateTime', () => {
		render(<ActivityFeed rows={[row({ kind: 'status' }, 5)]} now={NOW} />);

		const time = screen.getByText('5 minutes ago');
		expect(time.tagName).toBe('TIME');
		expect(time).toHaveAttribute('title', '2026-11-08T11:55:00.000Z');
		expect(time).toHaveAttribute('dateTime', '2026-11-08T11:55:00.000Z');
	});

	it('shows old struck through and muted, new after it', () => {
		render(<ActivityFeed rows={[row({ kind: 'status', details: { old: 'todo', new: 'done' } })]} now={NOW} />);

		const details = screen.getByTestId('activity-details');
		const oldValue = within(details).getByText('todo');
		expect(oldValue.className).toContain('line-through');
		expect(oldValue.className).toContain('text-muted');
		expect(within(details).getByText('done').className).not.toContain('line-through');
	});

	it('a long details text is collapsed with a toggle that unfolds and folds it', async () => {
		const user = userEvent.setup();
		const long = 'word '.repeat(80);
		render(<ActivityFeed rows={[row({ kind: 'description', details: long })]} now={NOW} />);

		const details = screen.getByTestId('activity-details');
		expect(details).toHaveAttribute('data-collapsed', 'true');
		const toggle = screen.getByRole('button', { name: 'Show details' });
		expect(toggle).toHaveAttribute('aria-expanded', 'false');
		await user.click(toggle);
		expect(details).toHaveAttribute('data-collapsed', 'false');
		expect(screen.getByRole('button', { name: 'Hide details' })).toHaveAttribute('aria-expanded', 'true');
		await user.click(screen.getByRole('button', { name: 'Hide details' }));
		expect(details).toHaveAttribute('data-collapsed', 'true');
	});

	it('a short details text has no toggle', () => {
		render(<ActivityFeed rows={[row({ kind: 'description', details: 'short' })]} now={NOW} />);

		expect(screen.queryByRole('button', { name: /details/ })).toBeNull();
		expect(screen.getByTestId('activity-details')).toHaveAttribute('data-collapsed', 'false');
	});

	it('a long old/new preview is collapsed too', () => {
		render(
			<ActivityFeed
				rows={[row({ kind: 'description', details: { old: 'a '.repeat(100), new: 'b '.repeat(100) } })]}
				now={NOW}
			/>
		);

		expect(screen.getByTestId('activity-details')).toHaveAttribute('data-collapsed', 'true');
	});
});

describe('ActivityFeed filters', () => {
	it('is a keyboard accessible tablist with "All" and "History" and their counts', () => {
		render(<ActivityFeed rows={MIXED} now={NOW} />);

		expect(screen.getByRole('tablist', { name: 'Activity filter' })).toBeInTheDocument();
		const tabs = screen.getAllByRole('tab');
		expect(tabs.map(t => t.textContent)).toEqual(['All5', 'History2']);
		expect(tabs[0]).toHaveAttribute('aria-selected', 'true');
		expect(tabs[0]).toHaveAttribute('tabindex', '0');
		expect(tabs[1]).toHaveAttribute('tabindex', '-1');
		expect(screen.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', tabs[0]!.id);
	});

	it('History keeps the property changes (status, type, parent, link, label, meta), not text edits, creation or unknown kinds', async () => {
		const user = userEvent.setup();
		render(<ActivityFeed rows={MIXED} now={NOW} />);

		await user.click(screen.getByRole('tab', { name: /History/ }));

		expect(screen.getAllByTestId('activity-row').map(r => r.getAttribute('data-kind'))).toEqual([
			'status',
			'label',
		]);
		expect(HISTORY_KINDS).toEqual(
			expect.arrayContaining(['status', 'type', 'parent', 'link', 'unlink', 'label', 'meta', 'unblocked'])
		);
		for (const kind of ['created', 'description', 'title', 'text', 'mystery']) {
			expect(HISTORY_KINDS).not.toContain(kind);
		}
	});

	it('arrows, Home and End move between tabs and select them', async () => {
		const user = userEvent.setup();
		render(<ActivityFeed rows={MIXED} now={NOW} />);

		screen.getAllByRole('tab')[0]!.focus();
		await user.keyboard('{ArrowRight}');
		expect(screen.getByRole('tab', { name: /History/ })).toHaveFocus();
		expect(screen.getByRole('tab', { name: /History/ })).toHaveAttribute('aria-selected', 'true');
		await user.keyboard('{ArrowRight}');
		expect(screen.getByRole('tab', { name: /^All/ })).toHaveFocus();
		await user.keyboard('{End}');
		expect(screen.getByRole('tab', { name: /History/ })).toHaveAttribute('aria-selected', 'true');
		await user.keyboard('{Home}');
		expect(screen.getByRole('tab', { name: /^All/ })).toHaveAttribute('aria-selected', 'true');
	});

	it('uses the filters the route lists and its counts when given; an unknown filter matches the kind of the same name', async () => {
		const user = userEvent.setup();
		render(<ActivityFeed rows={MIXED} filters={['all', 'label']} counts={{ all: 9, label: 1 }} now={NOW} />);

		expect(screen.getAllByRole('tab').map(t => t.textContent)).toEqual(['All9', 'Label1']);
		await user.click(screen.getByRole('tab', { name: /Label/ }));
		expect(screen.getAllByTestId('activity-row')).toHaveLength(1);
	});

	it('hides the tabs when the route lists a single filter', () => {
		render(<ActivityFeed rows={MIXED} filters={['all']} now={NOW} />);

		expect(screen.queryByRole('tablist')).toBeNull();
	});
});

describe('ActivityFeed paging and empty state', () => {
	const MANY = Array.from({ length: 40 }, (_, i) => row({ kind: 'status', text: `change ${i}` }, i));

	it('shows 15 rows, then Show more reveals 15 more until none are left', async () => {
		const user = userEvent.setup();
		render(<ActivityFeed rows={MANY} now={NOW} />);

		expect(screen.getAllByTestId('activity-row')).toHaveLength(15);
		await user.click(screen.getByRole('button', { name: 'Show more (25 left)' }));
		expect(screen.getAllByTestId('activity-row')).toHaveLength(30);
		await user.click(screen.getByRole('button', { name: 'Show more (10 left)' }));
		expect(screen.getAllByTestId('activity-row')).toHaveLength(40);
		expect(screen.queryByRole('button', { name: /Show more/ })).toBeNull();
	});

	it('does not offer Show more for 15 rows or fewer', () => {
		render(<ActivityFeed rows={MANY.slice(0, 15)} now={NOW} />);

		expect(screen.queryByRole('button', { name: /Show more/ })).toBeNull();
	});

	it('switching the filter starts over from the first 15 rows', async () => {
		const user = userEvent.setup();
		render(<ActivityFeed rows={MANY} now={NOW} />);

		await user.click(screen.getByRole('button', { name: /Show more/ }));
		await user.click(screen.getByRole('tab', { name: /History/ }));

		expect(screen.getAllByTestId('activity-row')).toHaveLength(15);
	});

	it('shows an explicit empty state, also for a filter with no row', async () => {
		const user = userEvent.setup();
		const { rerender } = render(<ActivityFeed rows={[]} now={NOW} />);
		expect(screen.getByTestId('activity-empty')).toHaveTextContent('No activity yet');

		rerender(<ActivityFeed rows={[row({ kind: 'created' })]} now={NOW} />);
		await user.click(screen.getByRole('tab', { name: /History/ }));
		expect(screen.getByTestId('activity-empty')).toHaveTextContent('No history yet');
	});

	it('survives garbage: rows that are not an array, rows without a text', () => {
		render(<ActivityFeed rows={'nope' as never} now={NOW} />);
		expect(screen.getByTestId('activity-empty')).toBeInTheDocument();
	});
});
