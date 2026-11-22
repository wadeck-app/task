import { toneOf } from '../tones.js';
import type { Tone } from '../tones.js';

/** One row of `GET /tasks` as the Tasks page hands it over. Everything but `id`, `title` and `status` can be absent. */
export interface TaskListRow {
	id: string;
	/** The full title (tooltip and search). */
	title: string;
	/** The title already cut by the route; shown instead of `title` when set. */
	titleText?: string;
	status: string;
	/** The tone of the status. The route does not send it today: see `statusTone`. */
	tone?: Tone;
	/** The effective priority name ("medium"), absent in the global list. */
	priority?: string | undefined;
	/** The effective priority, "medium (default)" when none is stored. */
	priorityText?: string;
	priorityIsDefault?: boolean;
	assignee?: string;
	/** The lease of the assignee, the tooltip of the assignee. */
	leaseText?: string;
	/** Short UTC text of the creation. */
	created?: string;
	createdAt?: string;
	/** ISO instant of the last update; absent on old data. */
	updatedAt?: string;
	/** Short UTC text of the last update. */
	updated?: string;
	statusSince?: string;
	/** The address of the task page (project query included). */
	href?: string;
	projectName?: string;
	projectPath?: string;
}

export type SortKey = 'id' | 'title' | 'status' | 'priority' | 'assignee' | 'created' | 'updated' | 'project';
export type SortDir = 'asc' | 'desc';
export type UpdatedRange = 'any' | '24h' | '7d' | '30d';
export type FacetKey = 'status' | 'priority' | 'assignee' | 'project';

export interface ListState {
	/** The text search. */
	q: string;
	sort: SortKey;
	dir: SortDir;
	status: string[];
	priority: string[];
	/** Names, and `UNASSIGNED` for the tasks nobody holds. */
	assignee: string[];
	project: string[];
	updated: UpdatedRange;
}

/** The value of the assignee filter for the tasks nobody holds. */
export const UNASSIGNED = '__unassigned__';

export const SORT_KEYS: readonly SortKey[] = [
	'id',
	'title',
	'status',
	'priority',
	'assignee',
	'created',
	'updated',
	'project',
];
export const UPDATED_RANGES: readonly UpdatedRange[] = ['any', '24h', '7d', '30d'];
export const UPDATED_RANGE_LABEL: Record<UpdatedRange, string> = {
	any: 'Any time',
	'24h': 'Last 24 hours',
	'7d': 'Last 7 days',
	'30d': 'Last 30 days',
};
const RANGE_MS: Record<Exclude<UpdatedRange, 'any'>, number> = {
	'24h': 24 * 3_600_000,
	'7d': 7 * 24 * 3_600_000,
	'30d': 30 * 24 * 3_600_000,
};

/** The default view: the last update, most recent first. */
export const DEFAULT_STATE: ListState = {
	q: '',
	sort: 'updated',
	dir: 'desc',
	status: [],
	priority: [],
	assignee: [],
	project: [],
	updated: 'any',
};

/** True when a filter (not the sort) narrows the list. */
export function hasActiveFilters(state: ListState): boolean {
	return activeFilterCount(state) > 0;
}

/** How many filters are set (the text counts as one, each facet as one, whatever its number of values). */
export function activeFilterCount(state: ListState): number {
	return (
		(state.q.trim() === '' ? 0 : 1) +
		[state.status, state.priority, state.assignee, state.project].filter(values => values.length > 0).length +
		(state.updated === 'any' ? 0 : 1)
	);
}

// ---------------------------------------------------------------------------------------------------------------------
// Values of a row

const DEFAULT_SUFFIX = / \(default\)$/;

/** The priority name of a row: `priority`, else `priorityText` without its "(default)" suffix; '' when it carries none. */
export function priorityName(row: TaskListRow): string {
	if (row.priority !== undefined && row.priority !== '') {
		return row.priority;
	}
	return (row.priorityText ?? '').replace(DEFAULT_SUFFIX, '');
}

/** The status colour. The row's own `tone` when the route sends one, else a guess from the NAME (the route sends none). */
export function statusTone(row: Pick<TaskListRow, 'status' | 'tone'>): Tone {
	if (row.tone !== undefined) {
		return toneOf(row.tone);
	}
	const name = row.status.toLowerCase();
	if (['done', 'closed', 'complete', 'completed', 'resolved', 'finished', 'shipped', 'merged'].includes(name)) {
		return 'success';
	}
	if (['cancelled', 'canceled', 'wontfix', 'rejected', 'abandoned', 'declined', 'invalid'].includes(name)) {
		return 'danger';
	}
	if (['open', 'todo', 'to-do', 'new', 'backlog', 'created'].includes(name)) {
		return 'neutral';
	}
	return 'info';
}

