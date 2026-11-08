import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ActivityFeed } from './ActivityFeed.js';
import type { ActivityRow } from './ActivityFeed.js';

const NOW = '2026-11-08T12:00:00.000Z';
const at = (n: number): string => new Date(Date.parse(NOW) - n * 60_000).toISOString();
const r = (kind: string, n: number, extra: Partial<ActivityRow> = {}): ActivityRow => ({
	at: at(n),
	kind,
	text: `row ${kind}`,
	...extra,
});

const REAL = [
	r('label-added', 1),
	r('label-removed', 2),
	r('meta-set', 3),
	r('meta-removed', 4),
	r('link-added', 5),
	r('link-removed', 6),
	r('description', 7),
	r('title', 8),
	r('comment', 9),
	r('status', 10),
];

describe('ActivityFeed real kinds', () => {
	it('keeps the raw kind in data-kind and draws an icon for every real kind', () => {
		render(<ActivityFeed rows={REAL} now={NOW} />);

		const items = screen.getAllByTestId('activity-row');
		expect(items.map(i => i.getAttribute('data-kind'))).toEqual(REAL.map(x => x.kind));
		for (const item of items) {
			expect(item.querySelector('[data-testid="activity-icon"]')).not.toBeNull();
		}
	});

	it('History covers the label, meta and link variants, not description, title or comment', async () => {
		const user = userEvent.setup();
		render(<ActivityFeed rows={REAL} now={NOW} />);

		await user.click(screen.getByRole('tab', { name: /History/ }));

		expect(screen.getAllByTestId('activity-row').map(i => i.getAttribute('data-kind'))).toEqual([
			'label-added',
			'label-removed',
			'meta-set',
			'meta-removed',
			'link-added',
			'link-removed',
			'status',
		]);
	});

	it('a filter named label matches label-added and label-removed', async () => {
		const user = userEvent.setup();
		render(<ActivityFeed rows={REAL} filters={['all', 'label']} now={NOW} />);

		await user.click(screen.getByRole('tab', { name: /Label/ }));

		expect(screen.getAllByTestId('activity-row')).toHaveLength(2);
	});

	it('details accept {oldValue,newValue}, {old,new} and a string', () => {
		render(
			<ActivityFeed
				rows={[
					r('meta-set', 1, { details: { oldValue: 'OLDV', newValue: 'NEWV' } as never }),
					r('status', 2, { details: { old: 'OLDX', new: 'NEWX' } }),
					r('title', 3, { details: 'plain' }),
				]}
				now={NOW}
			/>
		);

		const text = screen.getAllByTestId('activity-details').map(d => d.textContent);
		expect(text).toEqual(['OLDVNEWV', 'OLDXNEWX', 'plain']);
	});

	it('tabs are All, Comments, History', () => {
		render(<ActivityFeed rows={REAL} filters={['all', 'comments', 'history']} now={NOW} />);

		expect(screen.getAllByRole('tab').map(t => t.textContent)).toEqual(['All10', 'Comments1', 'History7']);
	});
});

describe('ActivityFeed filterAppearance, defaultFilter, slots', () => {
	it('select appearance: one native select with the counts, same behaviour', async () => {
		const user = userEvent.setup();
		render(
			<ActivityFeed rows={REAL} filters={['all', 'comments', 'history']} filterAppearance="select" now={NOW} />
		);

		expect(screen.queryByRole('tablist')).toBeNull();
		const select = screen.getByRole('combobox', { name: 'Activity filter' });
		expect(
			within(select)
				.getAllByRole('option')
				.map(o => o.textContent)
		).toEqual(['All activity (10)', 'Comments only (1)', 'History only (7)']);
		await user.selectOptions(select, 'comments');
		expect(screen.getAllByTestId('activity-row')).toHaveLength(1);
	});

	it('defaultFilter selects that filter first; an unknown one falls back to the first', () => {
		const { unmount } = render(
			<ActivityFeed rows={REAL} filters={['all', 'comments']} defaultFilter="comments" now={NOW} />
		);
		expect(screen.getAllByTestId('activity-row')).toHaveLength(1);
		unmount();
		render(<ActivityFeed rows={REAL} filters={['all', 'comments']} defaultFilter="nope" now={NOW} />);
		expect(screen.getAllByTestId('activity-row')).toHaveLength(10);
	});

	it('commentsContent replaces the comment rows under Comments, keeps the count, no Show more', async () => {
		const user = userEvent.setup();
		render(
			<ActivityFeed
				rows={REAL}
				filters={['all', 'comments']}
				pageSize={1}
				commentsContent={<div data-testid="slot">THREAD</div>}
				now={NOW}
			/>
		);

		expect(screen.queryByTestId('slot')).toBeNull();
		await user.click(screen.getByRole('tab', { name: /Comments/ }));

		expect(screen.getByTestId('slot')).toBeInTheDocument();
		expect(screen.queryAllByTestId('activity-row')).toHaveLength(0);
		expect(screen.queryByRole('button', { name: /Show more/ })).toBeNull();
		expect(screen.getByRole('tab', { name: /Comments/ })).toHaveTextContent('1');
	});

	it('composer is always rendered, after the panel by default and above the tabs at top', async () => {
		const user = userEvent.setup();
		const { rerender } = render(
			<ActivityFeed
				rows={REAL}
				filters={['all', 'comments']}
				composer={<div data-testid="composer" />}
				now={NOW}
			/>
		);
		const root = screen.getByTestId('activity-feed');
		await user.click(screen.getByRole('tab', { name: /Comments/ }));
		expect(root.lastElementChild).toBe(screen.getByTestId('composer'));

		rerender(
			<ActivityFeed
				rows={REAL}
				filters={['all', 'comments']}
				composer={<div data-testid="composer" />}
				composerPosition="top"
				now={NOW}
			/>
		);
		expect(root.firstElementChild).toBe(screen.getByTestId('composer'));
	});
});
