import { describe, expect, it } from 'vitest';
import {
	CARD_FIELDS,
	DEFAULT_CARD_LAYOUT,
	draftFromLayout,
	draftToBody,
	hideField,
	moveField,
	parseCardLayout,
	pickPreviewCards,
	shortDate,
	showField,
} from './cardLayout.js';
import type { BoardColumnData } from './boardModel.js';

const column = (key: string, statuses: string[], cards: BoardColumnData['cards']): BoardColumnData => ({
	key,
	label: key,
	statuses: statuses.map(name => ({ name })),
	count: cards.length,
	cards,
});

describe('card field table', () => {
	it('lists the seven fields with their styles, the first style being the default', () => {
		expect(CARD_FIELDS).toEqual({
			id: [],
			priority: ['pill', 'text', 'dot'],
			assignee: ['text', 'initials'],
			status: ['auto', 'pill', 'dot'],
			created: [],
			statusSince: [],
			parent: [],
		});
	});

	it('the default card is id, priority, assignee, status on two title lines', () => {
		expect(DEFAULT_CARD_LAYOUT.titleLines).toBe(2);
		expect(DEFAULT_CARD_LAYOUT.fields.map(entry => entry.field)).toEqual(['id', 'priority', 'assignee', 'status']);
	});
});

describe('parseCardLayout', () => {
	it('absent or malformed gives undefined (the usual card)', () => {
		expect(parseCardLayout(undefined)).toBeUndefined();
		expect(parseCardLayout(null)).toBeUndefined();
		expect(parseCardLayout('x')).toBeUndefined();
		expect(parseCardLayout([])).toBeUndefined();
	});

	it('fills the default style and the default title lines', () => {
		expect(parseCardLayout({ fields: [{ field: 'priority' }, { field: 'assignee', style: 'initials' }] })).toEqual({
			titleLines: 2,
			fields: [
				{ field: 'priority', style: 'pill' },
				{ field: 'assignee', style: 'initials' },
			],
		});
	});

	it('titleLines alone keeps the default fields', () => {
		expect(parseCardLayout({ titleLines: 3 })).toEqual({ titleLines: 3, fields: DEFAULT_CARD_LAYOUT.fields });
	});

	it('an empty fields list is a title-only card', () => {
		expect(parseCardLayout({ fields: [] })).toEqual({ titleLines: 2, fields: [] });
	});

	it('drops an unknown field, a repeated field and an unknown style of a known field', () => {
		expect(
			parseCardLayout({
				titleLines: 9,
				fields: [{ field: 'nope' }, { field: 'priority', style: 'huge' }, { field: 'priority' }, { field: 'id' }],
			})
		).toEqual({
			titleLines: 2,
			fields: [
				{ field: 'priority', style: 'pill' },
				{ field: 'id', style: '' },
			],
		});
	});
});

describe('draft helpers', () => {
	it('starts from the default card when there is no layout: four shown, three hidden after them', () => {
		const draft = draftFromLayout(undefined);
		expect(draft.titleLines).toBe(2);
		expect(draft.items.map(item => `${item.field}:${item.shown}`)).toEqual([
			'id:true',
			'priority:true',
			'assignee:true',
			'status:true',
			'created:false',
			'statusSince:false',
			'parent:false',
		]);
	});

	it('keeps the order of a stored layout and lists the hidden fields after the shown ones', () => {
		const draft = draftFromLayout({
			titleLines: 1,
			fields: [
				{ field: 'parent', style: '' },
				{ field: 'priority', style: 'dot' },
			],
		});
		expect(draft.titleLines).toBe(1);
		expect(draft.items.filter(item => item.shown).map(item => [item.field, item.style])).toEqual([
			['parent', ''],
			['priority', 'dot'],
		]);
		expect(draft.items.slice(2).every(item => !item.shown)).toBe(true);
		expect(draft.items).toHaveLength(7);
	});

	it('moves a shown field earlier or later among the shown ones only', () => {
		const draft = draftFromLayout(undefined);
		const later = moveField(draft.items, 'id', 1);
		expect(later.slice(0, 4).map(item => item.field)).toEqual(['priority', 'id', 'assignee', 'status']);
		expect(moveField(later, 'id', -1).slice(0, 4).map(item => item.field)).toEqual([
			'id',
			'priority',
			'assignee',
			'status',
		]);
		// At the border: nothing moves, nothing crosses into the hidden group.
		expect(moveField(draft.items, 'id', -1)).toEqual(draft.items);
		expect(moveField(draft.items, 'status', 1)).toEqual(draft.items);
	});

	it('hiding sends a field after the shown ones; showing appends it to the shown ones', () => {
		const draft = draftFromLayout(undefined);
		const hidden = hideField(draft.items, 'priority');
		expect(hidden.filter(item => item.shown).map(item => item.field)).toEqual(['id', 'assignee', 'status']);
		expect(hidden[3]!.field).toBe('priority');
		expect(hidden[3]!.shown).toBe(false);
		const shown = showField(hidden, 'parent');
		expect(shown.filter(item => item.shown).map(item => item.field)).toEqual(['id', 'assignee', 'status', 'parent']);
	});

	it('the body lists the shown fields in order, with a style only when it is not the default', () => {
		let { items } = draftFromLayout(undefined);
		items = items.map(item => (item.field === 'assignee' ? { ...item, style: 'initials' } : item));
		expect(draftToBody({ titleLines: 3, items })).toEqual({
			titleLines: 3,
			fields: [{ field: 'id' }, { field: 'priority' }, { field: 'assignee', style: 'initials' }, { field: 'status' }],
		});
		expect(draftToBody({ titleLines: 1, items: items.map(item => ({ ...item, shown: false })) })).toEqual({
			titleLines: 1,
			fields: [],
		});
	});
});

