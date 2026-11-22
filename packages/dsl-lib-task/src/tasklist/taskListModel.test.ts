import { describe, expect, it } from 'vitest';
import { GLOBAL_ROWS, NOW, ROWS } from './taskListFixtures.js';
import {
	DEFAULT_STATE,
	UNASSIGNED,
	applyFilters,
	facetOptions,
	hasActiveFilters,
	parseListState,
	priorityRanking,
	serializeListState,
	sortRows,
	statusTone,
} from './taskListModel.js';
import type { ListState } from './taskListModel.js';

const ids = (rows: Array<{ id: string }>): string[] => rows.map(r => r.id.slice(-1));
const NOW_MS = Date.parse(NOW);
const state = (over: Partial<ListState>): ListState => ({ ...DEFAULT_STATE, ...over });

describe('default order', () => {
	it('is the last update, most recent first; a row without updatedAt comes last; ties by id', () => {
		// 2 (22 Nov), 3 (21 Nov), 4 (16 Nov), then 1 and 6 tie on the same instant (by id), 5 has no date.
		expect(ids(sortRows(ROWS, DEFAULT_STATE, {}))).toEqual(['2', '3', '4', '1', '6', '5']);
	});

	it('keeps a row without updatedAt last in BOTH directions', () => {
		expect(ids(sortRows(ROWS, state({ dir: 'asc' }), {}))).toEqual(['1', '6', '4', '3', '2', '5']);
	});

	it('does not reorder the input; equal keys are ordered by id, ascending, in both directions', () => {
		const copy = [...ROWS];
		sortRows(ROWS, state({ sort: 'status' }), {});
		expect(ROWS).toEqual(copy);
		expect(ids(sortRows(ROWS, state({ sort: 'status', dir: 'asc' }), {}))).toEqual(['5', '3', '2', '4', '1', '6']);
		expect(ids(sortRows(ROWS, state({ sort: 'status', dir: 'desc' }), {}))).toEqual(['1', '6', '2', '4', '3', '5']);
	});
});

describe('sort columns', () => {
	it('sorts the id, the title (case-insensitive) and the assignee (empty last)', () => {
		expect(ids(sortRows(ROWS, state({ sort: 'id', dir: 'desc' }), {}))).toEqual(['6', '5', '4', '3', '2', '1']);
		expect(ids(sortRows(ROWS, state({ sort: 'title', dir: 'asc' }), {}))).toEqual(['1', '2', '3', '4', '5', '6']);
		expect(ids(sortRows(ROWS, state({ sort: 'assignee', dir: 'asc' }), {}))).toEqual(['2', '4', '3', '1', '5', '6']);
		expect(ids(sortRows(ROWS, state({ sort: 'assignee', dir: 'desc' }), {}))).toEqual(['3', '2', '4', '1', '5', '6']);
	});

	it('sorts the creation date', () => {
		expect(ids(sortRows(ROWS, state({ sort: 'created', dir: 'desc' }), {}))).toEqual(['6', '5', '4', '3', '2', '1']);
	});

	it('sorts the project of the global list', () => {
		expect(ids(sortRows(GLOBAL_ROWS, state({ sort: 'project', dir: 'asc' }), {})).join('')).toBe('135246');
	});
});

