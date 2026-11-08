import React, { useRef, useState } from 'react';
import { pathKeyOf } from '../pathKey.js';
import { useAction } from '../useAction.js';
import type { ActionHandler, ActionRunner } from '../useAction.js';
import { ChipField } from '../ui/ChipField.js';
import { SuggestBox } from '../ui/SuggestBox.js';
import type { SuggestOption } from '../ui/SuggestBox.js';
import { BUTTON_PRIMARY_CLASS, FIELD_CLASS, PILL_ADD_CLASS } from '../ui/tokens.js';

export interface MetaEntry {
	key: string;
	value: string;
}

export interface MetaEditorProps {
	/** The metadata of the task, in display order. */
	entries: MetaEntry[];
	/** Name of the `$actions` entry that sets a key (also used to add one). The key and value travel in the JSON body. Without it values are not editable and there is no "+ Add" chip. */
	setAction?: string;
	/** Name of the `$actions` entry that removes a key (the x of each chip). Without it there is no x. */
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
	/** Show only this many chips, then a "Show N more" chip. 0 (the default) = all, the chips wrap. */
	collapseAfter?: number;
	/** Keys the project already uses, offered under the key input when adding a property. */
	keySuggestions?: string[];
	/** Draws the chips only, whatever the actions. */
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

const MAX_KEY_OPTIONS = 8;

interface PanelBase {
	setter: ActionRunner;
	params: Record<string, unknown> | undefined;
	keyParam: string;
	valueParam: string;
	close: () => void;
}

/** The popover of a chip: its value in one input, Enter saves. */
function EditPanel({ entry, setter, params, keyParam, valueParam, close }: PanelBase & { entry: MetaEntry }) {
	const [draft, setDraft] = useState(entry.value);
	const [problem, setProblem] = useState<string | null>(null);
	// Enter makes the field busy: a second Enter must not save again.
	const saving = useRef(false);

	const save = async (): Promise<void> => {
		if (saving.current) {
			return;
		}
		if (draft === entry.value) {
			close();
			return;
		}
		saving.current = true;
		try {
			const ok = await setter.run(params ?? {}, { [keyParam]: entry.key, [valueParam]: draft });
			if (ok) {
				close();
			} else {
				setProblem(`The value of "${entry.key}" was not saved. Fix it and press Enter, or Escape to cancel.`);
			}
		} finally {
			saving.current = false;
		}
	};

	return (
		<>
			<p className="truncate text-xs font-medium text-muted" title={entry.key}>
				{entry.key}
			</p>
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
						void save();
					}
				}}
				className={`w-full ${FIELD_CLASS}`}
			/>
			<button type="button" aria-label="Save value" onClick={() => void save()} className={BUTTON_PRIMARY_CLASS}>
				Save
			</button>
			{problem ? (
				<p role="alert" className="text-xs text-warning-text">
					{problem}
				</p>
			) : null}
		</>
	);
}

/** The popover of "+ Add": a key with the known keys below it, then a value, then Save. */
function AddPanel({
	existing,
	keySuggestions,
	setter,
	params,
	keyParam,
	valueParam,
	close,
}: PanelBase & { existing: MetaEntry[]; keySuggestions: string[] }) {
	const [key, setKey] = useState('');
	const [value, setValue] = useState('');
	const [problem, setProblem] = useState<string | null>(null);
	const saving = useRef(false);
	const keyInput = useRef<HTMLInputElement>(null);
	const valueInput = useRef<HTMLInputElement>(null);

	const known = new Set(existing.map(e => e.key.toLowerCase()));
	const typed = key.trim().toLowerCase();
	const options: SuggestOption[] = keySuggestions
		.filter(k => !known.has(k.toLowerCase()) && (typed === '' || k.toLowerCase().includes(typed)))
		.slice(0, MAX_KEY_OPTIONS)
		.map(k => ({ key: k, label: k }));

	const add = async (): Promise<void> => {
		if (saving.current) {
			return;
		}
		const name = key.trim();
		if (name === '') {
			setProblem('Enter a key first.');
			keyInput.current?.focus();
			return;
		}
		if (existing.some(e => e.key.toLowerCase() === name.toLowerCase())) {
			setProblem(`The key "${name}" already exists: click its chip to edit the value.`);
			return;
		}
		saving.current = true;
		try {
			const ok = await setter.run(params ?? {}, { [keyParam]: name, [valueParam]: value });
			if (ok) {
				close();
			} else {
				setProblem(`"${name}" was not saved. Press Enter to retry, or Escape to cancel.`);
			}
		} finally {
			saving.current = false;
		}
	};

	const toValue = (name: string): void => {
		setKey(name);
		setProblem(null);
		valueInput.current?.focus();
	};

	return (
		<>
			<SuggestBox
				ariaLabel="New property key"
				placeholder="key"
				value={key}
				onChange={next => {
					setKey(next);
					setProblem(null);
				}}
				options={options}
				listLabel="Property keys"
				inputRef={keyInput}
				autoFocus
				onSubmit={highlighted => {
					if (highlighted) {
						toValue(highlighted.label);
					} else if (key.trim() === '') {
						setProblem('Enter a key first.');
					} else if (value === '') {
						valueInput.current?.focus();
					} else {
						void add();
					}
				}}
				onPick={option => toValue(option.label)}
			/>
			<input
				ref={valueInput}
				type="text"
				aria-label="New property value"
				placeholder="value"
				readOnly={setter.busy}
				value={value}
				onChange={event => {
					setValue(event.target.value);
					setProblem(null);
				}}
				onKeyDown={event => {
					if (event.key === 'Enter') {
						event.preventDefault();
						void add();
					}
				}}
				className={`w-full ${FIELD_CLASS}`}
			/>
			<button
				type="button"
				aria-label="Save property"
				onClick={() => void add()}
				className={BUTTON_PRIMARY_CLASS}
			>
				Add
			</button>
			{problem ? (
				<p role="alert" className="text-xs text-warning-text">
					{problem}
				</p>
			) : null}
		</>
	);
}

