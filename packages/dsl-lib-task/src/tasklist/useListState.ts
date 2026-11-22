import { useCallback, useEffect, useState } from 'react';
import {
	DEFAULT_STATE,
	SORT_KEYS,
	UPDATED_RANGES,
	parseListState,
	serializeListState,
} from './taskListModel.js';
import type { ListState, SortKey, SortDir, UpdatedRange } from './taskListModel.js';

export type ListScope = 'project' | 'all';

/** The columns (so the sorts) each scope has: the global list has no single set of priorities, nor holders. */
export const SCOPE_SORTS: Record<ListScope, readonly SortKey[]> = {
	project: ['id', 'title', 'status', 'priority', 'assignee', 'created', 'updated'],
	all: ['project', 'id', 'title', 'status', 'created', 'updated'],
};

const STORAGE_PREFIX = 'task.list.';

function isStringList(value: unknown): value is string[] {
	return Array.isArray(value) && value.every(item => typeof item === 'string');
}

/** The state of a saved view; undefined when the text is not one (never a half-read state). */
function parseStored(text: string): ListState | undefined {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
		return undefined;
	}
	const value = raw as Record<string, unknown>;
	const state: ListState = { ...DEFAULT_STATE };
	if (value['q'] !== undefined) {
		if (typeof value['q'] !== 'string') return undefined;
		state.q = value['q'];
	}
	if (value['sort'] !== undefined) {
		if (!(SORT_KEYS as readonly unknown[]).includes(value['sort'])) return undefined;
		state.sort = value['sort'] as SortKey;
	}
	if (value['dir'] !== undefined) {
		if (value['dir'] !== 'asc' && value['dir'] !== 'desc') return undefined;
		state.dir = value['dir'] as SortDir;
	}
	if (value['updated'] !== undefined) {
		if (!(UPDATED_RANGES as readonly unknown[]).includes(value['updated'])) return undefined;
		state.updated = value['updated'] as UpdatedRange;
	}
	for (const key of ['status', 'priority', 'assignee', 'project'] as const) {
		if (value[key] !== undefined) {
			if (!isStringList(value[key])) return undefined;
			state[key] = value[key];
		}
	}
	return state;
}

/** Drops what the scope cannot show, WITH a warning: a hidden filter would empty the list without a trace. */
export function fitToScope(state: ListState, scope: ListScope): { state: ListState; warnings: string[] } {
	const warnings: string[] = [];
	const next: ListState = { ...state };
	if (!SCOPE_SORTS[scope].includes(next.sort)) {
		warnings.push(
			`The saved or linked sort "${next.sort}" is not a column of this list; sorting by the last update instead.`
		);
		next.sort = DEFAULT_STATE.sort;
		next.dir = DEFAULT_STATE.dir;
	}
	const unavailable: Array<'priority' | 'assignee' | 'project'> =
		scope === 'all' ? ['priority', 'assignee'] : ['project'];
	for (const key of unavailable) {
		if (next[key].length > 0) {
			warnings.push(`The ${key} filter of the saved or linked view does not exist in this list and was ignored.`);
			next[key] = [];
		}
	}
	return { state: next, warnings };
}

function readStorage(key: string): string | null {
	try {
		return window.sessionStorage.getItem(STORAGE_PREFIX + key);
	} catch {
		return null;
	}
}

interface Initial {
	state: ListState;
	warnings: string[];
}

function initial(scope: ListScope, storageKey: string): Initial {
	const warnings: string[] = [];
	const fromAddress = parseListState(window.location.search);
	warnings.push(...fromAddress.warnings);
	let state = fromAddress.state;
	if (!fromAddress.present) {
		const saved = readStorage(storageKey);
		if (saved !== null) {
			const parsed = parseStored(saved);
			if (parsed === undefined) {
				warnings.push(
					'The saved view of this list could not be read, so the default view is shown. Change a filter or sort to save a new one.'
				);
			} else {
				state = parsed;
			}
		}
	}
	const fitted = fitToScope(state, scope);
	return { state: fitted.state, warnings: [...warnings, ...fitted.warnings] };
}

function persist(state: ListState, storageKey: string): void {
	const search = serializeListState(state, window.location.search);
	if (search !== window.location.search) {
		// Same history state (the router's own), no new entry: a reload or a shared link keeps the view, Back is unaffected.
		window.history.replaceState(window.history.state, '', `${window.location.pathname}${search}${window.location.hash}`);
	}
	try {
		const isDefault = serializeListState(state, '') === '';
		if (isDefault) {
			window.sessionStorage.removeItem(STORAGE_PREFIX + storageKey);
		} else {
			window.sessionStorage.setItem(STORAGE_PREFIX + storageKey, JSON.stringify(state));
		}
	} catch {
		// Storage refused (private mode, quota): the address still carries the view.
	}
}

/**
 * Sort and filters of a list: from the address, else from the last view of this list in sessionStorage; every change is
 * written back to the address (`history.replaceState`, the page's own parameters untouched) and to the storage.
 */
export function useListState(
	scope: ListScope,
	storageKey: string
): { state: ListState; warnings: string[]; update: (patch: Partial<ListState>) => void; reset: () => void } {
	const [start] = useState(() => initial(scope, storageKey));
	const [state, setState] = useState<ListState>(start.state);
	useEffect(() => {
		persist(state, storageKey);
	}, [state, storageKey]);
	const update = useCallback((patch: Partial<ListState>) => setState(current => ({ ...current, ...patch })), []);
	// Clearing the filters keeps the sort: sorting is a way of reading, not a narrowing.
	const reset = useCallback(
		() => setState(current => ({ ...DEFAULT_STATE, sort: current.sort, dir: current.dir })),
		[]
	);
	return { state, warnings: start.warnings, update, reset };
}
