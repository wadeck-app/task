import type { TaskServiceContext } from './context.js';

/** One valid status of the project. */
export interface StatusInfo {
	name: string;
	/** The status a new task starts in (exactly one). */
	default: boolean;
	/** The tasks in it are closed (hidden by default, they unblock what they block). */
	terminal: boolean;
}

/**
 * The valid statuses of the project in config order: the list `set-status` validates against (the merged project config).
 */
export function listStatuses(ctx: TaskServiceContext): StatusInfo[] {
	const { statuses, defaultStatus, terminalStatuses } = ctx.config;
	return statuses.map(name => ({
		name,
		default: name === defaultStatus,
		terminal: terminalStatuses.includes(name),
	}));
}