describe('priority order', () => {
	it('uses low < medium < high < urgent when the names are exactly those', () => {
		expect(priorityRanking(ROWS, undefined).kind).toBe('known');
		expect(ids(sortRows(ROWS, state({ sort: 'priority', dir: 'desc' }), {}))).toEqual(['4', '2', '5', '1', '6', '3']);
		expect(ids(sortRows(ROWS, state({ sort: 'priority', dir: 'asc' }), {}))).toEqual(['3', '1', '6', '2', '5', '4']);
	});

	it('uses the order the route supplies (lowest first), whatever the names', () => {
		const rows = ROWS.map(r => ({ ...r, priority: r.priority === 'urgent' ? 'p0' : r.priority }));
		const order = ['low', 'medium', 'high', 'p0'];
		expect(priorityRanking(rows, order).kind).toBe('supplied');
		expect(ids(sortRows(rows, state({ sort: 'priority', dir: 'desc' }), { priorityOrder: order }))[0]).toBe('4');
	});

	it('falls back to alphabetical, said so, when a name is not one of the four', () => {
		const rows = ROWS.map(r => ({ ...r, priority: r.priority === 'urgent' ? 'p0' : r.priority }));
		expect(priorityRanking(rows, undefined).kind).toBe('alphabetical');
		expect(ids(sortRows(rows, state({ sort: 'priority', dir: 'asc' }), {})).slice(0, 2)).toEqual(['2', '5']);
	});

	it('takes the name from priorityText when priority is absent, without the "(default)" suffix', () => {
		const rows = [{ ...ROWS[0]!, priority: undefined, priorityText: 'high (default)' }];
		expect(facetOptions(rows, 'priority')).toEqual([{ value: 'high', label: 'high', count: 1 }]);
	});
});

describe('filters', () => {
	it('searches id, title, assignee and project, case-insensitively', () => {
		expect(ids(applyFilters(ROWS, state({ q: 'BILLING' }), NOW_MS))).toEqual(['2', '4']);
		expect(ids(applyFilters(ROWS, state({ q: 'aaaa0003' }), NOW_MS))).toEqual(['3']);
		expect(ids(applyFilters(ROWS, state({ q: 'bob' }), NOW_MS))).toEqual(['3']);
		expect(ids(applyFilters(GLOBAL_ROWS, state({ q: 'Beta' }), NOW_MS))).toEqual(['2', '4', '6']);
		expect(applyFilters(ROWS, state({ q: '  ' }), NOW_MS)).toHaveLength(6);
	});

	it('filters by status, priority, assignee (with Unassigned) and project: values of one filter are OR', () => {
		expect(ids(applyFilters(ROWS, state({ status: ['in-progress', 'done'] }), NOW_MS))).toEqual(['2', '3', '4']);
		expect(ids(applyFilters(ROWS, state({ priority: ['high'] }), NOW_MS))).toEqual(['2', '5']);
		expect(ids(applyFilters(ROWS, state({ assignee: ['ann'] }), NOW_MS))).toEqual(['2', '4']);
		expect(ids(applyFilters(ROWS, state({ assignee: [UNASSIGNED] }), NOW_MS))).toEqual(['1', '5', '6']);
		expect(ids(applyFilters(ROWS, state({ assignee: [UNASSIGNED, 'bob'] }), NOW_MS))).toEqual(['1', '3', '5', '6']);
		expect(ids(applyFilters(GLOBAL_ROWS, state({ project: ['alpha'] }), NOW_MS))).toEqual(['1', '3', '5']);
	});

	it('filters by the update range; a row without updatedAt is not in any range', () => {
		expect(ids(applyFilters(ROWS, state({ updated: '24h' }), NOW_MS))).toEqual(['2']);
		expect(ids(applyFilters(ROWS, state({ updated: '7d' }), NOW_MS))).toEqual(['2', '3', '4']);
		expect(ids(applyFilters(ROWS, state({ updated: '30d' }), NOW_MS))).toEqual(['1', '2', '3', '4', '6']);
		expect(applyFilters(ROWS, state({ updated: 'any' }), NOW_MS)).toHaveLength(6);
	});

	it('combines every filter with AND', () => {
		const combined = state({
			q: 'billing',
			status: ['in-progress'],
			assignee: ['ann'],
			priority: ['urgent'],
			updated: '30d',
		});
		expect(ids(applyFilters(ROWS, combined, NOW_MS))).toEqual(['4']);
		expect(applyFilters(ROWS, state({ q: 'billing', status: ['done'] }), NOW_MS)).toEqual([]);
	});

	it('knows when a filter is active (sorting is not a filter)', () => {
		expect(hasActiveFilters(DEFAULT_STATE)).toBe(false);
		expect(hasActiveFilters(state({ sort: 'title', dir: 'asc' }))).toBe(false);
		expect(hasActiveFilters(state({ q: 'x' }))).toBe(true);
		expect(hasActiveFilters(state({ updated: '7d' }))).toBe(true);
		expect(hasActiveFilters(state({ status: ['done'] }))).toBe(true);
	});
});

