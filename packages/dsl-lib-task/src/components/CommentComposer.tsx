import { Loader2, Send } from 'lucide-react';
import React, { useCallback, useRef, useState } from 'react';
import { addProblemText, isUnreadableAnswer } from '../actionProblem.js';
import { useAction } from '../useAction.js';
import { useRefocus } from '../useRefocus.js';
import type { ActionHandler } from '../useAction.js';
import {
	BUTTON_PRIMARY_CLASS,
	CONTROL_RADIUS,
	CONTROL_TEXT,
	FIELD_FOCUS,
	GAP_CONTROLS,
	ICON_SIZE,
} from '../ui/tokens.js';
import { useAutoGrow } from '../ui/useAutoGrow.js';

/** The counter appears when the text uses this share of the limit. */
const COUNTER_FROM = 0.8;

export interface CommentComposerProps {
	/** Name of the `$actions` entry run when the comment is sent (`POST /tasks/{id}/comments`). */
	action: string;
	/**
	 * The `{placeholders}` of the action url (`id`, `projectParam`...).
	 * @resolveDeep
	 */
	params?: Record<string, unknown>;
	/** Sent as the `author` of the comment when not empty. Tasks have no user model: leave it out to send none. */
	author?: string;
	/** Shown in the empty field. */
	placeholder?: string;
	/** The label of the send button. */
	buttonLabel?: string;
	/** Longest text accepted (the task API refuses more than 10000); a counter shows near the limit. */
	maxLength?: number;
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

/**
 * The box that adds a comment: a field that grows with its text, and a button. Ctrl+Enter sends (Enter adds a line).
 * It sends the trimmed text in the JSON body, clears itself once the request succeeded, and keeps the text and says
 * so when it failed. Blank text cannot be sent.
 *
 * IN SCOPE: one new plain-text comment. OUT OF SCOPE: editing a comment (CommentThread), formatting, attachments.
 *
 * @registryCategory atomic
 * @registryTags comment composer textarea add note
 */
export function CommentComposer({
	action,
	params,
	author,
	placeholder = 'Write a comment...',
	buttonLabel = 'Comment',
	maxLength = 10000,
	onAction,
	actionPending,
}: CommentComposerProps): React.ReactElement {
	const runner = useAction('CommentComposer', action, onAction, actionPending);
	const [draft, setDraft] = useState('');
	const [sending, setSending] = useState(false);
	const [problem, setProblem] = useState<string | null>(null);
	// A second send while one is in flight (Ctrl+Enter held down) must not start another request.
	const guard = useRef(false);
	const field = useRef<HTMLTextAreaElement | null>(null);
	useAutoGrow(field, draft);
	const root = useRef<HTMLDivElement>(null);
	// The field takes the focus back after a successful send, so the next comment can be typed at once.
	const { fieldRef, refocus } = useRefocus<HTMLTextAreaElement>(root);
	const setField = useCallback(
		(element: HTMLTextAreaElement | null): void => {
			field.current = element;
			fieldRef(element);
		},
		[fieldRef]
	);

	const trimmed = draft.trim();
	const canSend = runner.available && !sending && trimmed !== '';

	const send = async (): Promise<void> => {
		if (guard.current || !runner.available || trimmed === '') {
			return;
		}
		guard.current = true;
		setProblem(null);
		setSending(true);
		try {
			const body = {
				text: trimmed,
				...(author !== undefined && author.trim() !== '' ? { author: author.trim() } : {}),
			};
			const ok = await runner.run({ ...(params ?? {}) }, body);
			if (ok) {
				setDraft('');
				refocus();
			} else {
				const failure = runner.lastFailure();
				setProblem(
					isUnreadableAnswer(failure)
						? addProblemText('The comment', failure)
						: 'The comment was not saved. The page shows the reason; your text is kept, send it again when fixed.'
				);
			}
		} finally {
			guard.current = false;
			setSending(false);
		}
	};

	const counterVisible = draft.length >= maxLength * COUNTER_FROM;

	return (
		<div ref={root} data-testid="comment-composer" className={`flex w-full flex-col ${GAP_CONTROLS}`}>
			<textarea
				ref={setField}
				aria-label="New comment"
				aria-busy={sending}
				aria-invalid={problem !== null}
				title={runner.unavailableReason}
				disabled={!runner.available}
				readOnly={sending}
				rows={2}
				maxLength={maxLength}
				placeholder={placeholder}
				value={draft}
				onChange={event => {
					setDraft(event.target.value);
					setProblem(null);
				}}
				onKeyDown={event => {
					if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
						event.preventDefault();
						void send();
					}
				}}
				style={{ resize: 'none', maxHeight: 'min(60vh, 36rem)' }}
				className={`block w-full ${CONTROL_RADIUS} border border-border bg-surface px-2 py-1 ${CONTROL_TEXT} text-content ${FIELD_FOCUS} placeholder:text-muted disabled:cursor-not-allowed disabled:opacity-60 read-only:opacity-70`}
			/>
			<div className={`flex items-center justify-end ${GAP_CONTROLS}`}>
				{counterVisible ? (
					<span data-testid="comment-composer-counter" className="mr-auto text-xs text-muted">
						{draft.length}/{maxLength}
					</span>
				) : null}
				{problem ? (
					<span role="alert" className="mr-auto text-xs text-warning-text">
						{problem}
					</span>
				) : null}
				<button
					type="button"
					title={runner.unavailableReason ?? 'Send (Ctrl+Enter)'}
					disabled={!canSend}
					onClick={() => void send()}
					className={BUTTON_PRIMARY_CLASS}
				>
					{sending ? (
						<Loader2
							data-testid="comment-composer-spinner"
							size={ICON_SIZE}
							aria-hidden="true"
							className="mr-2 animate-spin"
						/>
					) : (
						<Send size={ICON_SIZE} aria-hidden="true" className="mr-2" />
					)}
					{buttonLabel}
				</button>
			</div>
		</div>
	);
}
