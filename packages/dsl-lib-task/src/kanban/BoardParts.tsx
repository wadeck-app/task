import { ArrowRightLeft } from 'lucide-react';
import React, { useEffect, useRef, useState } from 'react';
import { useDismiss } from '../useDismiss.js';
import { CONTROL_RADIUS, CONTROL_SQUARE, FOCUS_RING, GAP_CONTROLS, ICON_SIZE, PILL_RADIUS } from '../ui/tokens.js';
import { hashIndex, TONE_DOT, TONE_PILL, TONES, toneOf } from '../tones.js';
import type { Tone } from '../tones.js';
import { cardsInStatusOrder } from './boardModel.js';
import type { BoardCardData, BoardColumnData, BoardStatusData } from './boardModel.js';
import { renderCardField, TITLE_CLAMP } from './CardFields.js';
import type { CardLayout } from './cardLayout.js';

/** What the columns need from the board: the cards as shown, the move, the drag state. */
export interface BoardView {
	columns: BoardColumnData[];
	readOnly: boolean;
	/** Ids of the cards whose move is running. */
	busy: ReadonlySet<string>;
	/** Which status the dragged card is over, when it may be dropped there. */
	overStatus: string | null;
	/** The card being dragged and its current status; null when nothing is dragged (the drop areas show only then). */
	dragging: { id: string; from: string } | null;
	startDrag: (event: React.DragEvent, card: BoardCardData, from: string) => void;
	endDrag: () => void;
	/** Props that make an element the drop target of EXACTLY `status`. */
	zone: (status: string) => ZoneProps;
	move: (id: string, status: string) => void;
	/** Drawn at the end of the header row of a column (the sort control or badge of the column). */
	headerControl?: (column: BoardColumnData) => React.ReactNode;
	/** Drawn under the header of a column (the sort chips). */
	belowHeader?: (column: BoardColumnData) => React.ReactNode;
	/** The saved layout of the cards (`config.card`); absent = the usual card. */
	cardLayout?: CardLayout;
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

/** A column heading is shown in the "Move to" menu unless it only repeats the one status it holds. */
function showsHeading(column: BoardColumnData): boolean {
	return column.statuses.length !== 1 || column.statuses[0]!.name !== column.label;
}

/** The "Move to" menu of a card: the keyboard and touch way to change its status. Every status, grouped by column. */
export function MoveMenu({
	card,
	from,
	columns,
	disabled,
	onMove,
}: {
	card: BoardCardData;
	/** The current status of the card. */
	from: string;
	columns: BoardColumnData[];
	disabled: boolean;
	onMove: (id: string, status: string) => void;
}): React.ReactElement {
	const [open, setOpen] = useState(false);
	const root = useRef<HTMLSpanElement>(null);
	const button = useRef<HTMLButtonElement>(null);
	const items = useRef<Array<HTMLButtonElement | null>>([]);
	const groups = columns
		.map(column => ({ column, targets: column.statuses.filter(status => status.name !== from) }))
		.filter(group => group.targets.length > 0);
	const count = groups.reduce((total, group) => total + group.targets.length, 0);

	useDismiss(root, open, () => setOpen(false));
	useEffect(() => {
		if (open) {
			items.current[0]?.focus();
		}
	}, [open]);

	const focusAt = (index: number): void => {
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
			focusAt(count - 1);
		} else if (event.key === 'Escape') {
			event.preventDefault();
			setOpen(false);
			button.current?.focus();
		} else if (event.key === 'Tab') {
			setOpen(false);
		}
	};

