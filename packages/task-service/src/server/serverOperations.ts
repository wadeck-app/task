// What the task server does for each operation of the protocol: calls the served project's backend and, for a write, derives the
// queue events the change produced. The server is the only place a remote project's events are raised (design R7), and it sees the
// port operations, not the use cases, so the events are derived from the record before and after.
//
// The names, the conditions and the payloads are the ones the use cases build for a local project (taskFields.ts, setStatus.ts,
// hierarchy.ts, links.ts, comments.ts, setTaskText.ts, createTask.ts, deleteTasks.ts); serverEvents.parity.test.ts runs the same
// scenario through both and compares them, so a change in one that is not in the other fails a test.
import type { TaskBackend, TaskResolvedConfig, VersionedRecord } from '@wadeck-app/task-core';
import { TaskNotFoundError } from '@wadeck-app/task-core';

import type { TaskEvent, TaskProjectEnv } from '../events.js';
import { taskDescription } from '../taskText.js';
import type { ValidInput } from './requestValidation.js';
import type { PortOperation } from '@wadeck-app/task-core';

export interface OperationContext {
	backend: TaskBackend;
	config: TaskResolvedConfig;
	/** `taskProjectId/Name/Path` of the SERVED project (the machine whose queue the events go to). */
	env: TaskProjectEnv;
	/** The `If-Match` revision of a write, when the client sent one. */
	expectedRevision?: string;
}

export interface OperationOutcome {
	result: unknown;
	/** The events the change produced, in order; empty for a read and for a write that changed nothing. */
	events: TaskEvent[];
}

const none = (result: unknown): OperationOutcome => ({ result, events: [] });

const labelsOf = (record: VersionedRecord): string[] => record.labels ?? [];

function parentChanged(
	env: TaskProjectEnv,
	taskId: string,
	oldParentId: string | undefined,
	newParentId: string | undefined
): TaskEvent[] {
	return oldParentId === newParentId
		? []
		: [{ name: 'onTaskParentChanged', payload: { taskId, oldParentId, newParentId, ...env } }];
}

type Handler<K extends PortOperation> = (input: ValidInput[K], ctx: OperationContext) => Promise<OperationOutcome>;

