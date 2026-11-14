import type { TaskRecord, TaskSummary } from '@wadeck-app/task-core';

import { projectEnv, type TaskServiceContext } from './context.js';
import { InvalidStatusError } from './errors.js';
import type { TaskEvent } from './events.js';
import { plain } from './plainRecord.js';
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
export async function setStatus(ctx: TaskServiceContext, input: SetStatusInput): Promise<SetStatusResult> {
	const { store, config } = ctx;
	if (!config.statuses.includes(input.status)) {
		const hint = suggest(input.status, config.statuses);
		throw new InvalidStatusError(input.status, config.statuses, hint === undefined ? [] : [hint]);
	}
	const before = await store.resolve(input.id);
	// The previous status is read before the write; the backend re-reads the record it updates.
	const oldStatus = before.status;
	// Events are built only after the write is awaited: a failed or refused write never yields one.
	const updated = plain(await store.updateStatus(before.id, input.status));
	const events: TaskEvent[] = [
		{
			name: 'onStatusChange',
			payload: {
				taskId: updated.id,
				oldStatus,
				newStatus: updated.status,
				status: updated.status,
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
		openBlockers = await store.getOpenBlockers(updated.id, isTerminal);
		// Tasks whose last open blocker was this one can now move forward.
		unblocked = await store.getUnblockedBy(updated.id, isTerminal);
		for (const summary of unblocked) {
			const record = await store.get(summary.id);
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
