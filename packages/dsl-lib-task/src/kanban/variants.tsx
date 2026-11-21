import React, { useEffect, useRef, useState } from 'react';
import { CONTROL_RADIUS, FOCUS_RING, GAP_BLOCKS, GAP_CONTROLS, PILL_RADIUS } from '../ui/tokens.js';
import { TONE_DOT, toneOf } from '../tones.js';
import { BoardCard, CardList, ColumnHeader, DropAreas, EmptyColumn, zoneClass } from './BoardParts.js';
import type { BoardView } from './BoardParts.js';
import { laneKeyOf, lanesOf } from './boardModel.js';
import type { BoardColumnData } from './boardModel.js';

/** Least width of a column (rem); the columns share the width down to it, then the strip scrolls. */
export const COLUMN_MIN_REM = 13;
/** Gap between columns, in rem (gap-4). */
const GAP_REM = 1;
/**
 * The cards of a column scroll INSIDE the column past this height, so the header and the drop areas (which sit above the cards)
 * are never pushed out of the window by a long column.
 */
const CARDS_SCROLL_CLASS = 'max-h-[calc(100vh-16rem)] min-h-[3rem] overflow-y-auto pr-1';

/** The status a whole column stands for when it holds exactly one (a drop anywhere on it sets that status); none for a group. */
function onlyStatus(column: BoardColumnData): string | undefined {
	return column.statuses.length === 1 ? column.statuses[0]!.name : undefined;
}

/**
 * The strip the columns live in: never wider than its container, it scrolls sideways when the columns at their least
 * width do not fit, and says so (a scrollbar can be an overlay that stays invisible until used).
 */
function ScrollStrip({
	children,
	className = '',
}: {
	children: React.ReactNode;
	className?: string;
}): React.ReactElement {
	const strip = useRef<HTMLDivElement>(null);
	const [overflowing, setOverflowing] = useState(false);
	useEffect(() => {
		const element = strip.current;
		if (element === null) {
			return undefined;
		}
		const measure = (): void => setOverflowing(element.scrollWidth > element.clientWidth + 1);
		measure();
		if (typeof ResizeObserver === 'undefined') {
			return undefined;
		}
		const observer = new ResizeObserver(measure);
		observer.observe(element);
		return () => observer.disconnect();
	});
	return (
		<div className="flex min-w-0 max-w-full flex-col gap-1">
			{overflowing ? (
				<p data-testid="kanban-scroll-hint" className="m-0 text-xs text-muted">
					More columns to the right: scroll sideways.
				</p>
			) : null}
			<div
				ref={strip}
				data-testid="kanban-strip"
				className={`min-w-0 max-w-full overflow-x-auto pb-2 ${className}`}
			>
				{children}
			</div>
		</div>
	);
}

/** The shell of one column: header, the drop areas (while dragging), cards or the quiet "No tasks". */
function Column({
	column,
	view,
	dense = false,
	className = '',
}: {
	column: BoardColumnData;
	view: BoardView;
	dense?: boolean;
	className?: string;
}): React.ReactElement {
	const only = onlyStatus(column);
	const zone = only === undefined ? undefined : view.zone(only);
	const grouped = column.statuses.length > 1;
	return (
		<section
			data-testid={`kanban-column-${column.key}`}
			data-status={only ?? column.key}
			data-terminal={column.terminal ? 'true' : 'false'}
			data-tone={toneOf(column.tone)}
			aria-label={column.label}
			{...(zone ?? {})}
			className={`flex min-w-0 flex-col gap-2 p-1 ${zoneClass(zone?.['data-drop-target'] === 'true')} ${className}`}
		>
			<ColumnHeader column={column} control={view.headerControl?.(column)} />
			{view.belowHeader?.(column)}
			<DropAreas statuses={column.statuses} view={view} />
			{column.cards.length === 0 ? (
				<EmptyColumn />
			) : (
				<div className={`flex flex-col ${dense ? 'gap-1' : 'gap-2'} ${CARDS_SCROLL_CLASS}`}>
					<CardList column={column} view={view} dense={dense} showStatus={grouped} />
				</div>
			)}
		</section>
	);
}

