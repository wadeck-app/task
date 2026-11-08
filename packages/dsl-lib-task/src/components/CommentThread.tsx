import { Trash2 } from 'lucide-react';
import React, { useState } from 'react';
import { useAction } from '../useAction.js';
import type { ActionHandler } from '../useAction.js';
import {
	CONTROL_H,
	CONTROL_RADIUS,
	FOCUS_RING,
	GAP_BLOCKS,
	GAP_CONTROLS,
	ICON_BUTTON_CLASS,
	ICON_SIZE,
	PILL_NEUTRAL_CLASS,
	PILL_TEXT,
} from '../ui/tokens.js';
import { relativeTime } from './ActivityFeed.js';
import { InlineText } from './InlineText.js';

export interface TaskCommentItem {
	/** Short id of the comment, unique within the task: the `{commentId}` of the edit and remove actions. */
	id: string;
	/** ISO 8601 instant of the creation. */
	at: string;
	/** The plain text, line breaks kept. */
	text: string;
	/** ISO 8601 instant of the last edit; absent for a comment never edited. */
	editedAt?: string;
	/** Who wrote it; absent when nobody was named (tasks have no user model). */
	author?: string;
}

export interface CommentThreadProps {
	/** The comments in the order to show them (the API gives oldest first). */
	comments: TaskCommentItem[];
	/** Name of the `$actions` entry run when a comment is edited (`PATCH /tasks/{id}/comments/{commentId}`, body `{text}`). Empty = not editable. */
	editAction?: string;
	/** Name of the `$actions` entry run when a comment is deleted (`DELETE /tasks/{id}/comments/{commentId}`). Empty = no delete control. */
	removeAction?: string;
	/**
	 * The `{placeholders}` of the action urls (`id`, `projectParam`...); the comment id is added as `commentId`.
	 * @resolveDeep
	 */
	params?: Record<string, unknown>;
	/** Draws the comments only: no edit, no delete. */
	readOnly?: boolean;
	/** Shown when there is no comment. */
	emptyText?: string;
	/** The instant "now" for the relative times (ISO 8601). Defaults to the clock. */
	now?: string;
	/**
	 * Runs an action of the page's `$actions`. Defaults to the page's `ctx.onAction`.
	 * @ctxDefault
	 */
	onAction?: ActionHandler;
	/**
	 * Actions currently running, by name. Defaults to the page's `$ctx.$actionPending`.
	 * @ctxDefault $actionPending
	 */
	actionPending?: Record<string, boolean>;
}

