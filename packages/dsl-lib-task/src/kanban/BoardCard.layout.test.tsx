import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { BoardCard } from './BoardParts.js';
import type { BoardView } from './BoardParts.js';
import type { BoardCardData } from './boardModel.js';
import type { CardLayout } from './cardLayout.js';

// The card of the board drawn with a layout (`board.card`): fields in order, styles, title lines, nothing for a missing fact.

const view = (readOnly = false): BoardView => ({
	columns: [],
	readOnly,
	busy: new Set(),
	overStatus: null,
	dragging: null,
	startDrag: vi.fn(),
	endDrag: vi.fn(),
	zone: () => ({ onDragOver: vi.fn(), onDragLeave: vi.fn(), onDrop: vi.fn() }),
	move: vi.fn(),
});

const task: BoardCardData = {
	id: 'aaa11111',
	headline: 'Write the spec',
	href: '/t/aaa11111',
	priority: 'high',
	priorityText: 'High',
	assignee: 'Ada Lovelace',
	status: 'review',
	tone: 'warning',
	type: 'bug',
	labels: ['billing'],
	createdAt: '2026-11-01T09:00:00.000Z',
	statusSince: '2026-11-10T09:00:00.000Z',
	parentId: 'ppp00000',
};

const layout = (fields: CardLayout['fields'], titleLines: CardLayout['titleLines'] = 2): CardLayout => ({
	titleLines,
	fields,
});

function draw(
	card: BoardCardData,
	cardLayout: CardLayout | undefined,
	options: { showStatus?: boolean; readOnly?: boolean } = {}
) {
	render(<BoardCard card={card} view={view(options.readOnly)} showStatus={options.showStatus} layout={cardLayout} />);
	return screen.getByTestId('kanban-card');
}

describe('a card with no layout', () => {
	it('looks like today: id, title, priority pill, type, assignee, labels', () => {
		const article = draw(task, undefined);
		expect(within(article).getByText('aaa11111')).toBeInTheDocument();
		expect(within(article).getByText('High')).toBeInTheDocument();
		expect(within(article).getByText('bug')).toBeInTheDocument();
		expect(within(article).getByText('Ada Lovelace')).toBeInTheDocument();
		expect(within(article).getByText('billing')).toBeInTheDocument();
		expect(within(article).getByRole('link')).toHaveClass('line-clamp-2');
		expect(within(article).queryByTestId('card-field-created')).toBeNull();
	});
});

