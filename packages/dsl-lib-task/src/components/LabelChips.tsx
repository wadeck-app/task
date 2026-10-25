import { Plus, X } from 'lucide-react';
import React, { useState } from 'react';
import { CHIP_PALETTE, TONE_PILL, hashIndex, isTone } from '../tones.js';
import { useAction } from '../useAction.js';
import type { ActionHandler } from '../useAction.js';

export interface LabelChipsProps {
	/** The labels of the task. */
	labels: string[];
	/** Colour of a label by name: a tone (`danger`, `success`, `info`, `warning`, `purple`, `neutral`). Others are coloured from a stable hash of the text. */
	colors?: Record<string, string>;
	/** Name of the `$actions` entry that adds a label (the inline field). Without it there is no field. */
	addAction?: string;
	/** Name of the `$actions` entry that removes a label (the x of each chip). Without it there is no x. */
	removeAction?: string;
	/** Name of the parameter that carries the label (a `{placeholder}` of the action urls). */
	labelParam?: string;
	/**
	 * The other `{placeholders}` of the action url (`id`, `projectParam`...). The installed shell sends no body.
	 * @resolveDeep
	 */
	params?: Record<string, unknown>;
	placeholder?: string;
	size?: 'sm' | 'md';
	/** Draws the chips only, whatever the actions. */
	readOnly?: boolean;
	/** Shown when there is no label and nothing to add. */
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

// @formatter:off
const SIZE: Record<NonNullable<LabelChipsProps['size']>, string> = {
	sm: 'px-2 py-0.5 text-xs',
	md: 'px-2.5 py-1 text-sm',
};
// @formatter:on

function chipClass(label: string, colors: Record<string, string> | undefined): string {
	const given = colors?.[label];
	if (given !== undefined && isTone(given)) {
		return TONE_PILL[given];
	}
	return CHIP_PALETTE[hashIndex(label, CHIP_PALETTE.length)]!;
}

/**
 * The labels of a task as coloured chips, with an x to remove one and an inline field to add one. Each change runs
 * a page action at once.
 *
 * @registryCategory composite
 * @registryTags labels chips tags action
 */
export function LabelChips({
	labels,
	colors,
	addAction,
	removeAction,
	labelParam = 'label',
	params,
	placeholder = 'Add label',
	size = 'sm',
	readOnly = false,
	emptyText,
	onAction,
	actionPending,
}: LabelChipsProps): React.ReactElement {
	const adder = useAction('LabelChips', readOnly ? undefined : addAction, onAction, actionPending);
	const remover = useAction('LabelChips', readOnly ? undefined : removeAction, onAction, actionPending);
	const [draft, setDraft] = useState('');
	const [problem, setProblem] = useState<string | null>(null);
	const list = Array.isArray(labels) ? labels : [];
	const busy = adder.busy || remover.busy;

	const add = async (): Promise<void> => {
		const text = draft.trim();
		if (text === '') {
			setProblem(null);
			return;
		}
		if (list.some(l => l.toLowerCase() === text.toLowerCase())) {
			setProblem(`This task already has the label "${text}"`);
			return;
		}
		setProblem(null);
		if (await adder.run({ ...(params ?? {}), [labelParam]: text })) {
			setDraft('');
		}
	};

	const remove = async (label: string): Promise<void> => {
		setProblem(null);
		await remover.run({ ...(params ?? {}), [labelParam]: label });
	};

	const showField = !readOnly && addAction !== undefined && addAction !== '';
	const showRemove = !readOnly && removeAction !== undefined && removeAction !== '';
	if (list.length === 0 && !showField) {
		return emptyText ? (
			<span data-testid="label-chips" className="text-sm text-muted">
				{emptyText}
			</span>
		) : (
			<span data-testid="label-chips" />
		);
	}
	return (
		<div data-testid="label-chips" className="flex flex-col gap-1">
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
							aria-label="Add a label"
							placeholder={placeholder}
							value={draft}
							disabled={!adder.available || busy}
							onChange={event => {
								setDraft(event.target.value);
								setProblem(null);
							}}
							onKeyDown={event => {
								if (event.key === 'Enter') {
									event.preventDefault();
									void add();
								}
							}}
							onBlur={() => {
								if (draft.trim() !== '') {
									void add();
								}
							}}
							className={`w-24 rounded border border-transparent bg-transparent text-content outline-none placeholder:text-muted hover:border-border focus:border-border focus:ring-1 focus:ring-primary disabled:cursor-not-allowed ${size === 'sm' ? 'px-1 py-0.5 text-xs' : 'px-1.5 py-1 text-sm'}`}
						/>
					</span>
				) : null}
			</div>
			{problem ? (
				<p role="alert" className="text-xs text-warning-text">
					{problem}
				</p>
			) : null}
		</div>
	);
}