// ---------------------------------------------------------------------------------------------------------------------
// Sort

const KNOWN_PRIORITIES = ['low', 'medium', 'high', 'urgent'];

export interface PriorityRanking {
	/** `supplied`: the order the route gave; `known`: low < medium < high < urgent; `alphabetical`: any other set of names. */
	kind: 'supplied' | 'known' | 'alphabetical';
	/** The names from lowest to highest; empty for `alphabetical`. */
	order: string[];
}

/**
 * How priorities are ranked. The rows carry only the NAME of the priority, never the project order, so: the order the
 * route supplies (`priorityOrder`, lowest first) wins; else low < medium < high < urgent when every name present is one
 * of those four; else alphabetical (the component says so under the list).
 */
export function priorityRanking(rows: readonly TaskListRow[], supplied: readonly string[] | undefined): PriorityRanking {
	if (supplied !== undefined && supplied.length > 0) {
		return { kind: 'supplied', order: supplied.map(name => name.toLowerCase()) };
	}
	const names = new Set(rows.map(priorityName).filter(name => name !== ''));
	if ([...names].every(name => KNOWN_PRIORITIES.includes(name.toLowerCase()))) {
		return { kind: 'known', order: KNOWN_PRIORITIES };
	}
	return { kind: 'alphabetical', order: [] };
}

export interface SortContext {
	/** The priorities of the project, lowest first, when the route supplies them. */
	priorityOrder?: readonly string[] | undefined;
}

function compareText(a: string, b: string): number {
	return a.localeCompare(b, 'en', { sensitivity: 'base', numeric: true });
}

