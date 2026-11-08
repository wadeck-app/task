import type { TaskComment, TaskRecord } from '@wadeck-app/task-core';

import { projectEnv, type TaskServiceContext } from './context.js';
import type { TaskEvent } from './events.js';
import { plain } from './plainRecord.js';

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
export async function addComment(
	ctx: TaskServiceContext,
	input: { id: string; text: string; author?: string }
): Promise<TaskCommentResult> {
	const before = await ctx.store.findByPrefix(input.id);
	const { task, comment } = await ctx.store.addComment(before.id, input.text, { author: input.author });
	return {
		task: plain(task),
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
export async function editComment(
	ctx: TaskServiceContext,
	input: { id: string; commentId: string; text: string }
): Promise<TaskCommentResult> {
	const before = await ctx.store.findByPrefix(input.id);
	const { task, comment, oldText, changed } = await ctx.store.editComment(before.id, input.commentId, input.text);
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
	return { task: plain(task), comment, events };
}

/** Removes a comment. `onTaskCommentRemoved` (the removed comment is in the result). */
export async function removeComment(
	ctx: TaskServiceContext,
	input: { id: string; commentId: string }
): Promise<TaskCommentResult> {
	const before = await ctx.store.findByPrefix(input.id);
	const { task, comment } = await ctx.store.removeComment(before.id, input.commentId);
	return {
		task: plain(task),
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
export async function listComments(ctx: TaskServiceContext, input: { id: string }): Promise<TaskComments> {
	const task = await ctx.store.findByPrefix(input.id);
	return { id: task.id, comments: task.comments ?? [] };
}
