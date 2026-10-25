import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Timeline } from './Timeline.js';
import type { TimelineEntry } from './Timeline.js';

// @formatter:off
const ENTRIES: TimelineEntry[] = [
	{ id: 'a', kind: 'created', title: 'Created', at: '2026-10-20T08:00:00.000Z', atText: '2026-10-20 08:00 UTC' },
	{
		id: 'b',
		kind: 'status',
		title: 'todo to doing',
		at: '2026-10-21T09:30:00.000Z',
		atText: '2026-10-21 09:30 UTC',
		detail: 'by hook',
	},
	{ id: 'c', kind: 'done', title: 'doing to done', at: '2026-10-21T17:00:00.000Z', atText: '2026-10-21 17:00 UTC' },
];
// @formatter:on

const titles = (): string[] => screen.getAllByTestId('timeline-entry').map(e => e.getAttribute('data-id') ?? '');

describe('Timeline', () => {
	it('shows the title, the time text and the detail of each entry', () => {
		render(<Timeline entries={ENTRIES} />);

		expect(screen.getByText('todo to doing')).toBeInTheDocument();
		expect(screen.getByText('2026-10-21 09:30 UTC')).toBeInTheDocument();
		expect(screen.getByText('by hook')).toBeInTheDocument();
	});

	it('lists the newest first by default and the oldest first on request', () => {
		const { rerender } = render(<Timeline entries={ENTRIES} />);
		expect(titles()).toEqual(['c', 'b', 'a']);

		rerender(<Timeline entries={ENTRIES} order="oldest-first" />);
		expect(titles()).toEqual(['a', 'b', 'c']);
	});

	it('groups the entries under one header per UTC day', () => {
		render(<Timeline entries={ENTRIES} groupByDay />);

		const headers = screen.getAllByTestId('timeline-day').map(h => h.textContent);
		expect(headers).toEqual(['2026-10-21', '2026-10-20']);
		const day = screen.getAllByTestId('timeline-group')[0]!;
		expect(within(day).getAllByTestId('timeline-entry')).toHaveLength(2);
	});

	it('draws no day header without groupByDay', () => {
		render(<Timeline entries={ENTRIES} />);

		expect(screen.queryByTestId('timeline-day')).toBeNull();
	});

	it('draws an icon per entry unless showIcons is false', () => {
		const { rerender } = render(<Timeline entries={ENTRIES} />);
		expect(screen.getAllByTestId('timeline-entry')[0]!.querySelector('svg')).not.toBeNull();

		rerender(<Timeline entries={ENTRIES} showIcons={false} />);
		expect(screen.getAllByTestId('timeline-entry')[0]!.querySelector('svg')).toBeNull();
	});

	it('says so when there is nothing yet, with the text it was given', () => {
		render(<Timeline entries={[]} emptyText="No activity" />);

		expect(screen.getByText('No activity')).toBeInTheDocument();
	});

	it('keeps an entry whose date is not a date, under an "unknown date" header', () => {
		render(<Timeline groupByDay entries={[{ id: 'x', kind: 'note', title: 'odd', at: 'nope', atText: '?' }]} />);

		expect(screen.getByTestId('timeline-day')).toHaveTextContent('Unknown date');
		expect(screen.getByText('odd')).toBeInTheDocument();
	});
});
