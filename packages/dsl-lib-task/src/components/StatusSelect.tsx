import React from 'react';
import { toneOf } from '../tones.js';
import type { Tone } from '../tones.js';
import type { ActionHandler } from '../useAction.js';
import { PropertyPopover } from './PropertyPopover.js';

export interface StatusSelectOption {
	value: string;
	label: string;
	/** Colour of the pill while this status is the current one, and of its dot in the list. */
	tone?: Tone;
	/** A terminal status (done, cancelled): the list says so. */
	terminal?: boolean;
}

export interface StatusSelectProps {
	/** The statuses, in the order of the list. */
	options: StatusSelectOption[];
	/** The value of the current status; the page gives the new one after the action ran and the sources reloaded. */
	current: string;
	/** Name of the `$actions` entry run when a status is picked. Empty = the pill cannot open. */
	action: string;
	/** The name of the property, part of the accessible name of the pill (`Status: In progress`). */
	label?: string;
	/** Name of the parameter that carries the picked value (a `{placeholder}` of the action url). */
	valueParam?: string;
	/** When set, the picked value travels in the JSON body under this key instead of in the params. */
	bodyKey?: string;
	/**
	 * The other `{placeholders}` of the action url (`id`, `projectParam`...).
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

/**
 * The status of a task as ONE compact pill that shows the current status and opens the list of statuses only when
 * the user wants to change it (never an always-visible stepper). Same height and radius as every other pill of the
 * page; picking a status runs a page action at once.
 *
 * IN SCOPE: one closed list of statuses (also fits a type). OUT OF SCOPE: free values (use PropertyPopover items).
 *
 * @registryCategory composite
 * @registryTags status select pill dropdown transition
 */
export function StatusSelect({
	options,
	current,
	action,
	label = 'Status',
	valueParam = 'status',
	bodyKey,
	params,
	disabled = false,
	onAction,
	actionPending,
}: StatusSelectProps): React.ReactElement {
	const list = Array.isArray(options) ? options : [];
	const active = list.find(option => option.value === current);
	const choices = list.map(option => ({
		value: option.value,
		label: option.label,
		tone: option.tone,
		hint: option.terminal === true ? 'terminal' : undefined,
	}));
	return (
		<PropertyPopover
			label={label}
			appearance="pill"
			valueText={active ? active.label : current}
			tone={active?.tone === undefined ? undefined : toneOf(active.tone)}
			options={choices}
			value={current}
			action={action}
			valueParam={valueParam}
			bodyKey={bodyKey}
			params={params}
			disabled={disabled}
			onAction={onAction}
			actionPending={actionPending}
		/>
	);
}