/** "2026-11-08 14:17 UTC": the tooltip of a time; a value that is not a date is returned as is. */
function absoluteUtc(iso: string): string {
	const time = Date.parse(iso);
	return Number.isNaN(time) ? iso : `${new Date(time).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

function isComment(value: unknown): value is TaskCommentItem {
	if (typeof value !== 'object' || value === null) {
		return false;
	}
	const item = value as Record<string, unknown>;
	return typeof item['id'] === 'string' && typeof item['text'] === 'string' && typeof item['at'] === 'string';
}

/**
 * The comments of a task, oldest first: author (when named), relative time with the UTC instant in the tooltip, an
 * "edited" marker, and the plain text with its line breaks (long words wrap). The text is edited in place like the
 * title (check and cross at the right, Ctrl+Enter saves, Esc cancels); delete asks for a confirmation. HTML and
 * links in a text are never interpreted.
 *
 * IN SCOPE: showing, editing and deleting the comments of one task. OUT OF SCOPE: adding one (CommentComposer).
 *
 * @registryCategory composite
 * @registryTags comment comments thread edit delete notes
 */
export function CommentThread({
	comments,
	editAction,
	removeAction,
	params,
	readOnly = false,
	emptyText = 'No comments yet.',
	now,
	onAction,
	actionPending,
}: CommentThreadProps): React.ReactElement {
	const remover = useAction('CommentThread', readOnly ? undefined : removeAction, onAction, actionPending);
	const [confirming, setConfirming] = useState<string | null>(null);
	const [deleting, setDeleting] = useState<string | null>(null);
	const [problem, setProblem] = useState<{ id: string; text: string } | null>(null);
	const list = (Array.isArray(comments) ? comments : []).filter(isComment);
	const parsedNow = now === undefined ? Number.NaN : Date.parse(now);
	const nowMs = Number.isNaN(parsedNow) ? Date.now() : parsedNow;
	const canEdit = !readOnly && editAction !== undefined && editAction !== '';
	const canDelete = !readOnly && removeAction !== undefined && removeAction !== '';

	const remove = async (id: string): Promise<void> => {
		setProblem(null);
		setDeleting(id);
		try {
			const ok = await remover.run({ ...(params ?? {}), commentId: id });
			if (ok) {
				setConfirming(null);
			} else {
				setProblem({
					id,
					text: 'The comment was not deleted. The page shows the reason; try again once it is fixed.',
				});
			}
		} finally {
			setDeleting(null);
		}
	};

	if (list.length === 0) {
		return (
			<p data-testid="comment-thread-empty" className="m-0 text-sm text-muted">
				{emptyText}
			</p>
		);
	}

	return (
		<ul data-testid="comment-thread" className={`m-0 flex list-none flex-col p-0 ${GAP_BLOCKS}`}>
			{list.map(comment => {
				const asking = confirming === comment.id;
				const busy = deleting === comment.id;
				return (
					<li
						key={comment.id}
						data-testid="comment"
						data-comment-id={comment.id}
						className={`flex flex-col ${GAP_CONTROLS} ${CONTROL_RADIUS} border border-border bg-surface p-3`}
					>
						<div className={`flex min-h-8 flex-wrap items-center ${GAP_CONTROLS}`}>
							{comment.author !== undefined && comment.author !== '' ? (
								<span
									data-testid="comment-author"
									className="break-words text-sm font-medium text-content"
								>
									{comment.author}
								</span>
							) : null}
							<time dateTime={comment.at} title={absoluteUtc(comment.at)} className="text-xs text-muted">
								{relativeTime(comment.at, nowMs)}
							</time>
							{comment.editedAt !== undefined ? (
								<span
									title={`Edited ${absoluteUtc(comment.editedAt)}`}
									className="text-xs italic text-muted"
								>
									edited
								</span>
							) : null}
							{canDelete ? (
								<span className={`ml-auto flex items-center ${GAP_CONTROLS}`}>
									{asking ? (
										<>
											<span className="text-xs text-content">Delete this comment?</span>
											<button
												type="button"
												disabled={busy}
												onClick={() => void remove(comment.id)}
												className={`inline-flex ${CONTROL_H} items-center ${CONTROL_RADIUS} bg-danger px-3 ${PILL_TEXT} text-white hover:opacity-90 ${FOCUS_RING} disabled:cursor-not-allowed disabled:opacity-60`}
											>
												Delete
											</button>
											<button
												type="button"
												disabled={busy}
												onClick={() => {
													setConfirming(null);
													setProblem(null);
												}}
												className={PILL_NEUTRAL_CLASS}
											>
												Cancel
											</button>
										</>
									) : (
										<button
											type="button"
											aria-label="Delete comment"
											title={remover.unavailableReason ?? 'Delete comment'}
											disabled={!remover.available}
											onClick={() => {
												setProblem(null);
												setConfirming(comment.id);
											}}
											className={ICON_BUTTON_CLASS}
										>
											<Trash2 size={ICON_SIZE} aria-hidden="true" />
										</button>
									)}
								</span>
							) : null}
						</div>
						<InlineText
							value={comment.text}
							action={canEdit ? editAction : ''}
							valueParam="text"
							params={{ ...(params ?? {}), commentId: comment.id }}
							multiline
							readOnly={!canEdit}
							ariaLabel="Comment"
							maxLength={10000}
							textClass="text-sm"
							onAction={onAction}
							actionPending={actionPending}
						/>
						{problem?.id === comment.id ? (
							<span role="alert" className="text-xs text-warning-text">
								{problem.text}
							</span>
						) : null}
					</li>
				);
			})}
		</ul>
	);
}