	let position = 0;
	return (
		<span ref={root} className="relative inline-flex shrink-0">
			<button
				ref={button}
				type="button"
				aria-label={`Move ${card.id} to another status`}
				aria-haspopup="menu"
				aria-expanded={open}
				title="Move to..."
				disabled={disabled || count === 0}
				onClick={() => setOpen(value => !value)}
				className={`inline-flex ${CONTROL_SQUARE} cursor-pointer items-center justify-center ${CONTROL_RADIUS} border-0 bg-transparent text-muted hover:bg-muted-bg hover:text-content ${FOCUS_RING} disabled:cursor-not-allowed disabled:opacity-40`}
			>
				<ArrowRightLeft size={ICON_SIZE} aria-hidden="true" />
			</button>
			{open ? (
				<ul
					role="menu"
					aria-label={`Move ${card.id} to`}
					onKeyDown={onKeyDown}
					className={`absolute right-0 top-full z-30 m-0 mt-1 max-h-[60vh] min-w-[10rem] list-none overflow-y-auto ${CONTROL_RADIUS} border border-border bg-surface p-1 shadow-lg`}
				>
					{groups.map(({ column, targets }) => (
						<React.Fragment key={column.key}>
							{showsHeading(column) ? (
								<li
									role="presentation"
									data-testid="kanban-move-group"
									className="px-2 pb-0.5 pt-1.5 text-xs font-semibold text-muted"
								>
									{column.label}
								</li>
							) : null}
							{targets.map(target => {
								const index = position++;
								return (
									<li key={target.name} role="none">
										<button
											ref={element => {
												items.current[index] = element;
											}}
											type="button"
											role="menuitem"
											tabIndex={-1}
											onClick={() => {
												setOpen(false);
												onMove(card.id, target.name);
											}}
											className={MENU_ITEM_CLASS}
										>
											<span
												aria-hidden="true"
												className={`inline-block h-2 w-2 shrink-0 ${PILL_RADIUS} ${TONE_DOT[toneOf(target.tone)]}`}
											/>
											{target.name}
										</button>
									</li>
								);
							})}
						</React.Fragment>
					))}
				</ul>
			) : null}
		</span>
	);
}

/** One card. */
export function BoardCard({
	card,
	view,
	showStatus = false,
	layout,
	preview = false,
}: {
	card: BoardCardData;
	view: BoardView;
	/** Shows the status of the card as a pill: the column holds several statuses. */
	showStatus?: boolean;
	/** The layout of the cards (`board.card`); absent = the usual card. */
	layout?: CardLayout | undefined;
	/** A card of the preview of the card editor: not draggable, its title is not a link. */
	preview?: boolean;
}): React.ReactElement {
	if (layout !== undefined) {
		return <LaidOutCard card={card} view={view} showStatus={showStatus} layout={layout} preview={preview} />;
	}
	const status = card.status ?? '';
	const busy = view.busy.has(card.id);
	const canDrag = !view.readOnly && !busy;
	const labels = card.labels ?? [];
	const tone = toneOf(card.tone);
	const priorityText = card.priorityText ?? card.priority;
	const headline = (
		<a
			href={card.href}
			title={card.headline}
			data-testid="kanban-card-title"
			className="line-clamp-2 min-w-0 break-words text-content no-underline hover:underline"
		>
			{card.headline}
		</a>
	);
	const idText = <span className="shrink-0 font-mono text-xs text-muted">{card.id}</span>;
	const move = view.readOnly ? null : (
		<MoveMenu card={card} from={status} columns={view.columns} disabled={busy} onMove={view.move} />
	);
	const statusPill =
		showStatus && status !== '' ? (
			<span
				data-testid="kanban-card-status"
				className={`inline-flex shrink-0 items-center ${PILL_RADIUS} px-2 text-xs font-medium ${TONE_PILL[tone]}`}
			>
				{status}
			</span>
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
			className={`relative ${CONTROL_RADIUS} border border-border bg-surface py-2 pl-3 pr-2 text-sm shadow-sm ${canDrag ? 'cursor-grab' : ''} ${busy ? 'opacity-60' : ''}`}
		>
			<span aria-hidden="true" className={`absolute inset-y-0 left-0 w-1 rounded-l-md ${TONE_DOT[tone]}`} />
			<div className="flex flex-col gap-2">
				<div className={`flex items-start justify-between ${GAP_CONTROLS}`}>
					{idText}
					{move}
				</div>
				{headline}
				<div className={`flex flex-wrap items-center ${GAP_CONTROLS} text-xs`}>
					{statusPill}
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
		</article>
	);
}

/**
 * A card drawn with a layout: a top row (the id when it is the first field, and the "Move to" menu), the title clamped to the
 * number of lines, then the other fields in order. Only the fields of the layout show: no type, no labels.
 */
