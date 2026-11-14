import { ArrowRightLeft } from 'lucide-react';
import React, { useEffect, useRef, useState } from 'react';
import { useDismiss } from '../useDismiss.js';
import { CONTROL_RADIUS, CONTROL_SQUARE, FOCUS_RING, GAP_CONTROLS, ICON_SIZE, PILL_RADIUS } from '../ui/tokens.js';
import { TONE_DOT, TONE_PILL, toneOf } from '../tones.js';
import type { BoardCardData, BoardColumnData } from './boardModel.js';

/** What the layouts need from the board: the cards as shown, the move, the drag state. */
export interface BoardView {
	columns: BoardColumnData[];
	readOnly: boolean;
	/** Ids of the cards whose move is running. */
	busy: ReadonlySet<string>;
	/** Which status the dragged card is over, when it may be dropped there. */
	overStatus: string | null;
	startDrag: (event: React.DragEvent, card: BoardCardData, from: string) => void;
	endDrag: () => void;
	/** Props that make an element a drop target for `status`. */
	zone: (status: string) => ZoneProps;
	move: (id: string, status: string) => void;
}

export interface ZoneProps {
	onDragOver: (event: React.DragEvent) => void;
	onDragLeave: (event: React.DragEvent) => void;
	onDrop: (event: React.DragEvent) => void;
	'data-drop-target'?: 'true';
}

const MAX_LABELS = 3;

function priorityTone(priority: string): 'danger' | 'warning' | 'neutral' {
	const key = priority.toLowerCase();
	return key === 'urgent' ? 'danger' : key === 'high' ? 'warning' : 'neutral';
}

const MENU_ITEM_CLASS = `flex w-full cursor-pointer items-center ${GAP_CONTROLS} ${CONTROL_RADIUS} border-0 bg-transparent px-2 py-1.5 text-left text-sm text-content hover:bg-muted-bg focus:bg-muted-bg focus:outline-none`;

/** The "Move to" menu of a card: the keyboard and touch way to change its status. */
export function MoveMenu({
	card,
	from,
	columns,
	disabled,
	dense = false,
	onMove,
}: {
	card: BoardCardData;
	from: string;
	columns: BoardColumnData[];
	disabled: boolean;
	dense?: boolean;
	onMove: (id: string, status: string) => void;
}): React.ReactElement {
	const [open, setOpen] = useState(false);
	const root = useRef<HTMLSpanElement>(null);
	const button = useRef<HTMLButtonElement>(null);
	const items = useRef<Array<HTMLButtonElement | null>>([]);
	const targets = columns.filter(column => column.status !== from);

	useDismiss(root, open, () => setOpen(false));
	useEffect(() => {
		if (open) {
			items.current[0]?.focus();
		}
	}, [open]);

	const focusAt = (index: number): void => {
		const count = targets.length;
		items.current[((index % count) + count) % count]?.focus();
	};

	const onKeyDown = (event: React.KeyboardEvent): void => {
		const index = items.current.findIndex(item => item === document.activeElement);
		if (event.key === 'ArrowDown') {
			event.preventDefault();
			focusAt(index + 1);
		} else if (event.key === 'ArrowUp') {
			event.preventDefault();
			focusAt(index - 1);
		} else if (event.key === 'Home') {
			event.preventDefault();
			focusAt(0);
		} else if (event.key === 'End') {
			event.preventDefault();
			focusAt(targets.length - 1);
		} else if (event.key === 'Escape') {
			event.preventDefault();
			setOpen(false);
			button.current?.focus();
		} else if (event.key === 'Tab') {
			setOpen(false);
		}
	};

	return (
		<span ref={root} className="relative inline-flex shrink-0">
			<button
				ref={button}
				type="button"
				aria-label={`Move ${card.id} to another status`}
				aria-haspopup="menu"
				aria-expanded={open}
				title="Move to..."
				disabled={disabled || targets.length === 0}
				onClick={() => setOpen(value => !value)}
				className={`inline-flex ${dense ? 'h-6 w-6' : CONTROL_SQUARE} cursor-pointer items-center justify-center ${CONTROL_RADIUS} border-0 bg-transparent text-muted hover:bg-muted-bg hover:text-content ${FOCUS_RING} disabled:cursor-not-allowed disabled:opacity-40`}
			>
				<ArrowRightLeft size={ICON_SIZE} aria-hidden="true" />
			</button>
			{open ? (
				<ul
					role="menu"
					aria-label={`Move ${card.id} to`}
					onKeyDown={onKeyDown}
					className={`absolute right-0 top-full z-30 m-0 mt-1 min-w-[10rem] list-none ${CONTROL_RADIUS} border border-border bg-surface p-1 shadow-lg`}
				>
					{targets.map((target, index) => (
						<li key={target.status} role="none">
							<button
								ref={element => {
									items.current[index] = element;
								}}
								type="button"
								role="menuitem"
								tabIndex={-1}
								onClick={() => {
									setOpen(false);
									onMove(card.id, target.status);
								}}
								className={MENU_ITEM_CLASS}
							>
								<span
									aria-hidden="true"
									className={`inline-block h-2 w-2 shrink-0 ${PILL_RADIUS} ${TONE_DOT[toneOf(target.tone)]}`}
								/>
								{target.label}
							</button>
						</li>
					))}
				</ul>
			) : null}
		</span>
	);
}

