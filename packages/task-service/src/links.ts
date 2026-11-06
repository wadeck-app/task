import { INVERSE_LINK_NAMES, LINK_TYPES, TaskNotFoundError } from '@wadeck-app/task-core';
import type { LinkType, TaskLinks, TaskRecord } from '@wadeck-app/task-core';

import { projectEnv, type TaskServiceContext } from './context.js';
import { DanglingLinkError, InvalidLinkTypeError } from './errors.js';
import type { TaskEvent } from './events.js';
import { suggest } from './text.js';

/** Every accepted link name: the stored types, then their inverses. */
export const ALL_LINK_NAMES: string[] = [...LINK_TYPES, ...Object.values(INVERSE_LINK_NAMES)];

/** Resolves a user-typed link name; an inverse name ("blocks") means the link is stored on the other task. */
export function parseLinkType(input: string): { type: LinkType; inverse: boolean } | undefined {
	const stored = LINK_TYPES.find(t => t === input);
	if (stored) return { type: stored, inverse: false };
	const inverse = LINK_TYPES.find(t => INVERSE_LINK_NAMES[t] === input);
	return inverse ? { type: inverse, inverse: true } : undefined;
}

export interface LinkTasksInput {
	/** Task id or unambiguous prefix. */
	id: string;
	/** Stored link type (blockedBy, ...) or inverse name (blocks, ...). */
	type: string;
	/** Target task id or unambiguous prefix. */
	target: string;
}

export interface LinkTasksResult {
	/** The task that holds the stored link (the target for an inverse name). */
	task: TaskRecord;
	events: TaskEvent[];
}

/**
 * The id of the other task. Unlinking also accepts the exact id of a task that no longer exists, when the task holds a
 * link to it: that is the only way to remove such a link (the target cannot be resolved by a prefix any more).
 */
function resolveTarget(
	ctx: TaskServiceContext,
	input: LinkTasksInput,
	spec: { type: LinkType; inverse: boolean },
	action: 'link' | 'unlink',
	holderId: string
): string {
	try {
		return ctx.store.findByPrefix(input.target).id;
	} catch (error) {
		const stored = action === 'unlink' && !spec.inverse && ctx.store.get(holderId).links;
		if (
			error instanceof TaskNotFoundError &&
			stored &&
			stored.some(l => l.type === spec.type && l.target === input.target)
		) {
			return input.target;
		}
		throw error;
	}
}

function changeLink(ctx: TaskServiceContext, input: LinkTasksInput, action: 'link' | 'unlink'): LinkTasksResult {
	const spec = parseLinkType(input.type);
	if (!spec) {
		const hint = suggest(input.type, ALL_LINK_NAMES);
		throw new InvalidLinkTypeError(input.type, ALL_LINK_NAMES, hint === undefined ? [] : [hint]);
	}
	const first = ctx.store.findByPrefix(input.id).id;
	const second = resolveTarget(ctx, input, spec, action, first);
	// "A blocks B" is stored on B as "B blockedBy A": the holder is the task that owns the stored link.
	const [holder, target] = spec.inverse ? [second, first] : [first, second];
	const task =
		action === 'link'
			? ctx.store.addLink(holder, spec.type, target)
			: ctx.store.removeLink(holder, spec.type, target);
	return {
		task,
		events: [
			{
				name: action === 'link' ? 'onTaskLinked' : 'onTaskUnlinked',
				payload: { taskId: holder, linkType: spec.type, targetId: target, ...projectEnv(ctx) },
			},
		],
	};
}

/** Adds a typed link between two tasks. */
export function linkTasks(ctx: TaskServiceContext, input: LinkTasksInput): LinkTasksResult {
	return changeLink(ctx, input, 'link');
}

/** Removes a typed link between two tasks. */
export function unlinkTasks(ctx: TaskServiceContext, input: LinkTasksInput): LinkTasksResult {
	return changeLink(ctx, input, 'unlink');
}

/** A task's outgoing links and their derived inverses. */
export function getTaskLinks(ctx: TaskServiceContext, input: { id: string }): TaskLinks {
	const id = ctx.store.findByPrefix(input.id).id;
	// A link to a task that is gone is reported with its fix (the store would only say the index is corrupted).
	const existing = new Set(ctx.store.list().map(t => t.id));
	const dangling = (ctx.store.get(id).links ?? []).find(l => !existing.has(l.target));
	if (dangling) throw new DanglingLinkError(id, dangling.type, dangling.target);
	return ctx.store.getLinks(id);
}

/** A stored link whose target task no longer exists, with the command that removes it. */
export interface DanglingLink {
	/** The stored link type held by the task (`blockedBy`...). */
	relation: LinkType;
	/** The exact id of the vanished task (what `unlink` takes). */
	targetId: string;
	/** The command that removes the link, e.g. `task unlink <id> blockedBy <target>`. */
	fix: string;
}

export interface TaskLinksReport {
	/** The links that resolve to a task: same shape as {@link getTaskLinks}. */
	links: TaskLinks;
	/** The links of the task that point to a vanished task; empty when the data is consistent. */
	dangling: DanglingLink[];
	/** One sentence per dangling link, with its fix, ready to show. */
	warnings: string[];
}

/**
 * Like {@link getTaskLinks}, but a link to a vanished task is reported (with its fix) instead of thrown: a task must
 * stay readable to be repaired, as for a dangling parent. Callers that need the failure keep `getTaskLinks`.
 */
export function readTaskLinks(ctx: TaskServiceContext, input: { id: string }): TaskLinksReport {
	const id = ctx.store.findByPrefix(input.id).id;
	const { links, dangling } = ctx.store.getLinksLenient(id);
	const errors = dangling.map(link => new DanglingLinkError(id, link.type, link.target));
	return {
		links,
		dangling: dangling.map(link => ({
			relation: link.type,
			targetId: link.target,
			fix: `task unlink ${id} ${link.type} ${link.target}`,
		})),
		warnings: errors.map(error => `${error.message}. ${error.hint}`),
	};
}