/** Classic board: the columns side by side, scrolling sideways when they do not fit. */
export function ColumnsLayout({ view, dense = false }: { view: BoardView; dense?: boolean }): React.ReactElement {
	return (
		<ScrollStrip>
			<div className={`flex items-start ${GAP_BLOCKS}`}>
				{view.columns.map(column => (
					<Column
						key={column.key}
						column={column}
						view={view}
						dense={dense}
						className={dense ? 'min-w-[15rem] flex-1' : 'min-w-[13rem] flex-1'}
					/>
				))}
			</div>
		</ScrollStrip>
	);
}

/** Dense one-line cards, counts in the headers. */
export function CompactLayout({ view }: { view: BoardView }): React.ReactElement {
	return <ColumnsLayout view={view} dense />;
}

/** Rows by effective priority, columns by status. The drop areas sit under the column headers, above the lanes. */
export function SwimlanesLayout({ view }: { view: BoardView }): React.ReactElement {
	const lanes = lanesOf(view.columns);
	const count = view.columns.length;
	const grid = { gridTemplateColumns: `repeat(${count}, minmax(${COLUMN_MIN_REM}rem, 1fr))` };
	const minWidth = `${count * COLUMN_MIN_REM + Math.max(count - 1, 0) * GAP_REM}rem`;
	return (
		<ScrollStrip>
			<div style={{ minWidth }} className={`flex flex-col ${GAP_BLOCKS}`}>
				<div className={`grid ${GAP_BLOCKS}`} style={grid}>
					{view.columns.map(column => (
						<div key={column.key} className="flex min-w-0 flex-col gap-1">
							<ColumnHeader column={column} control={view.headerControl?.(column)} />
							{view.belowHeader?.(column)}
							<DropAreas statuses={column.statuses} view={view} />
						</div>
					))}
				</div>
				<div className={`flex flex-col ${GAP_BLOCKS} max-h-[calc(100vh-18rem)] overflow-y-auto pr-1`}>
					{lanes.map(lane => (
						<section
							key={lane.key}
							data-testid="kanban-lane"
							data-lane={lane.key}
							aria-label={`Priority ${lane.label}`}
							className="flex flex-col gap-2"
						>
							<h3 className="m-0 text-xs font-semibold text-muted">{lane.label}</h3>
							<div className={`grid ${GAP_BLOCKS}`} style={grid}>
								{view.columns.map(column => {
									const only = onlyStatus(column);
									const zone = only === undefined ? undefined : view.zone(only);
									const cards = column.cards.filter(card => laneKeyOf(card) === lane.key);
									return (
										<div
											key={column.key}
											data-testid={`kanban-cell-${lane.key}-${column.key}`}
											data-status={only ?? column.key}
											{...(zone ?? {})}
											className={`flex min-h-[2.5rem] flex-col gap-2 p-1 ${zoneClass(zone?.['data-drop-target'] === 'true')}`}
										>
											{cards.map(card => (
												<BoardCard
													key={card.id}
													card={card}
													view={view}
													showStatus={column.statuses.length > 1}
												/>
											))}
										</div>
									);
								})}
							</div>
						</section>
					))}
				</div>
			</div>
		</ScrollStrip>
	);
}

/**
 * One expanded column; the others are vertical rails that open on click. While a card is dragged every rail opens into a
 * panel with its drop areas (a rail is too narrow to name the statuses it holds).
 */
