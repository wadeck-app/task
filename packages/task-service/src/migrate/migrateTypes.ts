// Types of `task migrate` (design 1.8 of .claude/plans/2026-11-08_storage-strategies.md): the endpoints, the options, the plan, the loss
// table, the result. The engine (migrateRun.ts) is adapter-agnostic: it sees two TaskBackends, never a CLI or a plugin.
import type { BackendTraits, TaskBackend } from '@wadeck-app/task-core';

import type { TaskEvent } from '../events.js';
import type { ProjectFacts, ReadNotice } from '../plugins/kinds.js';

/**
 * Every kind of loss the plan can report, by the name `--allow-loss` takes. A kind with a colon belongs to a group (`links`, `hierarchy`):
 * allowing the group allows every kind of it; `all` allows every kind.
 */
export const LOSS_KINDS = [
	'status',
	'status-outcome',
	'type',
	'labels',
	'meta',
	'comments',
	'history',
	'created-at',
	'marker',
	'text-length',
	'hierarchy:unsupported',
	'hierarchy:depth',
	'hierarchy:children',
	'hierarchy:orphan',
	'hierarchy:cycle',
	'links:blockedBy',
	'links:duplicateOf',
	'links:causedBy',
	'links:dangling',
] as const;
export type LossKind = (typeof LOSS_KINDS)[number];

/** The groups `--allow-loss` accepts besides the kinds themselves. */
export const LOSS_GROUPS = ['hierarchy', 'links', 'all'] as const;

/** One side of a migration: a project, its backend and what the backend keeps. */
export interface MigrationEndpoint {
	/** The registry project: `id` qualifies the task ids (`<id>/<task>`) and names the journal. */
	project: { id: string; name: string; path?: string };
	backend: TaskBackend;
	/** The statuses (config order) and types the project accepts: a task keeps its status only where the target has it. */
	facts: ProjectFacts;
	/** What the backend keeps and its limits; a backend that says nothing keeps nothing. */
	traits: BackendTraits;
	/** What the reads since the last call want the user to know (a cache served after a failure...). Absent: none. */
	takeNotices?: () => ReadNotice[];
}

export interface MigrationOptions {
	/** Read, plan, print: no write on either backend, no journal, no lock. */
	dryRun: boolean;
	/** Continue a journal that a previous run left unfinished. */
	resume: boolean;
	/** Loss kinds (or groups, or `all`) the person accepted. */
	allowLoss: readonly string[];
	/** Also deliver the per-task events the same writes would have raised in an ordinary session. */
	emitEvents: boolean;
	/** Write one note comment per task with its creation instant and its status history (so those are not lost). */
	historyComment: boolean;
}

export const DEFAULT_MIGRATION_OPTIONS: MigrationOptions = {
	dryRun: false,
	resume: false,
	allowLoss: [],
	emitEvents: false,
	historyComment: false,
};

/** One thing the target cannot represent, with the tasks it concerns (source ids). */
export interface LossRow {
	kind: LossKind;
	/** Number of items (tasks, labels, links, comments...) lost; what is counted is in `text`. */
	count: number;
	/** The source tasks concerned, at most {@link LOSS_IDS_MAX}. */
	taskIds: string[];
	text: string;
	/** What to do instead of accepting the loss. */
	fix: string;
	/** True when `--allow-loss` covers this kind. */
	allowed: boolean;
}

export const LOSS_IDS_MAX = 20;

export interface MigrationEstimate {
	/** Port writes the run will make (creates, fields, links, comments). */
	writes: number;
	/** Requests to the target system (0 for a local target). */
	requests: number;
	seconds: number;
	/** The hourly request quota of the target system, when it has one. */
	quotaPerHour?: number;
}

export type MigrationStatus = 'dry-run' | 'blocked' | 'completed' | 'rate-limited' | 'failed';

export interface MigrationCounts {
	/** Tasks read from the source. */
	source: number;
	/** Tasks created on the target by this run. */
	created: number;
	/** Tasks an earlier run had created and this run finished (fields, links, comments). */
	resumed: number;
	/** Tasks already fully migrated: nothing done. */
	skipped: number;
	/** Tasks the run stopped on (0 or 1: it stops at the first failure). */
	failed: number;
	/** Tasks not reached because the run stopped. */
	remaining: number;
}

export interface MigrationMismatch {
	sourceId: string;
	targetId: string;
	field: string;
	expected: string;
	actual: string;
}

export interface MigrationFailure {
	/** The source task being migrated, absent for a failure outside a task. */
	sourceId?: string;
	/** What the run was doing: `create`, `fields`, `links`, `comments`, `status`, `verify`. */
	step: string;
	message: string;
	hint?: string;
}

export interface MigrationSide {
	id: string;
	name: string;
	kind: string;
}

export interface MigrationResult {
	status: MigrationStatus;
	dryRun: boolean;
	from: MigrationSide;
	to: MigrationSide;
	counts: MigrationCounts;
	losses: LossRow[];
	/** Loss kinds present and not allowed: the run does not start while there are any. */
	blocking: LossKind[];
	/** Things worth knowing that lose nothing (references not rewritten, how idempotence is kept...). */
	notes: string[];
	warnings: string[];
	estimate: MigrationEstimate;
	/** Source id -> target id, for every task migrated so far (also the earlier runs'). */
	idMap: Array<{ source: string; target: string }>;
	journal: string;
	verification?: { checked: number; mismatches: MigrationMismatch[] };
	/** `rate-limited`: when the limit lifts. */
	retryAt?: string;
	/** `failed`, `rate-limited`: the command that continues. */
	resumeCommand?: string;
	failure?: MigrationFailure;
	/** The events to deliver (the summary one, and the per-task ones with `emitEvents`); never part of the printed result. */
	events: TaskEvent[];
}

/** What the run is doing, for the progress lines. */
export interface MigrationProgress {
	stage: 'read' | 'plan' | 'create' | 'links' | 'comments' | 'verify';
	/** Tasks done in this stage, out of `total`. */
	done: number;
	total: number;
	sourceId?: string;
	targetId?: string;
	title?: string;
	/** What was done to this task in this stage. */
	action?: 'created' | 'resumed' | 'skipped' | 'linked' | 'commented' | 'checked';
	/** The number of items written (links, comments), when the stage writes several. */
	items?: number;
}
