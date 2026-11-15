// What the three parts of the move machinery share (the writes of a person, the move of a task, the recovery after a crash): the
// dependencies, the way a copy is asked for, the stale flag and the classification of a failure. Nothing here knows a kind of storage.
import {
	BackendAuthError,
	BackendRejectedError,
	RateLimitedError,
	TaskConflictError,
	TaskNotFoundError,
	UnsupportedByBackendError,
} from '@wadeck-app/task-core';
import type { BackendCapabilities, BackendTraits, TaskBackend, VersionedRecord } from '@wadeck-app/task-core';

import type { TaskCopier, TaskCopyInput } from '../kinds.js';
import type { Authority } from './identityBlock.js';
import { IDENTITY_KEYS, contentHash, identityCarrierProblem } from './identityBlock.js';
import type { ContentFacts } from './identityBlock.js';
import type { KeyedMutex } from './keyedMutex.js';
import type { MigrationJournal } from './migrationJournal.js';
import type { IndexRow, IndexSnapshot, RoutingIndex } from './routingIndex.js';

/** Where a test (or a crash simulation) may stop the machinery: called with the name of each boundary, before the step it names. */
export type BoundaryHook = (boundary: string) => void | Promise<void>;

export interface EngineDeps {
	current: TaskBackend;
	next: TaskBackend;
	index: RoutingIndex;
	journal: MigrationJournal;
	copier: TaskCopier;
	mutex: KeyedMutex;
	nextTraits: BackendTraits;
	/** What `new` can do (it must be able to hold the identity block of a copy). */
	nextCapabilities: BackendCapabilities;
	/** The clock in milliseconds. */
	now: () => number;
	/** Tasks whose unfinished transaction could not be settled (public id -> why): a write to one is refused until it can. */
	unsettled: Map<string, string>;
	/** Tests: told at every boundary of a transaction. */
	boundary?: BoundaryHook;
}

export const iso = (deps: EngineDeps): string => new Date(deps.now()).toISOString();

/** Tells the hook (if any) a boundary was reached. */
/** Refuses, before anything is written, an operation that puts a task in new when new cannot carry the identity block. */
export function requireIdentityCarrier(deps: EngineDeps, operation: string): void {
	const problem = identityCarrierProblem(deps.nextCapabilities, 'strategy.options.new');
	if (problem === undefined) return;
	throw new UnsupportedByBackendError(
		'migrating',
		operation,
		deps.nextCapabilities.writes === 'none' ? 'writes' : 'meta',
		problem
	);
}

export async function reach(deps: EngineDeps, name: string): Promise<void> {
	await deps.boundary?.(name);
}

/** The refusals that say nothing was written: any other failure may have been applied (a lost answer, a half-done write). */
export function maybeApplied(error: unknown): boolean {
	if (
		error instanceof TaskNotFoundError ||
		error instanceof TaskConflictError ||
		error instanceof BackendRejectedError ||
		error instanceof UnsupportedByBackendError ||
		error instanceof BackendAuthError ||
		error instanceof RateLimitedError
	) {
		return false;
	}
	// The validation errors of the store (an unknown status, a bad field, a comment too long...) are named Invalid*.
	return !(error instanceof Error && /^Invalid/.test(error.name));
}

/**
 * Marks the copy of a moving task stale, in the index. Never throws: when even that cannot be written, the transaction that is still
 * open in the write-ahead log is the evidence (recovery marks it), and the problem is told.
 */
export function markStale(deps: EngineDeps, publicId: string, why: string): void {
	try {
		deps.index.mutate(rows =>
			rows.map(row =>
				row.publicId === publicId && row.state === 'moving' && row.stale !== true
					? { ...row, stale: true, version: row.version + 1 }
					: row
			)
		);
	} catch (error) {
		deps.journal.info(
			'error',
			`task ${publicId}: the copy in "new" is stale (${why}) but the routing index could not be updated (${error instanceof Error ? error.message : String(error)}); the unfinished transaction in the write-ahead log keeps the fact until it is recovered`,
			{ task: publicId, outcome: 'stale-not-recorded' }
		);
	}
}

/** The index row as a task has it now, `undefined` for a task of current with no row. */
export function rowOf(deps: EngineDeps, publicId: string): IndexRow | undefined {
	return deps.index.snapshot().byPublicId(publicId);
}

/** The ordered identity entries of a copy (the last entry makes the block readable, see taskCopier). */
export function identityEntries(input: {
	publicId: string;
	fromId?: string;
	hash: string;
	authority: Authority;
}): ReadonlyArray<readonly [string, string]> {
	return [
		...(input.fromId === undefined ? [] : [[IDENTITY_KEYS.fromId, input.fromId] as const]),
		[IDENTITY_KEYS.hash, input.hash] as const,
		[IDENTITY_KEYS.authority, input.authority] as const,
		[IDENTITY_KEYS.publicId, input.publicId] as const,
	];
}

export function hashOf(record: ContentFacts): string {
	return contentHash(record);
}

/** The input of a copy of `record` (a task of current) to new, from the index as it is now. */
export async function copyInputFor(
	deps: EngineDeps,
	snapshot: IndexSnapshot,
	record: VersionedRecord,
	acceptedLosses: readonly string[],
	identity?: TaskCopyInput['identity']
): Promise<TaskCopyInput> {
	const sourceIds = new Set((await deps.current.list()).map(summary => summary.id));
	let hierarchy: TaskCopyInput['hierarchy'];
	const limits = deps.nextTraits;
	if (
		record.parentId !== undefined &&
		(limits.hierarchyDepth !== undefined || limits.childrenPerParent !== undefined)
	) {
		hierarchy = {
			depth: (await deps.current.getAncestors(record.id)).length + 1,
			siblings: (await deps.current.getChildren(record.parentId)).length,
		};
	}
	return {
		record,
		sourceIds,
		targetIdOf: sourceId => snapshot.byPublicId(sourceId)?.b,
		acceptedLosses,
		...(hierarchy === undefined ? {} : { hierarchy }),
		...(identity === undefined ? {} : { identity }),
	};
}

/** True when the task holds a lease that is not over (a lease that is not a date is never over). */
export function isLeased(record: VersionedRecord, nowMs: number): boolean {
	if (record.leaseUntil === undefined) return false;
	const until = Date.parse(record.leaseUntil);
	return Number.isNaN(until) || until > nowMs;
}
