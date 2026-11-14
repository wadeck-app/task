import { InvalidTaskFieldError, MAX_LEASE_MINUTES } from '@wadeck-app/task-core';
import type { ClaimOutcome, TaskRecord } from '@wadeck-app/task-core';

import { projectEnv, type TaskServiceContext } from './context.js';
import type { AssigneeChangeOutcome, TaskEvent } from './events.js';
import { plain } from './plainRecord.js';
import { TaskClosedError } from './taskClosedError.js';
import { requireTaskField } from './taskFieldSupport.js';

export interface ClaimTaskInput {
	/** Task id or unambiguous prefix. */
	id: string;
	/** Who takes the task: free text, trimmed, at most 100 characters. */
	assignee: string;
	/** Length of the lease, whole minutes 1 to 10080. Absent: `defaults.leaseMinutes` of the project config (30). */
	leaseMinutes?: number;
	/** The assignee already holds the task: extend the lease instead of refusing. */
	renew?: boolean;
	/** Take the task even when someone else holds a live lease. */
	force?: boolean;
	/** The instant the claim is judged at (the lease starts there). Absent: now. */
	now?: Date;
}

/**
 * A claimed task: the stored record plus its `revision`. This is the ONE answer that carries the revision (every other use case
 * strips it through `plain()`): the worker that claimed the task hands it back as the expected revision of its later writes, to
 * detect a concurrent change.
 */
export type ClaimedTask = TaskRecord & { revision: string };

export interface ClaimTaskResult {
	task: ClaimedTask;
	/** `claimed` a free task (or one whose lease was over for the same name), `renewed` the holder's own lease, `takeover` of another holder. */
	outcome: ClaimOutcome;
	/** The holder a takeover replaced. */
	previousAssignee?: string;
	/** ISO instant the lease ends. */
	leaseUntil: string;
	events: TaskEvent[];
}

function assigneeEvent(
	ctx: TaskServiceContext,
	payload: {
		taskId: string;
		oldAssignee: string | undefined;
		newAssignee: string | undefined;
		outcome: AssigneeChangeOutcome;
	}
): TaskEvent {
	return { name: 'onTaskAssigneeChanged', payload: { ...payload, ...projectEnv(ctx) } };
}

function leaseMinutesOf(ctx: TaskServiceContext, requested: number | undefined): number {
	const minutes = requested ?? ctx.config.defaults.leaseMinutes;
	if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_LEASE_MINUTES) {
		throw new InvalidTaskFieldError(
			'lease',
			`a lease is a whole number of minutes, 1 to ${MAX_LEASE_MINUTES} (found ${String(minutes)})`,
			'Give the lease in minutes (for example 30), or leave it out for the default of the project (defaults.leaseMinutes).'
		);
	}
	return minutes;
}

/**
 * Claims a task under a lease: check and write are one step in the backend (local: under the project write lock). Free: claimed.
 * Held by someone else with a live lease: TaskClaimedError naming the holder and the time left, unless `force`. Lease over: taken over
 * without `force`. Held by `assignee` itself: refused unless `renew`, which extends the lease. Fires `onTaskAssigneeChanged` with the
 * outcome (a renewal has the old assignee equal to the new one). A storage that does not carry claims answers UnsupportedByBackendError.
 */
export async function claimTask(ctx: TaskServiceContext, input: ClaimTaskInput): Promise<ClaimTaskResult> {
	await requireTaskField(ctx, 'claim', 'claim');
	const minutes = leaseMinutesOf(ctx, input.leaseMinutes);
	const now = input.now ?? new Date();
	const leaseUntil = new Date(now.getTime() + minutes * 60_000).toISOString();
	const found = await ctx.store.resolve(input.id);
	// The store does not know statuses: a closed task is refused here, whatever --force says (nothing written, no event).
	if (ctx.config.terminalStatuses.includes(found.status)) {
		throw new TaskClosedError(found.id, found.status);
	}
	const claimed = await ctx.store.claim!(found.id, {
		assignee: input.assignee,
		leaseUntil,
		now: now.toISOString(),
		...(input.force === true ? { force: true } : {}),
		...(input.renew === true ? { renew: true } : {}),
	});
	const task: ClaimedTask = { ...plain(claimed.task), revision: claimed.task.revision };
	const newAssignee = task.assignee;
	// A claim of a task whose own lease had run out is `claimed` with no previous holder: the event then reads "from nobody".
	const oldAssignee = claimed.outcome === 'renewed' ? newAssignee : claimed.previousAssignee;
	return {
		task,
		outcome: claimed.outcome,
		...(claimed.previousAssignee === undefined ? {} : { previousAssignee: claimed.previousAssignee }),
		leaseUntil: task.leaseUntil ?? leaseUntil,
		events: [assigneeEvent(ctx, { taskId: task.id, oldAssignee, newAssignee, outcome: claimed.outcome })],
	};
}

export interface ReleaseTaskResult {
	task: TaskRecord;
	/** The holder that gave the task up. */
	previousAssignee: string;
	events: TaskEvent[];
}

/**
 * Gives a claimed task up: assignee, `claimedAt` and `leaseUntil` are cleared. TaskNotClaimedError when nobody holds it; with
 * `assignee`, a holder other than it needs `force` (TaskReleaseRefusedError). Fires `onTaskAssigneeChanged` with outcome `released`.
 */
export async function releaseTask(
	ctx: TaskServiceContext,
	input: { id: string; assignee?: string; force?: boolean }
): Promise<ReleaseTaskResult> {
	await requireTaskField(ctx, 'claim', 'release');
	const found = await ctx.store.resolve(input.id);
	const released = await ctx.store.release!(found.id, {
		...(input.assignee === undefined ? {} : { assignee: input.assignee }),
		...(input.force === true ? { force: true } : {}),
	});
	const task = plain(released.task);
	return {
		task,
		previousAssignee: released.previousAssignee,
		events: [
			assigneeEvent(ctx, {
				taskId: task.id,
				oldAssignee: released.previousAssignee,
				newAssignee: undefined,
				outcome: 'released',
			}),
		],
	};
}
