import React, { useEffect, useRef, useState } from 'react';
import { GAP_BLOCKS } from '../ui/tokens.js';
import { toneOf } from '../tones.js';
import { CardList, ColumnHeader, DropAreas, EmptyColumn } from './BoardParts.js';
import type { BoardView } from './BoardParts.js';
import type { BoardColumnData } from './boardModel.js';

/**
 * The cards of a column scroll INSIDE the column past this height, so the header (which sits above the cards) is never pushed
 * out of the window by a long column.
 */
const CARDS_SCROLL_CLASS = 'max-h-[calc(100vh-16rem)] min-h-[3rem] overflow-y-auto pr-1';

/**
 * The strip the columns live in: never wider than its container, it scrolls sideways when the columns at their least
 * width do not fit, and says so (a scrollbar can be an overlay that stays invisible until used).
 */
function ScrollStrip({ children }: { children: React.ReactNode }): React.ReactElement {
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
			<div ref={strip} data-testid="kanban-strip" className="min-w-0 max-w-full overflow-x-auto pb-2">
				{children}
			</div>
		</div>
	);
}

/**
 * One column: header, then its body (the cards or the quiet "No tasks"). While a card is dragged the body takes the rest of
 * the column's height (the columns stretch to the tallest one), its cards are dimmed and the drop bands cover it.
 */
function Column({ column, view }: { column: BoardColumnData; view: BoardView }): React.ReactElement {
	const only = column.statuses.length === 1 ? column.statuses[0]!.name : undefined;
	const dragging = view.dragging !== null;
	return (
		<section
			data-testid={`kanban-column-${column.key}`}
			data-status={only ?? column.key}
			data-terminal={column.terminal ? 'true' : 'false'}
			data-tone={toneOf(column.tone)}
			aria-label={column.label}
			className="flex min-w-[13rem] flex-1 flex-col gap-2 p-1"
		>
			<ColumnHeader column={column} control={view.headerControl?.(column)} />
			{view.belowHeader?.(column)}
			<div
				data-testid="kanban-column-body"
				className={`relative flex flex-1 flex-col ${dragging ? 'min-h-[8rem]' : 'min-h-0'}`}
			>
				<div
					data-testid="kanban-column-cards"
					className={`flex flex-col gap-2 ${CARDS_SCROLL_CLASS} ${dragging ? 'opacity-40' : ''}`}
				>
					{column.cards.length === 0 ? (
						<EmptyColumn />
					) : (
						<CardList column={column} view={view} showStatus={column.statuses.length > 1} />
					)}
				</div>
				<DropAreas statuses={column.statuses} view={view} />
			</div>
		</section>
	);
}

/** The board: the columns side by side, scrolling sideways when they do not fit. */
export function BoardColumns({ view }: { view: BoardView }): React.ReactElement {
	return (
		<ScrollStrip>
			<div className={`flex ${view.dragging === null ? 'items-start' : 'items-stretch'} ${GAP_BLOCKS}`}>
				{view.columns.map(column => (
					<Column key={column.key} column={column} view={view} />
				))}
			</div>
		</ScrollStrip>
	);
}
