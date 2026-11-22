import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, GripVertical, Plus, Trash2 } from 'lucide-react';
import React, { useEffect, useRef, useState } from 'react';
import { Notice } from '../components/Notice.js';
import { Dialog } from '../ui/Dialog.js';
import { TONE_DOT, toneOf } from '../tones.js';
import {
	BUTTON_PRIMARY_CLASS,
	CONTROL_BORDER,
	CONTROL_H,
	CONTROL_RADIUS,
	CONTROL_TEXT,
	FIELD_CLASS,
	FOCUS_RING,
	GAP_BLOCKS,
	GAP_CONTROLS,
	ICON_BUTTON_CLASS,
	ICON_SIZE,
	PILL_RADIUS,
	PILL_TEXT,
} from '../ui/tokens.js';
import { FINISHED_FOR_OPTIONS, isColumnSort, isFinishedFor, SORT_OPTIONS, sortOption } from './boardModel.js';
import type { BoardConfigBody, BoardLayoutData, BoardStatusData, ColumnSort, FinishedChoice } from './boardModel.js';

export const FINISHED_HINT =
	'Applies to tasks in a finished (terminal) status, counted from the moment they became finished.';

/** How long a moved status chip stays ringed, in milliseconds. */
export const LANDED_MS = 1500;

export interface ColumnsEditorProps {
	/** The stored layout (or one column per status) and every status of the project. */
	layout: BoardLayoutData;
	/** A save or a reset is running. */
	busy: boolean;
	/** The route's message and hint of the last refused save or reset; null when there is none. */
	error: string | null;
	/** The columns to store, their statuses in the order arranged; `sort` is left out for the default order. */
	onSave: (body: BoardConfigBody) => void;
	onReset: () => void;
	onCancel: () => void;
}

interface DraftColumn {
	/** Stable identity while editing (names change). */
	id: number;
	name: string;
	statuses: string[];
	sort?: ColumnSort;
}

/** Where a dragged status chip would land: before `index` of the statuses of `column` (as drawn), shown on the chip `anchor`. */
interface InsertPoint {
	column: number;
	index: number;
	anchor: string;
	side: 'before' | 'after';
}

/** The value of "Hide (no column)" in the select of a chip: the status leaves every column. */
const HIDE = '__hide__';
const SECONDARY_BUTTON_CLASS = `inline-flex ${CONTROL_H} items-center justify-center ${GAP_CONTROLS} ${CONTROL_RADIUS} ${CONTROL_BORDER} bg-surface px-3 ${PILL_TEXT} text-content hover:bg-muted-bg ${FOCUS_RING} disabled:cursor-not-allowed disabled:opacity-60`;
/** The small square buttons inside a chip (same height as the select of the chip). */
const CHIP_BUTTON_CLASS = `inline-flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center ${CONTROL_RADIUS} border-0 bg-transparent text-muted hover:bg-muted-bg hover:text-content ${FOCUS_RING} disabled:cursor-not-allowed disabled:opacity-40`;

/** A name for a new column that no other column has. */
export function freshColumnName(taken: readonly string[]): string {
	const lower = new Set(taken.map(name => name.trim().toLowerCase()));
	let candidate = 'New column';
	for (let n = 2; lower.has(candidate.toLowerCase()); n += 1) {
		candidate = `New column ${n}`;
	}
	return candidate;
}

const shownName = (name: string): string => (name.trim() === '' ? '(unnamed column)' : name);

/**
 * The draft with `status` put in column `target` before `index` (an index of the statuses as drawn, the status itself
 * included when it is already there; absent = at the end), or in no column (hidden).
 */
export function placeStatus<T extends { id: number; statuses: string[] }>(
	draft: readonly T[],
	status: string,
	target: number | typeof HIDE,
	index?: number
): T[] {
	return draft.map(column => {
		const without = column.statuses.filter(name => name !== status);
		if (column.id !== target) {
			return without.length === column.statuses.length ? column : { ...column, statuses: without };
		}
		let at = index ?? without.length;
		const was = column.statuses.indexOf(status);
		// The index counts the status at its old place: the places after it move one back once it is lifted.
		if (index !== undefined && was !== -1 && was < index) {
			at -= 1;
		}
		at = Math.max(0, Math.min(at, without.length));
		return { ...column, statuses: [...without.slice(0, at), status, ...without.slice(at)] };
	});
}

