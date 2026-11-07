import { Plus, X } from 'lucide-react';
import React, { useId, useRef, useState } from 'react';
import { pathKeyOf } from '../pathKey.js';
import { useAction } from '../useAction.js';
import type { ActionHandler } from '../useAction.js';

export interface MetaEntry {
	key: string;
	value: string;
}

export interface MetaEditorProps {
	/** The metadata of the task, in display order. */
	entries: MetaEntry[];
	/** Name of the `$actions` entry that sets a key (also used to add one). The key and value travel in the JSON body. Without it values are not editable. */
	setAction?: string;
	/** Name of the `$actions` entry that removes a key (the x of each row). Without it there is no x. */
	removeAction?: string;
	/** Name of the key in the set body and in the remove params. The base64url key of a removed key is `<keyParam>Key`. */
	keyParam?: string;
	/** Name of the value in the set body. */
	valueParam?: string;
	/**
	 * The other `{placeholders}` of the action urls (`id`, `projectParam`...).
	 * @resolveDeep
	 */
	params?: Record<string, unknown>;
	/** Show only this many rows, then a "N more" toggle. 0 = all. */
	collapseAfter?: number;
	/** Keys the project already uses, offered when adding a property. */
	keySuggestions?: string[];
	/** Draws the rows only, whatever the actions. */
	readOnly?: boolean;
	/** Shown when there is no entry. */
	emptyText?: string;
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

const FIELD =
	'min-w-0 rounded border border-border bg-surface px-1.5 py-0.5 text-sm text-content outline-none focus:ring-1 focus:ring-primary read-only:opacity-70';

/**
 * The metadata of a task as key / value rows: click a value to edit it in place (Enter saves, Escape cancels), x
 * removes a key, "Add property" adds one. Every change runs a page action at once; there is no Save button.
 *
 * @registryCategory composite
 * @registryTags metadata properties key value edit
 */
export function MetaEditor({
	entries,
	setAction,
	removeAction,
	keyParam = 'key',
	valueParam = 'value',
	params,
	collapseAfter = 3,
	keySuggestions,
	readOnly = false,
	emptyText,
	onAction,
	actionPending,
}: MetaEditorProps): React.ReactElement {
	const setter = useAction('MetaEditor', readOnly ? undefined : setAction, onAction, actionPending);
	const remover = useAction('MetaEditor', readOnly ? undefined : removeAction, onAction, actionPending);
	const list = Array.isArray(entries) ? entries : [];
	const busy = setter.busy || remover.busy;
	const listId = useId();

	const [expanded, setExpanded] = useState(false);
	const [editing, setEditing] = useState<string | null>(null);
	const [draft, setDraft] = useState('');
	const [adding, setAdding] = useState(false);
	const [newKey, setNewKey] = useState('');
	const [newValue, setNewValue] = useState('');
	const [problem, setProblem] = useState<string | null>(null);
	// Enter makes the field busy and the browser then blurs it: without this guard the blur saves the same value again.
	const saving = useRef(false);
	const cancelled = useRef(false);
	const keyInput = useRef<HTMLInputElement>(null);
	const valueInput = useRef<HTMLInputElement>(null);

	const startEdit = (entry: MetaEntry): void => {
		cancelled.current = false;
		setProblem(null);
		setAdding(false);
		setEditing(entry.key);
		setDraft(entry.value);
	};

	const save = async (entry: MetaEntry): Promise<void> => {
		if (saving.current || cancelled.current) {
			return;
		}
		if (draft === entry.value) {
			setEditing(null);
			setProblem(null);
			return;
		}
		saving.current = true;
		try {
			const ok = await setter.run(params ?? {}, { [keyParam]: entry.key, [valueParam]: draft });
			if (ok) {
				setEditing(null);
				setProblem(null);
			} else {
				setProblem(`The value of "${entry.key}" was not saved. Fix it and press Enter, or Escape to cancel.`);
			}
		} finally {
			saving.current = false;
		}
	};

	const cancel = (): void => {
		cancelled.current = true;
		setEditing(null);
		setProblem(null);
	};

	const remove = async (key: string): Promise<void> => {
		setProblem(null);
		await remover.run({ ...(params ?? {}), [keyParam]: key, [`${keyParam}Key`]: pathKeyOf(key) });
	};

	const closeAdd = (): void => {
		setAdding(false);
		setNewKey('');
		setNewValue('');
		setProblem(null);
	};

	const add = async (): Promise<void> => {
		if (saving.current) {
			return;
		}
		const key = newKey.trim();
		if (key === '') {
			setProblem('Enter a key first.');
			keyInput.current?.focus();
			return;
		}
		if (list.some(e => e.key.toLowerCase() === key.toLowerCase())) {
			setProblem(`The key "${key}" already exists: click its value to edit it.`);
			return;
		}
		saving.current = true;
		try {
			const ok = await setter.run(params ?? {}, { [keyParam]: key, [valueParam]: newValue });
			if (ok) {
				closeAdd();
			} else {
				setProblem(`"${key}" was not saved. Press Enter to retry, or Escape to cancel.`);
			}
		} finally {
			saving.current = false;
		}
	};

	const canEdit = !readOnly && setAction !== undefined && setAction !== '';
	const canRemove = !readOnly && removeAction !== undefined && removeAction !== '';
	const limit = collapseAfter > 0 ? collapseAfter : list.length;
	const shown = expanded ? list : list.slice(0, limit);
	const hidden = list.length - shown.length;
	const known = new Set(list.map(e => e.key.toLowerCase()));
	const suggestions = (Array.isArray(keySuggestions) ? keySuggestions : []).filter(k => !known.has(k.toLowerCase()));

	if (list.length === 0 && !canEdit) {
		return (
			<span data-testid="meta-editor" className="text-sm text-muted">
				{emptyText ?? ''}
			</span>
		);
	}

	return (
		<div data-testid="meta-editor" className="flex flex-col gap-1">
			{list.length === 0 && emptyText ? <p className="text-sm text-muted">{emptyText}</p> : null}
			<ul className="flex flex-col divide-y divide-border">
				{shown.map(entry => (
					<li key={entry.key} className="flex items-center gap-2 py-1 text-sm">
						<span className="w-28 shrink-0 truncate font-medium text-muted" title={entry.key}>
							{entry.key}
						</span>
						{editing === entry.key ? (
							<input
								type="text"
								aria-label={`Value of ${entry.key}`}
								aria-busy={setter.busy || undefined}
								readOnly={setter.busy}
								autoFocus
								value={draft}
								onChange={event => {
									setDraft(event.target.value);
									setProblem(null);
								}}
								onKeyDown={event => {
									if (event.key === 'Enter') {
										event.preventDefault();
										void save(entry);
									} else if (event.key === 'Escape') {
										event.preventDefault();
										cancel();
									}
								}}
								onBlur={() => void save(entry)}
								className={`${FIELD} flex-1`}
							/>
						) : canEdit ? (
							<button
								type="button"
								aria-label={`Edit value of ${entry.key}`}
								title={entry.value}
								disabled={busy}
								onClick={() => startEdit(entry)}
								className="min-h-6 min-w-0 flex-1 truncate rounded px-1.5 py-0.5 text-left text-content hover:bg-muted-bg focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-not-allowed"
							>
								{entry.value === '' ? <span className="text-muted">empty</span> : entry.value}
							</button>
						) : (
							<span className="min-w-0 flex-1 truncate px-1.5 text-content" title={entry.value}>
								{entry.value}
							</span>
						)}
						{canRemove ? (
							<button
								type="button"
								aria-label={`Remove ${entry.key}`}
								title={remover.unavailableReason ?? `Remove ${entry.key}`}
								disabled={!remover.available || busy}
								onClick={() => void remove(entry.key)}
								className="inline-flex shrink-0 rounded p-0.5 text-muted hover:text-content focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-not-allowed disabled:opacity-40"
							>
								<X size={14} aria-hidden="true" />
							</button>
						) : null}
					</li>
				))}
			</ul>
			{list.length > limit ? (
				<button
					type="button"
					aria-expanded={expanded}
					onClick={() => setExpanded(!expanded)}
					className="self-start rounded text-xs text-muted hover:text-content focus-visible:ring-2 focus-visible:ring-primary"
				>
					{expanded ? 'Show fewer' : `Show ${hidden} more`}
				</button>
			) : null}
			{canEdit ? (
				adding ? (
					<div className="flex flex-wrap items-center gap-2">
						<input
							ref={keyInput}
							type="text"
							aria-label="New property key"
							list={listId}
							autoFocus
							placeholder="key"
							value={newKey}
							onChange={event => {
								setNewKey(event.target.value);
								setProblem(null);
							}}
							onKeyDown={event => {
								if (event.key === 'Enter') {
									event.preventDefault();
									if (newValue === '') {
										valueInput.current?.focus();
									} else {
										void add();
									}
								} else if (event.key === 'Escape') {
									event.preventDefault();
									closeAdd();
								}
							}}
							className={`${FIELD} w-28`}
						/>
						<datalist id={listId}>
							{suggestions.map(k => (
								<option key={k} value={k} />
							))}
						</datalist>
						<input
							ref={valueInput}
							type="text"
							aria-label="New property value"
							placeholder="value"
							readOnly={setter.busy}
							value={newValue}
							onChange={event => {
								setNewValue(event.target.value);
								setProblem(null);
							}}
							onKeyDown={event => {
								if (event.key === 'Enter') {
									event.preventDefault();
									void add();
								} else if (event.key === 'Escape') {
									event.preventDefault();
									closeAdd();
								}
							}}
							className={`${FIELD} min-w-24 flex-1`}
						/>
					</div>
				) : (
					<button
						type="button"
						aria-label="Add property"
						disabled={!setter.available || busy}
						title={setter.unavailableReason}
						onClick={() => {
							cancelled.current = false;
							setEditing(null);
							setProblem(null);
							setAdding(true);
						}}
						className="inline-flex items-center gap-1 self-start rounded text-xs text-muted hover:text-content focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-not-allowed"
					>
						<Plus size={12} aria-hidden="true" />
						Add property
					</button>
				)
			) : null}
			{problem ? (
				<p role="alert" className="text-xs text-warning-text">
					{problem}
				</p>
			) : null}
		</div>
	);
}
