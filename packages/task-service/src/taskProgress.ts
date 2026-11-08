import type { TaskServiceContext } from './context.js';

export interface ChildrenSummary {
	/** Direct children. */
	total: number;
	/** Children in a terminal status of the project config (closed). */
	terminal: number;
	/** `total - terminal`. */
	open: number;
}

/**
 * How far a task's direct children are: the same terminal rule as `countTasksByStatus` and `setStatus` (the project's
 * `terminalStatuses`), so the CLI and the module never disagree on "done".
 */
export async function summarizeChildren(ctx: TaskServiceContext, input: { id: string }): Promise<ChildrenSummary> {
	const children = await ctx.store.getChildren((await ctx.store.findByPrefix(input.id)).id);
	const terminal = children.filter(child => ctx.config.terminalStatuses.includes(child.status)).length;
	return { total: children.length, terminal, open: children.length - terminal };
}

export interface Blocker {
	id: string;
	title: string;
	status: string;
}

export interface BlockerSummary {
	/** Number of open blockers. */
	count: number;
	blockers: Blocker[];
}

/**
 * The tasks that still block this one: its `blockedBy` links whose target is not in a terminal status. A closed
 * blocker does not block; the tasks this one blocks (the derived `blocks` inverse) are not reported.
 */
export async function describeBlockers(ctx: TaskServiceContext, input: { id: string }): Promise<BlockerSummary> {
	// A dangling link blocks nothing and has no task to show: it is left out (the task page reports it).
	const { links } = await ctx.store.getLinksLenient((await ctx.store.findByPrefix(input.id)).id);
	const blockers = links.blockedBy
		.filter(task => !ctx.config.terminalStatuses.includes(task.status))
		.map(task => ({ id: task.id, title: task.title, status: task.status }));
	return { count: blockers.length, blockers };
}
