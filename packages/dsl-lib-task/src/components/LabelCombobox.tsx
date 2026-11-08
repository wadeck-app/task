import { Plus, X } from 'lucide-react';
import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { ApiProblem, getJson, isAbort, problemText } from '../apiFetch.js';
import { pathKeyOf } from '../pathKey.js';
import { CHIP_PALETTE, TONE_PILL, hashIndex, isTone } from '../tones.js';
import { useAction } from '../useAction.js';
import type { ActionHandler } from '../useAction.js';
import { useDismiss } from '../useDismiss.js';

export interface LabelSuggestion {
	label: string;
	count: number;
}

export interface LabelComboboxProps {
	/** The labels of the task. */
	labels: string[];
	/** Colour of a label by name: a tone (`danger`, `success`, `info`, `warning`, `purple`, `neutral`). Others are coloured from a stable hash of the text. */
	colors?: Record<string, string>;
	/** Name of the `$actions` entry that adds a label; the label travels in the body under `labelParam`. Without it there is no field. */
	addAction?: string;
	/** Name of the `$actions` entry that removes a label (the x of each chip); the label and its key fill the url. Without it there is no x. */
	removeAction?: string;
	/** Name of the parameter that carries the label. The key of the label is `<labelParam>Key`. */
	labelParam?: string;
	/** Key of each label (label -> base64url of its UTF-8 bytes); a label missing here gets its key computed. */
	labelKeys?: Record<string, string>;
	/**
	 * The `{placeholders}` of the action urls (`id`, `projectParam`...).
	 * @resolveDeep
	 */
	params?: Record<string, unknown>;
	/** The project whose labels are suggested (the `project` query of the labels route): an id, a name or an alias. */
	projectParam?: string;
	/** The labels to suggest, with how many tasks carry each. Without them the labels route is asked when the field opens. */
	suggestions?: LabelSuggestion[];
	placeholder?: string;
	size?: 'sm' | 'md';
	/** Draws the chips only, whatever the actions. */
	readOnly?: boolean;
	/** Shown when there is no label and nothing to add. */
	emptyText?: string;
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

// @formatter:off
const SIZE: Record<NonNullable<LabelComboboxProps['size']>, string> = {
	sm: 'px-2 py-0.5 text-xs',
	md: 'px-2.5 py-1 text-sm',
};
// @formatter:on

const MAX_OPTIONS = 8;
const SKELETON_ROWS = 3;

interface Option {
	key: string;
	label: string;
	count: number | null;
	create: boolean;
}

function chipClass(label: string, colors: Record<string, string> | undefined): string {
	const given = colors?.[label];
	if (given !== undefined && isTone(given)) {
		return TONE_PILL[given];
	}
	return CHIP_PALETTE[hashIndex(label, CHIP_PALETTE.length)]!;
}

function suggestionsOf(answer: unknown): LabelSuggestion[] {
	if (!Array.isArray(answer)) {
		throw new ApiProblem(
			'The label list answered something unexpected',
			'Reload the page; if it persists, update the task module.'
		);
	}
	return answer
		.filter(
			(item): item is Record<string, unknown> =>
				typeof item === 'object' && item !== null && typeof item['label'] === 'string'
		)
		.map(item => ({ label: String(item['label']), count: typeof item['count'] === 'number' ? item['count'] : 0 }));
}

/**
 * The labels of a task as chips (x removes) and a field with autocomplete: existing labels of the project come first
 * with their count, Enter adds the highlighted suggestion (else the first matching one, else creates the typed text). Each change runs
 * a page action at once.
 *
 * IN SCOPE: add and remove labels of one task. OUT OF SCOPE: renaming a label project-wide.
 *
 * @registryCategory composite
 * @registryTags labels chips tags autocomplete combobox action
 */
export function LabelCombobox({
	labels,
	colors,
	addAction,
	removeAction,
	labelParam = 'label',
	labelKeys,
	params,
	projectParam,
	suggestions,
	placeholder = 'Add label',
	size = 'sm',
	readOnly = false,
	emptyText,
	apiBase,
	onAction,
	actionPending,
}: LabelComboboxProps): React.ReactElement {
	const adder = useAction('LabelCombobox', readOnly ? undefined : addAction, onAction, actionPending);
	const remover = useAction('LabelCombobox', readOnly ? undefined : removeAction, onAction, actionPending);
	const baseId = useId();
	const listId = `${baseId}-list`;
	const rootRef = useRef<HTMLDivElement>(null);
	const [text, setText] = useState('');
	const [open, setOpen] = useState(false);
	const [active, setActive] = useState(-1);
	const [problem, setProblem] = useState<string | null>(null);
	const [fetched, setFetched] = useState<LabelSuggestion[]>([]);
	const [loading, setLoading] = useState(false);
	const [loadProblem, setLoadProblem] = useState<string | null>(null);
	const adding = useRef(false);
	const list = Array.isArray(labels) ? labels : [];
	const given = Array.isArray(suggestions) ? suggestions : null;
	const hasGiven = given !== null;
	const busy = adder.busy || remover.busy;

	useEffect(() => {
		if (!open || hasGiven) {
			return undefined;
		}
		const controller = new AbortController();
		setLoading(true);
		setLoadProblem(null);
		getJson('/labels', { project: projectParam || undefined }, { signal: controller.signal, apiBase }).then(
			answer => {
				if (controller.signal.aborted) {
					return;
				}
				try {
					setFetched(suggestionsOf(answer));
				} catch (error) {
					setLoadProblem(problemText(error));
				}
				setLoading(false);
			},
			(error: unknown) => {
				if (isAbort(error) || controller.signal.aborted) {
					return;
				}
				setLoadProblem(problemText(error));
				setLoading(false);
			}
		);
		return () => controller.abort();
		// Only the presence of the suggestions matters: a new array of the same suggestions must not refetch.
	}, [open, hasGiven, projectParam, apiBase]);

	const close = useCallback(() => setOpen(false), []);
	useDismiss(rootRef, open, close);

	const query = text.trim();
	const lower = query.toLowerCase();
	const known = given ?? fetched;
	const currentLower = list.map(l => l.toLowerCase());
	const candidates = known.filter(s => !currentLower.includes(s.label.toLowerCase()));
	const matching = candidates
		.filter(s => lower === '' || s.label.toLowerCase().includes(lower))
		.sort((a, b) => {
			const ap = a.label.toLowerCase().startsWith(lower) ? 0 : 1;
			const bp = b.label.toLowerCase().startsWith(lower) ? 0 : 1;
			return ap - bp || b.count - a.count || a.label.localeCompare(b.label);
		})
		.slice(0, MAX_OPTIONS);
	const exact = known.find(s => s.label.toLowerCase() === lower);
	const options: Option[] = matching.map(s => ({ key: s.label, label: s.label, count: s.count, create: false }));
	if (query !== '' && !exact && !currentLower.includes(lower)) {
		options.push({ key: `create:${query}`, label: query, count: null, create: true });
	}
	const popup = open && (loading || loadProblem !== null || options.length > 0);
	const optionId = (index: number): string => `${baseId}-opt-${index}`;

	const add = async (requested: string): Promise<void> => {
		if (adding.current) {
			return;
		}
		const typed = requested.trim();
		if (typed === '') {
			setProblem(null);
			return;
		}
		if (currentLower.includes(typed.toLowerCase())) {
			setProblem(`This task already has the label "${typed}"`);
			return;
		}
		const label = known.find(s => s.label.toLowerCase() === typed.toLowerCase())?.label ?? typed;
		setProblem(null);
		adding.current = true;
		try {
			if (await adder.run({ ...(params ?? {}) }, { [labelParam]: label })) {
				setText('');
				setOpen(false);
			}
		} finally {
			adding.current = false;
		}
	};

	const remove = async (label: string): Promise<void> => {
		setProblem(null);
		await remover.run({
			...(params ?? {}),
			[labelParam]: label,
			[`${labelParam}Key`]: labelKeys?.[label] ?? pathKeyOf(label),
		});
	};

	const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
		if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
			event.preventDefault();
			if (!open) {
				setOpen(true);
				return;
			}
			if (options.length > 0) {
				const step = event.key === 'ArrowDown' ? 1 : -1;
				setActive(current => Math.min(options.length - 1, Math.max(-1, current + step)));
			}
		} else if (event.key === 'Enter') {
			event.preventDefault();
			// No highlight: the first existing label that matches the typed text (typing "bil" must not create "bil" while "billing"
			// exists); with no match the text is created. The raw text is still reachable: ArrowDown to the Create row.
			const chosen =
				active >= 0 ? options[active] : query === '' ? undefined : options.find(option => !option.create);
			void add(chosen ? chosen.label : text);
		} else if (event.key === 'Escape' && open) {
			event.preventDefault();
			setOpen(false);
		}
	};

	const showField = !readOnly && addAction !== undefined && addAction !== '';
	const showRemove = !readOnly && removeAction !== undefined && removeAction !== '';
	if (list.length === 0 && !showField) {
		return emptyText ? (
			<span data-testid="label-combobox" className="text-sm text-muted">
				{emptyText}
			</span>
		) : (
			<span data-testid="label-combobox" />
		);
	}
	return (
		<div ref={rootRef} data-testid="label-combobox" className="relative flex flex-col gap-1">
			<div className="flex flex-wrap items-center gap-1.5">
				{list.map(label => (
					<span
						key={label}
						data-testid="label-chip"
						className={`inline-flex max-w-full items-center gap-1 rounded-full font-medium ${SIZE[size]} ${chipClass(label, colors)}`}
					>
						<span className="truncate">{label}</span>
						{showRemove ? (
							<button
								type="button"
								aria-label={`Remove label ${label}`}
								title={remover.unavailableReason ?? `Remove label ${label}`}
								disabled={!remover.available || busy}
								onClick={() => void remove(label)}
								className="-mr-0.5 inline-flex rounded-full opacity-70 hover:opacity-100 focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-not-allowed disabled:opacity-40"
							>
								<X size={12} aria-hidden="true" />
							</button>
						) : null}
					</span>
				))}
				{showField ? (
					<span className="inline-flex items-center gap-1 text-muted" title={adder.unavailableReason}>
						<Plus size={12} aria-hidden="true" />
						<input
							type="text"
							role="combobox"
							aria-label="Add a label"
							aria-expanded={popup}
							aria-controls={popup ? listId : undefined}
							aria-autocomplete="list"
							aria-activedescendant={
								popup && active >= 0 && options[active] ? optionId(active) : undefined
							}
							aria-busy={busy || undefined}
							autoComplete="off"
							placeholder={placeholder}
							value={text}
							disabled={!adder.available}
							readOnly={busy}
							onFocus={() => setOpen(true)}
							onClick={() => setOpen(true)}
							onChange={event => {
								setText(event.target.value);
								setProblem(null);
								setActive(-1);
								setOpen(true);
							}}
							onKeyDown={onKeyDown}
							onBlur={event => {
								if (!rootRef.current?.contains(event.relatedTarget as Node | null)) {
									setOpen(false);
								}
							}}
							className={`w-28 rounded border border-transparent bg-transparent text-content outline-none placeholder:text-muted hover:border-border focus:border-border focus:ring-1 focus:ring-primary disabled:cursor-not-allowed ${size === 'sm' ? 'px-1 py-0.5 text-xs' : 'px-1.5 py-1 text-sm'}`}
						/>
					</span>
				) : null}
			</div>
			{popup ? (
				<div
					data-testid="label-popup"
					className="absolute left-0 top-full z-30 mt-1 max-h-64 w-64 max-w-[calc(100vw-1rem)] overflow-y-auto rounded-md border border-border bg-surface py-1 shadow-lg"
				>
					{loading
						? Array.from({ length: SKELETON_ROWS }, (_, i) => (
								<div
									key={i}
									data-testid="label-skeleton"
									aria-hidden="true"
									className="flex animate-pulse items-center gap-2 px-3 py-1.5"
								>
									<span className="h-3 flex-1 rounded bg-muted-bg" />
									<span className="h-3 w-6 rounded bg-muted-bg" />
								</div>
							))
						: null}
					{!loading && loadProblem !== null ? (
						<p role="alert" className="px-3 py-2 text-xs text-danger-text">
							{loadProblem}
						</p>
					) : null}
					<div id={listId} role="listbox" aria-busy={loading || undefined} aria-label="Labels">
						{options.map((option, index) => (
							<div
								key={option.key}
								id={optionId(index)}
								role="option"
								aria-selected={index === active}
								onMouseDown={event => event.preventDefault()}
								onMouseEnter={() => setActive(index)}
								onClick={() => void add(option.label)}
								className={`flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm ${index === active ? 'bg-muted-bg' : ''}`}
							>
								{option.create ? (
									<span className="min-w-0 flex-1 truncate text-content">{`Create "${option.label}"`}</span>
								) : (
									<>
										<span className="min-w-0 flex-1 truncate text-content">{option.label}</span>
										<span className="shrink-0 text-xs text-muted">{option.count}</span>
									</>
								)}
							</div>
						))}
					</div>
				</div>
			) : null}
			{problem ? (
				<p role="alert" className="text-xs text-warning-text">
					{problem}
				</p>
			) : null}
		</div>
	);
}
