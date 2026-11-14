import { UnknownPriorityError } from '@wadeck-app/task-core';
import type { TaskResolvedConfig, TaskSummary, TaskTreeNode } from '@wadeck-app/task-core';

import type { TaskServiceContext } from './context.js';
import { InvalidListQueryError, InvalidStatusError } from './errors.js';
import { withFreshReads } from './freshReads.js';
import { PluginLookupError } from './plugin-host/index.js';
import { createBuiltinRegistry } from './plugins/builtinPlugins.js';
import type { OrderingRow } from './plugins/kinds.js';
import { suggest } from './text.js';

/** The ordering `task next` uses unless told otherwise. */
export const DEFAULT_ORDER = 'priority-then-oldest';
/** Highest `limit` a list accepts. */
export const LIST_LIMIT_MAX = 1000;

export interface ListTasksInput {
	/** Include tasks in a terminal status (hidden by default). */
	showAll?: boolean;
	/** Restrict to this task's direct children (id or unambiguous prefix). */
	parent?: string;
	/** Keep the tasks in one of these statuses (each must be a status of the project). Replaces the hiding of terminal statuses. */
	statuses?: readonly string[];
	/** Keep the tasks this worker holds (exact name). */
	assignee?: string;
	/** Keep the tasks nobody holds. */
	unassigned?: boolean;
	/** Keep the tasks a worker may claim now: nobody holds them, or their lease is over at `now`. */
	available?: boolean;
	/** Keep the tasks with one of these EFFECTIVE priorities (a task without one has the project default). */
	priorities?: readonly string[];
	/** Name or ref of an ordering plugin. Absent: the order of the backend. */
	order?: string;
	/** Keep the first N tasks AFTER the filters and the order (1 to 1000). */
	limit?: number;
	/** Every read comes from the system itself, never from a cache (github, gitlab); no effect on local and remote. */
	fresh?: boolean;
	/** The instant leases are judged at. Absent: now. */
	now?: Date;
}

/** A row of a list that used a filter, an order or a limit: the summary plus the facts a dispatcher needs without a `show`. */
export type ListedTask = TaskSummary & {
	/** The EFFECTIVE priority: the stored one, else the project default. Never absent. */
	priority: string;
	/** Only when a lease is set and readable: its end is at or before `now`. */
	leaseExpired?: boolean;
	/** Only when the stored `leaseUntil` is not a valid date: what is wrong. The task is never `available` then. */
	leaseProblem?: string;
};

/** Predicate hiding terminal-status tasks unless `showAll` is set. */
export function createStatusFilter(config: TaskResolvedConfig, showAll: boolean): (task: TaskSummary) => boolean {
	return task => showAll || !config.terminalStatuses.includes(task.status);
}

const DISPATCH_KEYS = ['statuses', 'assignee', 'unassigned', 'available', 'priorities', 'order', 'limit'] as const;

/**
 * True when the input uses a filter, an order or a limit: only then do rows carry the effective priority and lease facts. A false
 * flag and an empty list are the same as leaving the input out.
 */
function isDispatchQuery(input: ListTasksInput): boolean {
	return DISPATCH_KEYS.some(key => {
		const value = input[key];
		return Array.isArray(value) ? value.length > 0 : value !== undefined && value !== false;
	});
}

function checkQuery(config: TaskResolvedConfig, input: ListTasksInput): void {
	const chosen = (
		[
			['assignee', input.assignee !== undefined],
			['unassigned', input.unassigned === true],
			['available', input.available === true],
		] as const
	)
		.filter(([, used]) => used)
		.map(([name]) => name);
	if (chosen.length > 1) {
		throw new InvalidListQueryError(
			`${chosen[0]} and ${chosen[1]} cannot be combined`,
			'Pick one: assignee <name> (held by that worker), unassigned (held by nobody) or available (held by nobody, or lease over).'
		);
	}
	if (input.assignee !== undefined && input.assignee.trim() === '') {
		throw new InvalidListQueryError('assignee needs a name, found a blank one', 'Give the worker name, e.g. w1.');
	}
	for (const status of input.statuses ?? []) {
		if (!config.statuses.includes(status)) {
			const hint = suggest(status, config.statuses);
			throw new InvalidStatusError(status, config.statuses, hint === undefined ? [] : [hint]);
		}
	}
	for (const priority of input.priorities ?? []) {
		if (!config.priorities.includes(priority)) throw new UnknownPriorityError(priority, config.priorities);
	}
	if (
		input.limit !== undefined &&
		(!Number.isInteger(input.limit) || input.limit < 1 || input.limit > LIST_LIMIT_MAX)
	) {
		throw new InvalidListQueryError(
			`limit must be a whole number from 1 to ${LIST_LIMIT_MAX}, found ${String(input.limit)}`,
			'Give a limit such as 10, or leave it out for every match.'
		);
	}
}