/** The parts of a draft that are saved, as one string (to tell whether the user changed anything). */
function draftSnapshot(draft: readonly DraftColumn[], finished: FinishedChoice): string {
	return JSON.stringify([draft.map(column => [column.name, column.statuses, column.sort ?? '']), finished]);
}

/** What the live region says once `status` was placed in `draft`. */
function landedText(draft: readonly DraftColumn[], status: string): string {
	const column = draft.find(entry => entry.statuses.includes(status));
	if (column === undefined) {
		return `${status} is now hidden (no column)`;
	}
	const position = column.statuses.indexOf(status) + 1;
	return `${status} is now in column ${shownName(column.name)}, position ${position} of ${column.statuses.length}`;
}

/**
 * The editor of the board columns ("Configure columns"): add, rename, delete and reorder columns (drag the handle, or the up and
 * down buttons), and put every status in a column at an exact place: drag its chip before or after another chip (an accent bar
 * shows where it lands; dropping on the body of a column appends), use the arrows of the chip (or Left and Right on a focused
 * chip), or pick the column in its select. The order of the statuses in a column IS their order on the board. "Hide (no
 * column)" takes a status out of every column: it is not on the board and the "Add status" select of every column shows it
 * again. A moved status is ringed for a moment, a polite live region says where it is, and the "Board preview" at the top
 * shows the whole board as it will be. The rules (names, a status in one column only) are the server's and a refused save
 * shows its message and hint; only "a column holds at least one status" is also said before the request (a refused empty
 * column read as an untested editor).
 */
