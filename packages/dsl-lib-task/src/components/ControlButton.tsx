import React from 'react';
import { useAction } from '../useAction.js';
import type { ActionHandler } from '../useAction.js';
import { isIconName, NAMED_ICONS } from '../ui/icons.js';
import type { IconName } from '../ui/icons.js';
import {
	CONTROL_BORDER,
	CONTROL_H,
	CONTROL_RADIUS,
	FOCUS_RING,
	GAP_CONTROLS,
	ICON_SIZE,
	PILL_TEXT,
} from '../ui/tokens.js';

export interface ControlButtonProps {
	/** The text of the button (also its accessible name). */
	label: string;
	/** A Lucide icon before the text: `plus`, `trash`, `link`, `unlink`, `sub-task`, `add-sub-task`. */
	icon?: IconName;
	/** `secondary`: a bordered neutral button. `danger`: the same shape in the danger colour (the delete). */
	variant?: 'secondary' | 'danger';
	/** The tooltip. */
	hint?: string;
	/** Name of the `$actions` entry run on click. Without it the button only takes the click of a container (a Dialog trigger). */
	action?: string;
	/**
	 * The `{placeholders}` of the action url (`id`, `projectParam`...).
	 * @resolveDeep
	 */
	params?: Record<string, unknown>;
	disabled?: boolean;
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
const VARIANT: Record<NonNullable<ControlButtonProps['variant']>, string> = {
	secondary: `${CONTROL_BORDER} bg-surface text-content hover:bg-muted-bg`,
	danger: 'border border-danger bg-surface text-danger hover:bg-danger-bg',
};
// @formatter:on

/**
 * A button with the height, radius and text of every other control of the page (h-8). It is the trigger of a dialog
 * (the click reaches the dialog) or runs a page action.
 *
 * IN SCOPE: one labelled button. OUT OF SCOPE: menus (never a menu for a single entry), forms.
 *
 * @registryCategory atomic
 * @registryTags button control delete danger secondary
 */
export function ControlButton({
	label,
	icon,
	variant = 'secondary',
	hint,
	action,
	params,
	disabled = false,
	onAction,
	actionPending,
}: ControlButtonProps): React.ReactElement {
	const runner = useAction('ControlButton', action, onAction, actionPending);
	const Glyph = isIconName(icon) ? NAMED_ICONS[icon] : null;
	const off = disabled || (action !== undefined && action !== '' && (!runner.available || runner.busy));
	return (
		<button
			type="button"
			disabled={off}
			title={hint ?? runner.unavailableReason}
			onClick={action ? () => void runner.run({ ...(params ?? {}) }) : undefined}
			className={`inline-flex ${CONTROL_H} shrink-0 items-center ${GAP_CONTROLS} ${CONTROL_RADIUS} px-3 ${PILL_TEXT} ${FOCUS_RING} disabled:cursor-not-allowed disabled:opacity-60 ${VARIANT[variant === 'danger' ? 'danger' : 'secondary']}`}
		>
			{Glyph ? <Glyph size={ICON_SIZE} aria-hidden="true" /> : null}
			<span>{label}</span>
		</button>
	);
}
