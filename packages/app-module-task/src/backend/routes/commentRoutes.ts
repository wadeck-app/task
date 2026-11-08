// Comment routes of a task: list, add, edit, remove. Plain text; the rules (trim, 1 to 10000 characters, ids) are task-core's.
import type { TaskComment } from '@wadeck-app/task-core';
import { addComment, editComment, listComments, removeComment } from '@wadeck-app/task-service';
import type { TaskCommentResult } from '@wadeck-app/task-service';

import { shortUtcTime } from '../display.js';
import { RequestError } from '../errors.js';
import { bodyObject, isBlankRequest, BLANK_ANSWER, requiredString } from '../request.js';
import { undeliveredFields } from '../undelivered.js';
import { taskId } from './routeKit.js';
import type { RouteKit } from './routeKit.js';

const ADD_USAGE =
	'Send a JSON body { "text": string, "author"?: string }: plain text, 1 to 10000 characters, not blank. The author is free text, absent by default.';
const EDIT_USAGE = 'Send a JSON body { "text": string }: the new plain text, 1 to 10000 characters, not blank.';

/** A comment as the views read it: the stored fields plus `edited`, `atText` and `editedText` (UTC minute). */
function commentView(comment: TaskComment): Record<string, unknown> {
	return {
		...comment,
		edited: comment.editedAt !== undefined,
		atText: shortUtcTime(comment.at),
		...(comment.editedAt === undefined ? {} : { editedText: shortUtcTime(comment.editedAt) }),
	};
}

export function registerCommentRoutes(kit: RouteKit): void {
	const { route, open, deliver } = kit;

	// The comments of a task, oldest first. A read: it emits no event.
	route('GET', '/tasks/:id/comments', req => {
		if (isBlankRequest(req.query)) return BLANK_ANSWER;
		const ctx = open(req);
		const { id, comments } = listComments(ctx, { id: taskId(req) });
		return {
			status: 200,
			body: {
				project: ctx.project,
				id,
				comments: comments.map(commentView),
				commentCount: comments.length,
				hasComments: comments.length > 0,
				noComments: comments.length === 0,
			},
		};
	});

	/** Delivers the events; the answer carries the comment, the new count and what the queue did not get. */
	const answer = async (
		status: number,
		result: TaskCommentResult,
		extra: Record<string, unknown> = {}
	): Promise<{ status: number; body: Record<string, unknown> }> => {
		const undelivered = await deliver(result.events);
		return {
			status,
			body: {
				taskId: result.task.id,
				comment: commentView(result.comment),
				commentCount: result.task.comments?.length ?? 0,
				...extra,
				...undeliveredFields(undelivered),
			},
		};
	};

	route('POST', '/tasks/:id/comments', req => {
		const ctx = open(req);
		const body = bodyObject(req.body, ADD_USAGE);
		const text = requiredString(body, 'text', ADD_USAGE);
		const author = body['author'];
		if (author !== undefined && typeof author !== 'string') {
			throw new RequestError(400, 'author must be a string when given', ADD_USAGE);
		}
		return answer(201, addComment(ctx, { id: taskId(req), text, ...(author === undefined ? {} : { author }) }));
	});

	route('PATCH', '/tasks/:id/comments/:commentId', req => {
		const ctx = open(req);
		const text = requiredString(bodyObject(req.body, EDIT_USAGE), 'text', EDIT_USAGE);
		const result = editComment(ctx, { id: taskId(req), commentId: req.params?.['commentId'] ?? '', text });
		return answer(200, result, { changed: result.events.length > 0 });
	});

	route('DELETE', '/tasks/:id/comments/:commentId', req => {
		const ctx = open(req);
		return answer(200, removeComment(ctx, { id: taskId(req), commentId: req.params?.['commentId'] ?? '' }));
	});
}
