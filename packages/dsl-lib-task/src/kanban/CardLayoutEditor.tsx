import { ArrowDown, ArrowUp } from 'lucide-react';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Notice } from '@wadeck-app/dsl-ui';
import { Dialog } from '../ui/Dialog.js';
import {
	BUTTON_PRIMARY_CLASS,
	CONTROL_BORDER,
	CONTROL_H,
	CONTROL_RADIUS,
	FIELD_CLASS,
	FOCUS_RING,
	GAP_BLOCKS,
	GAP_CONTROLS,
	ICON_BUTTON_CLASS,
	ICON_SIZE,
	PILL_TEXT,
} from '../ui/tokens.js';
import { BoardCard } from './BoardParts.js';
import type { BoardView } from './BoardParts.js';
import type { BoardColumnData } from './boardModel.js';
import {
	CARD_FIELDS,
	draftFromLayout,
	draftToBody,
	FIELD_HINTS,
	FIELD_LABELS,
	hideField,
	layoutOfDraft,
	moveField,
	pickPreviewCards,
	showField,
	STYLE_LABELS,
	TITLE_LINES,
} from './cardLayout.js';
import type { CardBody, CardDraft, CardField, CardLayout, TitleLines } from './cardLayout.js';

export interface CardLayoutEditorProps {
	/** The stored layout of the cards; undefined = the usual card. */
	layout: CardLayout | undefined;
	/** The cards of the board: the preview shows three of them. */
	columns: readonly BoardColumnData[];
	/** A save or a reset is running. */
	busy: boolean;
	/** The route's message and hint of the last refused save or reset; null when there is none. */
	error: string | null;
	/** The body of PUT /board/card. */
	onSave: (body: CardBody) => void;
	onReset: () => void;
	onCancel: () => void;
}

const SECONDARY_BUTTON_CLASS = `inline-flex ${CONTROL_H} items-center justify-center ${GAP_CONTROLS} ${CONTROL_RADIUS} ${CONTROL_BORDER} bg-surface px-3 ${PILL_TEXT} text-content hover:bg-muted-bg ${FOCUS_RING} disabled:cursor-not-allowed disabled:opacity-60`;

/** The preview is read only: no move menu, no drag, nothing to do on a click. */
const PREVIEW_VIEW: BoardView = {
	columns: [],
	readOnly: true,
	busy: new Set<string>(),
	overStatus: null,
	dragging: null,
	startDrag: () => undefined,
	endDrag: () => undefined,
	zone: () => ({ onDragOver: () => undefined, onDragLeave: () => undefined, onDrop: () => undefined }),
	move: () => undefined,
};

/** What a field is called in a sentence (an aria-label). */
const spoken = (field: CardField): string => FIELD_LABELS[field].toLowerCase();

const sameDraft = (a: CardDraft, b: CardDraft): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * The editor of the layout of the cards ("Configure cards"): a preview of three different cards at the top (real cards of the
 * board, completed with labelled samples), the title lines, then every field of a card: a checkbox to show it, buttons to move it
 * earlier or later among the shown ones, and a style when it has several. The hidden fields are listed after the shown ones. The
 * preview draws the draft with the same component as the board. Save stores it, "Reset to the usual card" removes the layout; the
 * rules (a field once, valid styles) are the server's and a refused save shows its message and hint.
 */
