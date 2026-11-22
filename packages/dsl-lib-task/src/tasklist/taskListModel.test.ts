import { describe, expect, it } from 'vitest';
import { GLOBAL_ROWS, NOW, ROWS } from './taskListFixtures.js';
import {
	DEFAULT_STATE,
	UNASSIGNED,
	applyFilters,
	facetOptions,
	activeFilterCount,
	favoriteProjects,
	hasActiveFilters,
	projectOptions,
	parseListState,
	priorityRanking,
	serializeListState,
	sortRows,
	statusTone,
} from './taskListModel.js';
import type { ListState, TaskListRow } from './taskListModel.js';

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

/** Rows of five projects: favorites (zeta, mid), high (hi), normal (plain), low (low). Two rows for zeta, none for mid. */
function projectRow(id: string, project: string, favorite?: boolean, priority?: 'high' | 'normal' | 'low'): TaskListRow {
	return {
		id: `pppp000${id}`,
		title: `Task ${id}`,
		status: 'open',
		projectName: project,
		projectPath: `/w/${project}`,
		...(favorite === undefined ? {} : { projectFavorite: favorite }),
		...(priority === undefined ? {} : { projectPriority: priority }),
	};
}

const PROJECT_ROWS: TaskListRow[] = [
	projectRow('1', 'plain', false, 'normal'),
	projectRow('2', 'zeta', true, 'normal'),
	projectRow('3', 'hi', false, 'high'),
	projectRow('4', 'low', false, 'low'),
	projectRow('5', 'zeta', true, 'normal'),
	projectRow('6', 'plain', false, 'normal'),
];

describe('project options (favorites, priority)', () => {
	it('orders favorites first, then high, normal, low, then the name; counts rows; a project without a row is listed with 0', () => {
		const projects = [
			{ name: 'plain', favorite: false, priority: 'normal' as const, count: 2 },
			{ name: 'mid', favorite: true, priority: 'low' as const, count: 0 },
			{ name: 'zeta', favorite: true, priority: 'normal' as const, count: 2 },
			{ name: 'hi', favorite: false, priority: 'high' as const, count: 1 },
			{ name: 'low', favorite: false, priority: 'low' as const, count: 1 },
		];

		expect(projectOptions(PROJECT_ROWS, projects, []).map(o => [o.value, o.favorite, o.priority, o.count])).toEqual([
			['zeta', true, 'normal', 2],
			['mid', true, 'low', 0],
			['hi', false, 'high', 1],
			['plain', false, 'normal', 2],
			['low', false, 'low', 1],
		]);
	});

	it('without the projects of the server (older answer) it derives them from the rows, in the same order', () => {
		expect(projectOptions(PROJECT_ROWS, undefined, []).map(o => [o.value, o.count])).toEqual([
			['zeta', 2],
			['hi', 1],
			['plain', 2],
			['low', 1],
		]);
	});

	it('rows lacking the new fields are not favorite and normal, ordered by name', () => {
		const old = GLOBAL_ROWS;

		expect(projectOptions(old, undefined, []).map(o => [o.value, o.favorite, o.priority])).toEqual([
			['alpha', false, 'normal'],
			['beta', false, 'normal'],
		]);
		expect(favoriteProjects(projectOptions(old, undefined, []))).toEqual([]);
	});

	it('keeps a selected project that no row has, with 0 and no importance', () => {
		expect(projectOptions(PROJECT_ROWS, undefined, ['ghost'])).toContainEqual({
			value: 'ghost',
			label: 'ghost',
			count: 0,
			favorite: false,
			priority: 'normal',
		});
	});

	it('favoriteProjects lists the favorites in order', () => {
		const options = projectOptions(PROJECT_ROWS, undefined, []);

		expect(favoriteProjects(options).map(o => o.value)).toEqual(['zeta']);
	});
});

describe('favorites only', () => {
	it('keeps the rows of favorite projects; a row without the field is not a favorite', () => {
		expect(ids(applyFilters(PROJECT_ROWS, state({ favoritesOnly: true }), NOW_MS))).toEqual(['2', '5']);
		expect(applyFilters(GLOBAL_ROWS, state({ favoritesOnly: true }), NOW_MS)).toEqual([]);
	});

	it('combines with the project filter, the text, the status and the range (AND)', () => {
		const rows = [...PROJECT_ROWS, { ...projectRow('7', 'mid', true, 'normal'), status: 'done' }];

		expect(ids(applyFilters(rows, state({ favoritesOnly: true, project: ['zeta', 'plain'] }), NOW_MS))).toEqual(['2', '5']);
		expect(ids(applyFilters(rows, state({ favoritesOnly: true, status: ['done'] }), NOW_MS))).toEqual(['7']);
		expect(ids(applyFilters(rows, state({ favoritesOnly: true, q: 'task 5' }), NOW_MS))).toEqual(['5']);
		expect(applyFilters(rows, state({ favoritesOnly: true, project: ['hi'] }), NOW_MS)).toEqual([]);
	});

	it('is a filter: counted once, and active', () => {
		expect(hasActiveFilters(state({ favoritesOnly: true }))).toBe(true);
		expect(activeFilterCount(state({ favoritesOnly: true, project: ['a', 'b'] }))).toBe(2);
	});

	it('does not change the order of the rows (the default order is still the last update)', () => {
		expect(ids(sortRows(applyFilters(ROWS, DEFAULT_STATE, NOW_MS), DEFAULT_STATE, {}))).toEqual(['2', '3', '4', '1', '6', '5']);
	});

	it('lives in the address as fav=1, round-trips, and the default view writes nothing', () => {
		const wanted = state({ favoritesOnly: true, project: ['zeta'] });
		const search = serializeListState(wanted, '?showAll=true');

		expect(new URLSearchParams(search).get('fav')).toBe('1');
		expect(parseListState(search)).toEqual({ state: wanted, present: true, warnings: [] });
		expect(serializeListState(DEFAULT_STATE, '?fav=1')).toBe('');
		expect(parseListState('?fav=1').present).toBe(true);
	});

	it('an address value other than 1 is ignored with a warning naming the accepted value', () => {
		const parsed = parseListState('?fav=yes');

		expect(parsed.state.favoritesOnly).toBe(false);
		expect(parsed.warnings.join(' ')).toContain('fav=1');
	});
});
