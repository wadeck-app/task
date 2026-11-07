import { AmbiguousTaskPrefixError, TaskNotFoundError } from '@wadeck-app/task-core';
import type { TaskSummary } from '@wadeck-app/task-core';

import type { TaskServiceContext } from './context.js';
import { headlineOf } from './taskText.js';

export const SEARCH_DEFAULT_LIMIT = 8;
export const SEARCH_MAX_LIMIT = 20;

export interface SearchTasksInput {
	/** Text to look for in the ids and titles (case-insensitive). Empty matches every task. */
	q: string;
	/** Clamped to 1..{@link SEARCH_MAX_LIMIT}; default {@link SEARCH_DEFAULT_LIMIT}. */
	limit?: number;
	/** Full task ids to leave out. */
	exclude?: readonly string[];
	/** Id or unambiguous prefix of a task; it and all its descendants are left out (the candidates of a "parent" picker). */
	excludeDescendantsOf?: string;
}

export interface TaskSearchHit {
	id: string;
	/** At most 90 characters, see `headlineOf`. */
	headline: string;
	status: string;
}

/** Rank of a match, lower is better: 0 id prefix, 1 a word of the title starts with the query, 2 the query is inside the title, 3 empty query. */
function rankOf(task: TaskSummary, query: string): number | undefined {
	if (query === '') {
		return 3;
	}
	if (task.id.toLowerCase().startsWith(query)) {
		return 0;
	}
	const title = task.title.toLowerCase();
	let found = title.indexOf(query);
	if (found === -1) {
		return undefined;
	}
	while (found !== -1) {
		if (found === 0 || /[^\p{L}\p{N}]/u.test(title[found - 1]!)) {
			return 1;
		}
		found = title.indexOf(query, found + 1);
	}
	return 2;
}

/** Resolves an id or prefix against the index (no file read). */
function resolveInIndex(tasks: readonly TaskSummary[], idOrPrefix: string): string {
	if (tasks.some(task => task.id === idOrPrefix)) {
		return idOrPrefix;
	}
	const lower = idOrPrefix.toLowerCase();
	const matches = tasks.filter(task => task.id.toLowerCase().startsWith(lower));
	if (matches.length === 0) {
		throw new TaskNotFoundError(idOrPrefix);
	}
	if (matches.length > 1) {
		throw new AmbiguousTaskPrefixError(
			idOrPrefix,
			matches.map(task => task.id)
		);
	}
	return matches[0]!.id;
}

/** The task and everything below it, from the parent links of the index (a cycle of a corrupted index ends the walk). */
function subtreeIds(tasks: readonly TaskSummary[], rootId: string): Set<string> {
	const childrenOf = new Map<string, string[]>();
	for (const task of tasks) {
		if (task.parentId !== undefined) {
			childrenOf.set(task.parentId, [...(childrenOf.get(task.parentId) ?? []), task.id]);
		}
	}
	const seen = new Set<string>([rootId]);
	const pending = [rootId];
	while (pending.length > 0) {
		for (const child of childrenOf.get(pending.pop()!) ?? []) {
			if (!seen.has(child)) {
				seen.add(child);
				pending.push(child);
			}
		}
	}
	return seen;
}

/**
 * Finds tasks by id prefix or title text for a picker: reads the INDEX only (never a task file).
 * Ranking: id prefix, then title word prefix, then substring; inside a rank the index order is kept.
 */
export function searchTasks(ctx: TaskServiceContext, input: SearchTasksInput): TaskSearchHit[] {
	const tasks = ctx.store.list();
	const query = input.q.trim().toLowerCase();
	const limit = Math.min(SEARCH_MAX_LIMIT, Math.max(1, Math.floor(input.limit ?? SEARCH_DEFAULT_LIMIT)));
	const excluded = new Set(input.exclude ?? []);
	if (input.excludeDescendantsOf !== undefined) {
		for (const id of subtreeIds(tasks, resolveInIndex(tasks, input.excludeDescendantsOf))) {
			excluded.add(id);
		}
	}
	const ranked: Array<{ task: TaskSummary; rank: number; position: number }> = [];
	tasks.forEach((task, position) => {
		const rank = excluded.has(task.id) ? undefined : rankOf(task, query);
		if (rank !== undefined) {
			ranked.push({ task, rank, position });
		}
	});
	ranked.sort((a, b) => a.rank - b.rank || a.position - b.position);
	return ranked
		.slice(0, limit)
		.map(({ task }) => ({ id: task.id, headline: headlineOf(task.title), status: task.status }));
}
