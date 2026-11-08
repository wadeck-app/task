import type { TaskComment, TaskRecord } from '@wadeck-app/task-core';

import { projectEnv, type TaskServiceContext } from './context.js';
import type { TaskEvent } from './events.js';

/** The task as saved, the comment concerned, and the events the change produced (none when nothing changed). */
export interface TaskCommentResult {
	task: TaskRecord;
	comment: TaskComment;
	events: TaskEvent[];
}

/**
 * Adds a comment to a task (plain text, trimmed; blank or over the limit refused). `onTaskCommentAdded` carries the
 * full text and the author when there is one. The author is whatever the caller passes: there is no user model.
 */
export function addComment(
	ctx: TaskServiceContext,
	input: { id: string; text: string; author?: string }
): TaskCommentResult {
	const before = ctx.store.findByPrefix(input.id);
	const { task, comment } = ctx.store.addComment(before.id, input.text, input.author);
	return {
		task,
		comment,
		events: [
			{
				name: 'onTaskCommentAdded',
				payload: {
					taskId: task.id,
					commentId: comment.id,
					text: comment.text,
					author: comment.author,
					...projectEnv(ctx),
				},
			},
		],
	};
}

/** Replaces the text of a comment. `onTaskCommentEdited` only when the text really changed. */
export function editComment(
	ctx: TaskServiceContext,
	input: { id: string; commentId: string; text: string }
): TaskCommentResult {
	const before = ctx.store.findByPrefix(input.id);
	const { task, comment, oldText, changed } = ctx.store.editComment(before.id, input.commentId, input.text);
	const events: TaskEvent[] = changed
		? [
				{
					name: 'onTaskCommentEdited',
					payload: {
						taskId: task.id,
						commentId: comment.id,
						oldText,
						newText: comment.text,
						...projectEnv(ctx),
					},
				},
			]
		: [];
	return { task, comment, events };
}

/** Removes a comment. `onTaskCommentRemoved` (the removed comment is in the result). */
export function removeComment(ctx: TaskServiceContext, input: { id: string; commentId: string }): TaskCommentResult {
	const before = ctx.store.findByPrefix(input.id);
	const { task, comment } = ctx.store.removeComment(before.id, input.commentId);
	return {
		task,
		comment,
		events: [
			{
				name: 'onTaskCommentRemoved',
				payload: { taskId: task.id, commentId: comment.id, ...projectEnv(ctx) },
			},
		],
	};
}

export interface TaskComments {
	/** Full id of the resolved task. */
	id: string;
	/** Chronological (oldest first). */
	comments: TaskComment[];
}

/** The comments of a task, oldest first (empty for a task without any). */
export function listComments(ctx: TaskServiceContext, input: { id: string }): TaskComments {
	const task = ctx.store.findByPrefix(input.id);
	return { id: task.id, comments: task.comments ?? [] };
}