function LaidOutCard({
	card,
	view,
	showStatus,
	layout,
	preview,
}: {
	card: BoardCardData;
	view: BoardView;
	showStatus: boolean;
	layout: CardLayout;
	preview: boolean;
}): React.ReactElement {
	const status = card.status ?? '';
	const busy = view.busy.has(card.id);
	const canDrag = !preview && !view.readOnly && !busy;
	const tone = toneOf(card.tone);
	const leadsWithId = layout.fields[0]?.field === 'id';
	const rest = leadsWithId ? layout.fields.slice(1) : layout.fields;
	// A field the card has nothing for draws nothing.
	const nodes = rest
		.map(entry => ({ entry, rendered: renderCardField(entry, card, showStatus) }))
		.filter(item => item.rendered !== null);
	const lead = leadsWithId ? renderCardField(layout.fields[0]!, card, showStatus) : null;
	const move = view.readOnly ? null : (
		<MoveMenu card={card} from={status} columns={view.columns} disabled={busy || preview} onMove={view.move} />
	);
	return (
		<article
			data-testid={preview ? 'kanban-card-preview' : 'kanban-card'}
			data-card-id={card.id}
			data-tone={tone}
			aria-label={`${card.id} ${card.headline}`}
			aria-busy={busy || undefined}
			draggable={canDrag ? true : undefined}
			onDragStart={event => (canDrag ? view.startDrag(event, card, status) : event.preventDefault())}
			onDragEnd={() => view.endDrag()}
			className={`relative ${CONTROL_RADIUS} border border-border bg-surface py-2 pl-3 pr-2 text-sm shadow-sm ${canDrag ? 'cursor-grab' : ''} ${busy ? 'opacity-60' : ''}`}
		>
			<span aria-hidden="true" className={`absolute inset-y-0 left-0 w-1 rounded-l-md ${TONE_DOT[tone]}`} />
			<div className="flex flex-col gap-2">
				{lead !== null || move !== null ? (
					<div className={`flex items-start justify-between ${GAP_CONTROLS}`}>
						{lead ?? <span />}
						{move}
					</div>
				) : null}
				<a
					href={preview ? undefined : card.href}
					title={card.headline}
					data-testid="kanban-card-title"
					className={`${TITLE_CLAMP[layout.titleLines]} min-w-0 break-words text-content no-underline hover:underline`}
				>
					{card.headline}
				</a>
				{nodes.length > 0 ? (
					<div data-testid="card-meta" className={`flex flex-wrap items-center ${GAP_CONTROLS} text-xs`}>
						{nodes.map(item => (
							<React.Fragment key={item.entry.field}>{item.rendered}</React.Fragment>
						))}
					</div>
				) : null}
			</div>
		</article>
	);
}

/** The header of a column: label, count and the hidden count; a terminal column is tinted by its tone. `control` ends the row. */
export function ColumnHeader({
	column,
	count,
	control,
}: {
	column: BoardColumnData;
	count?: number;
	control?: React.ReactNode;
}): React.ReactElement {
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
			{control}
		</header>
	);
}

export const EMPTY_COLUMN_TEXT = 'No tasks';

export function EmptyColumn(): React.ReactElement {
	return <p className="m-0 px-2 py-3 text-center text-xs text-muted">{EMPTY_COLUMN_TEXT}</p>;
}

/**
 * The drop areas of a column, shown while a card is dragged (Jira): an overlay over the WHOLE body of the column, split in
 * bands of equal height, one per status the column holds, in the order of the column (a one-status column = one band over
 * the whole body). Each band is labelled with the status and its tone dot; the cards stay drawn, dimmed, behind the bands.
 * Dropping on a band sets EXACTLY that status. The band of the status the card is in is marked and takes no drop.
 */
