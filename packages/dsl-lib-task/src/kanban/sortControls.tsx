import { ArrowUpDown, Check } from 'lucide-react';
import React, { useEffect, useRef, useState } from 'react';
import { ChipRow } from '../components/ChipRow.js';
import { useDismiss } from '../useDismiss.js';
import {
	CONTROL_BORDER,
	CONTROL_H,
	CONTROL_RADIUS,
	CONTROL_SQUARE,
	CONTROL_TEXT,
	FIELD_CLASS,
	FOCUS_RING,
	GAP_CONTROLS,
	ICON_SIZE,
	PILL_NEUTRAL_CLASS,
	PILL_RADIUS,
	PILL_TEXT,
} from '../ui/tokens.js';
import { SORT_OPTIONS, sortOption } from './boardModel.js';
import type { ColumnSort, SortChoice } from './boardModel.js';

/** The A/B options of the sort control (row "Board columns: sort control" of the shared dock; `header-menu` otherwise). */
export type SortVariant = 'header-menu' | 'toolbar-select' | 'chips' | 'editor-only' | 'segmented';

export const SORT_VARIANT_OPTIONS: Record<SortVariant, { label: string; hint: string }> = {
	'header-menu': { label: 'Header menu', hint: 'Sort button in each column header' },
	'toolbar-select': { label: 'Toolbar select', hint: 'One select sets every column' },
	chips: { label: 'Chips', hint: 'Sort chips under each header' },
	'editor-only': { label: 'Editor only', hint: 'Badge on the board, change in Configure columns' },
	segmented: { label: 'Segmented', hint: 'Segmented toolbar sets every column' },
};

/** Where the control of a variant sits: in each column, in the toolbar for every column, or nowhere (the editor). */
export const SORT_VARIANT_PLACE: Record<SortVariant, 'column' | 'toolbar' | 'none'> = {
	'header-menu': 'column',
	'toolbar-select': 'toolbar',
	chips: 'column',
	'editor-only': 'none',
	segmented: 'toolbar',
};

/** The value of a control acting on every column when the columns do not share one sort. */
export const MIXED_SORT = '*';
export type ToolbarSortValue = SortChoice | typeof MIXED_SORT;

const MENU_ITEM_CLASS = `flex w-full cursor-pointer items-center ${GAP_CONTROLS} ${CONTROL_RADIUS} border-0 bg-transparent px-2 py-1.5 text-left text-sm text-content hover:bg-muted-bg focus:bg-muted-bg focus:outline-none`;
const PRESSED_CLASS = 'border-primary bg-primary-light text-primary';

/** A small button in a column header opening the menu of the sorts of that column (option header-menu). */
export function SortHeaderMenu({
	columnLabel,
	current,
	busy,
	onPick,
}: {
	columnLabel: string;
	current: ColumnSort | undefined;
	busy: boolean;
	onPick: (choice: SortChoice) => void;
}): React.ReactElement {
	const [open, setOpen] = useState(false);
	const root = useRef<HTMLSpanElement>(null);
	const button = useRef<HTMLButtonElement>(null);
	const items = useRef<Array<HTMLButtonElement | null>>([]);
	const checked = sortOption(current).value;
	const count = SORT_OPTIONS.length;

	useDismiss(root, open, () => setOpen(false));
	useEffect(() => {
		if (open) {
			const index = SORT_OPTIONS.findIndex(option => option.value === checked);
			items.current[index === -1 ? 0 : index]?.focus();
		}
	}, [open, checked]);

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

	return (
		<span ref={root} className="relative -my-1.5 inline-flex shrink-0">
			<button
				ref={button}
				type="button"
				aria-label={`Sort column ${columnLabel}`}
				aria-haspopup="menu"
				aria-expanded={open}
				aria-busy={busy || undefined}
				title={current === undefined ? 'Sort the cards' : `Sorted: ${sortOption(current).label}`}
				disabled={busy}
				onClick={() => setOpen(value => !value)}
				className={`inline-flex ${CONTROL_SQUARE} cursor-pointer items-center justify-center ${CONTROL_RADIUS} border-0 bg-transparent ${current === undefined ? 'text-muted' : 'text-primary'} hover:bg-surface hover:text-content ${FOCUS_RING} disabled:cursor-not-allowed disabled:opacity-40`}
			>
				<ArrowUpDown size={ICON_SIZE} aria-hidden="true" />
			</button>
			{open ? (
				<ul
					role="menu"
					aria-label={`Sort cards of ${columnLabel}`}
					onKeyDown={onKeyDown}
					className={`absolute right-0 top-full z-30 m-0 mt-1 min-w-[11rem] list-none ${CONTROL_RADIUS} border border-border bg-surface p-1 font-normal shadow-lg`}
				>
					{SORT_OPTIONS.map((option, index) => (
						<li key={option.value} role="none">
							<button
								ref={element => {
									items.current[index] = element;
								}}
								type="button"
								role="menuitemradio"
								aria-checked={option.value === checked}
								tabIndex={-1}
								onClick={() => {
									setOpen(false);
									button.current?.focus();
									if (option.value !== checked) {
										onPick(option.value);
									}
								}}
								className={MENU_ITEM_CLASS}
							>
								<span aria-hidden="true" className="inline-flex w-4 shrink-0 justify-center">
									{option.value === checked ? <Check size={ICON_SIZE} /> : null}
								</span>
								{option.label}
							</button>
						</li>
					))}
				</ul>
			) : null}
		</span>
	);
}

