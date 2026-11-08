import { TaskNotFoundError, type TaskSummary } from '@wadeck-app/task-core';

import { projectEnv, type TaskServiceContext } from './context.js';
import { AmbiguousDeletePrefixError, InvalidDeleteFilterError, PartialDeleteError } from './errors.js';
import type { TaskEvent } from './events.js';
import { taskDescription } from './taskText.js';
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
export async function planDelete(ctx: TaskServiceContext, input: PlanDeleteInput): Promise<DeletePlan> {
	const { store } = ctx;
	const { selector } = input;
	let tasks: TaskSummary[] = [];
	const notFound: string[] = [];

	if (selector.kind === 'all') {
		tasks = await store.list();
	} else if (selector.kind === 'filter') {
		const { field, values } = selector;
		// A root task has no parentId: it never matches a parentId pattern.
		tasks = (await store.list()).filter(t => t[field] !== undefined && values.some(v => matchGlob(v, t[field]!)));
	} else {
		const all = await store.list();
		// Several prefixes (or a repeated id) can resolve to the same task: plan it once, in first-occurrence order.
		const seen = new Set<string>();
		for (const rawId of selector.ids) {
			const matches = all.filter(t => t.id.startsWith(rawId));
			if (matches.length === 0) {
				notFound.push(rawId);
			} else if (matches.length > 1) {
				throw new AmbiguousDeletePrefixError(
					rawId,
					matches.map(t => t.id)
				);
			} else if (!seen.has(matches[0]!.id)) {
				seen.add(matches[0]!.id);
				tasks.push(matches[0]!);
			}
		}
	}

	if (input.cascade) {
		const selected = new Set(tasks.map(t => t.id));
		for (const t of [...tasks]) {
			for (const descendant of await store.getDescendants(t.id)) {
				if (!selected.has(descendant.id)) {
					selected.add(descendant.id);
					tasks.push(descendant);
				}
			}
		}
	}

	// Children that survive the deletion lose their parent and become root tasks.
	const deletedIds = new Set(tasks.map(t => t.id));
	const remaining = await store.list();
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

export interface ExecuteDeleteResult {
	deletedCount: number;
	/** One `onTaskDeleted` per task really deleted, in deletion order: deepest tasks first (leaves before parents). */
	events: TaskEvent[];
}

/** Number of ancestors of a task; stops on a cycle of a corrupted index instead of looping. */
function depthOf(id: string, parentOf: ReadonlyMap<string, string | undefined>): number {
	const seen = new Set([id]);
	let depth = 0;
	for (let parent = parentOf.get(id); parent !== undefined && !seen.has(parent); parent = parentOf.get(parent)) {
		seen.add(parent);
		depth++;
	}
	return depth;
}

/**
 * The text the event reports: the full description (as onTaskCreated), read before the file goes away.
 * The index only has the title; if the file cannot be read the title is reported (the deletion itself does not need the file).
 */
// Comments the task holds (they go with its file); 0 for a task that vanished since the plan (it gets no event anyway).
async function commentCountOf(ctx: TaskServiceContext, id: string): Promise<number> {
	try {
		return (await ctx.store.get(id)).comments?.length ?? 0;
	} catch (error) {
		if (error instanceof TaskNotFoundError) return 0;
		throw error;
	}
}

async function fullTextOf(ctx: TaskServiceContext, task: TaskSummary): Promise<string> {
	try {
		return taskDescription(await ctx.store.get(task.id));
	} catch {
		return task.title;
	}
}

/**
 * Deletes the planned tasks, deepest first (a cascade removes leaves before their parents; tasks of the same depth keep
 * the plan order). Each deleted task yields an `onTaskDeleted` carrying what it was and what its deletion did: the
 * children that became root tasks, and the links held by the tasks still present that pointed to it (a holder deleted
 * later in the same plan is still counted). Called with a plan only: a preview never produces events.
 *
 * A store failure after at least one deletion throws a {@link PartialDeleteError} carrying the events of the tasks already
 * deleted (they are gone: the caller must still deliver them); with nothing deleted yet the original error propagates.
 */
export async function executeDelete(ctx: TaskServiceContext, plan: DeletePlan): Promise<ExecuteDeleteResult> {
	const parentOf = new Map((await ctx.store.list()).map(t => [t.id, t.parentId]));
	const ordered = plan.tasks
		.map((task, index) => ({ task, index, depth: depthOf(task.id, parentOf) }))
		.sort((a, b) => b.depth - a.depth || a.index - b.index);

	let deletedCount = 0;
	const events: TaskEvent[] = [];
	for (const { task: planned } of ordered) {
		// Read just before the deletion: earlier deletions of the plan may have changed the surroundings.
		const present = await ctx.store.list();
		const task = present.find(t => t.id === planned.id) ?? planned;
		const orphanedChildIds = present.filter(t => t.parentId === task.id).map(t => t.id);
		const removedLinkCount = present
			.filter(t => t.id !== task.id)
			.flatMap(t => t.links ?? [])
			.filter(link => link.target === task.id).length;
		const description = await fullTextOf(ctx, task);
		const commentCount = await commentCountOf(ctx, task.id);
		let removed: boolean;
		try {
			// One awaited deletion at a time, never in parallel: the order is the event order and the partial-failure semantics.
			removed = await ctx.store.deleteTask(task.id);
		} catch (error) {
			if (deletedCount === 0) throw error;
			throw new PartialDeleteError(deletedCount, ordered.length, task.id, events, error);
		}
		if (removed) {
			deletedCount++;
			events.push({
				name: 'onTaskDeleted',
				payload: {
					taskId: task.id,
					description,
					status: task.status,
					parentId: task.parentId,
					orphanedChildIds,
					removedLinkCount,
					...(commentCount > 0 && { commentCount }),
					...projectEnv(ctx),
				},
			});
		}
	}
	return { deletedCount, events };
}