export function RailsLayout({ view }: { view: BoardView }): React.ReactElement {
	const [chosen, setChosen] = useState<string | undefined>(undefined);
	const expanded = view.columns.some(column => column.key === chosen) ? chosen : view.columns[0]?.key;
	return (
		<ScrollStrip>
			<div className={`flex items-stretch ${GAP_BLOCKS}`}>
				{view.columns.map(column => {
					if (column.key === expanded) {
						return <Column key={column.key} column={column} view={view} className="min-w-[16rem] flex-1" />;
					}
					if (view.dragging !== null) {
						return (
							<section
								key={column.key}
								data-testid={`kanban-rail-open-${column.key}`}
								aria-label={column.label}
								className={`flex w-44 shrink-0 flex-col gap-2 p-1 ${CONTROL_RADIUS} border border-border bg-muted-bg`}
							>
								<ColumnHeader column={column} />
								<DropAreas statuses={column.statuses} view={view} />
							</section>
						);
					}
					const only = onlyStatus(column);
					const zone = only === undefined ? undefined : view.zone(only);
					const tone = toneOf(column.tone);
					return (
						<button
							key={column.key}
							type="button"
							data-testid={`kanban-rail-${column.key}`}
							aria-label={`Show ${column.label} (${column.count})`}
							onClick={() => setChosen(column.key)}
							{...(zone ?? {})}
							className={`flex w-12 shrink-0 cursor-pointer flex-col items-center ${GAP_CONTROLS} ${CONTROL_RADIUS} border border-border bg-muted-bg px-1 py-3 text-sm text-content ${FOCUS_RING} ${zone?.['data-drop-target'] === 'true' ? 'bg-primary-light ring-2 ring-primary' : ''}`}
						>
							<span
								aria-hidden="true"
								className={`inline-block h-2 w-2 shrink-0 ${PILL_RADIUS} ${TONE_DOT[tone]}`}
							/>
							<span className="text-xs font-semibold">{column.count}</span>
							<span className="font-medium [writing-mode:vertical-rl]">{column.label}</span>
						</button>
					);
				})}
			</div>
		</ScrollStrip>
	);
}

/** Column tabs and the list of the selected one; moves go through the "Move to" menu (no drag: good on a phone). */
export function TabsLayout({ view }: { view: BoardView }): React.ReactElement {
	const [chosen, setChosen] = useState<string | undefined>(undefined);
	const active = view.columns.find(column => column.key === chosen) ?? view.columns[0];
	if (active === undefined) {
		return <EmptyColumn />;
	}
	// The sort control of the shown column sits above its cards (a tab has no header).
	const controls = [view.headerControl?.(active), view.belowHeader?.(active)]
		.filter(node => node !== null && node !== undefined && node !== false)
		.map((node, index) => <React.Fragment key={index}>{node}</React.Fragment>);
	return (
		<div className="flex flex-col gap-2">
			<div role="tablist" aria-label="Statuses" className={`flex ${GAP_CONTROLS} overflow-x-auto pb-1`}>
				{view.columns.map(column => {
					const selected = column.key === active.key;
					return (
						<button
							key={column.key}
							type="button"
							role="tab"
							id={`kanban-tab-${column.key}`}
							aria-selected={selected}
							aria-controls="kanban-tabpanel"
							onClick={() => setChosen(column.key)}
							className={`inline-flex h-8 shrink-0 cursor-pointer items-center ${GAP_CONTROLS} ${PILL_RADIUS} border px-3 text-sm font-medium ${FOCUS_RING} ${selected ? 'border-primary bg-primary-light text-primary' : 'border-border bg-surface text-content'}`}
						>
							{column.label}
							<span className="text-xs">{column.count}</span>
						</button>
					);
				})}
			</div>
			<div
				role="tabpanel"
				id="kanban-tabpanel"
				aria-labelledby={`kanban-tab-${active.key}`}
				data-testid={`kanban-column-${active.key}`}
				data-status={onlyStatus(active) ?? active.key}
				className="flex flex-col gap-2"
			>
				{controls.length > 0 ? (
					<div className={`flex flex-wrap items-center ${GAP_CONTROLS}`}>{controls}</div>
				) : null}
				{(active.hiddenCount ?? 0) > 0 ? (
					<p className="m-0 text-xs text-muted">{`+${active.hiddenCount} hidden`}</p>
				) : null}
				{active.cards.length === 0 ? (
					<EmptyColumn />
				) : (
					<CardList column={active} view={view} draggable={false} showStatus={active.statuses.length > 1} />
				)}
			</div>
		</div>
	);
}
