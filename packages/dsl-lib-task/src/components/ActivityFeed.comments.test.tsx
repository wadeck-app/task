import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ActivityFeed } from './ActivityFeed.js';

// The Comments tab of the activity feed: the comment rows only, their full text with line breaks kept.
const LONG = `${'a long comment sentence '.repeat(20)}end\nsecond line`;
const ROWS = [
	{ at: '2026-11-08T11:00:00.000Z', kind: 'comment', text: LONG, id: 'c1' },
	{ at: '2026-11-08T10:00:00.000Z', kind: 'comment-edited', text: 'Comment c1 edited' },
	{ at: '2026-11-08T09:00:00.000Z', kind: 'status', text: 'Status changed from backlog to done' },
	{ at: '2026-11-08T08:00:00.000Z', kind: 'created', text: 'Created with status backlog' },
];

describe('ActivityFeed comments', () => {
	it('offers the tabs All activity, Comments and History, in the order given, with counts', () => {
		render(
			<ActivityFeed
				rows={ROWS}
				filters={['all', 'comments', 'history']}
				counts={{ all: 4, comments: 1, history: 1 }}
			/>
		);

		const tabs = screen.getAllByRole('tab').map(tab => tab.textContent);
		expect(tabs[0]).toContain('All activity');
		expect(tabs[1]).toContain('Comments');
		expect(tabs[1]).toContain('1');
		expect(tabs[2]).toContain('History');
	});

	it('the Comments tab lists the comment rows only; the count is computed when none is given', async () => {
		const user = userEvent.setup();
		render(<ActivityFeed rows={ROWS} filters={['all', 'comments', 'history']} />);

		expect(screen.getByRole('tab', { name: /Comments/ })).toHaveTextContent('1');
		await user.click(screen.getByRole('tab', { name: /Comments/ }));

		const shown = screen.getAllByTestId('activity-row');
		expect(shown).toHaveLength(1);
		expect(shown[0]).toHaveAttribute('data-kind', 'comment');
	});

	it('a comment row prints the FULL text, line breaks kept and long words wrapped', () => {
		render(<ActivityFeed rows={ROWS} filters={['all']} />);

		const row = screen.getAllByTestId('activity-row').find(r => r.getAttribute('data-kind') === 'comment')!;
		const body = within(row).getByTestId('activity-comment-text');
		expect(body.textContent).toBe(LONG);
		expect(body.className).toContain('whitespace-pre-wrap');
		expect(body.className).toContain('break-words');
	});

	it('shows the author of a comment when the row has an actor', () => {
		render(<ActivityFeed rows={[{ ...ROWS[0]!, actor: 'alice' }]} filters={['all']} />);

		expect(screen.getByTestId('activity-actor')).toHaveTextContent('alice');
	});

	it('the edited and removed comment kinds have an icon, not the bare dot', () => {
		render(
			<ActivityFeed
				rows={[
					{ at: '2026-11-08T10:00:00.000Z', kind: 'comment-edited', text: 'Comment c1 edited' },
					{ at: '2026-11-08T09:00:00.000Z', kind: 'comment-removed', text: 'Comment c1 removed' },
				]}
				filters={['all']}
			/>
		);

		expect(screen.getAllByTestId('activity-icon')).toHaveLength(2);
		expect(screen.queryByTestId('activity-dot')).toBeNull();
	});
});
