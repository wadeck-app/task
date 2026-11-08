import { Search, X } from 'lucide-react';
import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { ApiProblem, getJson, isAbort, problemText } from '../apiFetch.js';
import { toneOf } from '../tones.js';
import { useAction } from '../useAction.js';
import type { ActionHandler } from '../useAction.js';
import { useDismiss } from '../useDismiss.js';
import { StatusBadge } from './StatusBadge.js';
import { FIELD_CLASS, GAP_CONTROLS, ICON_SIZE, RESULTS_CLASS, SEARCH_STICKY_CLASS } from '../ui/tokens.js';

export interface TaskPickerProps {
	/** Name of the `$actions` entry run when a task is picked. */
	action: string;
	/**
	 * The `{placeholders}` of the action url (`id`, `projectParam`...).
	 * @resolveDeep
	 */
	params?: Record<string, unknown>;
	/** Name of the body field that carries the id of the picked task. */
	bodyKey?: string;
	/** A select shown before the field (a relation: blocked by, blocks...). Its value travels in the body under `choiceKey`; the first one is the default. */
	choices?: Array<{ value: string; label: string }>;
	/** Name of the body field that carries the chosen value of `choices`. */
	choiceKey?: string;
	/** The accessible name of the `choices` select. */
	choiceLabel?: string;
	/** The project to search in (the `project` query of the search route): an id, a name or an alias. */
	projectParam?: string;
	placeholder?: string;
	/** The accessible name of the field. */
	ariaLabel?: string;
	/**
	 * Ids that must not be offered (the task itself, its current parent...).
	 * @resolveDeep
	 */
	excludeIds?: string[];
	/** Task whose descendants must not be offered (a parent cannot be one of its own descendants). */
	excludeDescendantsOf?: string;
	/** Rows asked from the search route. */
	limit?: number;
	/** Wait after the last keystroke before searching. */
	debounceMs?: number;
	/** A button empties the field while it holds text. */
	clearable?: boolean;
	disabled?: boolean;
	/** Overrides the api base set by `configureTaskUi`. */
	apiBase?: string;
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

interface PickerRow {
	id: string;
	headline: string;
	status: string;
	statusText: string;
	tone: string;
}

function rowsOf(answer: unknown): PickerRow[] {
	if (!Array.isArray(answer)) {
		throw new ApiProblem(
			'The task search answered something unexpected',
			'Reload the page; if it persists, update the task module.'
		);
	}
	return answer
		.filter(
			(item): item is Record<string, unknown> =>
				typeof item === 'object' && item !== null && typeof item['id'] === 'string'
		)
		.map(item => ({
			id: String(item['id']),
			headline: typeof item['headline'] === 'string' ? item['headline'] : '',
			status: typeof item['status'] === 'string' ? item['status'] : '',
			statusText: typeof item['statusText'] === 'string' ? item['statusText'] : String(item['status'] ?? ''),
			tone: typeof item['tone'] === 'string' ? item['tone'] : 'neutral',
		}));
}

const SKELETON_ROWS = 3;

/**
 * A search-as-you-type field over the tasks of a project: pick one and a page action runs with its id in the body.
 * Used to choose a parent or the other end of a link without typing an id.
 *
 * IN SCOPE: finding one task by id or words. OUT OF SCOPE: picking several tasks, free text.
 *
 * @registryCategory composite
 * @registryTags task picker search combobox parent link autocomplete
 */
export function TaskPicker({
	action,
	params,
	bodyKey = 'target',
	choices,
	choiceKey = 'choice',
	choiceLabel = 'Choice',
	projectParam,
	placeholder = 'Search a task',
	ariaLabel,
	excludeIds,
	excludeDescendantsOf,
	limit = 8,
	debounceMs = 150,
	clearable = false,
	disabled = false,
	apiBase,
	onAction,
	actionPending,
}: TaskPickerProps): React.ReactElement {
	const runner = useAction('TaskPicker', action, onAction, actionPending);
	const baseId = useId();
	const listId = `${baseId}-list`;
	const rootRef = useRef<HTMLDivElement>(null);
	const [text, setText] = useState('');
	const choiceList = Array.isArray(choices) ? choices : [];
	const [choice, setChoice] = useState<string | undefined>(undefined);
	// The first choice until the user picks another; a choice that vanished from the list falls back to the first.
	const chosen = choiceList.some(entry => entry.value === choice) ? choice : choiceList[0]?.value;
	const [open, setOpen] = useState(false);
	const [rows, setRows] = useState<PickerRow[]>([]);
	const [loading, setLoading] = useState(false);
	const [problem, setProblem] = useState<string | null>(null);
	const [active, setActive] = useState(0);
	const [picking, setPicking] = useState(false);
	const pickingRef = useRef(false);
	// A field just opened by focus or click searches at once; typing waits for the debounce.
	const immediate = useRef(false);
	const excluded = Array.isArray(excludeIds) ? excludeIds.filter(id => id !== '') : [];
	const excludedKey = excluded.join(',');

	useEffect(() => {
		if (!open) {
			return undefined;
		}
		const controller = new AbortController();
		const delay = immediate.current ? 0 : debounceMs;
		immediate.current = false;
		setLoading(true);
		setProblem(null);
		const timer = setTimeout(() => {
			getJson(
				'/tasks/search',
				{
					q: text,
					limit,
					project: projectParam || undefined,
					exclude: excludedKey || undefined,
					excludeDescendantsOf: excludeDescendantsOf || undefined,
				},
				{ signal: controller.signal, apiBase }
			).then(
				answer => {
					if (controller.signal.aborted) {
						return;
					}
					try {
						setRows(rowsOf(answer));
						setActive(0);
					} catch (error) {
						setRows([]);
						setProblem(problemText(error));
					}
					setLoading(false);
				},
				(error: unknown) => {
					if (isAbort(error) || controller.signal.aborted) {
						return;
					}
					setRows([]);
					setProblem(problemText(error));
					setLoading(false);
				}
			);
		}, delay);
		return () => {
			clearTimeout(timer);
			controller.abort();
		};
	}, [open, text, limit, debounceMs, projectParam, excludedKey, excludeDescendantsOf, apiBase]);

	const close = useCallback(() => setOpen(false), []);
	useDismiss(rootRef, open, close);

	const shown = rows.filter(row => !excluded.includes(row.id));
	const optionId = (index: number): string => `${baseId}-opt-${index}`;

	const pick = async (row: PickerRow | undefined): Promise<void> => {
		if (!row || pickingRef.current) {
			return;
		}
		pickingRef.current = true;
		setPicking(true);
		try {
			const body: Record<string, string> = { [bodyKey]: row.id };
			if (chosen !== undefined) {
				body[choiceKey] = chosen;
			}
			const ok = await runner.run({ ...(params ?? {}) }, body);
			if (ok) {
				setText('');
			}
		} finally {
			pickingRef.current = false;
			setPicking(false);
			setOpen(false);
		}
	};

	const openNow = (): void => {
		if (!open) {
			immediate.current = true;
			setOpen(true);
		}
	};

	const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
		if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
			event.preventDefault();
			if (!open) {
				openNow();
				return;
			}
			if (shown.length > 0) {
				const step = event.key === 'ArrowDown' ? 1 : -1;
				setActive(current => Math.min(shown.length - 1, Math.max(0, current + step)));
			}
		} else if (event.key === 'Enter') {
			event.preventDefault();
			if (open && !loading) {
				void pick(shown[active]);
			}
		} else if (event.key === 'Escape' && open) {
			event.preventDefault();
			setOpen(false);
		}
	};

	const unavailable = disabled || !runner.available;
	const showStatus = open && !loading && problem === null && shown.length === 0;
	const activeId = open && !loading && shown[active] ? optionId(active) : undefined;

	return (
		<div ref={rootRef} data-testid="task-picker" className={`flex w-full min-w-0 flex-col ${GAP_CONTROLS}`}>
			{choiceList.length > 0 ? (
				<select
					aria-label={choiceLabel}
					value={chosen}
					disabled={unavailable}
					onChange={event => setChoice(event.target.value)}
					className={`w-full ${FIELD_CLASS}`}
				>
					{choiceList.map(entry => (
						<option key={entry.value} value={entry.value}>
							{entry.label}
						</option>
					))}
				</select>
			) : null}
			<div data-testid="task-picker-search" className={`relative flex items-center ${SEARCH_STICKY_CLASS}`}>
				<Search
					size={ICON_SIZE}
					aria-hidden="true"
					className="pointer-events-none absolute left-2 text-muted"
				/>
				<input
					type="text"
					role="combobox"
					aria-label={ariaLabel ?? placeholder}
					aria-expanded={open}
					aria-controls={open ? listId : undefined}
					aria-autocomplete="list"
					aria-activedescendant={activeId}
					aria-busy={picking || undefined}
					autoComplete="off"
					placeholder={placeholder}
					title={runner.unavailableReason}
					value={text}
					disabled={unavailable}
					readOnly={picking}
					onFocus={openNow}
					onClick={openNow}
					onChange={event => {
						setText(event.target.value);
						setOpen(true);
					}}
					onKeyDown={onKeyDown}
					className={`w-full pl-7 pr-8 ${FIELD_CLASS}`}
				/>
				{clearable && text !== '' && !picking ? (
					<button
						type="button"
						aria-label="Clear"
						onClick={() => setText('')}
						className="absolute right-1.5 inline-flex rounded p-0.5 text-muted hover:text-content focus-visible:ring-2 focus-visible:ring-primary"
					>
						<X size={14} aria-hidden="true" />
					</button>
				) : null}
			</div>
			{open ? (
				<div
					data-testid="task-picker-popup"
					className={`w-full min-w-0 max-w-[calc(100vw-1rem)] ${RESULTS_CLASS}`}
				>
					{loading
						? Array.from({ length: SKELETON_ROWS }, (_, i) => (
								<div
									key={i}
									data-testid="task-picker-skeleton"
									aria-hidden="true"
									className="flex animate-pulse items-center gap-2 px-3 py-1.5"
								>
									<span className="h-3 w-14 rounded bg-muted-bg" />
									<span className="h-3 flex-1 rounded bg-muted-bg" />
									<span className="h-4 w-12 rounded-full bg-muted-bg" />
								</div>
							))
						: null}
					{!loading && problem !== null ? (
						<p role="alert" className="px-3 py-2 text-sm text-danger-text">
							{problem}
						</p>
					) : null}
					{showStatus ? (
						<p role="status" className="px-3 py-2 text-sm text-muted">
							{text.trim() === '' ? 'No task to pick' : `No match for "${text.trim()}"`}
						</p>
					) : null}
					<div id={listId} role="listbox" aria-busy={loading || undefined} aria-label="Matching tasks">
						{!loading && problem === null
							? shown.map((row, index) => (
									<div
										key={row.id}
										id={optionId(index)}
										role="option"
										aria-selected={index === active}
										onMouseDown={event => event.preventDefault()}
										onMouseEnter={() => setActive(index)}
										onClick={() => void pick(row)}
										className={`flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm ${index === active ? 'bg-muted-bg' : ''}`}
									>
										<span className="shrink-0 font-mono text-xs text-muted">{row.id}</span>
										<span className="min-w-0 flex-1 truncate text-content" title={row.headline}>
											{row.headline}
										</span>
										<StatusBadge label={row.statusText || row.status} tone={toneOf(row.tone)} />
									</div>
								))
							: null}
					</div>
				</div>
			) : null}
		</div>
	);
}
