import { TaskConflictError } from '@wadeck-app/task-core';

/**
 * A claim of a task whose status ends it (terminal in the project config). `--force` does not override it: forcing is for a live
 * lease, not for a closed task. Nothing was written.
 */
export class TaskClosedError extends TaskConflictError {
	readonly hint: string;

	constructor(
		readonly taskId: string,
		readonly status: string
	) {
		super(`Task "${taskId}" is closed (status "${status}") and cannot be claimed; nothing was written`);
		this.name = 'TaskClosedError';
		this.hint = `--force does not apply to a closed task: reopen it first with task set-status ${taskId} <status>, then claim it.`;
	}
}
