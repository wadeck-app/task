import { createHash } from 'node:crypto';

import { LINK_TYPES } from '@wadeck-app/task-core';

import type { TaskEvent } from './events.js';

/**
 * The single source of truth for what task tells the queue about its events (`registerEvents`): names, when they fire,
 * payload schemas, examples. The tests keep it honest: every TaskEvent has exactly one entry, each example fits its schema,
 * and the payloads the operations really produce fit the schemas (so the declaration cannot drift from the code).
 */

/** The queue source the events are declared under (`[a-z0-9][a-z0-9_-]*`). */
export const TASK_QUEUE_SOURCE = 'task';

/** One declared event, in the shape `queue-sdk` `registerEvents` sends. */
export interface QueueEventDeclaration {
	name: TaskEvent['name'];
	/** When it fires, whether it repeats, what does NOT fire it (at most 500 characters). */
	description: string;
	/** JSON Schema of the payload (documentation: the queue never checks a push against it). */
	schema: Record<string, unknown>;
	/** A typical payload; prefills the dashboard "push test event" form. */
	example: Record<string, unknown>;
	/** What `queue wait --when` filters on. */
	correlationKey: string;
	terminal?: boolean;
}

/** Typed so that adding an event to the TaskEvent union breaks the build until it is listed here (and declared below). */
export const TASK_EVENT_NAMES: Record<TaskEvent['name'], true> = {
	onTaskCreated: true,
	onStatusChange: true,
	onTaskLinked: true,
	onTaskUnlinked: true,
	onTaskUnblocked: true,
};

/** The limits the queue daemon enforces on a declaration (queue-core `EventCatalog`); a test holds ours to them. */
export const QUEUE_EVENT_LIMITS = {
	nameLength: 128,
	descriptionLength: 500,
	schemaBytes: 64 * 1024,
	exampleBytes: 16 * 1024,
	eventsPerSource: 500,
} as const;

const string = { type: 'string' } as const;
const labels = { type: 'array', items: string } as const;
const projectProperties = {
	taskProjectName: { type: 'string', description: 'Name of the project (its directory name).' },
	taskProjectPath: { type: 'string', description: 'Absolute path of the project directory.' },
} as const;
const projectRequired = ['taskProjectName', 'taskProjectPath'] as const;

const projectExample = { taskProjectName: 'my-project', taskProjectPath: '/work/my-project' } as const;

const linkProperties = {
	taskId: { type: 'string', description: 'The holder of the stored link.' },
	linkType: { enum: [...LINK_TYPES], description: 'The stored (canonical) link type, never an inverse name.' },
	targetId: { type: 'string', description: 'The task the link points to.' },
	...projectProperties,
} as const;

function linkSchema(): Record<string, unknown> {
	return {
		type: 'object',
		properties: { ...linkProperties },
		required: ['taskId', 'linkType', 'targetId', ...projectRequired],
		additionalProperties: false,
	};
}

