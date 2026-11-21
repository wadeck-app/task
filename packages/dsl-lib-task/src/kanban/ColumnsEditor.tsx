import { ArrowDown, ArrowUp, GripVertical, Plus, Trash2 } from 'lucide-react';
import React, { useRef, useState } from 'react';
import { Notice } from '../components/Notice.js';
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
import { isColumnSort, SORT_OPTIONS } from './boardModel.js';
import type { BoardLayoutData, BoardStatusData, ColumnSort, LayoutColumn } from './boardModel.js';

export interface ColumnsEditorProps {
	/** The stored layout (or one column per status) and every status of the project. */
	layout: BoardLayoutData;
	/** A save or a reset is running. */
	busy: boolean;
	/** The route's message and hint of the last refused save or reset; null when there is none. */
	error: string | null;
	/** The columns to store; `sort` is left out for the default order. */
	onSave: (columns: LayoutColumn[]) => void;
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

const UNMAPPED = 'unmapped';
const SECONDARY_BUTTON_CLASS = `inline-flex ${CONTROL_H} items-center justify-center ${GAP_CONTROLS} ${CONTROL_RADIUS} ${CONTROL_BORDER} bg-surface px-3 ${PILL_TEXT} text-content hover:bg-muted-bg ${FOCUS_RING} disabled:cursor-not-allowed disabled:opacity-60`;

/** A name for a new column that no other column has. */
export function freshColumnName(taken: readonly string[]): string {
	const lower = new Set(taken.map(name => name.trim().toLowerCase()));
	let candidate = 'New column';
	for (let n = 2; lower.has(candidate.toLowerCase()); n += 1) {
		candidate = `New column ${n}`;
	}
	return candidate;
}

/**
 * The editor of the board columns ("Configure columns"): add, rename, delete and reorder columns (drag the handle, or the up and
 * down buttons), and put every status in a column (drag its chip onto a column, or pick the column in its select). A status in no
 * column goes to the Unmapped box: the board shows those in an Unmapped column. The rules (names, a status in one column only)
 * are the server's and a refused save shows its message and hint; only "a column holds at least one status" is also said before the request (a refused empty column read as an untested editor).
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
	const [draft, setDraft] = useState<DraftColumn[]>(() =>
		layout.columns.map((column, index) => ({
			id: index,
			name: column.name,
			statuses: [...column.statuses],
			...(column.sort === undefined ? {} : { sort: column.sort }),
		}))
	);
	const drag = useRef<{ kind: 'column'; id: number } | { kind: 'status'; name: string } | null>(null);
	const [overKey, setOverKey] = useState<string | null>(null);
	// The column just added: its name field takes the focus (name selected) as soon as it is drawn, wherever the list was scrolled.
	const focusId = useRef<number | null>(null);

	const byName = new Map<string, BoardStatusData>(layout.allStatuses.map(status => [status.name, status]));
	const placed = new Set(draft.flatMap(column => column.statuses));
	const unmapped = layout.allStatuses.filter(status => !placed.has(status.name)).map(status => status.name);

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
	/** Puts a status in a column (appended), or in none. */
	const assign = (status: string, target: number | typeof UNMAPPED): void =>
		setDraft(current =>
			current.map(column => {
				const without = column.statuses.filter(name => name !== status);
				return column.id === target
					? { ...column, statuses: [...without, status] }
					: { ...column, statuses: without };
			})
		);

	const chip = (status: string, current: number | typeof UNMAPPED): React.ReactElement => {
		const info = byName.get(status);
		return (
			<span
				key={status}
				data-testid={`columns-editor-chip-${status}`}
				draggable
				onDragStart={event => {
					drag.current = { kind: 'status', name: status };
					event.dataTransfer?.setData('text/plain', status);
					if (event.dataTransfer) {
						event.dataTransfer.effectAllowed = 'move';
					}
				}}
				onDragEnd={() => {
					drag.current = null;
					setOverKey(null);
				}}
				className={`inline-flex ${CONTROL_H} min-w-0 max-w-full cursor-grab items-center ${GAP_CONTROLS} ${PILL_RADIUS} ${CONTROL_BORDER} bg-surface pl-3 pr-1 ${CONTROL_TEXT} text-content`}
			>
				<span
					aria-hidden="true"
					className={`inline-block h-2 w-2 shrink-0 ${PILL_RADIUS} ${TONE_DOT[toneOf(info?.tone)]}`}
				/>
				<span className="min-w-0 truncate">{status}</span>
				<select
					aria-label={`Column of status ${status}`}
					value={String(current)}
					onChange={event => {
						const value = event.target.value;
						assign(status, value === UNMAPPED ? UNMAPPED : Number(value));
					}}
					className={`h-6 min-w-0 max-w-[8rem] truncate ${CONTROL_RADIUS} border-0 bg-muted-bg px-1 text-xs text-content ${FOCUS_RING}`}
				>
					{draft.map(column => (
						<option key={column.id} value={String(column.id)}>
							{column.name.trim() === '' ? '(unnamed column)' : column.name}
						</option>
					))}
					<option value={UNMAPPED}>Unmapped</option>
				</select>
			</span>
		);
	};