/** One chip per sort under a column header, the active one pressed (option chips). */
export function SortChips({
	columnLabel,
	current,
	busy,
	onPick,
}: {
	columnLabel: string;
	current: ColumnSort | undefined;
	busy: boolean;
	onPick: (choice: SortChoice) => void;
}): React.ReactElement {
	const checked = sortOption(current).value;
	return (
		<div role="group" aria-label={`Sort cards of ${columnLabel}`} aria-busy={busy || undefined}>
			<ChipRow
				items={SORT_OPTIONS.map(option => {
					const pressed = option.value === checked;
					return (
						<button
							key={option.value}
							type="button"
							aria-pressed={pressed}
							title={option.label}
							disabled={busy}
							onClick={() => {
								if (!pressed) {
									onPick(option.value);
								}
							}}
							className={`${PILL_NEUTRAL_CLASS} cursor-pointer px-2 text-xs ${pressed ? PRESSED_CLASS : 'hover:bg-muted-bg'}`}
						>
							{option.shortLabel}
						</button>
					);
				})}
			/>
		</div>
	);
}

/** A read-only badge naming the sort of a column; nothing for the default order (option editor-only). */
export function SortBadge({ sort }: { sort: ColumnSort | undefined }): React.ReactElement | null {
	if (sort === undefined) {
		return null;
	}
	return (
		<span
			data-testid="kanban-sort-badge"
			title={`Cards sorted: ${sortOption(sort).label} (change it in Configure columns)`}
			className={`inline-flex shrink-0 items-center ${PILL_RADIUS} bg-surface px-2 text-xs font-medium text-muted`}
		>
			{sortOption(sort).badge}
		</span>
	);
}

/** One select in the board toolbar that sets the sort of every column (option toolbar-select). */
export function ToolbarSortSelect({
	value,
	busy,
	onPick,
}: {
	value: ToolbarSortValue;
	busy: boolean;
	onPick: (choice: SortChoice) => void;
}): React.ReactElement {
	return (
		<label className={`inline-flex items-center ${GAP_CONTROLS} ${CONTROL_TEXT} text-content`}>
			<span className={PILL_TEXT}>Sort cards by</span>
			<select
				value={value}
				disabled={busy}
				aria-busy={busy || undefined}
				onChange={event => {
					const next = event.target.value;
					if (next !== MIXED_SORT) {
						onPick(next as SortChoice);
					}
				}}
				className={`${FIELD_CLASS} cursor-pointer`}
			>
				{/* Only shows that the columns differ: picking it would change nothing. */}
				<option value={MIXED_SORT} disabled>
					Per column (as configured)
				</option>
				{SORT_OPTIONS.map(option => (
					<option key={option.value} value={option.value}>
						{option.label}
					</option>
				))}
			</select>
		</label>
	);
}

/** One segmented control in the board toolbar that sets the sort of every column; none pressed when they differ (option segmented). */
export function ToolbarSegmented({
	value,
	busy,
	onPick,
}: {
	value: ToolbarSortValue;
	busy: boolean;
	onPick: (choice: SortChoice) => void;
}): React.ReactElement {
	return (
		<div
			role="group"
			aria-label="Sort cards of every column"
			aria-busy={busy || undefined}
			className={`inline-flex ${CONTROL_H} max-w-[calc(100vw-6rem)] items-stretch overflow-x-auto ${CONTROL_RADIUS} ${CONTROL_BORDER} bg-surface`}
		>
			{SORT_OPTIONS.map((option, index) => {
				const pressed = option.value === value;
				return (
					<button
						key={option.value}
						type="button"
						aria-pressed={pressed}
						title={option.label}
						disabled={busy}
						onClick={() => {
							if (!pressed) {
								onPick(option.value);
							}
						}}
						className={`shrink-0 cursor-pointer border-0 px-3 ${PILL_TEXT} ${FOCUS_RING} disabled:cursor-not-allowed disabled:opacity-60 ${index > 0 ? 'border-l border-solid border-border' : ''} ${pressed ? 'bg-primary-light text-primary' : 'bg-transparent text-content hover:bg-muted-bg'}`}
					>
						{option.shortLabel}
					</button>
				);
			})}
		</div>
	);
}
