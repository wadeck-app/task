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
	/** True when the event ends the entity it is about (nothing more will happen to that taskId). */
	terminal?: boolean;
	/** How a terminal event ended: `info` when it is neither a success nor a failure. */
	outcome?: 'success' | 'failure' | 'info';
}

/** Typed so that adding an event to the TaskEvent union breaks the build until it is listed here (and declared below). */
export const TASK_EVENT_NAMES: Record<TaskEvent['name'], true> = {
	onTaskCreated: true,
	onStatusChange: true,
	onTaskLinked: true,
	onTaskUnlinked: true,
	onTaskUnblocked: true,
	onTaskTypeChanged: true,
	onTaskLabelAdded: true,
	onTaskLabelRemoved: true,
	onTaskMetaChanged: true,
	onTaskParentChanged: true,
	onTaskDeleted: true,
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
	taskProjectId: {
		type: 'string',
		description:
			'Id of the project in the shared project registry (8 hex characters). Absent when the project is not registered there.',
	},
	taskProjectName: {
		type: 'string',
		description: 'Name of the project (its name in the shared registry, else its directory name).',
	},
	taskProjectPath: { type: 'string', description: 'Absolute path of the project directory.' },
} as const;
const projectRequired = ['taskProjectName', 'taskProjectPath'] as const;

const projectExample = {
	taskProjectId: '3fa9c1d2',
	taskProjectName: 'my-project',
	taskProjectPath: '/work/my-project',
} as const;

const linkProperties = {
	taskId: { type: 'string', description: 'The holder of the stored link.' },
	linkType: { enum: [...LINK_TYPES], description: 'The stored (canonical) link type, never an inverse name.' },
	targetId: { type: 'string', description: 'The task the link points to.' },
	...projectProperties,
} as const;