export function DropAreas({
	statuses,
	view,
}: {
	statuses: BoardStatusData[];
	view: BoardView;
}): React.ReactElement | null {
	const drag = view.dragging;
	if (drag === null) {
		return null;
	}
	return (
		<div data-testid="kanban-drop-areas" className="absolute inset-0 z-10 flex flex-col gap-1">
			{statuses.map(status => {
				const current = status.name === drag.from;
				const zone = view.zone(status.name);
				const over = zone['data-drop-target'] === 'true';
				const tone = toneOf(status.tone);
				return (
					<div
						key={status.name}
						data-testid={`kanban-drop-area-${status.name}`}
						data-status={status.name}
						data-tone={tone}
						data-current={current ? 'true' : undefined}
						aria-label={
							current ? `${status.name} (current status)` : `Drop here to set status ${status.name}`
						}
						{...zone}
						className={`flex min-h-0 min-w-0 flex-1 basis-0 flex-col items-stretch ${CONTROL_RADIUS} border-2 border-dashed p-1 text-xs font-medium ${current ? 'border-border text-muted' : over ? 'border-primary bg-primary-light text-content ring-2 ring-primary' : 'border-primary text-content'}`}
					>
						<span
							className={`inline-flex min-w-0 max-w-full items-center self-start ${GAP_CONTROLS} ${PILL_RADIUS} border border-border bg-surface px-2 py-0.5 shadow-sm`}
						>
							<span
								aria-hidden="true"
								data-testid="kanban-band-dot"
								className={`inline-block h-2 w-2 shrink-0 ${PILL_RADIUS} ${TONE_DOT[tone]}`}
							/>
							<span className="min-w-0 truncate">{status.name}</span>
							{current ? <span className="shrink-0 font-normal">current</span> : null}
						</span>
					</div>
				);
			})}
		</div>
	);
}

/** The tone of a group: the tone of its status for a column sorted by status, else a stable tone picked from its name. */
export function groupTone(column: BoardColumnData, group: string): Tone {
	if (column.sort === 'status') {
		const status = column.statuses.find(entry => entry.name === group);
		if (status !== undefined) {
			return toneOf(status.tone);
		}
	}
	return TONES[hashIndex(group, TONES.length)]!;
}

/** What a screen reader hears for a group: its name and the number of its cards in the column. */
export function groupLabel(group: string, count: number): string {
	return `${group}, ${count} ${count === 1 ? 'card' : 'cards'}`;
}

/** The line that opens a group of cards: a thin rule on both sides of the group name, the name in a pill tinted by the group tone. */
export function GroupSeparator({
	group,
	count,
	tone,
}: {
	group: string;
	count: number;
	tone: Tone;
}): React.ReactElement {
	return (
		<div
			role="separator"
			aria-label={groupLabel(group, count)}
			data-testid="kanban-group-separator"
			data-tone={tone}
			className={`flex items-center ${GAP_CONTROLS} pt-1`}
		>
			<span aria-hidden="true" className="h-px min-w-[1rem] flex-1 bg-border" />
			<span
				className={`inline-block min-w-0 max-w-[70%] truncate ${PILL_RADIUS} px-2 text-xs font-medium ${TONE_PILL[tone]}`}
			>
				{group}
			</span>
			<span aria-hidden="true" className="h-px min-w-[1rem] flex-1 bg-border" />
		</div>
	);
}

/**
 * The cards of a column, in the order of the answer; a column sorted by status follows the order of its statuses. When the
 * cards carry a `group` (a sort that forms groups), every run of cards of one group, the first one included, opens with a
 * {@link GroupSeparator}. Cards without a group are drawn as they are.
 */
export function CardList({
	column,
	view,
	showStatus = false,
}: {
	column: BoardColumnData;
	view: BoardView;
	showStatus?: boolean;
}): React.ReactElement {
	const cards = column.sort === 'status' ? cardsInStatusOrder(column) : column.cards;
	const counts = new Map<string, number>();
	for (const card of cards) {
		if (card.group !== undefined) {
			counts.set(card.group, (counts.get(card.group) ?? 0) + 1);
		}
	}
	const items: React.ReactElement[] = [];
	let previous: string | undefined;
	cards.forEach((card, index) => {
		// A new run of a group (the first card of the column included) opens with its separator.
		if (card.group !== undefined && (index === 0 || card.group !== previous)) {
			items.push(
				<GroupSeparator
					key={`group-${index}-${card.group}`}
					group={card.group}
					count={counts.get(card.group) ?? 0}
					tone={groupTone(column, card.group)}
				/>
			);
		}
		previous = card.group;
		items.push(<BoardCard key={card.id} card={card} view={view} showStatus={showStatus} layout={view.cardLayout} />);
	});
	return <>{items}</>;
}
