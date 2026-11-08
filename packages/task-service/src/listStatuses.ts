import type { StatusOutcome } from '@wadeck-app/task-core';

import type { TaskServiceContext } from './context.js';

/** One valid status of the project. */
export interface StatusInfo {
	name: string;
	/** The status a new task starts in (exactly one). */
	default: boolean;
	/** The tasks in it are closed (hidden by default, they unblock what they block). */
	terminal: boolean;
	/** How a terminal status ended: `positive` (default, e.g. done) or `negative` (e.g. rejected). Absent on non-terminal statuses. A negative one still unblocks. */
	outcome?: StatusOutcome;
}

/**
 * The valid statuses of the project in config order: the list `set-status` validates against (the merged project config).
 */
export function listStatuses(ctx: TaskServiceContext): StatusInfo[] {
	const { statuses, defaultStatus, terminalStatuses, negativeStatuses } = ctx.config;
	return statuses.map(name => {
		const terminal = terminalStatuses.includes(name);
		return {
			name,
			default: name === defaultStatus,
			terminal,
			...(terminal
				? { outcome: negativeStatuses.includes(name) ? ('negative' as const) : ('positive' as const) }
				: {}),
		};
	});
}