/**
 * The metadata of a task as chips "key: value" (x removes, a click on the chip edits its value) and a trailing "+ Add"
 * chip, in the same wrapping row and the same popover layout as the labels (ChipField): the key input has the known
 * keys below it, then the value, Enter adds. Every change runs a page action at once; there is no Save button on the
 * page.
 *
 * @registryCategory composite
 * @registryTags metadata properties key value edit chips
 */
export function MetaEditor({
	entries,
	setAction,
	removeAction,
	keyParam = 'key',
	valueParam = 'value',
	params,
	collapseAfter = 0,
	keySuggestions,
	readOnly = false,
	emptyText,
	onAction,
	actionPending,
}: MetaEditorProps): React.ReactElement {
	const setter = useAction('MetaEditor', readOnly ? undefined : setAction, onAction, actionPending);
	const remover = useAction('MetaEditor', readOnly ? undefined : removeAction, onAction, actionPending);
	const list = Array.isArray(entries) ? entries : [];
	const [expanded, setExpanded] = useState(false);

	const remove = async (key: string): Promise<void> => {
		await remover.run({ ...(params ?? {}), [keyParam]: key, [`${keyParam}Key`]: pathKeyOf(key) });
	};

	const canEdit = !readOnly && setAction !== undefined && setAction !== '';
	const canRemove = !readOnly && removeAction !== undefined && removeAction !== '';
	const limit = collapseAfter > 0 ? collapseAfter : list.length;
	const shown = expanded ? list : list.slice(0, limit);
	const hidden = list.length - shown.length;

	if (list.length === 0 && !canEdit) {
		return (
			<span data-testid="meta-editor" className="text-sm text-muted">
				{emptyText ?? ''}
			</span>
		);
	}

	return (
		<ChipField
			testId="meta-editor"
			chipTestId="meta-chip"
			chips={shown.map(entry => ({
				key: entry.key,
				content: (
					<>
						<span className="font-normal opacity-70">{entry.key}:</span>{' '}
						{entry.value === '' ? <span className="opacity-70">empty</span> : entry.value}
					</>
				),
				title: `${entry.key}: ${entry.value}`,
				colorClass: 'bg-muted-bg text-content',
				removeLabel: `Remove ${entry.key}`,
				editLabel: `Edit value of ${entry.key}`,
			}))}
			addLabel="Add property"
			canAdd={canEdit}
			addUnavailableReason={setter.available ? undefined : (setter.unavailableReason ?? 'No page action to run')}
			canRemove={canRemove}
			removeOff={!remover.available}
			removeUnavailableReason={remover.unavailableReason}
			canEdit={canEdit}
			busy={setter.busy || remover.busy}
			onRemove={key => void remove(key)}
			extra={
				<>
					{list.length === 0 && emptyText ? <span className="text-sm text-muted">{emptyText}</span> : null}
					{list.length > limit || expanded ? (
						<button
							type="button"
							aria-expanded={expanded}
							onClick={() => setExpanded(!expanded)}
							className={PILL_ADD_CLASS}
						>
							{expanded ? 'Show fewer' : `Show ${hidden} more`}
						</button>
					) : null}
				</>
			}
			renderPanel={({ mode, close }) => {
				const base = { setter, params, keyParam, valueParam, close };
				if (mode.kind === 'edit') {
					const entry = list.find(e => e.key === mode.key);
					return entry ? <EditPanel entry={entry} {...base} /> : null;
				}
				return (
					<AddPanel
						existing={list}
						keySuggestions={Array.isArray(keySuggestions) ? keySuggestions : []}
						{...base}
					/>
				);
			}}
		/>
	);
}