export function CardLayoutEditor({
	layout,
	columns,
	busy,
	error,
	onSave,
	onReset,
	onCancel,
}: CardLayoutEditorProps): React.ReactElement {
	const [draft, setDraft] = useState<CardDraft>(() => draftFromLayout(layout));
	// The draft as the dialog opened: closing asks first once it differs (a live refresh of the layout does not reset it).
	const opened = useRef(JSON.stringify(draft));
	const dirty = JSON.stringify(draft) !== opened.current;
	const [announcement, setAnnouncement] = useState('');
	// The control to focus once the list is redrawn: a move keeps the focus on the field that moved.
	const focusAfter = useRef<{ field: CardField; direction: 'earlier' | 'later' } | null>(null);
	const moveButtons = useRef(new Map<string, HTMLButtonElement>());
	const previewCards = useMemo(() => pickPreviewCards(columns), [columns]);
	const drawn = useMemo(() => layoutOfDraft(draft), [draft]);
	const shownCount = draft.items.filter(item => item.shown).length;

	useEffect(() => {
		const wanted = focusAfter.current;
		if (wanted === null) {
			return;
		}
		focusAfter.current = null;
		const other = wanted.direction === 'earlier' ? 'later' : 'earlier';
		const first = moveButtons.current.get(`${wanted.field}:${wanted.direction}`);
		const target = first !== undefined && !first.disabled ? first : moveButtons.current.get(`${wanted.field}:${other}`);
		target?.focus();
	}, [draft]);

	const move = (field: CardField, direction: -1 | 1): void => {
		const items = moveField(draft.items, field, direction);
		focusAfter.current = { field, direction: direction === -1 ? 'earlier' : 'later' };
		setDraft({ ...draft, items });
		const position = items.filter(item => item.shown).findIndex(item => item.field === field) + 1;
		setAnnouncement(`${FIELD_LABELS[field]} moved to position ${position} of ${shownCount}`);
	};

	const toggle = (field: CardField, on: boolean): void => {
		const items = on ? showField(draft.items, field) : hideField(draft.items, field);
		setDraft({ ...draft, items });
		if (on) {
			setAnnouncement(`${FIELD_LABELS[field]} shown at position ${shownCount + 1} of ${shownCount + 1}`);
		} else {
			setAnnouncement(`${FIELD_LABELS[field]} hidden`);
		}
	};

	const setStyle = (field: CardField, style: string): void =>
		setDraft({ ...draft, items: draft.items.map(item => (item.field === field ? { ...item, style } : item)) });

	const usual = layout === undefined;
	const unchanged = sameDraft(draft, draftFromLayout(layout));
	const firstHidden = draft.items.findIndex(item => !item.shown);
	let position = 0;

	return (
		<Dialog
			title="Configure cards"
			testId="card-editor"
			size="lg"
			dirty={dirty}
			busy={busy}
			onClose={onCancel}
			alert={error !== null ? <Notice variant="danger" label={error} /> : undefined}
			footer={({ requestClose }) => (
				<>
					<span className="flex-1" />
					<button
						type="button"
						onClick={onReset}
						disabled={busy || usual}
						title={usual ? 'The cards already have the usual layout' : 'Back to the usual card: id, title, priority, assignee, status'}
						className={SECONDARY_BUTTON_CLASS}
					>
						Reset to the usual card
					</button>
					<button type="button" onClick={requestClose} disabled={busy} className={SECONDARY_BUTTON_CLASS}>
						Cancel
					</button>
					<button
						type="button"
						onClick={() => onSave(draftToBody(draft))}
						disabled={busy || (usual && unchanged)}
						title={usual && unchanged ? 'Change a field first: the cards already have this layout' : undefined}
						className={BUTTON_PRIMARY_CLASS}
					>
						{busy ? 'Saving' : 'Save'}
					</button>
				</>
			)}
		>
			<p className="m-0 text-xs text-muted">
				Pick the fields a card shows and put them in order: the preview shows your changes on three cards. The
				title is always shown. A field a task has no value for is left out of its card.
			</p>
			<div
				role="group"
				aria-label="Card preview"
				data-testid="card-editor-preview"
				className={`flex min-w-0 flex-col ${GAP_CONTROLS}`}
			>
				<span aria-hidden="true" className="text-xs font-medium text-muted">
					Card preview
				</span>
				<div className={`grid grid-cols-1 ${GAP_BLOCKS} sm:grid-cols-3`}>
					{previewCards.map(entry => (
						<div key={entry.card.id} className="flex min-w-0 flex-col gap-1">
							<BoardCard
								card={entry.card}
								view={PREVIEW_VIEW}
								showStatus={entry.showStatus}
								layout={drawn}
								preview
							/>
							<span className="text-xs text-muted">{entry.sample ? 'Sample' : 'Your task'}</span>
						</div>
					))}
				</div>
			</div>
			<p data-testid="card-editor-announce" role="status" aria-live="polite" className="sr-only">
				{announcement}
			</p>
			<label className={`flex flex-wrap items-center ${GAP_CONTROLS} text-xs text-muted`}>
				<span className="font-medium">Title lines</span>
				<select
					aria-label="Title lines"
					value={String(draft.titleLines)}
					disabled={busy}
					onChange={event => setDraft({ ...draft, titleLines: Number(event.target.value) as TitleLines })}
					className={`${FIELD_CLASS} min-w-0 max-w-full`}
				>
					{TITLE_LINES.map(lines => (
						<option key={lines} value={String(lines)}>
							{lines === 1 ? '1 line' : `${lines} lines`}
						</option>
					))}
				</select>
			</label>
			<ol className={`m-0 flex list-none flex-col ${GAP_CONTROLS} p-0`}>
				{draft.items.map((item, index) => {
					const styles: readonly string[] = CARD_FIELDS[item.field];
					const here = item.shown ? ++position : 0;
					const hint = FIELD_HINTS[item.field];
					return (
						<React.Fragment key={item.field}>
							{index === firstHidden ? (
								<li role="presentation" className="pt-1 text-xs font-medium text-muted">
									Not on the card
								</li>
							) : null}
							<li
								data-testid="card-editor-row"
								data-field={item.field}
								data-shown={item.shown ? 'true' : 'false'}
								className={`flex flex-col gap-1 ${CONTROL_RADIUS} ${CONTROL_BORDER} p-2 ${item.shown ? '' : 'bg-muted-bg'}`}
							>
								<div className={`flex flex-wrap items-center ${GAP_CONTROLS}`}>
									<label className={`flex min-w-[9rem] flex-1 cursor-pointer items-center ${GAP_CONTROLS} text-sm text-content`}>
										<input
											type="checkbox"
											aria-label={`Show ${spoken(item.field)}`}
											checked={item.shown}
											disabled={busy}
											onChange={event => toggle(item.field, event.target.checked)}
											className={`h-4 w-4 shrink-0 cursor-pointer accent-primary ${FOCUS_RING}`}
										/>
										<span className={item.shown ? 'font-medium' : 'text-muted'}>{FIELD_LABELS[item.field]}</span>
										{item.shown ? <span className="text-xs text-muted">{`(${here})`}</span> : null}
									</label>
									{styles.length > 0 ? (
										<select
											aria-label={`Style of ${spoken(item.field)}`}
											value={item.style}
											disabled={busy || !item.shown}
											onChange={event => setStyle(item.field, event.target.value)}
											className={`${FIELD_CLASS} min-w-0 max-w-full`}
										>
											{styles.map(style => (
												<option key={style} value={style}>
													{STYLE_LABELS[style] ?? style}
												</option>
											))}
										</select>
									) : null}
									<button
										type="button"
										aria-label={`Move ${spoken(item.field)} earlier`}
										title={item.shown ? 'Move earlier' : 'Show the field to move it'}
										disabled={busy || !item.shown || here === 1}
										onClick={() => move(item.field, -1)}
										ref={element => {
											const key = `${item.field}:earlier`;
											if (element === null) moveButtons.current.delete(key);
											else moveButtons.current.set(key, element);
										}}
										className={ICON_BUTTON_CLASS}
									>
										<ArrowUp size={ICON_SIZE} aria-hidden="true" />
									</button>
									<button
										type="button"
										aria-label={`Move ${spoken(item.field)} later`}
										title={item.shown ? 'Move later' : 'Show the field to move it'}
										disabled={busy || !item.shown || here === shownCount}
										onClick={() => move(item.field, 1)}
										ref={element => {
											const key = `${item.field}:later`;
											if (element === null) moveButtons.current.delete(key);
											else moveButtons.current.set(key, element);
										}}
										className={ICON_BUTTON_CLASS}
									>
										<ArrowDown size={ICON_SIZE} aria-hidden="true" />
									</button>
								</div>
								{hint !== undefined ? <p className="m-0 text-xs text-muted">{hint}</p> : null}
							</li>
						</React.Fragment>
					);
				})}
			</ol>
		</Dialog>
	);
}