describe('facets', () => {
	it('lists the values present with their counts, most frequent first then by name; Unassigned is an entry', () => {
		expect(facetOptions(ROWS, 'status')).toEqual([
			{ value: 'in-progress', label: 'in-progress', count: 2 },
			{ value: 'open', label: 'open', count: 2 },
			{ value: 'cancelled', label: 'cancelled', count: 1 },
			{ value: 'done', label: 'done', count: 1 },
		]);
		expect(facetOptions(ROWS, 'assignee')).toEqual([
			{ value: UNASSIGNED, label: 'Unassigned', count: 3 },
			{ value: 'ann', label: 'ann', count: 2 },
			{ value: 'bob', label: 'bob', count: 1 },
		]);
		expect(facetOptions(GLOBAL_ROWS, 'project').map(o => `${o.value}:${o.count}`)).toEqual(['alpha:3', 'beta:3']);
	});

	it('keeps a selected value that no row has (count 0): a shared link never hides its own filter', () => {
		expect(facetOptions(ROWS, 'status', ['ghost'])).toContainEqual({ value: 'ghost', label: 'ghost', count: 0 });
	});
});

describe('status tone', () => {
	it('uses the tone of the row when the route gives one, else a documented guess by name', () => {
		expect(statusTone({ status: 'whatever', tone: 'danger' })).toBe('danger');
		expect(statusTone({ status: 'done' })).toBe('success');
		expect(statusTone({ status: 'cancelled' })).toBe('danger');
		expect(statusTone({ status: 'open' })).toBe('neutral');
		expect(statusTone({ status: 'in-progress' })).toBe('info');
	});
});

describe('address state', () => {
	it('reads nothing from an address without list parameters', () => {
		const parsed = parseListState('?showAll=true&parent=ab');
		expect(parsed.state).toEqual(DEFAULT_STATE);
		expect(parsed.present).toBe(false);
		expect(parsed.warnings).toEqual([]);
	});

	it('round-trips every field and leaves the other parameters of the page untouched', () => {
		const wanted = state({
			q: 'bill ing&x',
			sort: 'title',
			dir: 'asc',
			status: ['in-progress', 'done'],
			priority: ['high'],
			assignee: [UNASSIGNED, 'ann'],
			project: ['alpha'],
			updated: '7d',
		});
		const search = serializeListState(wanted, '?showAll=true&parent=ab&reload=3');
		const params = new URLSearchParams(search);
		expect(params.get('showAll')).toBe('true');
		expect(params.get('parent')).toBe('ab');
		expect(params.get('reload')).toBe('3');
		expect(parseListState(search)).toEqual({ state: wanted, present: true, warnings: [] });
	});

	it('writes nothing for the default view and removes stale list parameters', () => {
		const search = serializeListState(DEFAULT_STATE, '?showAll=true&q=old&status=done&sort=id&dir=asc');
		expect(search).toBe('?showAll=true');
		expect(serializeListState(DEFAULT_STATE, '')).toBe('');
	});

	it('says what it ignores: an unknown sort, direction or range is a warning, never a silent default', () => {
		const parsed = parseListState('?sort=colour&dir=sideways&updated=1y');
		expect(parsed.state).toEqual(DEFAULT_STATE);
		expect(parsed.warnings).toHaveLength(3);
		expect(parsed.warnings.join(' ')).toContain('"colour"');
	});
});