export function ColumnsEditor({
	layout,
	busy,
	error,
	onSave,
	onReset,
	onCancel,
}: ColumnsEditorProps): React.ReactElement {
	const counter = useRef(layout.columns.length);
	const [finished, setFinished] = useState<FinishedChoice>(layout.finishedFor ?? 'none');
	const [draft, setDraft] = useState<DraftColumn[]>(() =>
		layout.columns.map((column, index) => ({
			id: index,
			name: column.name,
			statuses: [...column.statuses],
			...(column.sort === undefined ? {} : { sort: column.sort }),
		}))
	);
	// What the draft was when the dialog opened: closing asks first once it differs (a live refresh of the layout does not reset it).
	const opened = useRef(draftSnapshot(draft, layout.finishedFor ?? 'none'));
	const dirty = draftSnapshot(draft, finished) !== opened.current;
	const drag = useRef<{ kind: 'column'; id: number } | { kind: 'status'; name: string } | null>(null);
	const [overKey, setOverKey] = useState<string | null>(null);
	// Where the dragged chip would land: state for the accent bar, a ref for the drop handler (it may run before a render).
	const [insert, setInsertState] = useState<InsertPoint | null>(null);
	const insertRef = useRef<InsertPoint | null>(null);
	const setInsert = (point: InsertPoint | null): void => {
		insertRef.current = point;
		setInsertState(point);
	};
	// The status just placed (ringed for LANDED_MS) and what the live region says about it.
	const [landed, setLanded] = useState<string | null>(null);
	const [announcement, setAnnouncement] = useState('');
	const landedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	useEffect(
		() => () => {
			if (landedTimer.current !== null) {
				clearTimeout(landedTimer.current);
			}
		},
		[]
	);
	// The control to focus again once a keyboard move redrew the chips (moving a node in the DOM drops its focus).
	const refocus = useRef<{ status: string; label: string | null } | null>(null);
	const root = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const target = refocus.current;
		if (target === null || root.current === null) {
			return;
		}
		refocus.current = null;
		// Compared as attributes, not in a selector: a status name may hold any character.
		const chipElement = Array.from(
			root.current.querySelectorAll<HTMLElement>('[data-testid^="columns-editor-chip-"]')
		).find(element => element.getAttribute('data-testid') === `columns-editor-chip-${target.status}`);
		const button =
			target.label === null || chipElement === undefined
				? undefined
				: Array.from(chipElement.querySelectorAll('button')).find(
						element => element.getAttribute('aria-label') === target.label
					);
		(button !== undefined && !button.disabled ? button : chipElement)?.focus();
	}, [draft]);
	// The column just added: its name field takes the focus (name selected) as soon as it is drawn, wherever the list was scrolled.
	const focusId = useRef<number | null>(null);

	const byName = new Map<string, BoardStatusData>(layout.allStatuses.map(status => [status.name, status]));
	const placed = new Set(draft.flatMap(column => column.statuses));
	// Statuses in no column, in the project order: not on the board.
	const hidden = layout.allStatuses.filter(status => !placed.has(status.name)).map(status => status.name);

	// The route refuses a column with no status: said here, before the request, so the user never learns it from a failed save.
	const empty = draft.filter(column => column.statuses.length === 0);

	const addColumn = (): void => {
		counter.current += 1;
		focusId.current = counter.current;
		setDraft(current => [
			...current,
			{ id: counter.current, name: freshColumnName(current.map(column => column.name)), statuses: [] },
		]);
	};
	const rename = (id: number, name: string): void =>
		setDraft(current => current.map(column => (column.id === id ? { ...column, name } : column)));
	const setSort = (id: number, value: string): void =>
		setDraft(current =>
			current.map(column => {
				if (column.id !== id) {
					return column;
				}
				const { sort: _previous, ...rest } = column;
				return isColumnSort(value) ? { ...rest, sort: value } : rest;
			})
		);
	const remove = (id: number): void => setDraft(current => current.filter(column => column.id !== id));
	const moveBy = (id: number, delta: -1 | 1): void =>
		setDraft(current => {
			const from = current.findIndex(column => column.id === id);
			const to = from + delta;
			if (from === -1 || to < 0 || to >= current.length) {
				return current;
			}
			const next = [...current];
			const [item] = next.splice(from, 1);
			next.splice(to, 0, item!);
			return next;
		});
	const moveBefore = (id: number, targetId: number): void =>
		setDraft(current => {
			const from = current.findIndex(column => column.id === id);
			const to = current.findIndex(column => column.id === targetId);
			if (from === -1 || to === -1 || from === to) {
				return current;
			}
			const next = [...current];
			const [item] = next.splice(from, 1);
			next.splice(to, 0, item!);
			return next;
		});

	/** Puts a status in a column (at `index`, else at the end) or in none (hidden), then says where it landed. */
	const assign = (status: string, target: number | typeof HIDE, index?: number): void => {
		const next = placeStatus(draft, status, target, index);
		setDraft(next);
		setAnnouncement(landedText(next, status));
		setLanded(target === HIDE ? null : status);
		if (landedTimer.current !== null) {
			clearTimeout(landedTimer.current);
		}
		landedTimer.current = setTimeout(() => {
			landedTimer.current = null;
			setLanded(null);
		}, LANDED_MS);
	};
	/** Moves a status one place earlier or later inside its column (the keyboard way); the focus stays where it was. */
	const shift = (status: string, column: DraftColumn, delta: -1 | 1, label: string | null): void => {
		const from = column.statuses.indexOf(status);
		const to = from + delta;
		if (from === -1 || to < 0 || to >= column.statuses.length) {
			return;
		}
		refocus.current = { status, label };
		// An index of the statuses as drawn: one later = before the one after the next.
		assign(status, column.id, delta < 0 ? to : to + 1);
	};

	const endDrag = (): void => {
		drag.current = null;
		setOverKey(null);
		setInsert(null);
	};

	const chip = (status: string, column: DraftColumn, index: number): React.ReactElement => {
		const info = byName.get(status);
		const last = column.statuses.length - 1;
		const earlier = `Move ${status} earlier in ${shownName(column.name)}`;
		const later = `Move ${status} later in ${shownName(column.name)}`;
		const bar = insert !== null && insert.anchor === status ? insert.side : null;
		return (
			<span
				key={status}
				role="listitem"
				tabIndex={0}
				aria-label={`${status}, position ${index + 1} of ${column.statuses.length}`}
				aria-keyshortcuts="ArrowLeft ArrowRight"
				data-testid={`columns-editor-chip-${status}`}
				{...(landed === status ? { 'data-recent': 'true' } : {})}
				draggable
				onKeyDown={event => {
					// Only the chip itself: the arrows of its select move inside the select.
					if (event.target !== event.currentTarget) {
						return;
					}
					if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
						event.preventDefault();
						shift(status, column, event.key === 'ArrowLeft' ? -1 : 1, null);
					}
				}}
				onDragStart={event => {
					drag.current = { kind: 'status', name: status };
					event.dataTransfer?.setData('text/plain', status);
					if (event.dataTransfer) {
						event.dataTransfer.effectAllowed = 'move';
					}
				}}
				onDragEnd={endDrag}
				onDragOver={event => {
					// A dragged column goes on to the column under the chip.
					if (drag.current?.kind !== 'status') {
						return;
					}
					event.preventDefault();
					event.stopPropagation();
					const rect = event.currentTarget.getBoundingClientRect();
					const after = typeof event.clientX === 'number' && event.clientX > rect.left + rect.width / 2;
					setOverKey(`col-${column.id}`);
					const point: InsertPoint = {
						column: column.id,
						index: after ? index + 1 : index,
						anchor: status,
						side: after ? 'after' : 'before',
					};
					const previous = insertRef.current;
					if (
						previous === null ||
						previous.anchor !== point.anchor ||
						previous.side !== point.side ||
						previous.column !== point.column
					) {
						setInsert(point);
					}
				}}
				className={`relative inline-flex min-h-8 min-w-0 max-w-full cursor-grab flex-wrap items-center py-0.5 sm:h-8 sm:flex-nowrap sm:py-0 ${GAP_CONTROLS} ${PILL_RADIUS} ${CONTROL_BORDER} bg-surface pl-3 pr-1 ${CONTROL_TEXT} text-content ${FOCUS_RING} ${landed === status ? 'ring-2 ring-primary' : ''}`}
			>
				{bar !== null ? (
					<span
						aria-hidden="true"
						data-testid="columns-editor-insert"
						data-side={bar}
						className={`pointer-events-none absolute inset-y-0 ${bar === 'before' ? '-left-1.5' : '-right-1.5'} w-1 ${PILL_RADIUS} bg-primary`}
					/>
				) : null}
				<span
					aria-hidden="true"
					className={`inline-block h-2 w-2 shrink-0 ${PILL_RADIUS} ${TONE_DOT[toneOf(info?.tone)]}`}
				/>
				<span className="min-w-0 flex-1 truncate sm:flex-none">{status}</span>
				<button
					type="button"
					aria-label={earlier}
					title="Move earlier"
					disabled={busy || index === 0}
					onClick={() => shift(status, column, -1, earlier)}
					className={CHIP_BUTTON_CLASS}
				>
					<ChevronLeft size={ICON_SIZE} aria-hidden="true" />
				</button>
				<button
					type="button"
					aria-label={later}
					title="Move later"
					disabled={busy || index === last}
					onClick={() => shift(status, column, 1, later)}
					className={CHIP_BUTTON_CLASS}
				>
					<ChevronRight size={ICON_SIZE} aria-hidden="true" />
				</button>
				<select
					aria-label={`Column of status ${status}`}
					value={String(column.id)}
					onChange={event => {
						const value = event.target.value;
						assign(status, value === HIDE ? HIDE : Number(value));
					}}
					className={`h-6 w-full min-w-0 truncate sm:w-auto sm:max-w-[8rem] ${CONTROL_RADIUS} border-0 bg-muted-bg px-1 text-xs text-content ${FOCUS_RING}`}
				>
					{draft.map(entry => (
						<option key={entry.id} value={String(entry.id)}>
							{shownName(entry.name)}
						</option>
					))}
					<option value={HIDE}>Hide (no column)</option>
				</select>
			</span>
		);
	};

	/** Props that make a column accept a dragged status chip (appended, unless a chip showed another place) or a dragged column (before it). */
	const dropOn = (key: string, column: DraftColumn): React.HTMLAttributes<HTMLElement> => ({
		onDragOver: event => {
			const dragged = drag.current;
			if (dragged === null) {
				return;
			}
			event.preventDefault();
			setOverKey(key);
			if (dragged.kind === 'status') {
				// Over the body of the column (not a chip): the end of the column.
				const lastStatus = column.statuses[column.statuses.length - 1];
				const point: InsertPoint | null =
					lastStatus === undefined
						? null
						: { column: column.id, index: column.statuses.length, anchor: lastStatus, side: 'after' };
				const previous = insertRef.current;
				if (
					point === null
						? previous !== null
						: previous === null || previous.anchor !== point.anchor || previous.side !== point.side
				) {
					setInsert(point);
				}
			}
		},
		onDragLeave: event => {
			if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) {
				setOverKey(current => (current === key ? null : current));
				if (insertRef.current?.column === column.id) {
					setInsert(null);
				}
			}
		},
		onDrop: event => {
			const dragged = drag.current;
			const point = insertRef.current;
			endDrag();
			if (dragged === null) {
				return;
			}
			event.preventDefault();
			if (dragged.kind === 'status') {
				assign(dragged.name, column.id, point !== null && point.column === column.id ? point.index : undefined);
			} else {
				moveBefore(dragged.id, column.id);
			}
		},
	});

	const highlight = (key: string): string => (overKey === key ? 'ring-2 ring-primary bg-primary-light' : '');

	return (
		<Dialog
			title="Configure columns"
			testId="columns-editor"
			size="md"
			dirty={dirty}
			busy={busy}
			onClose={onCancel}
			alert={error !== null ? <Notice variant="danger" label={error} /> : undefined}
			footer={({ requestClose }) => (
				<>
					<button type="button" onClick={addColumn} disabled={busy} className={SECONDARY_BUTTON_CLASS}>
						<Plus size={ICON_SIZE} aria-hidden="true" />
						Add column
					</button>
					<span className="flex-1" />
					<button
						type="button"
						onClick={onReset}
						disabled={busy || layout.isDefault}
						title={
							layout.isDefault
								? 'The board already has one column per status'
								: 'Back to one column per status'
						}
						className={SECONDARY_BUTTON_CLASS}
					>
						Reset to default
					</button>
					<button type="button" onClick={requestClose} disabled={busy} className={SECONDARY_BUTTON_CLASS}>
						Cancel
					</button>
					{empty.length > 0 ? (
						<span id="columns-editor-save-why" className="sr-only">
							{`${empty.length} ${empty.length === 1 ? 'column has' : 'columns have'} no status: fill or delete ${empty.length === 1 ? 'it' : 'them'} to save`}
						</span>
					) : null}
					<button
						type="button"
						onClick={() =>
							onSave({
								columns: draft.map(column => ({
									name: column.name,
									statuses: column.statuses,
									...(column.sort === undefined ? {} : { sort: column.sort }),
								})),
								...(finished === 'none' ? {} : { finishedFor: finished }),
							})
						}
						disabled={busy || empty.length > 0}
						aria-describedby={empty.length > 0 ? 'columns-editor-save-why' : undefined}
						title={empty.length > 0 ? 'A column with no status cannot be saved: fill or delete it' : undefined}
						className={BUTTON_PRIMARY_CLASS}
					>
						{busy ? 'Saving' : 'Save'}
					</button>
				</>
			)}
		>
			<div ref={root} className={`flex flex-col ${GAP_BLOCKS}`}>
				<p className="m-0 text-xs text-muted">
					A column shows the tasks of the statuses it holds, in the order of its chips. Drag a status before or
					after another one, or onto a column; use the arrows of a chip (or Left and Right) to reorder, or pick
					the column in its list. Drag the handle of a column, or use its arrows, to reorder the columns. A
					status in no column is hidden from the board.
				</p>
				<BoardPreview draft={draft} hidden={hidden} byName={byName} />
				<p data-testid="columns-editor-announce" role="status" aria-live="polite" className="sr-only">
					{announcement}
				</p>
				<div className="flex flex-col gap-1">
					<label className={`flex flex-wrap items-center ${GAP_CONTROLS} text-xs text-muted`}>
						<span className="font-medium">Show finished tasks for</span>
						<select
							aria-label="Show finished tasks for"
							value={finished}
							disabled={busy}
							onChange={event => {
								const value = event.target.value;
								setFinished(isFinishedFor(value) ? value : 'none');
							}}
							className={`${FIELD_CLASS} min-w-0 max-w-full`}
						>
							{FINISHED_FOR_OPTIONS.map(option => (
								<option key={option.value} value={option.value}>
									{option.label}
								</option>
							))}
						</select>
					</label>
					<p className="m-0 text-xs text-muted">{FINISHED_HINT}</p>
				</div>
				<ol className={`m-0 flex list-none flex-col ${GAP_CONTROLS} p-0`}>
					{draft.map((column, index) => (
						<li
							key={column.id}
							data-testid="columns-editor-column"
							{...(column.statuses.length === 0 ? { 'data-empty': 'true' } : {})}
							{...dropOn(`col-${column.id}`, column)}
							className={`flex flex-col ${GAP_CONTROLS} ${CONTROL_RADIUS} ${CONTROL_BORDER} p-2 ${column.statuses.length === 0 ? 'border-warning-text bg-warning-bg' : ''} ${highlight(`col-${column.id}`)}`}
						>
							<div className={`flex flex-wrap items-center ${GAP_CONTROLS}`}>
								<span
									draggable
									role="img"
									aria-label={`Drag to reorder column ${column.name}`}
									title="Drag to reorder"
									data-testid="columns-editor-handle"
									onDragStart={event => {
										drag.current = { kind: 'column', id: column.id };
										event.dataTransfer?.setData('text/plain', column.name);
										if (event.dataTransfer) {
											event.dataTransfer.effectAllowed = 'move';
										}
									}}
									onDragEnd={endDrag}
									className="inline-flex h-8 w-6 shrink-0 cursor-grab items-center justify-center text-muted"
								>
									<GripVertical size={ICON_SIZE} aria-hidden="true" />
								</span>
								<input
									type="text"
									value={column.name}
									aria-label={`Name of column ${index + 1}`}
									ref={element => {
										if (element !== null && focusId.current === column.id) {
											focusId.current = null;
											element.focus();
											element.select();
											element.scrollIntoView?.({ block: 'nearest' });
										}
									}}
									onChange={event => rename(column.id, event.target.value)}
									className={`${FIELD_CLASS} min-w-[9rem] flex-1`}
								/>
								<button
									type="button"
									aria-label={`Move column ${column.name} up`}
									title="Move up"
									disabled={busy || index === 0}
									onClick={() => moveBy(column.id, -1)}
									className={ICON_BUTTON_CLASS}
								>
									<ArrowUp size={ICON_SIZE} aria-hidden="true" />
								</button>
								<button
									type="button"
									aria-label={`Move column ${column.name} down`}
									title="Move down"
									disabled={busy || index === draft.length - 1}
									onClick={() => moveBy(column.id, 1)}
									className={ICON_BUTTON_CLASS}
								>
									<ArrowDown size={ICON_SIZE} aria-hidden="true" />
								</button>
								<button
									type="button"
									aria-label={`Delete column ${column.name}`}
									title="Delete column (its statuses are hidden)"
									disabled={busy}
									onClick={() => remove(column.id)}
									className={ICON_BUTTON_CLASS}
								>
									<Trash2 size={ICON_SIZE} aria-hidden="true" />
								</button>
							</div>
							<div className={`flex flex-wrap items-center ${GAP_CONTROLS}`}>
								{column.statuses.length === 0 ? (
									<span
										data-testid="columns-editor-column-empty"
										className="text-xs font-medium text-content"
									>
										No status yet: drag one here or pick this column in a status list.
									</span>
								) : (
									<span
										role="list"
										aria-label={`Statuses of column ${shownName(column.name)}, in board order`}
										className={`flex min-w-0 max-w-full flex-wrap items-center ${GAP_CONTROLS}`}
									>
										{column.statuses.map((status, position) => chip(status, column, position))}
									</span>
								)}
								{hidden.length > 0 ? (
									<select
										aria-label={`Add a status to column ${column.name}`}
										value=""
										disabled={busy}
										onChange={event => {
											if (event.target.value !== '') {
												assign(event.target.value, column.id);
											}
										}}
										className={`${FIELD_CLASS} min-w-0 max-w-[10rem] cursor-pointer text-xs`}
									>
										<option value="">Add status</option>
										{hidden.map(status => (
											<option key={status} value={status}>
												{status}
											</option>
										))}
									</select>
								) : null}
							</div>
							<div className={`flex flex-wrap items-center ${GAP_CONTROLS} text-xs text-muted`}>
								<label className={`flex flex-wrap items-center ${GAP_CONTROLS}`}>
									<span className="font-medium">Sort cards</span>
									<select
										aria-label={`Sort of column ${column.name}`}
										value={column.sort ?? ''}
										disabled={busy}
										onChange={event => setSort(column.id, event.target.value)}
										className={`${FIELD_CLASS} min-w-0 max-w-full`}
									>
										{SORT_OPTIONS.map(option => (
											<option key={option.value} value={option.value}>
												{option.label}
											</option>
										))}
									</select>
								</label>
							</div>
						</li>
					))}
				</ol>
				{hidden.length > 0 ? (
					<p data-testid="columns-editor-hidden" className="m-0 text-xs text-muted">
						{`Hidden (no column): ${hidden.join(', ')}`}
					</p>
				) : null}
				{empty.length > 0 ? (
					<div data-testid="columns-editor-empty" className={`flex flex-col ${GAP_CONTROLS}`}>
						{empty.map(column => (
							<Notice
								key={column.id}
								variant="warning"
								label={`Column "${column.name.trim() === '' ? '(unnamed)' : column.name}" has no status: drag a status onto it, or delete the column.`}
							/>
						))}
					</div>
				) : null}
			</div>
		</Dialog>
	);
}

