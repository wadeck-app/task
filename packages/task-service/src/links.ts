import { INVERSE_LINK_NAMES, LINK_TYPES } from '@wadeck-app/task-core';
import type { LinkType, TaskLinks, TaskRecord } from '@wadeck-app/task-core';

import { projectEnv, type TaskServiceContext } from './context.js';
import { InvalidLinkTypeError } from './errors.js';
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

function changeLink(ctx: TaskServiceContext, input: LinkTasksInput, action: 'link' | 'unlink'): LinkTasksResult {
	const spec = parseLinkType(input.type);
	if (!spec) {
		const hint = suggest(input.type, ALL_LINK_NAMES);
		throw new InvalidLinkTypeError(input.type, ALL_LINK_NAMES, hint === undefined ? [] : [hint]);
	}
	const first = ctx.store.findByPrefix(input.id).id;
	const second = ctx.store.findByPrefix(input.target).id;
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
	return ctx.store.getLinks(ctx.store.findByPrefix(input.id).id);
}
