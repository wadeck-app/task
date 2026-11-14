import { TaskClaimedError } from '@wadeck-app/task-core';

import type { TaskServiceContext } from './context.js';
import { NextTaskContentionError } from './errors.js';
import { DEFAULT_ORDER, listTasks } from './listTasks.js';
import { claimTask } from './taskClaim.js';
import type { ClaimTaskResult } from './taskClaim.js';

/** Candidates tried before `next` gives up: each failed attempt is a task another worker claimed between the list and the claim. */
export const NEXT_MAX_ATTEMPTS = 10;

export interface NextTaskInput {
	/** Who takes the task (see claimTask). */
	assignee: string;
	/** Statuses a candidate may be in. Absent: every non-terminal status of the project. */
	statuses?: readonly string[];
	priorities?: readonly string[];
	/** Ordering plugin. Absent: `priority-then-oldest`. */
	order?: string;
	/** Lease in whole minutes (see claimTask). */
	leaseMinutes?: number;
	/** Candidates are listed from the system itself, not from a cache. */
	fresh?: boolean;
	/** Also offer tasks with an open `blockedBy` link (default: they are skipped). */
	includeBlocked?: boolean;
	now?: Date;
}

/** `claim` is absent when no task was available (nothing was written, no event). */
export interface NextTaskResult {
	claim?: ClaimTaskResult;
	/** How many candidates were claimed by someone else first (0 when none): an empty answer with `lost` > 0 is a lost race, not an empty queue. */
	lost: number;
	/** How many candidates were skipped because an open `blockedBy` link blocks them. */
	skippedBlocked: number;
}

/**
 * Claims the first available task in order: lists the candidates (`available`, the ordering, the filters), claims the first and,
 * when someone else won it (TaskClaimedError), the next one, at most NEXT_MAX_ATTEMPTS times (then NextTaskContentionError); a candidate with an open blockedBy link is skipped (not an attempt) unless includeBlocked. Any other
 * error stops at once. The events are the ones of the claim.
 */
export async function nextTask(ctx: TaskServiceContext, input: NextTaskInput): Promise<NextTaskResult> {
	const now = input.now ?? new Date();
	const statuses =
		input.statuses ?? ctx.config.statuses.filter(status => !ctx.config.terminalStatuses.includes(status));
	// An empty status list would mean "no filter" to the list: with every status closed there is simply nothing to offer.
	if (statuses.length === 0) return { lost: 0, skippedBlocked: 0 };
	const candidates = await listTasks(ctx, {
		statuses,
		available: true,
		order: input.order ?? DEFAULT_ORDER,
		...(input.priorities === undefined ? {} : { priorities: input.priorities }),
		...(input.fresh === true ? { fresh: true } : {}),
		now,
	});
	let lost = 0;
	let skippedBlocked = 0;
	let attempts = 0;
	let lastLost = '';
	const isTerminal = (status: string): boolean => ctx.config.terminalStatuses.includes(status);
	for (const candidate of candidates) {
		if (attempts >= NEXT_MAX_ATTEMPTS) break;
		// Checked here, one candidate at a time and right before its claim: a blocker closed meanwhile is seen, the rest of the list costs nothing.
		if (input.includeBlocked !== true && (await ctx.store.getOpenBlockers(candidate.id, isTerminal)).length > 0) {
			skippedBlocked++;
			continue;
		}
		attempts++;
		try {
			const claim = await claimTask(ctx, {
				id: candidate.id,
				assignee: input.assignee,
				now,
				...(input.leaseMinutes === undefined ? {} : { leaseMinutes: input.leaseMinutes }),
			});
			return { claim, lost, skippedBlocked };
		} catch (error) {
			if (!(error instanceof TaskClaimedError)) throw error;
			lost++;
			lastLost = candidate.id;
		}
	}
	// Gave up on the cap with candidates left (not looked at): an error, never "nothing available".
	if (attempts >= NEXT_MAX_ATTEMPTS && candidates.length > attempts + skippedBlocked) {
		throw new NextTaskContentionError(lost, lastLost);
	}
	return { lost, skippedBlocked };
}