/**
 * The board as the draft would draw it, live: one small box per column in order (name, sort, statuses in order), the hidden
 * statuses in a muted box at the end.
 */
function BoardPreview({
	draft,
	hidden,
	byName,
}: {
	draft: readonly DraftColumn[];
	hidden: readonly string[];
	byName: ReadonlyMap<string, BoardStatusData>;
}): React.ReactElement {
	const statusChip = (status: string): React.ReactElement => (
		<span
			key={status}
			data-testid="columns-editor-preview-status"
			className={`inline-flex min-w-0 max-w-full items-center gap-1 ${PILL_RADIUS} bg-surface px-1.5 text-xs text-content`}
		>
			<span
				aria-hidden="true"
				className={`inline-block h-1.5 w-1.5 shrink-0 ${PILL_RADIUS} ${TONE_DOT[toneOf(byName.get(status)?.tone)]}`}
			/>
			<span className="min-w-0 truncate">{status}</span>
		</span>
	);
	return (
		<div
			role="group"
			aria-label="Board preview"
			data-testid="columns-editor-preview"
			className={`flex min-w-0 flex-col gap-1`}
		>
			<span aria-hidden="true" className="text-xs font-medium text-muted">
				Board preview
			</span>
			<ol className={`m-0 flex min-w-0 list-none flex-col items-stretch sm:flex-row ${GAP_CONTROLS} p-0 pb-1 sm:overflow-x-auto`}>
				{draft.map(column => (
					<li
						key={column.id}
						data-testid="columns-editor-preview-column"
						className={`flex w-full flex-col gap-1 sm:w-36 sm:shrink-0 ${CONTROL_RADIUS} ${CONTROL_BORDER} bg-muted-bg p-2`}
					>
						<span
							data-testid="columns-editor-preview-name"
							className="min-w-0 truncate text-xs font-semibold text-content"
						>
							{shownName(column.name)}
						</span>
						<span data-testid="columns-editor-preview-sort" className="text-xs text-muted">
							{sortOption(column.sort).label}
						</span>
						<span className="flex min-w-0 flex-wrap gap-1">{column.statuses.map(statusChip)}</span>
					</li>
				))}
				{hidden.length > 0 ? (
					<li
						data-testid="columns-editor-preview-hidden"
						className={`flex w-full flex-col gap-1 sm:w-36 sm:shrink-0 ${CONTROL_RADIUS} border border-dashed border-border p-2 text-xs text-muted`}
					>
						<span className="font-semibold">Hidden</span>
						<span className="flex min-w-0 flex-wrap gap-1 opacity-70">{hidden.map(statusChip)}</span>
					</li>
				) : null}
			</ol>
		</div>
	);
}