describe('a card with a layout', () => {
	it('draws only the fields of the layout, in order, after the title', () => {
		const article = draw(
			task,
			layout([
				{ field: 'assignee', style: 'text' },
				{ field: 'priority', style: 'pill' },
			])
		);
		const fields = within(article).getAllByTestId(/^card-field-/);
		expect(fields.map(el => el.getAttribute('data-testid'))).toEqual(['card-field-assignee', 'card-field-priority']);
		// Not in the layout: no id, no type, no label.
		expect(within(article).queryByText('aaa11111')).toBeNull();
		expect(within(article).queryByText('bug')).toBeNull();
		expect(within(article).queryByText('billing')).toBeNull();
	});

	it('the id leads the card when it is the first field and sits in the row when it is not', () => {
		const first = draw(task, layout([{ field: 'id', style: '' }, { field: 'priority', style: 'pill' }]));
		expect(within(first).getByTestId('card-field-id')).toHaveTextContent('aaa11111');
		expect(first.querySelector('[data-testid="card-meta"]')).not.toContainElement(
			within(first).getByTestId('card-field-id')
		);
	});

	it('an id after another field is drawn in the row of fields, in its place', () => {
		const article = draw(task, layout([{ field: 'priority', style: 'pill' }, { field: 'id', style: '' }]));
		const meta = within(article).getByTestId('card-meta');
		expect(within(meta).getAllByTestId(/^card-field-/).map(el => el.getAttribute('data-testid'))).toEqual([
			'card-field-priority',
			'card-field-id',
		]);
	});

	it('title lines clamp the title: 1, 2 or 3', () => {
		for (const [lines, className] of [
			[1, 'line-clamp-1'],
			[2, 'line-clamp-2'],
			[3, 'line-clamp-3'],
		] as const) {
			const { unmount } = render(<BoardCard card={task} view={view()} layout={layout([], lines)} />);
			expect(screen.getByTestId('kanban-card-title')).toHaveClass(className);
			unmount();
		}
	});

	it('an empty field list is a title-only card', () => {
		const article = draw(task, layout([]));
		expect(within(article).queryAllByTestId(/^card-field-/)).toEqual([]);
		expect(within(article).queryByTestId('card-meta')).toBeNull();
		expect(within(article).getByRole('link')).toHaveTextContent('Write the spec');
	});

	it('priority: pill is a coloured pill, text is plain muted text, dot is a dot titled with the priority', () => {
		const pill = draw(task, layout([{ field: 'priority', style: 'pill' }]));
		expect(within(pill).getByTestId('card-field-priority')).toHaveAttribute('data-style', 'pill');
		expect(within(pill).getByTestId('card-field-priority')).toHaveClass('rounded-full');
		document.body.innerHTML = '';
		const text = draw(task, layout([{ field: 'priority', style: 'text' }]));
		const textField = within(text).getByTestId('card-field-priority');
		expect(textField).toHaveTextContent('High');
		expect(textField).toHaveClass('text-muted');
		expect(textField).not.toHaveClass('rounded-full');
		document.body.innerHTML = '';
		const dot = draw(task, layout([{ field: 'priority', style: 'dot' }]));
		const dotField = within(dot).getByTestId('card-field-priority');
		expect(dotField).toHaveAttribute('title', 'High');
		expect(dotField).toHaveAttribute('aria-label', 'Priority: High');
		expect(dotField).toHaveTextContent('');
	});

	it('assignee: text is the name, initials is a round badge titled with the name', () => {
		const text = draw(task, layout([{ field: 'assignee', style: 'text' }]));
		expect(within(text).getByTestId('card-field-assignee')).toHaveTextContent('Ada Lovelace');
		document.body.innerHTML = '';
		const initials = draw(task, layout([{ field: 'assignee', style: 'initials' }]));
		const badge = within(initials).getByTestId('card-field-assignee');
		expect(badge).toHaveTextContent('AL');
		expect(badge).toHaveAttribute('title', 'Ada Lovelace');
		expect(badge).toHaveAttribute('aria-label', 'Assignee: Ada Lovelace');
		expect(badge).toHaveClass('rounded-full');
	});

	it('initials of a single word or a login are one or two letters', () => {
		const one = draw({ ...task, assignee: 'ann' }, layout([{ field: 'assignee', style: 'initials' }]));
		expect(within(one).getByTestId('card-field-assignee')).toHaveTextContent('A');
		document.body.innerHTML = '';
		const dotted = draw({ ...task, assignee: 'ann.lee' }, layout([{ field: 'assignee', style: 'initials' }]));
		expect(within(dotted).getByTestId('card-field-assignee')).toHaveTextContent('AL');
	});

	it('status: auto shows only where the column holds several statuses; pill and dot always', () => {
		const alone = draw(task, layout([{ field: 'status', style: 'auto' }]), { showStatus: false });
		expect(within(alone).queryByTestId('card-field-status')).toBeNull();
		document.body.innerHTML = '';
		const grouped = draw(task, layout([{ field: 'status', style: 'auto' }]), { showStatus: true });
		expect(within(grouped).getByTestId('card-field-status')).toHaveTextContent('review');
		document.body.innerHTML = '';
		const pill = draw(task, layout([{ field: 'status', style: 'pill' }]), { showStatus: false });
		expect(within(pill).getByTestId('card-field-status')).toHaveTextContent('review');
		document.body.innerHTML = '';
		const dot = draw(task, layout([{ field: 'status', style: 'dot' }]), { showStatus: false });
		const dotField = within(dot).getByTestId('card-field-status');
		expect(dotField).toHaveAttribute('title', 'review');
		expect(dotField).toHaveAttribute('aria-label', 'Status: review');
	});

	it('created and statusSince show a short date; parent shows a child icon and the parent id', () => {
		const article = draw(
			task,
			layout([
				{ field: 'created', style: '' },
				{ field: 'statusSince', style: '' },
				{ field: 'parent', style: '' },
			])
		);
		expect(within(article).getByTestId('card-field-created')).toHaveTextContent('2026-11-01');
		expect(within(article).getByTestId('card-field-created')).toHaveAttribute('title', 'Created 2026-11-01T09:00:00.000Z');
		expect(within(article).getByTestId('card-field-statusSince')).toHaveTextContent('since 2026-11-10');
		const parent = within(article).getByTestId('card-field-parent');
		expect(parent).toHaveTextContent(/^ppp00000$/);
		expect(parent).toHaveAttribute('title', 'Parent task ppp00000');
		expect(parent.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
	});

	it('draws nothing, no placeholder, for a fact the card does not have', () => {
		const bare: BoardCardData = { id: 'bbb22222', headline: 'Bare', status: 'todo' };
		const article = draw(
			bare,
			layout([
				{ field: 'priority', style: 'pill' },
				{ field: 'assignee', style: 'text' },
				{ field: 'created', style: '' },
				{ field: 'statusSince', style: '' },
				{ field: 'parent', style: '' },
			])
		);
		expect(within(article).queryAllByTestId(/^card-field-/)).toEqual([]);
		expect(within(article).queryByTestId('card-meta')).toBeNull();
	});

	it('an unreadable date draws nothing', () => {
		const article = draw({ ...task, createdAt: 'later' }, layout([{ field: 'created', style: '' }]));
		expect(within(article).queryByTestId('card-field-created')).toBeNull();
	});

	it('keeps the Move to menu and the drag whatever the layout', () => {
		const article = draw(task, layout([]));
		expect(within(article).getByRole('button', { name: 'Move aaa11111 to another status' })).toBeInTheDocument();
		expect(article).toHaveAttribute('draggable', 'true');
	});

	it('a read-only card has no Move to menu', () => {
		const article = draw(task, layout([{ field: 'id', style: '' }]), { readOnly: true });
		expect(within(article).queryByRole('button')).toBeNull();
	});
});
