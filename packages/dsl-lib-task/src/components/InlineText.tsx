import { Pencil } from 'lucide-react';
import React, { useEffect, useRef, useState } from 'react';
import { useAction } from '../useAction.js';
import type { ActionHandler } from '../useAction.js';

// A line of the page holds roughly this many characters (the same estimate as TitleText).
const CHARS_PER_LINE = 70;

export interface InlineTextProps {
	/** The current text. The page gives the new one after the action ran and the sources reloaded. */
	value: string;
	/** Name of the `$actions` entry run when the text is saved. */
	action: string;
	/** Name of the key that carries the text in the JSON body of the action. */
	valueParam?: string;
	/**
	 * The `{placeholders}` of the action url (`id`, `projectParam`...).
	 * @resolveDeep
	 */
	params?: Record<string, unknown>;
	/** Several lines: Enter adds a line, Ctrl+Enter saves. Otherwise Enter saves. */
	multiline?: boolean;
	/** Shown when the text is empty. */
	placeholder?: string;
	/** Longest text accepted; the counter shows while editing. */
	maxLength?: number;
	/** Allows saving an empty text. */
	allowEmpty?: boolean;
	/** Draws the text only. */
	readOnly?: boolean;
	/** The accessible name of the field (`Title`, `Description`). */
	ariaLabel?: string;
	/** Shows at most this many lines of a long text, with a Show more / Show less button (a prompt of 700 characters). 0 = all. */
	collapsedLines?: number;
	/** Classes of the text, shared by the display and the editor so the page does not jump (`text-xl font-semibold`). */
	textClass?: string;
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
 * A text (title, description) that becomes an editable field on click and is saved with the Enter key, with no
 * Save button. Escape cancels. The text is sent in the JSON body of the action.
 *
 * IN SCOPE: one text of one task. OUT OF SCOPE: rich text and several fields (use a Form).
 *
 * @registryCategory atomic
 * @registryTags text edit inline title description
 */
export function InlineText({
	value,
	action,
	valueParam = 'value',
	params,
	multiline = false,
	placeholder,
	maxLength,
	allowEmpty = false,
	readOnly = false,
	ariaLabel = 'Text',
	collapsedLines = 0,
	textClass = 'text-sm',
	onAction,
	actionPending,
}: InlineTextProps): React.ReactElement {
	const runner = useAction('InlineText', readOnly ? undefined : action, onAction, actionPending);
	const current = typeof value === 'string' ? value : '';
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState(current);
	const [saving, setSaving] = useState(false);
	const [problem, setProblem] = useState<string | null>(null);
	const [unfolded, setUnfolded] = useState(false);
	// Enter makes the field read-only and the browser may then blur it: the guard keeps the blur from saving again.
	const guard = useRef(false);
	const cancelled = useRef(false);
	const restoreFocus = useRef(false);
	const field = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
	const display = useRef<HTMLButtonElement>(null);

	useEffect(() => {
		if (editing) {
			const el = field.current;
			el?.focus();
			el?.setSelectionRange(el.value.length, el.value.length);
		} else if (restoreFocus.current) {
			restoreFocus.current = false;
			display.current?.focus();
		}
	}, [editing]);

	const start = (): void => {
		cancelled.current = false;
		guard.current = false;
		setDraft(current);
		setProblem(null);
		setEditing(true);
	};

	const finish = (focus: boolean): void => {
		restoreFocus.current = focus;
		setProblem(null);
		setEditing(false);
	};

	const save = async (): Promise<void> => {
		if (guard.current) {
			return;
		}
		const next = draft.trim();
		if (next === current.trim()) {
			finish(true);
			return;
		}
		if (next === '' && !allowEmpty) {
			setProblem('This text cannot be empty. Type something, or press Esc to cancel.');
			return;
		}
		guard.current = true;
		setProblem(null);
		setSaving(true);
		try {
			const ok = await runner.run({ ...(params ?? {}) }, { [valueParam]: next });
			if (ok) {
				finish(true);
			} else {
				setProblem('The change was not saved. The page shows the reason; fix it, or press Esc to cancel.');
			}
		} finally {
			guard.current = false;
			setSaving(false);
		}
	};

	const cancel = (): void => {
		cancelled.current = true;
		finish(true);
	};

	if (readOnly) {
		return (
			<span data-testid="inline-text" className={`whitespace-pre-wrap break-words ${textClass}`}>
				{current !== '' ? current : <span className="text-muted">{placeholder}</span>}
			</span>
		);
	}

	if (!editing) {
		// A text shorter than this many lines x characters never needs the fold.
		const foldable =
			collapsedLines > 0 &&
			(current.split('\n').length > collapsedLines || current.length > collapsedLines * CHARS_PER_LINE);
		const clamped = foldable && !unfolded;
		const button = (
			<button
				ref={display}
				type="button"
				data-testid="inline-text"
				aria-label={`Edit ${ariaLabel}`}
				title={runner.unavailableReason}
				disabled={!runner.available}
				onClick={start}
				className={`group inline-flex w-full items-start gap-2 rounded border border-transparent px-1 text-left hover:border-border focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-not-allowed ${multiline ? 'whitespace-pre-wrap' : ''} break-words ${textClass}`}
			>
				<span
					data-clamped={clamped ? 'true' : undefined}
					style={
						clamped
							? {
									display: '-webkit-box',
									WebkitLineClamp: collapsedLines,
									WebkitBoxOrient: 'vertical',
									overflow: 'hidden',
								}
							: undefined
					}
					className={`min-w-0 flex-1 ${current === '' ? 'text-muted' : ''}`}
				>
					{current !== '' ? current : placeholder}
				</span>
				<Pencil
					size={14}
					aria-hidden="true"
					className="mt-1 shrink-0 opacity-0 group-hover:opacity-60 group-focus-visible:opacity-60"
				/>
			</button>
		);
		if (!foldable) {
			return button;
		}
		return (
			<div className="flex w-full flex-col items-start gap-0.5">
				{button}
				<button
					type="button"
					aria-expanded={unfolded}
					onClick={() => setUnfolded(open => !open)}
					className="ml-1 cursor-pointer border-0 bg-transparent p-0 text-xs font-medium text-muted underline"
				>
					{unfolded ? 'Show less' : 'Show more'}
				</button>
			</div>
		);
	}

	const fieldClass = `w-full rounded border border-primary bg-surface px-1 text-content outline-none focus:ring-1 focus:ring-primary read-only:opacity-70 ${textClass}`;
	const common = {
		ref: field,
		'aria-label': ariaLabel,
		'aria-busy': saving,
		'aria-invalid': problem !== null,
		readOnly: saving,
		value: draft,
		maxLength,
		placeholder,
		className: fieldClass,
		onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
			setDraft(event.target.value);
			setProblem(null);
		},
		onKeyDown: (event: React.KeyboardEvent) => {
			if (event.key === 'Escape') {
				event.preventDefault();
				cancel();
			} else if (event.key === 'Enter' && (!multiline || event.ctrlKey || event.metaKey)) {
				event.preventDefault();
				void save();
			}
		},
		onBlur: () => {
			if (cancelled.current || guard.current) {
				return;
			}
			if (draft.trim() === '' && !allowEmpty) {
				cancel();
				return;
			}
			void save();
		},
	};

	return (
		<span data-testid="inline-text" className="flex w-full flex-col gap-1">
			{multiline ? (
				<textarea {...common} rows={Math.max(2, draft.split('\n').length)} />
			) : (
				<input {...common} type="text" />
			)}
			{maxLength !== undefined ? (
				<span data-testid="inline-text-counter" className="text-xs text-muted">
					{draft.length}/{maxLength}
				</span>
			) : null}
			{problem ? (
				<span role="alert" className="text-xs text-warning-text">
					{problem}
				</span>
			) : null}
		</span>
	);
}