export const queueEventDeclarations: readonly QueueEventDeclaration[] = [
	{
		name: 'onTaskCreated',
		description:
			'A task was created (task new, or the Task page of the app-core UI). Fires once per task, after it is saved. ' +
			'taskId is the new task, status its initial status. Does NOT fire for later changes of status, type, labels, ' +
			'links or parent, nor for a deletion.',
		schema: {
			type: 'object',
			properties: {
				taskId: string,
				status: { type: 'string', description: 'Initial status (the configured default).' },
				description: string,
				parentId: { type: 'string', description: 'Absent for a root task.' },
				type: { type: 'string', description: 'Absent when the task has no type.' },
				labels,
				...projectProperties,
			},
			required: ['taskId', 'status', 'description', 'labels', ...projectRequired],
			additionalProperties: false,
		},
		example: {
			taskId: '3f2a9c1e-0000-4000-8000-000000000001',
			status: 'backlog',
			description: 'Write the release notes',
			labels: [],
			...projectExample,
		},
		correlationKey: 'payload.taskId',
	},
	{
		name: 'onStatusChange',
		description:
			'The status of a task changed (task set-status, or the Task page of the app-core UI). Fires once per change, after ' +
			'it is saved, with oldStatus and newStatus. Never fires for an unchanged status (that request is refused). ' +
			'Reaching a terminal status such as done does not end anything by itself: onTaskUnblocked may follow. Not fired by creation.',
		schema: {
			type: 'object',
			properties: {
				taskId: string,
				oldStatus: string,
				newStatus: string,
				type: { type: 'string', description: 'Absent when the task has no type.' },
				labels,
				...projectProperties,
			},
			required: ['taskId', 'oldStatus', 'newStatus', 'labels', ...projectRequired],
			additionalProperties: false,
		},
		example: {
			taskId: '3f2a9c1e-0000-4000-8000-000000000001',
			oldStatus: 'in-progress',
			newStatus: 'done',
			labels: ['urgent'],
			...projectExample,
		},
		correlationKey: 'payload.taskId',
		terminal: false,
	},
	{
		name: 'onTaskUnblocked',
		description:
			'A task has no open blocker left. Fires right after onStatusChange, once per task whose last open blocker has just ' +
			'moved from a non-terminal to a terminal status. taskId is the UNBLOCKED task, blockerId the one that finished. ' +
			'Does NOT fire while another blocker is open, when a link is removed, or when a terminal status changes to another.',
		schema: {
			type: 'object',
			properties: {
				taskId: { type: 'string', description: 'The task that is no longer blocked.' },
				blockerId: { type: 'string', description: 'The blocker that just finished.' },
				status: { type: 'string', description: 'Current status of the unblocked task.' },
				type: { type: 'string', description: 'Type of the unblocked task; absent when it has none.' },
				labels,
				...projectProperties,
			},
			required: ['taskId', 'blockerId', 'status', 'labels', ...projectRequired],
			additionalProperties: false,
		},
		example: {
			taskId: '3f2a9c1e-0000-4000-8000-000000000002',
			blockerId: '3f2a9c1e-0000-4000-8000-000000000001',
			status: 'backlog',
			labels: [],
			...projectExample,
		},
		correlationKey: 'payload.taskId',
	},
	{
		name: 'onTaskLinked',
		description:
			'A link was stored between two tasks (task link, or the app-core UI). taskId is the holder of the stored link ' +
			'(blockedBy, duplicateOf, causedBy), targetId the other task. An inverse spelling swaps them: "A blocks B" fires with ' +
			'taskId B, linkType blockedBy, targetId A. Fires once per link. Does NOT fire on removal (onTaskUnlinked).',
		schema: linkSchema(),
		example: {
			taskId: '3f2a9c1e-0000-4000-8000-000000000002',
			linkType: 'blockedBy',
			targetId: '3f2a9c1e-0000-4000-8000-000000000001',
			...projectExample,
		},
		correlationKey: 'payload.taskId',
	},
	{
		name: 'onTaskUnlinked',
		description:
			'A stored link between two tasks was removed (task unlink, or the app-core UI). taskId is the holder of the stored ' +
			'link, targetId the other task; an inverse spelling swaps them, as for onTaskLinked. Fires once per removed link. ' +
			'Does NOT fire when a task is deleted.',
		schema: linkSchema(),
		example: {
			taskId: '3f2a9c1e-0000-4000-8000-000000000002',
			linkType: 'blockedBy',
			targetId: '3f2a9c1e-0000-4000-8000-000000000001',
			...projectExample,
		},
		correlationKey: 'payload.taskId',
	},
];

/**
 * A digest of the declaration: changes when anything the queue would be told changes. A caller that must declare "once per
 * version" (the short-lived CLI) compares it with the one it stored.
 */
export function queueEventDeclarationsHash(
	declarations: readonly QueueEventDeclaration[] = queueEventDeclarations
): string {
	return createHash('sha256')
		.update(JSON.stringify([TASK_QUEUE_SOURCE, declarations]))
		.digest('hex');
}
