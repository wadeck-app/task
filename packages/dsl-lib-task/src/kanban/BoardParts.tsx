import { ArrowRightLeft } from 'lucide-react';
import React, { useEffect, useRef, useState } from 'react';
import { useDismiss } from '../useDismiss.js';
import { CONTROL_RADIUS, CONTROL_SQUARE, FOCUS_RING, GAP_CONTROLS, ICON_SIZE, PILL_RADIUS } from '../ui/tokens.js';
import { hashIndex, TONE_BG, TONE_BORDER, TONE_DOT, TONE_PILL, TONES, toneOf } from '../tones.js';
import type { Tone } from '../tones.js';
import { DEFAULT_GROUP_STYLE } from './boardModel.js';
import type { BoardCardData, BoardColumnData, BoardStatusData, GroupStyle } from './boardModel.js';

/** What the layouts need from the board: the cards as shown, the move, the drag state. */
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
	/** A group style drawn on EVERY column instead of the column's own `groupStyle` (the A/B preview); null or absent = as configured. */
	groupStyleOverride?: GroupStyle | null;
	/** Drawn at the end of the header row of a column (the sort control or badge of the column). */
	headerControl?: (column: BoardColumnData) => React.ReactNode;
	/** Drawn under the header of a column (the sort chips). */
	belowHeader?: (column: BoardColumnData) => React.ReactNode;
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
	dense = false,
	onMove,
}: {
	card: BoardCardData;
	/** The current status of the card. */
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
				className={`inline-flex ${dense ? 'h-6 w-6' : CONTROL_SQUARE} cursor-pointer items-center justify-center ${CONTROL_RADIUS} border-0 bg-transparent text-muted hover:bg-muted-bg hover:text-content ${FOCUS_RING} disabled:cursor-not-allowed disabled:opacity-40`}
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

/** One card. `dense` is the one-line card of the compact layout. */
export function BoardCard({
	card,
	view,
	dense = false,
	showMove = true,
	draggable = true,
	showStatus = false,
}: {
	card: BoardCardData;
	view: BoardView;
	dense?: boolean;
	showMove?: boolean;
	draggable?: boolean;
	/** Shows the status of the card as a pill: the column holds several statuses. */
	showStatus?: boolean;
}): React.ReactElement {
	const status = card.status ?? '';
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
			className={`relative ${CONTROL_RADIUS} border border-border bg-surface pl-3 pr-2 text-sm shadow-sm ${dense ? 'py-1' : 'py-2'} ${canDrag ? 'cursor-grab' : ''} ${busy ? 'opacity-60' : ''}`}
		>
			<span aria-hidden="true" className={`absolute inset-y-0 left-0 w-1 rounded-l-md ${TONE_DOT[tone]}`} />
			{dense ? (
				<div className={`flex flex-wrap items-center ${GAP_CONTROLS}`}>
					{idText}
					{headline}
					{statusPill}
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
			)}
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

/** Common classes of a drop target, highlighted while a dragged card is over it. */
export function zoneClass(highlighted: boolean): string {
	return `${CONTROL_RADIUS} ${highlighted ? 'bg-primary-light ring-2 ring-primary' : ''}`;
}

/**
 * The drop areas of a column, shown while a card is dragged: one labelled area per status the column holds, stacked, each
 * tinted by the tone of its status. Dropping on an area sets EXACTLY that status. The area of the status the card is in is
 * marked and does not accept the drop.
 */
export function DropAreas({
	statuses,
	view,
	direction = 'column',
}: {
	statuses: BoardStatusData[];
	view: BoardView;
	direction?: 'column' | 'row';
}): React.ReactElement | null {
	const drag = view.dragging;
	if (drag === null) {
		return null;
	}
	return (
		<div
			data-testid="kanban-drop-areas"
			className={`flex ${direction === 'row' ? 'flex-row flex-wrap' : 'flex-col'} gap-1`}
		>
			{statuses.map(status => {
				const current = status.name === drag.from;
				const zone = view.zone(status.name);
				const over = zone['data-drop-target'] === 'true';
				return (
					<div
						key={status.name}
						data-testid={`kanban-drop-area-${status.name}`}
						data-status={status.name}
						data-current={current ? 'true' : undefined}
						aria-label={
							current ? `${status.name} (current status)` : `Drop here to set status ${status.name}`
						}
						{...zone}
						className={`flex min-h-[2.5rem] min-w-0 flex-1 items-center ${GAP_CONTROLS} ${CONTROL_RADIUS} border-2 border-dashed px-2 text-xs font-medium ${current ? 'border-border bg-muted-bg text-muted opacity-70' : over ? 'border-primary bg-primary-light text-content ring-2 ring-primary' : 'border-primary/50 bg-surface text-content'}`}
					>
						<span
							aria-hidden="true"
							className={`inline-block h-2 w-2 shrink-0 ${PILL_RADIUS} ${TONE_DOT[toneOf(status.tone)]}`}
						/>
						<span className="min-w-0 flex-1 truncate">{status.name}</span>
						{current ? <span className="shrink-0 font-normal">current</span> : null}
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

/** The styles that wrap the cards of a group in an element of their own (the others draw a line before the cards). */
const WRAPPING: ReadonlySet<GroupStyle> = new Set<GroupStyle>(['tint', 'border', 'boxed']);

const CAPTION_CLASS = 'min-w-0 truncate text-xs font-semibold';

/** The line that opens a group in the styles that do not wrap its cards (label, bar, gap, pill, divider). */
export function GroupSeparator({
	group,
	count,
	style,
	tone,
	first,
}: {
	group: string;
	count: number;
	style: Exclude<GroupStyle, 'tint' | 'border' | 'boxed'>;
	tone: Tone;
	/** The first group of the column (no gap above it). */
	first: boolean;
}): React.ReactElement {
	const label = groupLabel(group, count);
	const common = {
		role: 'separator',
		'aria-label': label,
		'data-testid': 'kanban-group-separator',
		'data-style': style,
		'data-tone': tone,
	} as const;
	if (style === 'bar') {
		return (
			<div
				{...common}
				className={`flex w-full items-center ${GAP_CONTROLS} ${CONTROL_RADIUS} px-2 py-1 text-xs font-semibold ${TONE_PILL[tone]}`}
			>
				<span className="min-w-0 flex-1 truncate">{group}</span>
				<span data-testid="kanban-group-count" className="shrink-0 font-medium">
					{count}
				</span>
			</div>
		);
	}
	if (style === 'gap') {
		return (
			<div
				{...common}
				className={`${first ? '' : 'mt-6'} truncate px-1 text-xs font-semibold text-muted`}
			>
				{group}
			</div>
		);
	}
	if (style === 'pill') {
		return (
			<div {...common} className={`flex items-center ${GAP_CONTROLS} pt-1`}>
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
	if (style === 'divider') {
		return <div {...common} title={label} className={`my-1 border-0 border-t-2 border-dashed ${TONE_BORDER[tone]}`} />;
	}
	return (
		<div {...common} className={`flex items-center ${GAP_CONTROLS} pt-1 text-xs font-medium text-muted`}>
			<span className="min-w-0 max-w-[70%] truncate">{group}</span>
			<span aria-hidden="true" className="h-px min-w-[1rem] flex-1 bg-border" />
		</div>
	);
}

/** A group whose cards sit inside an element of their own: a tinted panel, a coloured left border, or a bordered box. */
function GroupBlock({
	group,
	count,
	style,
	tone,
	dense,
	children,
}: {
	group: string;
	count: number;
	style: 'tint' | 'border' | 'boxed';
	tone: Tone;
	dense: boolean;
	children: React.ReactNode;
}): React.ReactElement {
	const label = groupLabel(group, count);
	const cards = `flex flex-col ${dense ? 'gap-1' : 'gap-2'}`;
	if (style === 'boxed') {
		return (
			<div
				role="group"
				aria-label={label}
				data-testid="kanban-group"
				data-style="boxed"
				data-tone={tone}
				className={`flex flex-col ${CONTROL_RADIUS} border border-border bg-surface`}
			>
				<div
					data-testid="kanban-group-header"
					className={`flex items-center ${GAP_CONTROLS} border-0 border-b border-solid border-border px-2 py-1 text-xs font-semibold text-content`}
				>
					<span aria-hidden="true" className={`inline-block h-2 w-2 shrink-0 ${PILL_RADIUS} ${TONE_DOT[tone]}`} />
					<span className="min-w-0 flex-1 truncate">{group}</span>
					<span className="shrink-0 font-medium text-muted">{count}</span>
				</div>
				<div className={`${cards} p-1`}>{children}</div>
			</div>
		);
	}
	const caption = (
		<div role="separator" aria-label={label} data-testid="kanban-group-separator" data-style={style} data-tone={tone}>
			<span className={`${CAPTION_CLASS} ${style === 'tint' ? 'text-content' : 'text-muted'}`}>{group}</span>
		</div>
	);
	if (style === 'tint') {
		return (
			<div
				data-testid="kanban-group"
				data-style="tint"
				data-tone={tone}
				className={`${cards} ${CONTROL_RADIUS} ${TONE_BG[tone]} p-2`}
			>
				{caption}
				{children}
			</div>
		);
	}
	return (
		<div
			data-testid="kanban-group"
			data-style="border"
			data-tone={tone}
			className={`${cards} border-0 border-l-4 border-solid ${TONE_BORDER[tone]} pl-2`}
		>
			{caption}
			{children}
		</div>
	);
}

/**
 * The cards of a column, in the order of the answer. When the cards carry a `group` (a sort that forms groups), every run of
 * cards of one group, the first one included, is introduced in the group style of the column (`view.groupStyleOverride` wins):
 * a line before the cards (label, bar, gap, pill, divider) or an element around them (tint, border, boxed). Cards without a
 * group are drawn as they are.
 */
export function CardList({
	column,
	view,
	dense = false,
	draggable = true,
	showStatus = false,
}: {
	column: BoardColumnData;
	view: BoardView;
	dense?: boolean;
	draggable?: boolean;
	showStatus?: boolean;
}): React.ReactElement {
	const style: GroupStyle = view.groupStyleOverride ?? column.groupStyle ?? DEFAULT_GROUP_STYLE;
	const counts = new Map<string, number>();
	for (const card of column.cards) {
		if (card.group !== undefined) {
			counts.set(card.group, (counts.get(card.group) ?? 0) + 1);
		}
	}
	const drawCard = (card: BoardCardData): React.ReactElement => (
		<BoardCard
			key={card.id}
			card={card}
			view={view}
			dense={dense}
			draggable={draggable}
			showStatus={showStatus}
		/>
	);
	// Runs of consecutive cards with the same group (undefined = no group).
	const runs: Array<{ group: string | undefined; cards: BoardCardData[] }> = [];
	for (const card of column.cards) {
		const last = runs[runs.length - 1];
		if (last !== undefined && last.group === card.group) {
			last.cards.push(card);
		} else {
			runs.push({ group: card.group, cards: [card] });
		}
	}
	const items: React.ReactElement[] = [];
	let groupIndex = 0;
	runs.forEach((run, index) => {
		if (run.group === undefined) {
			items.push(...run.cards.map(drawCard));
			return;
		}
		const count = counts.get(run.group) ?? 0;
		const tone = groupTone(column, run.group);
		const key = `group-${index}-${run.group}`;
		if (WRAPPING.has(style)) {
			items.push(
				<GroupBlock
					key={key}
					group={run.group}
					count={count}
					style={style as 'tint' | 'border' | 'boxed'}
					tone={tone}
					dense={dense}
				>
					{run.cards.map(drawCard)}
				</GroupBlock>
			);
		} else {
			items.push(
				<GroupSeparator
					key={key}
					group={run.group}
					count={count}
					style={style as Exclude<GroupStyle, 'tint' | 'border' | 'boxed'>}
					tone={tone}
					first={groupIndex === 0}
				/>,
				...run.cards.map(drawCard)
			);
		}
		groupIndex += 1;
	});
	return <>{items}</>;
}