describe('shortDate', () => {
	it('is the UTC day of a valid date', () => {
		expect(shortDate('2026-11-14T23:30:00.000Z')).toBe('2026-11-14');
	});

	it('is undefined for a missing or invalid date: no placeholder', () => {
		expect(shortDate(undefined)).toBeUndefined();
		expect(shortDate('')).toBeUndefined();
		expect(shortDate('yesterday')).toBeUndefined();
	});
});

describe('pickPreviewCards', () => {
	const many = (): BoardColumnData[] => [
		column('A', ['todo'], [
			{ id: 'a1', headline: 'Short', status: 'todo' },
			{
				id: 'a2',
				headline: 'A very long title that goes on and on and on so that it needs more than one line to be read',
				status: 'todo',
			},
			{ id: 'a3', headline: 'Mid size title', status: 'todo', priority: 'high', assignee: 'ann' },
		]),
		column('B', ['doing', 'review'], [
			{ id: 'b1', headline: 'Child', status: 'review', parentId: 'a1', priority: 'low', assignee: 'bob' },
			{ id: 'b2', headline: 'Other', status: 'doing' },
		]),
	];

	it('picks three different real cards: the longest title, an assigned one, one with a parent', () => {
		const picked = pickPreviewCards(many());
		expect(picked).toHaveLength(3);
		expect(picked.every(entry => !entry.sample)).toBe(true);
		const ids = picked.map(entry => entry.card.id);
		expect(new Set(ids).size).toBe(3);
		expect(ids).toContain('a2');
		expect(ids).toContain('b1');
		expect(picked.some(entry => entry.card.assignee !== undefined)).toBe(true);
	});

	it('is deterministic', () => {
		expect(pickPreviewCards(many())).toEqual(pickPreviewCards(many()));
	});

	it('tells whether the column of the card holds several statuses (status auto)', () => {
		const picked = pickPreviewCards(many());
		const child = picked.find(entry => entry.card.id === 'b1')!;
		expect(child.showStatus).toBe(true);
		expect(picked.find(entry => entry.card.id === 'a2')!.showStatus).toBe(false);
	});

	it('completes with clearly labelled samples when the board has fewer than three cards', () => {
		const picked = pickPreviewCards([column('A', ['todo'], [{ id: 'a1', headline: 'Only one', status: 'todo' }])]);
		expect(picked).toHaveLength(3);
		expect(picked[0]!.sample).toBe(false);
		expect(picked.slice(1).every(entry => entry.sample)).toBe(true);
		expect(picked.slice(1).every(entry => entry.card.headline.startsWith('Sample'))).toBe(true);
	});

	it('an empty board gives three samples, each with something to show for every field', () => {
		const picked = pickPreviewCards([]);
		expect(picked).toHaveLength(3);
		expect(picked.every(entry => entry.sample)).toBe(true);
		expect(picked.some(entry => entry.card.parentId !== undefined)).toBe(true);
		expect(picked.some(entry => entry.card.assignee !== undefined)).toBe(true);
		expect(picked.every(entry => entry.card.createdAt !== undefined && entry.card.statusSince !== undefined)).toBe(true);
	});

	it('never changes the real cards', () => {
		const columns = many();
		const before = JSON.stringify(columns);
		pickPreviewCards(columns);
		expect(JSON.stringify(columns)).toBe(before);
	});
});