function compareCode(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

/** A sortable key of a row: a number, a string, or undefined (the row goes last in both directions). */
type Key = number | string | undefined;

function instant(text: string | undefined): number | undefined {
	if (text === undefined || text === '') {
		return undefined;
	}
	const time = Date.parse(text);
	return Number.isNaN(time) ? undefined : time;
}

/** The rows ordered by the sort of the state; ties by id (ascending), rows without a value last, whatever the direction. */
export function sortRows(rows: readonly TaskListRow[], state: ListState, context: SortContext): TaskListRow[] {
	const ranking = priorityRanking(rows, context.priorityOrder);
	const keyOf = (row: TaskListRow): Key => {
		switch (state.sort) {
			case 'id':
				return row.id;
			case 'title':
				return (row.title || row.titleText) ?? '';
			case 'status':
				return row.status;
			case 'assignee':
				return row.assignee === undefined || row.assignee === '' ? undefined : row.assignee;
			case 'project':
				return row.projectName === undefined || row.projectName === '' ? undefined : row.projectName;
			case 'created':
				return instant(row.createdAt);
			case 'updated':
				return instant(row.updatedAt);
			case 'priority': {
				const name = priorityName(row);
				if (name === '') {
					return undefined;
				}
				if (ranking.kind === 'alphabetical') {
					return name;
				}
				const rank = ranking.order.indexOf(name.toLowerCase());
				// A name the supplied order does not list sorts below every listed one.
				return rank === -1 ? -1 : rank;
			}
		}
	};
	const sign = state.dir === 'asc' ? 1 : -1;
	return rows
		.map(row => ({ row, key: keyOf(row) }))
		.sort((a, b) => {
			if (a.key === undefined || b.key === undefined) {
				if (a.key !== b.key) {
					return a.key === undefined ? 1 : -1;
				}
			} else if (typeof a.key === 'number' && typeof b.key === 'number') {
				if (a.key !== b.key) {
					return (a.key - b.key) * sign;
				}
			} else {
				const order = compareText(String(a.key), String(b.key));
				if (order !== 0) {
					return order * sign;
				}
			}
			return compareCode(a.row.id, b.row.id);
		})
		.map(entry => entry.row);
}

// ---------------------------------------------------------------------------------------------------------------------
// Filters

/** What a row offers to the facet `key`: a value, or undefined when it has none. */
function facetValue(row: TaskListRow, key: FacetKey): string | undefined {
	switch (key) {
		case 'status':
			return row.status === '' ? undefined : row.status;
		case 'priority': {
			const name = priorityName(row);
			return name === '' ? undefined : name;
		}
		case 'assignee':
			return row.assignee === undefined || row.assignee === '' ? UNASSIGNED : row.assignee;
		case 'project':
			return row.projectName === undefined || row.projectName === '' ? undefined : row.projectName;
	}
}

function matchesText(row: TaskListRow, text: string): boolean {
	const needle = text.trim().toLowerCase();
	if (needle === '') {
		return true;
	}
	return [row.id, row.title, row.titleText, row.assignee, row.projectName].some(
		value => value !== undefined && value.toLowerCase().includes(needle)
	);
}

/** The rows that pass every filter of the state (AND between filters, OR between the values of one). Order kept. */
export function applyFilters(rows: readonly TaskListRow[], state: ListState, nowMs: number): TaskListRow[] {
	const facets: FacetKey[] = ['status', 'priority', 'assignee', 'project'];
	return rows.filter(row => {
		if (!matchesText(row, state.q)) {
			return false;
		}
		for (const key of facets) {
			const wanted = state[key];
			if (wanted.length === 0) {
				continue;
			}
			const value = facetValue(row, key);
			if (value === undefined || !wanted.includes(value)) {
				return false;
			}
		}
		if (state.updated !== 'any') {
			const at = instant(row.updatedAt);
			if (at === undefined || nowMs - at > RANGE_MS[state.updated]) {
				return false;
			}
		}
		return true;
	});
}

export interface FacetOption {
	value: string;
	label: string;
	count: number;
}

/**
 * The values of one facet present in the rows, with their counts: most frequent first, then by name (Unassigned is a
 * value of the assignee facet). `selected` values no row has stay listed with a count of 0.
 */
export function facetOptions(rows: readonly TaskListRow[], key: FacetKey, selected: readonly string[] = []): FacetOption[] {
	const counts = new Map<string, number>();
	for (const row of rows) {
		const value = facetValue(row, key);
		if (value !== undefined) {
			counts.set(value, (counts.get(value) ?? 0) + 1);
		}
	}
	for (const value of selected) {
		if (!counts.has(value)) {
			counts.set(value, 0);
		}
	}
	return [...counts.entries()]
		.map(([value, count]) => ({ value, label: value === UNASSIGNED ? 'Unassigned' : value, count }))
		.sort((a, b) => b.count - a.count || compareText(a.label, b.label));
}

// ---------------------------------------------------------------------------------------------------------------------
// Address

/** The query parameters this list owns. Every other one belongs to the page and is never touched. */
export const LIST_PARAMS = ['q', 'sort', 'dir', 'status', 'priority', 'assignee', 'projectIn', 'updated'] as const;

export interface ParsedState {
	state: ListState;
	/** At least one list parameter is in the address. */
	present: boolean;
	/** What was ignored, each with the accepted values. */
	warnings: string[];
}

/** The state an address describes. An unknown sort, direction or range is ignored WITH a warning. */
export function parseListState(search: string): ParsedState {
	const params = new URLSearchParams(search);
	const warnings: string[] = [];
	const state: ListState = { ...DEFAULT_STATE };
	const present = LIST_PARAMS.some(name => params.has(name));
	state.q = params.get('q') ?? '';
	const sort = params.get('sort');
	if (sort !== null) {
		if ((SORT_KEYS as readonly string[]).includes(sort)) {
			state.sort = sort as SortKey;
		} else {
			warnings.push(`The address asks to sort by "${sort}", which does not exist; use one of ${SORT_KEYS.join(', ')}.`);
		}
	}
	const dir = params.get('dir');
	if (dir !== null) {
		if (dir === 'asc' || dir === 'desc') {
			state.dir = dir;
		} else {
			warnings.push(`The address asks for the direction "${dir}"; use asc or desc.`);
		}
	}
	const updated = params.get('updated');
	if (updated !== null) {
		if ((UPDATED_RANGES as readonly string[]).includes(updated)) {
			state.updated = updated as UpdatedRange;
		} else {
			warnings.push(`The address asks for the update range "${updated}"; use ${UPDATED_RANGES.join(', ')}.`);
		}
	}
	state.status = params.getAll('status');
	state.priority = params.getAll('priority');
	state.assignee = params.getAll('assignee');
	state.project = params.getAll('projectIn');
	return { state, present, warnings };
}

/**
 * The query string (with its `?`, or '' when empty) for `state`, over `currentSearch`: the page's own parameters are kept
 * as they are, the list's are rewritten, and the default view writes none.
 */
export function serializeListState(state: ListState, currentSearch: string): string {
	const params = new URLSearchParams(currentSearch);
	for (const name of LIST_PARAMS) {
		params.delete(name);
	}
	if (state.q !== '') {
		params.set('q', state.q);
	}
	if (state.sort !== DEFAULT_STATE.sort || state.dir !== DEFAULT_STATE.dir) {
		params.set('sort', state.sort);
		params.set('dir', state.dir);
	}
	for (const value of state.status) {
		params.append('status', value);
	}
	for (const value of state.priority) {
		params.append('priority', value);
	}
	for (const value of state.assignee) {
		params.append('assignee', value);
	}
	for (const value of state.project) {
		params.append('projectIn', value);
	}
	if (state.updated !== 'any') {
		params.set('updated', state.updated);
	}
	const text = params.toString();
	return text === '' ? '' : `?${text}`;
}
