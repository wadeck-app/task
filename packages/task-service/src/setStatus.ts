import type { TaskRecord, TaskSummary } from '@wadeck-app/task-core';

import { projectEnv, type TaskServiceContext } from './context.js';
import { InvalidStatusError } from './errors.js';
import type { TaskEvent } from './events.js';
import { suggest } from './text.js';

export interface SetStatusInput {
	/** Task id or unambiguous prefix. */
	id: string;
	status: string;
}

export interface SetStatusResult {
	task: TaskRecord;
	oldStatus: string;
	/**
	 * Only filled when the task just became terminal: the blockers that are still open
	 * (the caller should warn that the task is closed while still blocked).
	 */
	openBlockers: TaskSummary[];
	/** Only filled when the task just became terminal: tasks whose last open blocker was this one. */
	unblocked: TaskSummary[];
	/** `onStatusChange` first, then one `onTaskUnblocked` per unblocked task. */
	events: TaskEvent[];
}

/** Changes a task's status; the status must be one of the configured `statuses`. */
export function setStatus(ctx: TaskServiceContext, input: SetStatusInput): SetStatusResult {
	const { store, config } = ctx;
	if (!config.statuses.includes(input.status)) {
		const hint = suggest(input.status, config.statuses);
		throw new InvalidStatusError(input.status, config.statuses, hint === undefined ? [] : [hint]);
	}
	const before = store.findByPrefix(input.id);
	// updateStatus() mutates `before` in place: read the previous status first.
	const oldStatus = before.status;
	const updated = store.updateStatus(before.id, input.status, before);
	const events: TaskEvent[] = [
		{
			name: 'onStatusChange',
			payload: {
				taskId: updated.id,
				oldStatus,
				newStatus: updated.status,
				type: updated.type,
				labels: updated.labels ?? [],
				...projectEnv(ctx),
			},
		},
	];

	const isTerminal = (status: string): boolean => config.terminalStatuses.includes(status);
	let openBlockers: TaskSummary[] = [];
	let unblocked: TaskSummary[] = [];
	if (isTerminal(updated.status) && !isTerminal(oldStatus)) {
		openBlockers = store.getOpenBlockers(updated.id, isTerminal);
		// Tasks whose last open blocker was this one can now move forward.
		unblocked = store.getUnblockedBy(updated.id, isTerminal);
		for (const summary of unblocked) {
			const record = store.get(summary.id);
			events.push({
				name: 'onTaskUnblocked',
				payload: {
					taskId: record.id,
					blockerId: updated.id,
					status: record.status,
					type: record.type,
					labels: record.labels ?? [],
					...projectEnv(ctx),
				},
			});
		}
	}
	return { task: updated, oldStatus, openBlockers, unblocked, events };
}