const HANDLERS: { [K in PortOperation]: Handler<K> } = {
	// ---- reads ----
	list: async (_input, { backend }) => none({ items: await backend.list() }),
	listPage: async (input, { backend }) => none(await backend.listPage(input)),
	get: async ({ id }, { backend }) => none(await backend.get(id)),
	getMany: async ({ ids }, { backend }) => none({ items: await backend.getMany(ids) }),
	findByPrefix: async ({ prefix }, { backend }) => none(await backend.findByPrefix(prefix)),
	listLabels: async (_input, { backend }) => none({ items: await backend.listLabels() }),
	getLinks: async ({ id }, { backend }) => none(await backend.getLinks(id)),
	getLinksLenient: async ({ id }, { backend }) => none(await backend.getLinksLenient(id)),
	getChildren: async ({ id }, { backend }) => none({ items: await backend.getChildren(id) }),
	getTree: async ({ id }, { backend }) => none(await backend.getTree(id)),
	getForest: async (input, { backend }) =>
		none({ items: await backend.getForest(input.parentId === undefined ? {} : { parentId: input.parentId }) }),
	getDescendants: async ({ id }, { backend }) => none({ items: await backend.getDescendants(id) }),
	getFullTree: async ({ id }, { backend }) => none(await backend.getFullTree(id)),
	getAncestors: async ({ id }, { backend }) => none({ items: await backend.getAncestors(id) }),

	// ---- writes ----
	create: async (input, { backend, env }) => {
		const task = await backend.create(input);
		return {
			result: task,
			events: [
				{
					name: 'onTaskCreated',
					payload: {
						taskId: task.id,
						status: task.status,
						description: taskDescription(task),
						parentId: task.parentId,
						type: task.type,
						labels: labelsOf(task),
						...env,
					},
				},
			],
		};
	},

	updateStatus: async ({ id, status }, { backend, config, env, expectedRevision }) => {
		const before = await backend.get(id);
		const task = await backend.updateStatus(id, status, writeOptions(expectedRevision));
		const events: TaskEvent[] = [
			{
				name: 'onStatusChange',
				payload: {
					taskId: task.id,
					oldStatus: before.status,
					newStatus: task.status,
					status: task.status,
					type: task.type,
					labels: labelsOf(task),
					...env,
				},
			},
		];
		const isTerminal = (candidate: string): boolean => config.terminalStatuses.includes(candidate);
		if (isTerminal(task.status) && !isTerminal(before.status)) {
			for (const summary of await backend.getUnblockedBy(task.id, isTerminal)) {
				const record = await backend.get(summary.id);
				events.push({
					name: 'onTaskUnblocked',
					payload: {
						taskId: record.id,
						blockerId: task.id,
						status: record.status,
						type: record.type,
						labels: labelsOf(record),
						...env,
					},
				});
			}
		}
		return { result: task, events };
	},

	setTitle: async ({ id, title }, { backend, env, expectedRevision }) => {
		const before = await backend.get(id);
		const task = await backend.setTitle(id, title, writeOptions(expectedRevision));
		return {
			result: task,
			events:
				title === before.title
					? []
					: [
							{
								name: 'onTaskTextChanged',
								payload: {
									taskId: task.id,
									field: 'title',
									oldValue: before.title,
									newValue: title,
									...env,
								},
							},
						],
		};
	},

	setDescription: async ({ id, description }, { backend, env, expectedRevision }) => {
		const before = await backend.get(id);
		const task = await backend.setDescription(id, description, writeOptions(expectedRevision));
		// Same rule as setTaskText: a blank description is "none" (the body is the title again), and it only counts when the body changed.
		const newDescription = description.trim() === '' ? '' : description;
		const newBody = newDescription === '' ? before.title : newDescription;
		return {
			result: task,
			events:
				newBody === taskDescription(before)
					? []
					: [
							{
								name: 'onTaskTextChanged',
								payload: {
									taskId: task.id,
									field: 'description',
									oldValue: before.description,
									newValue: newDescription,
									...env,
								},
							},
						],
		};
	},

	setType: async ({ id, type }, { backend, env, expectedRevision }) => {
		const before = await backend.get(id);
		const task = await backend.setType(id, type, writeOptions(expectedRevision));
		return {
			result: task,
			events:
				before.type === type
					? []
					: [
							{
								name: 'onTaskTypeChanged',
								payload: { taskId: task.id, oldType: before.type, newType: type, ...env },
							},
						],
		};
	},

	clearType: async ({ id }, { backend, env, expectedRevision }) => {
		const before = await backend.get(id);
		const task = await backend.clearType(id, writeOptions(expectedRevision));
		return {
			result: task,
			events:
				before.type === undefined
					? []
					: [
							{
								name: 'onTaskTypeChanged',
								payload: { taskId: task.id, oldType: before.type, newType: undefined, ...env },
							},
						],
		};
	},

	addLabel: async ({ id, label }, { backend, env, expectedRevision }) => {
		const before = await backend.get(id);
		const task = await backend.addLabel(id, label, writeOptions(expectedRevision));
		return {
			result: task,
			events: labelsOf(before).includes(label)
				? []
				: [{ name: 'onTaskLabelAdded', payload: { taskId: task.id, label, ...env } }],
		};
	},

	removeLabel: async ({ id, label }, { backend, env, expectedRevision }) => {
		const before = await backend.get(id);
		const task = await backend.removeLabel(id, label, writeOptions(expectedRevision));
		return {
			result: task,
			events: labelsOf(before).includes(label)
				? [{ name: 'onTaskLabelRemoved', payload: { taskId: task.id, label, ...env } }]
				: [],
		};
	},

	setMeta: async ({ id, key, value }, { backend, env, expectedRevision }) => {
		const before = await backend.get(id);
		// Own property only: a key such as "constructor" must not read as already set.
		const oldValue = Object.hasOwn(before.meta ?? {}, key) ? before.meta![key] : undefined;
		const task = await backend.setMeta(id, key, value, writeOptions(expectedRevision));
		return {
			result: task,
			events:
				oldValue === value
					? []
					: [
							{
								name: 'onTaskMetaChanged',
								payload: { taskId: task.id, key, oldValue, newValue: value, ...env },
							},
						],
		};
	},

	removeMeta: async ({ id, key }, { backend, env, expectedRevision }) => {
		const before = await backend.get(id);
		const existed = Object.hasOwn(before.meta ?? {}, key);
		const task = await backend.removeMeta(id, key, writeOptions(expectedRevision));
		return {
			result: task,
			events: existed
				? [
						{
							name: 'onTaskMetaChanged',
							payload: { taskId: task.id, key, oldValue: before.meta![key], newValue: undefined, ...env },
						},
					]
				: [],
		};
	},

	setParent: async ({ id, parentId }, { backend, env, expectedRevision }) => {
		const before = await backend.get(id);
		const task = await backend.setParent(id, parentId, writeOptions(expectedRevision));
		return { result: task, events: parentChanged(env, task.id, before.parentId, task.parentId) };
	},

	removeParent: async ({ id }, { backend, env, expectedRevision }) => {
		const before = await backend.get(id);
		const task = await backend.removeParent(id, writeOptions(expectedRevision));
		return { result: task, events: parentChanged(env, task.id, before.parentId, task.parentId) };
	},

	addLink: async ({ id, type, targetId }, { backend, env, expectedRevision }) => {
		const task = await backend.addLink(id, type, targetId, writeOptions(expectedRevision));
		return {
			result: task,
			events: [{ name: 'onTaskLinked', payload: { taskId: id, linkType: type, targetId, ...env } }],
		};
	},

	removeLink: async ({ id, type, targetId }, { backend, env, expectedRevision }) => {
		const task = await backend.removeLink(id, type, targetId, writeOptions(expectedRevision));
		return {
			result: task,
			events: [{ name: 'onTaskUnlinked', payload: { taskId: id, linkType: type, targetId, ...env } }],
		};
	},

	addComment: async ({ id, text, author }, { backend, env, expectedRevision }) => {
		const { task, comment } = await backend.addComment(id, text, {
			...writeOptions(expectedRevision),
			...(author === undefined ? {} : { author }),
		});
		return {
			result: { task, comment },
			events: [
				{
					name: 'onTaskCommentAdded',
					payload: {
						taskId: task.id,
						commentId: comment.id,
						text: comment.text,
						author: comment.author,
						...env,
					},
				},
			],
		};
	},

	editComment: async ({ id, commentId, text }, { backend, env, expectedRevision }) => {
		const edit = await backend.editComment(id, commentId, text, writeOptions(expectedRevision));
		return {
			result: { task: edit.task, comment: edit.comment, oldText: edit.oldText, changed: edit.changed },
			events: edit.changed
				? [
						{
							name: 'onTaskCommentEdited',
							payload: {
								taskId: edit.task.id,
								commentId: edit.comment.id,
								oldText: edit.oldText,
								newText: edit.comment.text,
								...env,
							},
						},
					]
				: [],
		};
	},

	removeComment: async ({ id, commentId }, { backend, env, expectedRevision }) => {
		const { task, comment } = await backend.removeComment(id, commentId, writeOptions(expectedRevision));
		return {
			result: { task, comment },
			events: [{ name: 'onTaskCommentRemoved', payload: { taskId: task.id, commentId: comment.id, ...env } }],
		};
	},

	deleteTask: async ({ id }, { backend, env, expectedRevision }) => {
		// Read just before the deletion, as executeDelete does: what the task was and what its removal does to the others.
		let record: VersionedRecord;
		try {
			record = await backend.get(id);
		} catch (error) {
			if (error instanceof TaskNotFoundError) return { result: { deleted: false }, events: [] };
			throw error;
		}
		const present = await backend.list();
		const orphanedChildIds = present.filter(task => task.parentId === id).map(task => task.id);
		const removedLinkCount = present
			.filter(task => task.id !== id)
			.flatMap(task => task.links ?? [])
			.filter(link => link.target === id).length;
		const commentCount = record.comments?.length ?? 0;
		const deleted = await backend.deleteTask(id, writeOptions(expectedRevision));
		return {
			result: { deleted },
			events: deleted
				? [
						{
							name: 'onTaskDeleted',
							payload: {
								taskId: id,
								description: taskDescription(record),
								status: record.status,
								parentId: record.parentId,
								orphanedChildIds,
								removedLinkCount,
								...(commentCount > 0 && { commentCount }),
								...env,
							},
						},
					]
				: [],
		};
	},
};

function writeOptions(expectedRevision: string | undefined): { expectedRevision?: string } {
	return expectedRevision === undefined ? {} : { expectedRevision };
}

/** Runs one operation of the protocol on the served project's backend. `input` has been validated for `op`. */
export function runOperation<K extends PortOperation>(
	op: K,
	input: ValidInput[K],
	context: OperationContext
): Promise<OperationOutcome> {
	return (HANDLERS[op] as Handler<K>)(input, context);
}
