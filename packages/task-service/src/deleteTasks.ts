import type { TaskSummary } from '@wadeck-app/task-core';

import type { TaskServiceContext } from './context.js';
import { AmbiguousDeletePrefixError, InvalidDeleteFilterError } from './errors.js';
import { matchGlob } from './text.js';

export const DELETE_FILTER_FIELDS = ['id', 'title', 'status', 'parentId'] as const;
export type DeleteFilterField = (typeof DELETE_FILTER_FIELDS)[number];

export type DeleteSelector =
	{ kind: 'ids'; ids: string[] } | { kind: 'all' } | { kind: 'filter'; field: DeleteFilterField; values: string[] };

/** Parses a `<field>=<glob>[,<glob>...]` expression (glob `*` allowed). */
export function parseDeleteFilter(spec: string): Extract<DeleteSelector, { kind: 'filter' }> {
	const eqIdx = spec.indexOf('=');
	if (eqIdx === -1) {
		throw new InvalidDeleteFilterError(`invalid filter: "${spec}" (expected field=value)`, DELETE_FILTER_FIELDS);
	}
	const field = spec.slice(0, eqIdx);
	if (!(DELETE_FILTER_FIELDS as ReadonlyArray<string>).includes(field)) {
		throw new InvalidDeleteFilterError(`unknown filter field: "${field}"`, DELETE_FILTER_FIELDS);
	}
	const values = spec
		.slice(eqIdx + 1)
		.split(',')
		.filter(v => v.length > 0);
	return { kind: 'filter', field: field as DeleteFilterField, values };
}

export interface PlanDeleteInput {
	selector: DeleteSelector;
	/** Also delete every descendant of the selected tasks (default: children become root tasks). */
	cascade?: boolean;
}

export interface DeletePlan {
	/** Tasks that will be deleted (selection, plus descendants when cascading). */
	tasks: TaskSummary[];
	/** Id prefixes of an `ids` selector that matched no task. */
	notFound: string[];
	/** Surviving children that lose their parent and become root tasks. */
	orphanCount: number;
	/** Links held by surviving tasks that point to a deleted task (removed with it). */
	danglingLinkCount: number;
}

/** Resolves the selection into a plan without deleting anything (this is the `--dry-run` data). */
export function planDelete(ctx: TaskServiceContext, input: PlanDeleteInput): DeletePlan {
	const { store } = ctx;
	const { selector } = input;
	let tasks: TaskSummary[] = [];
	const notFound: string[] = [];

	if (selector.kind === 'all') {
		tasks = store.list();
	} else if (selector.kind === 'filter') {
		const { field, values } = selector;
		// A root task has no parentId: it never matches a parentId pattern.
		tasks = store.list().filter(t => t[field] !== undefined && values.some(v => matchGlob(v, t[field]!)));
	} else {
		const all = store.list();
		for (const rawId of selector.ids) {
			const matches = all.filter(t => t.id.startsWith(rawId));
			if (matches.length === 0) {
				notFound.push(rawId);
			} else if (matches.length > 1) {
				throw new AmbiguousDeletePrefixError(
					rawId,
					matches.map(t => t.id)
				);
			} else {
				tasks.push(matches[0]!);
			}
		}
	}

	if (input.cascade) {
		const selected = new Set(tasks.map(t => t.id));
		for (const t of [...tasks]) {
			for (const descendant of store.getDescendants(t.id)) {
				if (!selected.has(descendant.id)) {
					selected.add(descendant.id);
					tasks.push(descendant);
				}
			}
		}
	}

	// Children that survive the deletion lose their parent and become root tasks.
	const deletedIds = new Set(tasks.map(t => t.id));
	const remaining = store.list();
	const orphanCount = remaining.filter(
		t => t.parentId !== undefined && deletedIds.has(t.parentId) && !deletedIds.has(t.id)
	).length;
	// Links held by surviving tasks that point to a deleted task are removed with it.
	const danglingLinkCount = remaining
		.filter(t => !deletedIds.has(t.id))
		.flatMap(t => t.links ?? [])
		.filter(l => deletedIds.has(l.target)).length;

	return { tasks, notFound, orphanCount, danglingLinkCount };
}

/** Deletes the planned tasks. */
export function executeDelete(ctx: TaskServiceContext, plan: DeletePlan): { deletedCount: number } {
	let deletedCount = 0;
	for (const t of plan.tasks) {
		if (ctx.store.deleteTask(t.id)) {
			deletedCount++;
		}
	}
	return { deletedCount };
}
