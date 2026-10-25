import React, { useId, useRef, useState } from 'react';
import { TONE_PILL, toneOf } from '../tones.js';
import type { Tone } from '../tones.js';
import { useAction } from '../useAction.js';
import type { ActionHandler } from '../useAction.js';

export interface SegmentedOption {
	value: string;
	label: string;
	/** Colour of this option while it is the selected one (`pills` only). */
	tone?: Tone;
	disabled?: boolean;
	/** Tooltip. */
	hint?: string;
}

export interface SegmentedControlProps {
	options: SegmentedOption[];
	/** The current value; the page gives the new one after the action ran and the sources reloaded. */
	value: string;
	/** Name of the `$actions` entry run when another option is chosen. Without it the control only displays. */
	action?: string;
	/** Name of the parameter that carries the chosen value (a `{placeholder}` of the action url). */
	valueParam?: string;
	/**
	 * The other `{placeholders}` of the action url (`id`, `projectParam`...). The installed shell sends no body.
	 * @resolveDeep
	 */
	params?: Record<string, unknown>;
	/** `segmented`: one bordered track. `pills`: separate rounded buttons. `tabs`: underline. */
	appearance?: 'segmented' | 'pills' | 'tabs';
	size?: 'sm' | 'md';
	fullWidth?: boolean;
	/** The accessible name of the group. */
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
const TRACK: Record<NonNullable<SegmentedControlProps['appearance']>, string> = {
	segmented: 'inline-flex rounded-md border border-border bg-muted-bg p-0.5',
	pills: 'inline-flex flex-wrap gap-1',
	tabs: 'inline-flex border-b border-border',
};
const SIZE: Record<NonNullable<SegmentedControlProps['size']>, string> = {
	sm: 'px-2.5 py-1 text-xs',
	md: 'px-3.5 py-1.5 text-sm',
};
const OFF: Record<NonNullable<SegmentedControlProps['appearance']>, string> = {
	segmented: 'rounded text-muted hover:text-content',
	pills: 'rounded-full border border-border text-muted hover:bg-muted-bg',
	tabs: 'border-b-2 border-transparent text-muted hover:text-content',
};
// @formatter:on

function selectedClass(appearance: NonNullable<SegmentedControlProps['appearance']>, tone: Tone | undefined): string {
	if (appearance === 'segmented') {
		return 'rounded bg-surface font-medium text-content shadow-sm';
	}
	if (appearance === 'tabs') {
		return 'border-b-2 border-primary font-medium text-content';
	}
	return `rounded-full border border-transparent font-medium ${tone ? TONE_PILL[toneOf(tone)] : 'bg-primary-light text-primary'}`;
}

/**
 * A row of exclusive choices. With an `action` a click runs it at once (change a status in one click); without, it
 * only displays the current choice.
 *
 * IN SCOPE: few options, shown all at once. OUT OF SCOPE: many options (use ActionSelect), multi-select.
 *
 * @registryCategory atomic
 * @registryTags segmented buttons choice status action
 */
export function SegmentedControl({
	options,
	value,
	action,
	valueParam = 'value',
	params,
	appearance = 'segmented',
	size = 'sm',
	fullWidth = false,
	ariaLabel,
	onAction,
	actionPending,
}: SegmentedControlProps): React.ReactElement {
	const runner = useAction('SegmentedControl', action, onAction, actionPending);
	const [chosen, setChosen] = useState<string | null>(null);
	const root = useRef<HTMLDivElement>(null);
	const groupName = useId();
	const hasAction = action !== undefined && action !== '';
	const list = Array.isArray(options) ? options : [];
	const shown = chosen ?? value;
	const interactive = runner.available;

	const choose = async (next: string): Promise<void> => {
		const option = list.find(o => o.value === next);
		if (!interactive || runner.busy || !option || option.disabled || next === shown) {
			return;
		}
		setChosen(next);
		await runner.run({ ...(params ?? {}), [valueParam]: next });
		// The page reloads its sources before the handler resolves: from here on `value` is the truth.
		setChosen(null);
	};

	const onKeyDown = (event: React.KeyboardEvent): void => {
		const step =
			event.key === 'ArrowRight' || event.key === 'ArrowDown'
				? 1
				: event.key === 'ArrowLeft' || event.key === 'ArrowUp'
					? -1
					: 0;
		if (step === 0) {
			return;
		}
		event.preventDefault();
		const enabled = list.filter(o => !o.disabled);
		const at = enabled.findIndex(o => o.value === shown);
		const target = enabled[(at + step + enabled.length) % enabled.length];
		if (!target) {
			return;
		}
		const inputs = root.current?.querySelectorAll<HTMLInputElement>('input[type="radio"]');
		inputs?.forEach(input => {
			if (input.value === target.value) {
				input.focus();
			}
		});
		void choose(target.value);
	};

	return (
		<div
			ref={root}
			role="radiogroup"
			aria-label={ariaLabel}
			aria-busy={runner.busy || undefined}
			title={runner.unavailableReason}
			data-testid="segmented-control"
			data-appearance={appearance}
			onKeyDown={onKeyDown}
			className={`${TRACK[appearance]}${fullWidth ? ' w-full' : ''}${runner.busy ? ' opacity-70' : ''}`}
		>
			{list.map(option => {
				const selected = option.value === shown;
				const disabled = hasAction && (!interactive || runner.busy);
				return (
					<label
						key={option.value}
						title={option.hint}
						className={`inline-flex cursor-pointer select-none items-center justify-center whitespace-nowrap transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-primary${fullWidth ? ' flex-1' : ''}${disabled || option.disabled ? ' cursor-not-allowed opacity-50' : ''} ${SIZE[size]} ${selected ? selectedClass(appearance, option.tone) : OFF[appearance]}`}
					>
						<input
							type="radio"
							className="sr-only"
							name={groupName}
							value={option.value}
							checked={selected}
							disabled={disabled || option.disabled === true}
							onChange={() => void choose(option.value)}
						/>
						{option.label}
					</label>
				);
			})}
		</div>
	);
}