/** One card. `dense` is the one-line card of the compact layout. */
export function BoardCard({
	card,
	status,
	view,
	dense = false,
	showMove = true,
	draggable = true,
}: {
	card: BoardCardData;
	status: string;
	view: BoardView;
	dense?: boolean;
	showMove?: boolean;
	draggable?: boolean;
}): React.ReactElement {
	const busy = view.busy.has(card.id);
	const canDrag = draggable && !view.readOnly && !busy;
	const labels = card.labels ?? [];
	const tone = toneOf(card.tone);
	const priorityText = card.priorityText ?? card.priority;
	const headline = (
		<a
			href={card.href}
			title={card.headline}
			className={`min-w-0 text-content no-underline hover:underline ${dense ? 'min-w-[10rem] flex-1 line-clamp-2 break-words' : 'line-clamp-2 break-words'}`}
		>
			{card.headline}
		</a>
	);
	const idText = <span className="shrink-0 font-mono text-xs text-muted">{card.id}</span>;
	const move =
		showMove && !view.readOnly ? (
			<MoveMenu
				card={card}
				from={status}
				columns={view.columns}
				disabled={busy}
				dense={dense}
				onMove={view.move}
			/>
		) : null;
	const priority =
		card.priority !== undefined && card.priority !== '' ? (
			<span
				className={`inline-flex shrink-0 items-center ${PILL_RADIUS} px-2 text-xs font-medium ${TONE_PILL[priorityTone(card.priority)]}`}
			>
				{priorityText}
			</span>
		) : null;

	return (
		<article
			data-testid="kanban-card"
			data-card-id={card.id}
			data-tone={tone}
			aria-label={`${card.id} ${card.headline}`}
			aria-busy={busy || undefined}
			draggable={canDrag ? true : undefined}
			onDragStart={event => (canDrag ? view.startDrag(event, card, status) : event.preventDefault())}
			onDragEnd={() => view.endDrag()}
			className={`relative ${CONTROL_RADIUS} border border-border bg-surface pl-3 pr-2 text-sm shadow-sm ${dense ? 'py-1' : 'py-2'} ${canDrag ? 'cursor-grab' : ''} ${busy ? 'opacity-60' : ''}`}
		>
			<span aria-hidden="true" className={`absolute inset-y-0 left-0 w-1 rounded-l-md ${TONE_DOT[tone]}`} />
			{dense ? (
				<div className={`flex flex-wrap items-center ${GAP_CONTROLS}`}>
					{idText}
					{headline}
					{priority}
					{card.assignee ? <span className="shrink-0 text-xs text-muted">{card.assignee}</span> : null}
					{move}
				</div>
			) : (
				<div className="flex flex-col gap-2">
					<div className={`flex items-start justify-between ${GAP_CONTROLS}`}>
						{idText}
						{move}
					</div>
					{headline}
					<div className={`flex flex-wrap items-center ${GAP_CONTROLS} text-xs`}>
						{priority}
						{card.type ? <span className="text-muted">{card.type}</span> : null}
						{card.assignee ? <span className="text-muted">{card.assignee}</span> : null}
					</div>
					{labels.length > 0 ? (
						<div className={`flex flex-wrap items-center ${GAP_CONTROLS} text-xs`}>
							{labels.slice(0, MAX_LABELS).map(label => (
								<span key={label} className={`${PILL_RADIUS} bg-muted-bg px-2 text-muted`}>
									{label}
								</span>
							))}
							{labels.length > MAX_LABELS ? (
								<span className="text-muted">{`+${labels.length - MAX_LABELS}`}</span>
							) : null}
						</div>
					) : null}
				</div>
			)}
		</article>
	);
}

/** The header of a column: label, count and the hidden count; a terminal column is tinted by its tone. */
export function ColumnHeader({ column, count }: { column: BoardColumnData; count?: number }): React.ReactElement {
	const tone = toneOf(column.tone);
	const hidden = column.hiddenCount ?? 0;
	return (
		<header
			className={`flex items-center ${GAP_CONTROLS} ${CONTROL_RADIUS} px-2 py-1.5 text-sm font-semibold ${column.terminal ? TONE_PILL[tone] : 'bg-muted-bg text-content'}`}
		>
			<span aria-hidden="true" className={`inline-block h-2 w-2 shrink-0 ${PILL_RADIUS} ${TONE_DOT[tone]}`} />
			<span className="min-w-0 flex-1 truncate">{column.label}</span>
			<span data-testid="kanban-count" className="shrink-0 text-xs font-medium">
				{count ?? column.count}
			</span>
			{hidden > 0 ? <span className="shrink-0 text-xs font-normal">{`+${hidden} hidden`}</span> : null}
		</header>
	);
}

export const EMPTY_COLUMN_TEXT = 'No tasks';

export function EmptyColumn(): React.ReactElement {
	return <p className="m-0 px-2 py-3 text-center text-xs text-muted">{EMPTY_COLUMN_TEXT}</p>;
}

/** Common classes of a drop target, highlighted while a dragged card is over it. */
export function zoneClass(highlighted: boolean): string {
	return `${CONTROL_RADIUS} ${highlighted ? 'bg-primary-light ring-2 ring-primary' : ''}`;
}
