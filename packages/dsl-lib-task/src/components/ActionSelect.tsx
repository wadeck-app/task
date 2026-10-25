import { ChevronDown } from 'lucide-react';
import React, { useState } from 'react';
import { TONE_DOT, TONE_PILL, toneOf } from '../tones.js';
import type { Tone } from '../tones.js';
import { useAction } from '../useAction.js';
import type { ActionHandler } from '../useAction.js';

export interface ActionSelectOption {
	value: string;
	label: string;
	/** Colour of the dot (and of the pill with `appearance: pill`) while this option is the current one. */
	tone?: Tone;
}

export interface ActionSelectProps {
	options: ActionSelectOption[];
	/** The current value; the page gives the new one after the action ran and the sources reloaded. */
	value: string;
	/** Name of the `$actions` entry run on every change. There is no Save button. */
	action: string;
	/** Name of the parameter that carries the chosen value (a `{placeholder}` of the action url). */
	valueParam?: string;
	/**
	 * The other `{placeholders}` of the action url (`id`, `projectParam`...). The installed shell sends no body.
	 * @resolveDeep
	 */
	params?: Record<string, unknown>;
	/** Text of the empty choice, shown while the value is empty. */
	placeholder?: string;
	/** Keeps the empty choice selectable, so the value can be cleared (the action then receives an empty string). */
	allowEmpty?: boolean;
	/** `field`: bordered select. `pill`: tinted capsule coloured by the current option. `ghost`: bare until hovered. */
	appearance?: 'field' | 'pill' | 'ghost';
	disabled?: boolean;
	/** The accessible name of the select. */
	ariaLabel?: string;
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
const LOOK: Record<NonNullable<ActionSelectProps['appearance']>, string> = {
	field: 'rounded-md border border-border bg-surface text-content',
	pill: 'rounded-full font-medium',
	ghost: 'rounded-md border border-transparent text-content hover:border-border',
};
// @formatter:on

/**
 * A select that runs a page action as soon as another value is chosen (status, type...): no Save button. The result
 * and the events the queue did not receive are shown by the page next to it, under the action's `resultKey`.
 *
 * IN SCOPE: one value out of a list, changed in place. OUT OF SCOPE: free text (use LabelChips or a Form).
 *
 * @registryCategory atomic
 * @registryTags select status type action choice
 */
export function ActionSelect({
	options,
	value,
	action,
	valueParam = 'value',
	params,
	placeholder,
	allowEmpty = false,
	appearance = 'field',
	disabled = false,
	ariaLabel,
	onAction,
	actionPending,
}: ActionSelectProps): React.ReactElement {
	const runner = useAction('ActionSelect', action, onAction, actionPending);
	const [chosen, setChosen] = useState<string | null>(null);
	const list = Array.isArray(options) ? options : [];
	const shown = chosen ?? value ?? '';
	const known = list.some(o => o.value === shown);
	const current = list.find(o => o.value === shown);
	const tone = toneOf(current?.tone);

	const change = async (next: string): Promise<void> => {
		if (!runner.available || next === shown) {
			return;
		}
		setChosen(next);
		await runner.run({ ...(params ?? {}), [valueParam]: next });
		// The page reloads its sources before the handler resolves: from here on `value` is the truth.
		setChosen(null);
	};

	return (
		<span
			data-testid="action-select"
			data-tone={tone}
			data-appearance={appearance}
			title={runner.unavailableReason}
			className={`relative inline-flex items-center ${LOOK[appearance]}${appearance === 'pill' ? ` ${TONE_PILL[tone]}` : ''}${runner.busy ? ' opacity-70' : ''}`}
		>
			{appearance === 'pill' ? null : (
				<span
					aria-hidden="true"
					className={`pointer-events-none absolute left-2.5 h-2 w-2 rounded-full ${current?.tone ? TONE_DOT[tone] : 'hidden'}`}
				/>
			)}
			<select
				aria-label={ariaLabel}
				aria-busy={runner.busy || undefined}
				value={shown}
				disabled={disabled || !runner.available || runner.busy}
				onChange={event => void change(event.target.value)}
				className={`min-w-0 cursor-pointer appearance-none bg-transparent py-1 pr-7 text-sm outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-not-allowed ${appearance !== 'pill' && current?.tone ? 'pl-6' : 'pl-3'} ${appearance === 'pill' ? 'rounded-full' : 'rounded-md'}`}
			>
				{placeholder !== undefined || allowEmpty ? (
					<option value="" disabled={!allowEmpty}>
						{placeholder ?? ''}
					</option>
				) : null}
				{known || shown === '' ? null : <option value={shown}>{shown}</option>}
				{list.map(option => (
					<option key={option.value} value={option.value}>
						{option.label}
					</option>
				))}
			</select>
			<ChevronDown size={14} aria-hidden="true" className="pointer-events-none absolute right-2 text-muted" />
		</span>
	);
}
