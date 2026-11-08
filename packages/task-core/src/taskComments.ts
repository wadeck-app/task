import * as crypto from 'node:crypto';

import type { TaskRecord } from './TaskStore.js';

/** A comment text is at most this many characters (after trimming). */
export const COMMENT_TEXT_MAX = 10000;
/** An author name is at most this many characters (after trimming). */
export const COMMENT_AUTHOR_MAX = 100;

/**
 * A free-text note on a task, stored in `TaskRecord.comments` (oldest first). Plain text: newlines are kept, nothing is
 * interpreted. There is no user model, so `author` is a free string the caller chose, absent by default.
 */
export interface TaskComment {
	/** Short id, unique within the task. */
	id: string;
	/** ISO instant of the creation. */
	at: string;
	text: string;
	/** ISO instant of the last edit; absent for a comment never edited. */
	editedAt?: string;
	author?: string;
}

/** The task as saved and the comment concerned (for a removal: the comment as it was). */
export interface CommentChange {
	task: TaskRecord;
	comment: TaskComment;
}

export interface CommentEdit extends CommentChange {
	/** The text before the edit. */
	oldText: string;
	/** False when the new text equals the current one: nothing was written. */
	changed: boolean;
}

/** The text or the author of a comment is rejected (blank, too long). `hint` says how to fix it. */
export class InvalidCommentTextError extends Error {
	constructor(
		message: string,
		readonly hint: string
	) {
		super(message);
		this.name = 'InvalidCommentTextError';
	}
}

/** The task has no comment with this id. `validIds` are the ids it has (oldest first). */
export class CommentNotFoundError extends Error {
	readonly hint: string;

	constructor(
		readonly taskId: string,
		readonly commentId: string,
		readonly validIds: string[]
	) {
		super(`Comment not found: ${commentId} (task ${taskId})`);
		this.name = 'CommentNotFoundError';
		this.hint =
			validIds.length === 0
				? `Task ${taskId} has no comment yet. Add one with: task comment ${taskId} <text>`
				: `Comment ids of task ${taskId}: ${validIds.join(', ')} (list them with: task comments ${taskId})`;
	}
}

/** Trimmed text; throws {@link InvalidCommentTextError} when blank or over {@link COMMENT_TEXT_MAX}. */
export function normalizeCommentText(text: string): string {
	const trimmed = text.trim();
	if (trimmed === '') {
		throw new InvalidCommentTextError('a comment cannot be blank', 'Give the text of the comment.');
	}
	if (trimmed.length > COMMENT_TEXT_MAX) {
		throw new InvalidCommentTextError(
			`a comment is at most ${COMMENT_TEXT_MAX} characters (this one has ${trimmed.length})`,
			`Shorten it to ${COMMENT_TEXT_MAX} characters or less, or split it in several comments.`
		);
	}
	return trimmed;
}

/** Trimmed author, undefined when blank or absent; throws {@link InvalidCommentTextError} when over {@link COMMENT_AUTHOR_MAX}. */
export function normalizeCommentAuthor(author: string | undefined): string | undefined {
	const trimmed = author?.trim() ?? '';
	if (trimmed === '') {
		return undefined;
	}
	if (trimmed.length > COMMENT_AUTHOR_MAX) {
		throw new InvalidCommentTextError(
			`an author name is at most ${COMMENT_AUTHOR_MAX} characters (this one has ${trimmed.length})`,
			`Give a shorter author name (${COMMENT_AUTHOR_MAX} characters or less).`
		);
	}
	return trimmed;
}

/** Six lowercase base-36 characters not in `taken`. */
export function generateCommentId(taken: readonly string[]): string {
	for (;;) {
		const bytes = crypto.randomBytes(6);
		const id = Array.from(bytes, byte => (byte % 36).toString(36)).join('');
		if (!taken.includes(id)) {
			return id;
		}
	}
}