	/** Props that make an element accept a dragged status chip (onto `target`) or a dragged column (before `target`). */
	const dropOn = (key: string, target: number | typeof UNMAPPED): React.HTMLAttributes<HTMLElement> => ({
		onDragOver: event => {
			const dragged = drag.current;
			if (dragged === null || (dragged.kind === 'column' && target === UNMAPPED)) {
				return;
			}
			event.preventDefault();
			setOverKey(key);
		},
		onDragLeave: event => {
			if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) {
				setOverKey(current => (current === key ? null : current));
			}
		},
		onDrop: event => {
			const dragged = drag.current;
			drag.current = null;
			setOverKey(null);
			if (dragged === null) {
				return;
			}
			event.preventDefault();
			if (dragged.kind === 'status') {
				assign(dragged.name, target);
			} else if (target !== UNMAPPED) {
				moveBefore(dragged.id, target);
			}
		},
	});

	const highlight = (key: string): string => (overKey === key ? 'ring-2 ring-primary bg-primary-light' : '');

	return (
		<section
			data-testid="columns-editor"
			aria-label="Configure columns"
			className={`flex flex-col ${GAP_BLOCKS} ${CONTROL_RADIUS} ${CONTROL_BORDER} bg-surface p-3`}
		>
			<div className="flex flex-col gap-1">
				<h3 className="m-0 text-sm font-semibold text-content">Configure columns</h3>
				<p className="m-0 text-xs text-muted">
					A column shows the tasks of the statuses it holds. Drag a status onto a column, or pick the column
					in its list; drag the handle of a column, or use its arrows, to reorder. Statuses in no column
					appear in an Unmapped column.
				</p>
			</div>
			<ol className={`m-0 flex list-none flex-col ${GAP_CONTROLS} p-0`}>
				{draft.map((column, index) => (
					<li
						key={column.id}
						data-testid="columns-editor-column"
						{...(column.statuses.length === 0 ? { 'data-empty': 'true' } : {})}
						{...dropOn(`col-${column.id}`, column.id)}
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
								onDragEnd={() => {
									drag.current = null;
									setOverKey(null);
								}}
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
								title="Delete column (its statuses become Unmapped)"
								disabled={busy}
								onClick={() => remove(column.id)}
								className={ICON_BUTTON_CLASS}
							>
								<Trash2 size={ICON_SIZE} aria-hidden="true" />
							</button>
						</div>
						<div className={`flex flex-wrap items-center ${GAP_CONTROLS}`}>
							{column.statuses.length === 0 ? (
								<span data-testid="columns-editor-column-empty" className="text-xs font-medium text-content">
									No status yet: drag one here or pick this column in a status list.
								</span>
							) : (
								column.statuses.map(status => chip(status, column.id))
							)}
						</div>
						<label className={`flex flex-wrap items-center ${GAP_CONTROLS} text-xs text-muted`}>
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
					</li>
				))}
			</ol>
			<div
				data-testid="columns-editor-unmapped"
				{...dropOn('unmapped', UNMAPPED)}
				className={`flex flex-col ${GAP_CONTROLS} ${CONTROL_RADIUS} border border-dashed border-border p-2 ${highlight('unmapped')}`}
			>
				<span className="text-xs font-semibold text-muted">Unmapped</span>
				<div className={`flex flex-wrap items-center ${GAP_CONTROLS}`}>
					{unmapped.length === 0 ? (
						<span className="text-xs text-muted">Every status is in a column.</span>
					) : (
						unmapped.map(status => chip(status, UNMAPPED))
					)}
				</div>
			</div>
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
			{error !== null ? <Notice variant="danger" label={error} /> : null}
			<div className={`flex flex-wrap items-center ${GAP_CONTROLS}`}>
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
				<button type="button" onClick={onCancel} disabled={busy} className={SECONDARY_BUTTON_CLASS}>
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
						onSave(
							draft.map(column => ({
								name: column.name,
								statuses: column.statuses,
								...(column.sort === undefined ? {} : { sort: column.sort }),
							}))
						)
					}
					disabled={busy || empty.length > 0}
					aria-describedby={empty.length > 0 ? 'columns-editor-save-why' : undefined}
					title={empty.length > 0 ? 'A column with no status cannot be saved: fill or delete it' : undefined}
					className={BUTTON_PRIMARY_CLASS}
				>
					{busy ? 'Saving' : 'Save'}
				</button>
			</div>
		</section>
	);
}