function labelSchema(): Record<string, unknown> {
	return {
		type: 'object',
		properties: { taskId: string, label: string, ...projectProperties },
		required: ['taskId', 'label', ...projectRequired],
		additionalProperties: false,
	};
}

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
			'it is saved, with oldStatus and newStatus (status equals newStatus). Never fires for an unchanged status (refused). ' +
			'Reaching a terminal status such as done does not end anything by itself: onTaskUnblocked may follow. Not fired by creation.',
		schema: {
			type: 'object',
			properties: {
				taskId: string,
				oldStatus: string,
				newStatus: string,
				status: { type: 'string', description: 'Same value as newStatus (for filters on payload.status).' },
				type: { type: 'string', description: 'Absent when the task has no type.' },
				labels,
				...projectProperties,
			},
			required: ['taskId', 'oldStatus', 'newStatus', 'status', 'labels', ...projectRequired],
			additionalProperties: false,
		},
		example: {
			taskId: '3f2a9c1e-0000-4000-8000-000000000001',
			oldStatus: 'in-progress',
			newStatus: 'done',
			status: 'done',
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
	{
		name: 'onTaskTypeChanged',
		description:
			'The type of a task changed (task set-type, or the app-core UI). Fires once per change, after it is saved, with ' +
			'oldType (absent when the task had no type) and newType. Does NOT fire when the type is set to its current value, ' +
			'when the request is refused (unknown type), at creation, or when the list of project types is edited.',
		schema: {
			type: 'object',
			properties: {
				taskId: string,
				oldType: { type: 'string', description: 'Absent when the task had no type.' },
				newType: string,
				...projectProperties,
			},
			required: ['taskId', 'newType', ...projectRequired],
			additionalProperties: false,
		},
		example: {
			taskId: '3f2a9c1e-0000-4000-8000-000000000001',
			oldType: 'bug',
			newType: 'feature',
			...projectExample,
		},
		correlationKey: 'payload.taskId',
	},
	{
		name: 'onTaskLabelAdded',
		description:
			'A label was added to a task (task add-label, or the app-core UI). Fires once per label really added, after it is ' +
			'saved; label is the added one, not the full list. Does NOT fire when the task already has the label, at creation, ' +
			'or for a removal (onTaskLabelRemoved).',
		schema: labelSchema(),
		example: { taskId: '3f2a9c1e-0000-4000-8000-000000000001', label: 'urgent', ...projectExample },
		correlationKey: 'payload.taskId',
	},
	{
		name: 'onTaskLabelRemoved',
		description:
			'A label was removed from a task (task remove-label, or the app-core UI). Fires once per label really removed, after ' +
			'it is saved. Does NOT fire when the task does not have the label, when the task is deleted, or for an addition ' +
			'(onTaskLabelAdded).',
		schema: labelSchema(),
		example: { taskId: '3f2a9c1e-0000-4000-8000-000000000001', label: 'urgent', ...projectExample },
		correlationKey: 'payload.taskId',
	},
	{
		name: 'onTaskMetaChanged',
		description:
			'A metadata key of a task was set (task set-meta, or the app-core UI). Fires once per change, after it is saved, ' +
			'with key, newValue and oldValue (absent when the key is new; an existing empty value is ""). Does NOT fire when ' +
			'the key already holds that value, when the request is refused, or at creation.',
		schema: {
			type: 'object',
			properties: {
				taskId: string,
				key: string,
				oldValue: { type: 'string', description: 'Absent when the key did not exist before.' },
				newValue: { type: 'string', description: 'May be empty.' },
				...projectProperties,
			},
			required: ['taskId', 'key', 'newValue', ...projectRequired],
			additionalProperties: false,
		},
		example: {
			taskId: '3f2a9c1e-0000-4000-8000-000000000001',
			key: 'owner',
			oldValue: 'ann',
			newValue: 'bob',
			...projectExample,
		},
		correlationKey: 'payload.taskId',
	},
	{
		name: 'onTaskParentChanged',
		description:
			'A task was attached under a parent, moved to another, or detached (task set-parent / remove-parent, or the app-core ' +
			'UI). Fires once per change, after it is saved. oldParentId is absent for a root task, newParentId when detached. ' +
			'Does NOT fire when the parent is unchanged, at creation under a parent (onTaskCreated), or when a parent is deleted.',
		schema: {
			type: 'object',
			properties: {
				taskId: string,
				oldParentId: { type: 'string', description: 'Absent when the task was a root task.' },
				newParentId: { type: 'string', description: 'Absent when the task was detached (now a root task).' },
				...projectProperties,
			},
			required: ['taskId', ...projectRequired],
			additionalProperties: false,
		},
		example: {
			taskId: '3f2a9c1e-0000-4000-8000-000000000002',
			oldParentId: '3f2a9c1e-0000-4000-8000-000000000001',
			...projectExample,
		},
		correlationKey: 'payload.taskId',
	},
	{
		name: 'onTaskDeleted',
		description:
			'A task was deleted (task delete, or the Delete page of the app-core UI). Fires once per deleted task, after the ' +
			'deletion is done; a cascade fires one per descendant, leaves before parents. It ends the task. Does NOT fire for a ' +
			'preview (--dry-run), an unconfirmed or refused delete, or a selection that matches nothing. Removed links fire no ' +
			'onTaskUnlinked: see removedLinkCount.',
		schema: {
			type: 'object',
			properties: {
				taskId: { type: 'string', description: 'The deleted task (it no longer exists).' },
				description: { type: 'string', description: 'The description (title) the task had.' },
				status: { type: 'string', description: 'The status the task had.' },
				parentId: { type: 'string', description: 'Absent when the task was a root task.' },
				orphanedChildIds: {
					type: 'array',
					items: string,
					description: 'Children that lost their parent and became root tasks; empty in a cascade.',
				},
				removedLinkCount: {
					type: 'integer',
					description: 'Links held by the tasks still present that pointed to this task, removed with it.',
				},
				...projectProperties,
			},
			required: ['taskId', 'description', 'status', 'orphanedChildIds', 'removedLinkCount', ...projectRequired],
			additionalProperties: false,
		},
		example: {
			taskId: '3f2a9c1e-0000-4000-8000-000000000001',
			description: 'Write the release notes',
			status: 'backlog',
			orphanedChildIds: [],
			removedLinkCount: 0,
			...projectExample,
		},
		correlationKey: 'payload.taskId',
		terminal: true,
		outcome: 'info',
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
