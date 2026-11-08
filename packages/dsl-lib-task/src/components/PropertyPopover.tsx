import { Check, ChevronDown } from 'lucide-react';
import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { TONE_DOT, TONE_PILL, toneOf } from '../tones.js';
import type { Tone } from '../tones.js';
import { useAction } from '../useAction.js';
import type { ActionHandler } from '../useAction.js';
import { useDismiss } from '../useDismiss.js';
import { InsidePopoverContext } from '../ui/popoverContext.js';
import {
	CONTROL_BORDER,
	CONTROL_H,
	CONTROL_RADIUS,
	CONTROL_TEXT,
	FOCUS_RING,
	GAP_CONTROLS,
	ICON_SIZE,
	PILL_RADIUS,
	PILL_TEXT,
	POPOVER_PANEL_CLASS,
} from '../ui/tokens.js';

export interface PropertyPopoverOption {
	value: string;
	label: string;
	/** A short muted note after the label (`terminal`). */
	hint?: string;
	/** Colour of the dot in front of the option. */
	tone?: Tone;
}

export interface PropertyPopoverProps {
	/** The name of the property (`Status`, `Type`, `Parent`). It is part of the accessible name of the trigger. */
	label: string;
	/** The current value as text. Empty shows `empty`. */
	valueText?: string;
	/** Shown in place of an empty value. */
	empty?: string;
	/** Colour of the trigger. Without it the trigger is a bordered button. */
	tone?: Tone;
	/**
	 * `pill`: tinted capsule. `row`: label and value on one line, full width. `field`: the value only and a chevron, full
	 * width, the border shows on hover (the label is the accessible name, not drawn). `button`: like `pill` with the
	 * radius of a button.
	 */
	appearance?: 'pill' | 'row' | 'field' | 'button';
	/** `field` only: this text, muted and right aligned, replaces the chevron (`Edit`). */
	actionLabel?: string;
	/** `end`: the panel is anchored to the right edge of the trigger (a popover at the right edge of a header). */
	align?: 'start' | 'end';
	/** The choices. Without them the popover shows its `items`. */
	options?: PropertyPopoverOption[];
	/** The value of the current choice (marked, and picking it again only closes). */
	value?: string;
	/** Name of the `$actions` entry run when a choice is picked. */
	action?: string;
	/** Name of the parameter that carries the picked value (a `{placeholder}` of the action url). */
	valueParam?: string;
	/** When set, the picked value travels in the JSON body under this key instead of in the params. */
	bodyKey?: string;
	/**
	 * The other `{placeholders}` of the action url (`id`, `projectParam`...).
	 * @resolveDeep
	 */
	params?: Record<string, unknown>;
	/** Names of page actions run from the `items` content: the popover closes when one of them has finished. */
	closeOnActions?: string[];
	disabled?: boolean;
	/**
	 * The content when there are no options (a picker, a form).
	 * @slot tag:layout, tag:display, tag:composite, tag:atomic, tag:form
	 */
	items?: React.ReactNode;
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

/**
 * A property of a task (status, type, parent) as a pill or a row that opens a popover: a list of choices that runs an
 * action on pick and closes, or any content. Below 640 px the popover is a full-width sheet at the bottom.
 *
 * IN SCOPE: one property, one popover. OUT OF SCOPE: free text (use InlineText) and several choices (LabelCombobox).
 *
 * @registryCategory composite
 * @registryTags property popover pill status type parent picker
 */
export function PropertyPopover({
	label,
	valueText,
	empty = 'none',
	tone,
	appearance = 'pill',
	actionLabel,
	align = 'start',
	options,
	value,
	action,
	valueParam = 'value',
	bodyKey,
	params,
	closeOnActions,
	disabled = false,
	items,
	onAction,
	actionPending,
}: PropertyPopoverProps): React.ReactElement {
	const runner = useAction(
		'PropertyPopover',
		options && options.length > 0 ? action : undefined,
		onAction,
		actionPending
	);
	const id = useId();
	const list = Array.isArray(options) ? options : [];
	const hasOptions = list.length > 0;
	const [open, setOpen] = useState(false);
	const [busy, setBusy] = useState(false);
	const [active, setActive] = useState(0);
	const picking = useRef(false);
	const root = useRef<HTMLSpanElement>(null);
	const trigger = useRef<HTMLButtonElement>(null);
	const listbox = useRef<HTMLDivElement>(null);
	const resolvedTone = tone === undefined ? undefined : toneOf(tone);
	const text = valueText !== undefined && valueText !== '' ? valueText : empty;
	const unavailable = hasOptions && action !== undefined && action !== '' && !runner.available;
	const off = disabled || unavailable || (hasOptions && (action === undefined || action === ''));

	const close = useCallback((returnFocus: boolean): void => {
		setOpen(false);
		if (returnFocus) {
			trigger.current?.focus();
		}
	}, []);
	const dismiss = useCallback(() => close(false), [close]);
	useDismiss(root, open, dismiss);

	const panel = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (!open) {
			return;
		}
		if (hasOptions) {
			listbox.current?.focus();
			return;
		}
		// A picker or a form: the first field takes the focus, so what the user types lands in it.
		panel.current?.querySelector<HTMLElement>('input, textarea, select, button')?.focus();
	}, [open, hasOptions]);

	// The popover closes when an action of the content has finished (running -> idle).
	const anyRunning = (closeOnActions ?? []).some(name => actionPending?.[name] === true);
	const wasRunning = useRef(false);
	useEffect(() => {
		if (wasRunning.current && !anyRunning) {
			close(false);
		}
		wasRunning.current = anyRunning;
	}, [anyRunning, close]);

	const toggle = (): void => {
		if (off) {
			return;
		}
		if (open) {
			close(false);
			return;
		}
		const current = list.findIndex(option => option.value === value);
		setActive(current >= 0 ? current : 0);
		setOpen(true);
	};

	const pick = async (index: number): Promise<void> => {
		const option = list[index];
		if (!option || picking.current) {
			return;
		}
		if (option.value === value) {
			close(true);
			return;
		}
		picking.current = true;
		setBusy(true);
		try {
			const ok =
				bodyKey === undefined
					? await runner.run({ ...(params ?? {}), [valueParam]: option.value })
					: await runner.run({ ...(params ?? {}) }, { [bodyKey]: option.value });
			if (ok) {
				close(true);
			}
		} finally {
			picking.current = false;
			setBusy(false);
		}
	};

	const onListKey = (event: React.KeyboardEvent): void => {
		const last = list.length - 1;
		if (event.key === 'ArrowDown') {
			event.preventDefault();
			setActive(index => Math.min(index + 1, last));
		} else if (event.key === 'ArrowUp') {
			event.preventDefault();
			setActive(index => Math.max(index - 1, 0));
		} else if (event.key === 'Home') {
			event.preventDefault();
			setActive(0);
		} else if (event.key === 'End') {
			event.preventDefault();
			setActive(last);
		} else if (event.key === 'Enter' || event.key === ' ') {
			event.preventDefault();
			void pick(active);
		} else if (event.key === 'Tab') {
			close(false);
		}
	};

	const full = appearance === 'row' || appearance === 'field';
	const tinted = resolvedTone ? TONE_PILL[resolvedTone] : `${CONTROL_BORDER} bg-surface text-content`;
	let look: string;
	if (full) {
		look = `${CONTROL_H} w-full justify-between ${CONTROL_RADIUS} border border-transparent px-2 ${CONTROL_TEXT} hover:border-border`;
	} else if (appearance === 'button') {
		look = `${CONTROL_H} ${CONTROL_RADIUS} px-3 ${CONTROL_TEXT} font-semibold ${tinted}`;
	} else {
		look = `${CONTROL_H} ${PILL_RADIUS} px-3 ${PILL_TEXT} ${tinted}`;
	}
	// A field panel is at least as wide as the trigger (and as a plain panel).
	const widthBase =
		appearance === 'field'
			? POPOVER_PANEL_CLASS.replace('min-w-[12rem]', 'min-w-[max(100%,12rem)]')
			: POPOVER_PANEL_CLASS;
	const panelBase = align === 'end' ? widthBase.replace('left-0', 'right-0') : widthBase;

	return (
		<span
			ref={root}
			data-testid="property-popover"
			data-tone={resolvedTone}
			className={`relative ${full ? 'flex w-full' : 'inline-flex'}`}
			onKeyDown={event => {
				if (event.key === 'Escape' && open) {
					event.stopPropagation();
					close(true);
				}
			}}
		>
			<button
				ref={trigger}
				type="button"
				aria-label={`${label}: ${text}`}
				aria-haspopup={hasOptions ? 'listbox' : 'dialog'}
				aria-expanded={open}
				aria-controls={open ? `${id}-panel` : undefined}
				disabled={off}
				title={runner.unavailableReason}
				onClick={toggle}
				className={`inline-flex min-w-0 items-center ${GAP_CONTROLS} ${FOCUS_RING} disabled:cursor-not-allowed disabled:opacity-60 ${look}`}
			>
				{appearance === 'row' ? <span className="shrink-0 text-muted">{label}</span> : null}
				<span className={appearance === 'field' ? 'min-w-0 flex-1 truncate text-left' : 'truncate'}>
					{text}
				</span>
				{appearance === 'field' && actionLabel ? (
					<span className="ml-auto shrink-0 text-muted">{actionLabel}</span>
				) : (
					<ChevronDown size={ICON_SIZE} aria-hidden="true" className="shrink-0 opacity-70" />
				)}
			</button>
			{open ? (
				<>
					<div
						data-testid="property-popover-backdrop"
						aria-hidden="true"
						onClick={() => close(true)}
						className="fixed inset-0 z-20 bg-black/30 sm:hidden"
					/>
					<div
						ref={panel}
						id={`${id}-panel`}
						data-testid="property-popover-panel"
						className={`${panelBase} ${hasOptions ? '' : 'w-80'}`}
					>
						{hasOptions ? (
							<div
								ref={listbox}
								role="listbox"
								tabIndex={-1}
								aria-label={label}
								aria-busy={busy}
								aria-activedescendant={`${id}-opt-${active}`}
								onKeyDown={onListKey}
								className="flex flex-col outline-none"
							>
								{list.map((option, index) => (
									<div
										key={option.value}
										id={`${id}-opt-${index}`}
										role="option"
										aria-selected={option.value === value}
										onMouseEnter={() => setActive(index)}
										onClick={() => void pick(index)}
										className={`flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm text-content ${index === active ? 'bg-muted-bg' : ''} ${busy ? 'opacity-60' : ''}`}
									>
										<span
											aria-hidden="true"
											className={`h-2 w-2 shrink-0 rounded-full ${option.tone ? TONE_DOT[toneOf(option.tone)] : 'bg-transparent'}`}
										/>
										<span className="min-w-0 flex-1 truncate">{option.label}</span>
										{option.hint ? (
											<span className="shrink-0 text-xs text-muted">{option.hint}</span>
										) : null}
										{option.value === value ? <Check size={ICON_SIZE} aria-hidden="true" /> : null}
									</div>
								))}
							</div>
						) : (
							<InsidePopoverContext.Provider value={true}>
								<div className="flex flex-col gap-2">{items}</div>
							</InsidePopoverContext.Provider>
						)}
					</div>
				</>
			) : null}
		</span>
	);
}
