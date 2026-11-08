import React, { useEffect, useRef, useState } from 'react';
import { ApiProblem, getJson, isAbort, problemText } from '../apiFetch.js';
import { pathKeyOf } from '../pathKey.js';
import { CHIP_PALETTE, TONE_PILL, hashIndex, isTone } from '../tones.js';
import { useAction } from '../useAction.js';
import type { ActionHandler, ActionRunner } from '../useAction.js';
import { ChipField } from '../ui/ChipField.js';
import { SuggestBox } from '../ui/SuggestBox.js';
import type { SuggestOption } from '../ui/SuggestBox.js';

export interface LabelSuggestion {
	label: string;
	count: number;
}

export interface LabelComboboxProps {
	/** The labels of the task. */
	labels: string[];
	/** Colour of a label by name: a tone (`danger`, `success`, `info`, `warning`, `purple`, `neutral`). Others are coloured from a stable hash of the text. */
	colors?: Record<string, string>;
	/** Name of the `$actions` entry that adds a label; the label travels in the body under `labelParam`. Without it there is no "+ Add" chip. */
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
	/** The labels to suggest, with how many tasks carry each. Without them the labels route is asked when the popover opens. */
	suggestions?: LabelSuggestion[];
	/** Placeholder of the input in the popover. */
	placeholder?: string;
	/** Kept for compatibility with older views; ignored, every chip has the one control height. */
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

const MAX_OPTIONS = 8;

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

interface AddPanelProps {
	adder: ActionRunner;
	current: string[];
	given: LabelSuggestion[] | null;
	labelParam: string;
	params: Record<string, unknown> | undefined;
	projectParam: string | undefined;
	placeholder: string;
	apiBase: string | undefined;
	close: () => void;
}

/** The popover of "+ Add": one input, suggestions below it (existing labels with their count, then "Create"). */
function AddPanel({
	adder,
	current,
	given,
	labelParam,
	params,
	projectParam,
	placeholder,
	apiBase,
	close,
}: AddPanelProps): React.ReactElement {
	const [text, setText] = useState('');
	const [problem, setProblem] = useState<string | null>(null);
	const [fetched, setFetched] = useState<LabelSuggestion[]>([]);
	const [loading, setLoading] = useState(false);
	const [loadProblem, setLoadProblem] = useState<string | null>(null);
	const adding = useRef(false);
	const hasGiven = given !== null;

	useEffect(() => {
		if (hasGiven) {
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
	}, [hasGiven, projectParam, apiBase]);

	const query = text.trim();
	const lower = query.toLowerCase();
	const known = given ?? fetched;
	const currentLower = current.map(l => l.toLowerCase());
	const matching = known
		.filter(s => !currentLower.includes(s.label.toLowerCase()))
		.filter(s => lower === '' || s.label.toLowerCase().includes(lower))
		.sort((a, b) => {
			const ap = a.label.toLowerCase().startsWith(lower) ? 0 : 1;
			const bp = b.label.toLowerCase().startsWith(lower) ? 0 : 1;
			return ap - bp || b.count - a.count || a.label.localeCompare(b.label);
		})
		.slice(0, MAX_OPTIONS);
	const exact = known.find(s => s.label.toLowerCase() === lower);
	const options: SuggestOption[] = matching.map(s => ({
		key: s.label,
		label: s.label,
		hint: String(s.count),
	}));
	if (query !== '' && !exact && !currentLower.includes(lower)) {
		options.push({ key: `create:${query}`, label: query, create: true });
	}

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
				close();
			}
		} finally {
			adding.current = false;
		}
	};

	return (
		<>
			<SuggestBox
				ariaLabel="Add a label"
				placeholder={placeholder}
				value={text}
				onChange={value => {
					setText(value);
					setProblem(null);
				}}
				options={options}
				listLabel="Labels"
				loading={loading}
				loadProblem={loadProblem}
				busy={adder.busy}
				autoFocus
				// No highlight: the first existing label that matches the typed text (typing "bil" must not create "bil" while "billing"
				// exists); with no match the text is created. The raw text is still reachable: ArrowDown to the Create row.
				onSubmit={highlighted => {
					const chosen = highlighted ?? (query === '' ? undefined : options.find(option => !option.create));
					void add(chosen ? chosen.label : text);
				}}
				onPick={option => void add(option.label)}
			/>
			{problem ? (
				<p role="alert" className="text-xs text-warning-text">
					{problem}
				</p>
			) : null}
		</>
	);
}

/**
 * The labels of a task as chips (x removes) and a trailing "+ Add" chip that opens a popover with one input: existing
 * labels of the project come first with their count, Enter adds the highlighted suggestion (else the first matching
 * one, else creates the typed text). Each change runs a page action at once. Built on the same ChipField as
 * MetaEditor, so both look and behave the same.
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
	readOnly = false,
	emptyText,
	apiBase,
	onAction,
	actionPending,
}: LabelComboboxProps): React.ReactElement {
	const adder = useAction('LabelCombobox', readOnly ? undefined : addAction, onAction, actionPending);
	const remover = useAction('LabelCombobox', readOnly ? undefined : removeAction, onAction, actionPending);
	const list = Array.isArray(labels) ? labels : [];
	const given = Array.isArray(suggestions) ? suggestions : null;

	const remove = async (label: string): Promise<void> => {
		await remover.run({
			...(params ?? {}),
			[labelParam]: label,
			[`${labelParam}Key`]: labelKeys?.[label] ?? pathKeyOf(label),
		});
	};

	const showAdd = !readOnly && addAction !== undefined && addAction !== '';
	const showRemove = !readOnly && removeAction !== undefined && removeAction !== '';
	if (list.length === 0 && !showAdd) {
		return emptyText ? (
			<span data-testid="label-combobox" className="text-sm text-muted">
				{emptyText}
			</span>
		) : (
			<span data-testid="label-combobox" />
		);
	}
	return (
		<ChipField
			testId="label-combobox"
			chipTestId="label-chip"
			chips={list.map(label => ({
				key: label,
				content: label,
				title: label,
				colorClass: chipClass(label, colors),
				removeLabel: `Remove label ${label}`,
			}))}
			addLabel="Add label"
			canAdd={showAdd}
			addUnavailableReason={adder.available ? undefined : (adder.unavailableReason ?? 'No page action to run')}
			canRemove={showRemove}
			removeOff={!remover.available}
			removeUnavailableReason={remover.unavailableReason}
			busy={adder.busy || remover.busy}
			onRemove={label => void remove(label)}
			renderPanel={({ close }) => (
				<AddPanel
					adder={adder}
					current={list}
					given={given}
					labelParam={labelParam}
					params={params}
					projectParam={projectParam}
					placeholder={placeholder}
					apiBase={apiBase}
					close={close}
				/>
			)}
		/>
	);
}