function toOrderingRow(task: ListedTask): OrderingRow {
	return {
		id: task.id,
		status: task.status,
		createdAt: task.createdAt,
		priority: task.priority,
		...(task.assignee === undefined ? {} : { assignee: task.assignee }),
	};
}

/**
 * Flat task list, optionally limited to the direct children of a parent. With a filter, an order or a limit (see ListTasksInput) the
 * rows also carry the effective `priority` and `leaseExpired`, and the filtering, ordering and cut run here over the summaries, the
 * same for every backend. Without any of them the answer is the historical one, key for key.
 */
export async function listTasks(ctx: TaskServiceContext, input: ListTasksInput): Promise<TaskSummary[]> {
	if (!isDispatchQuery(input)) {
		const passesFilter = createStatusFilter(ctx.config, input.showAll ?? false);
		return withFreshReads(ctx, input.fresh, async read => {
			const parentId = input.parent === undefined ? undefined : (await read.store.resolve(input.parent)).id;
			return (parentId === undefined ? await read.store.list() : await read.store.getChildren(parentId)).filter(
				passesFilter
			);
		});
	}
	checkQuery(ctx.config, input);
	let ordering;
	if (input.order !== undefined) {
		try {
			ordering = (ctx.registry ?? createBuiltinRegistry()).lookup(input.order, 'ordering');
		} catch (error) {
			if (error instanceof PluginLookupError) throw new InvalidListQueryError(error.message, error.hint);
			throw error;
		}
	}
	const now = (input.now ?? new Date()).getTime();
	const defaultPriority = ctx.config.defaults.priority;
	const statuses = input.statuses?.length ? new Set(input.statuses) : undefined;
	const priorities = input.priorities?.length ? new Set(input.priorities) : undefined;
	const hideClosed = createStatusFilter(ctx.config, input.showAll ?? false);

	const summaries = await withFreshReads(ctx, input.fresh, async read => {
		const parentId = input.parent === undefined ? undefined : (await read.store.resolve(input.parent)).id;
		return parentId === undefined ? await read.store.list() : await read.store.getChildren(parentId);
	});

	let rows: ListedTask[] = summaries
		.filter(task => (statuses === undefined ? hideClosed(task) : statuses.has(task.status)))
		.map((task): ListedTask => {
			const leaseEnd = task.leaseUntil === undefined ? undefined : Date.parse(task.leaseUntil);
			return {
				...task,
				priority: task.priority ?? defaultPriority,
				// A lease that cannot be read is neither live nor over: it is reported, and the task is not offered until someone fixes it.
				...(leaseEnd === undefined
					? {}
					: Number.isNaN(leaseEnd)
						? { leaseProblem: `leaseUntil ${task.leaseUntil} is not a valid date` }
						: { leaseExpired: leaseEnd <= now }),
			};
		})
		.filter(task => {
			if (priorities !== undefined && !priorities.has(task.priority)) return false;
			if (input.assignee !== undefined) return task.assignee === input.assignee.trim();
			if (input.unassigned === true) return task.assignee === undefined;
			if (input.available === true) return task.assignee === undefined || task.leaseExpired === true;
			return true;
		});

	if (ordering !== undefined) {
		const instance = await ordering.create({}, {});
		try {
			const facts = { priorities: ctx.config.priorities };
			rows = rows.sort((a, b) => instance.compare(toOrderingRow(a), toOrderingRow(b), facts));
		} finally {
			await instance.dispose();
		}
	}
	// The limit comes after the order: "the 5 most urgent", never "the first 5 the backend returned, then ordered".
	return input.limit === undefined ? rows : rows.slice(0, input.limit);
}

/** Nested forest of the matching tasks plus the ancestors leading to them. */
export async function listForest(ctx: TaskServiceContext, input: ListTasksInput): Promise<TaskTreeNode[]> {
	const parentId = input.parent === undefined ? undefined : (await ctx.store.resolve(input.parent)).id;
	return ctx.store.getForest({ parentId, predicate: createStatusFilter(ctx.config, input.showAll ?? false) });
}
