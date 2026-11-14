// Assignee and claim for a forge: the decision of each operation over the claim the managed block of the issue holds. Pure: the
// forge reads the block, asks for the plan, and writes the block back in one change of the body. The rules are the ones of
// TaskStore (decideClaim, normalizeAssignee, the typed errors), so a forge answers like the local store does.
import {
	TaskNotClaimedError,
	TaskReleaseRefusedError,
	decideClaim,
	normalizeAssignee,
	normalizeClaimRequest,
} from '@wadeck-app/task-core';
import type { ClaimOutcome, ClaimRequest } from '@wadeck-app/task-core';

import type { BlockClaim } from './managedBlock.js';

/** What `setAssignee` / `clearAssignee` decide: the claim the block must hold afterwards, and whether that is a change. */
export interface AssigneePlan {
	claim: BlockClaim | undefined;
	changed: boolean;
}

/** Gives the issue to a name by hand: no lease. The same assignee changes nothing (a live lease of that assignee is kept). */
export function planSetAssignee(current: BlockClaim | undefined, assignee: string): AssigneePlan {
	const normalized = normalizeAssignee(assignee);
	if (current?.assignee === normalized) return { claim: current, changed: false };
	return { claim: { assignee: normalized }, changed: true };
}

/** Removes the assignee and its lease. An issue nobody holds changes nothing. */
export function planClearAssignee(current: BlockClaim | undefined): AssigneePlan {
	return { claim: undefined, changed: current !== undefined };
}

export interface ClaimPlan {
	claim: BlockClaim;
	outcome: ClaimOutcome;
	previousAssignee?: string;
}

/**
 * A claim judged at `request.now` by the rules of the local store. Throws InvalidTaskFieldError for a bad request and TaskClaimedError
 * for a live lease held by someone else (or by the same assignee without `renew`). A renewal keeps `claimedAt`.
 */
export function planClaim(taskId: string, current: BlockClaim | undefined, request: ClaimRequest): ClaimPlan {
	const normalized = normalizeClaimRequest(request);
	const decision = decideClaim(taskId, current ?? {}, normalized);
	const claimedAt =
		decision.outcome === 'renewed' && current?.claimedAt !== undefined ? current.claimedAt : normalized.now;
	return {
		claim: { assignee: normalized.assignee, claimedAt, leaseUntil: normalized.leaseUntil },
		outcome: decision.outcome,
		...(decision.previousAssignee === undefined ? {} : { previousAssignee: decision.previousAssignee }),
	};
}

/**
 * Gives the issue up. Nobody holding it is a TaskNotClaimedError; with `assignee`, another holder needs `force`
 * (TaskReleaseRefusedError). Returns the holder it was.
 */
export function planRelease(
	taskId: string,
	current: BlockClaim | undefined,
	options: { assignee?: string; force?: boolean } = {}
): { previousAssignee: string } {
	if (current === undefined) throw new TaskNotClaimedError(taskId);
	if (options.assignee !== undefined && options.force !== true) {
		const requestedBy = normalizeAssignee(options.assignee);
		if (requestedBy !== current.assignee) throw new TaskReleaseRefusedError(taskId, current.assignee, requestedBy);
	}
	return { previousAssignee: current.assignee };
}

/** The content of the block with `claim` set, or removed when `claim` is undefined (the other keys are kept as they are). */
export function withClaim(
	data: Record<string, unknown> | undefined,
	claim: BlockClaim | undefined
): Record<string, unknown> {
	const next: Record<string, unknown> = { ...(data ?? {}) };
	if (claim === undefined) delete next['claim'];
	else next['claim'] = claim;
	return next;
}
