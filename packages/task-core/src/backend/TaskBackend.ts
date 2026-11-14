// The async port every task store implements (design 1.1/1.2). Types only: no Node module is imported here, so a
// forge or remote adapter can be written against it without the local file API (architecture.test.ts checks it).
//
// v0 mirrors the operations of the synchronous TaskStore one for one (same names, same errors), so moving a caller
// is `await` and nothing else. Two shape changes, both deliberate:
//  - `create` takes one object (the positional list grew by one optional every time);
//  - `updateStatus` has no `existing` record (the backend re-reads; a remote cannot mutate the caller's object).
// Domain rules (cycles, single duplicateOf, inverse links, activity entries) still live in the local TaskStore; step 0.7
// of the design lifts them into a shared layer over a thinner port.
import type { ClaimOutcome, ClaimRequest } from '../taskFields.js';
import type { CommentChange, CommentEdit } from '../taskComments.js';
import type { LinkType, TaskLink, TaskLinks, TaskRecord, TaskStatus, TaskSummary, TaskTreeNode } from '../TaskStore.js';
import type { BackendCapabilities, BackendKind } from './capabilities.js';

/** A record read or written through a backend. `revision` is opaque: hand it back as `expectedRevision` to detect a concurrent change. Never stored. */
export type VersionedRecord = TaskRecord & {
	readonly revision: string;
	/**
	 * Set by a backend that reads through a cache, ONLY when part of the record was served from the cache after the server could
	 * not be asked (offline, rate limited): `cachedAt` is the oldest instant of the data used. Absent on a fresh read.
	 */
	readonly stale?: true;
	readonly cachedAt?: string;
};

/**
 * What {@link TaskBackend.resolve} answers: the fields of a task a use case reads to name it and to know the value a write is about
 * to replace. Not its links, history, activity or comments (a backend that holds them elsewhere than in the task itself does not
 * fetch them for this). Every {@link VersionedRecord} is a ResolvedTask.
 */
export type ResolvedTask = Pick<
	VersionedRecord,
	| 'id'
	| 'title'
	| 'description'
	| 'status'
	| 'parentId'
	| 'type'
	| 'labels'
	| 'meta'
	| 'priority'
	| 'assignee'
	| 'createdAt'
	| 'updatedAt'
	| 'revision'
>;

/** Options of every write that changes an existing task. */
export interface WriteOptions {
	/**
	 * The `revision` of the record as the caller read it. When it differs from the stored one the write is refused with
	 * StaleRevisionError (a TaskConflictError of kind `stale`) before anything is written. Absent = last write wins, as today.
	 * A backend whose `capabilities.concurrency` is `none` answers UnsupportedByBackendError when it is given.
	 */
	expectedRevision?: string;
}

export interface ListQuery {
	/** A task id: its direct children; `null`: root tasks only; absent: no filter. */
	parentId?: string | null;
	statusIn?: readonly TaskStatus[];
	/** Case-insensitive substring of the title (the index holds titles only). Needs `capabilities.search` other than `none`. */
	text?: string;
	/** Positive integer. Absent = everything in one page. */
	limit?: number;
	/** The `nextCursor` of the previous page. Opaque to callers. */
	cursor?: string;
}

export interface Page<T> {
	items: T[];
	/** Absent on the last page. */
	nextCursor?: string;
}

export interface LabelCount {
	label: string;
	/** Number of tasks (open or closed) carrying the label. */
	count: number;
}

export interface CreateTaskInput {
	title: string;
	status: TaskStatus;
	parentId?: string;
	/** Stored only when it differs from the title. */
	description?: string;
	/**
	 * ISO 8601 instant of the creation, for a task that existed elsewhere before (a migration). Honoured only by a backend whose
	 * traits say `keepsCreatedAt`; any other ignores it. Absent: now.
	 */
	createdAt?: string;
}

export interface BackendCommentChange extends Omit<CommentChange, 'task'> {
	task: VersionedRecord;
}

export interface BackendCommentEdit extends Omit<CommentEdit, 'task'> {
	task: VersionedRecord;
}

/** What `claim` takes: the claim rules' input (see ClaimRequest) and the revision the caller read, if it wants the write refused when the task changed. */
export type BackendClaimInput = ClaimRequest & WriteOptions;

/** What `claim` answers: the saved task, how it went, and who held the task before a takeover. */
export interface BackendClaimResult {
	task: VersionedRecord;
	outcome: ClaimOutcome;
	previousAssignee?: string;
}

/** Options of `release`: with `assignee`, a holder other than it needs `force`. */
export interface ReleaseOptions extends WriteOptions {
	assignee?: string;
	force?: boolean;
}

/** What `release` answers: the saved task and who held it. */
export interface BackendReleaseResult {
	task: VersionedRecord;
	previousAssignee: string;
}

/** One label a project needs in the remote system, and why. */
export interface LabelSyncEntry {
	name: string;
	kind: 'status' | 'type' | 'deleted';
	why: string;
}

/** What `task labels sync` did (or, with `dryRun`, would do). */
export interface LabelSyncReport {
	dryRun: boolean;
	/** Every label the configuration needs. */
	wanted: LabelSyncEntry[];
	/** The names created (dry run: that would be). */
	created: string[];
	/** The names that were already there. */
	existing: string[];
	/** What else the person should know (labels that are created on demand). */
	notes: string[];
}

export interface TaskBackend {
	readonly kind: BackendKind;
	readonly capabilities: BackendCapabilities;

	// ---- reads: records ----
	/** Every task summary (the index). Prefer {@link listPage} for a backend that may hold many tasks. */
	list(): Promise<TaskSummary[]>;
	listPage(query?: ListQuery): Promise<Page<TaskSummary>>;
	/** Throws TaskNotFoundError. */
	get(id: string): Promise<VersionedRecord>;
	/** In the order of `ids`; throws TaskNotFoundError for the first missing one. Avoids N round trips on a remote backend. */
	getMany(ids: readonly string[]): Promise<VersionedRecord[]>;
	/** Throws TaskNotFoundError or AmbiguousTaskPrefixError. A backend with `capabilities.ids` = `assigned` accepts exact ids only. */
	findByPrefix(prefix: string): Promise<VersionedRecord>;
	/**
	 * Same resolution and same errors as {@link findByPrefix}, answering only the {@link ResolvedTask} fields. For the use cases that
	 * need an id, or the current status / type / labels / meta / parent / title / description of a task before they write it; a use
	 * case that shows the record, its history, activity, comments or links calls `findByPrefix` or `get`. A backend whose full record
	 * costs more than its fields (github: the timeline, the comments, the dependencies are separate requests) answers this with less.
	 */
	resolve(prefix: string): Promise<ResolvedTask>;
	/** Every label in use, most used first, then by name. Needs `capabilities.labels`. */
	listLabels(): Promise<LabelCount[]>;

	// ---- reads: graph (parent/child and links) ----
	getLinks(id: string): Promise<TaskLinks>;
	getLinksLenient(id: string): Promise<{ links: TaskLinks; dangling: TaskLink[] }>;
	getOpenBlockers(id: string, isTerminal: (status: TaskStatus) => boolean): Promise<TaskSummary[]>;
	getUnblockedBy(blockerId: string, isTerminal: (status: TaskStatus) => boolean): Promise<TaskSummary[]>;
	getChildren(id: string): Promise<TaskSummary[]>;
	getTree(id: string): Promise<TaskTreeNode>;
	getForest(options?: { parentId?: string; predicate?: (task: TaskSummary) => boolean }): Promise<TaskTreeNode[]>;
	getDescendants(id: string): Promise<TaskSummary[]>;
	getFullTree(id: string): Promise<TaskTreeNode>;
	getAncestors(id: string): Promise<TaskSummary[]>;

	// ---- writes: fields ----
	create(input: CreateTaskInput): Promise<VersionedRecord>;
	updateStatus(id: string, status: TaskStatus, options?: WriteOptions): Promise<VersionedRecord>;
	setTitle(id: string, title: string, options?: WriteOptions): Promise<VersionedRecord>;
	setDescription(id: string, description: string, options?: WriteOptions): Promise<VersionedRecord>;
	setType(id: string, type: string, options?: WriteOptions): Promise<VersionedRecord>;
	clearType(id: string, options?: WriteOptions): Promise<VersionedRecord>;
	addLabel(id: string, label: string, options?: WriteOptions): Promise<VersionedRecord>;
	removeLabel(id: string, label: string, options?: WriteOptions): Promise<VersionedRecord>;
	setMeta(id: string, key: string, value: string, options?: WriteOptions): Promise<VersionedRecord>;
	removeMeta(id: string, key: string, options?: WriteOptions): Promise<VersionedRecord>;

	// ---- writes: graph ----
	setParent(id: string, parentId: string, options?: WriteOptions): Promise<VersionedRecord>;
	removeParent(id: string, options?: WriteOptions): Promise<VersionedRecord>;
	addLink(id: string, type: LinkType, targetId: string, options?: WriteOptions): Promise<VersionedRecord>;
	removeLink(id: string, type: LinkType, targetId: string, options?: WriteOptions): Promise<VersionedRecord>;

	// ---- writes: comments ----
	addComment(id: string, text: string, options?: WriteOptions & { author?: string }): Promise<BackendCommentChange>;
	editComment(id: string, commentId: string, text: string, options?: WriteOptions): Promise<BackendCommentEdit>;
	removeComment(id: string, commentId: string, options?: WriteOptions): Promise<BackendCommentChange>;

	// ---- optional: priority, assignee and claim (capabilities `priority`, `assignee`, `claim`) ----
	// Optional so that a backend written before them keeps compiling. A backend WITHOUT the capability must still implement them,
	// answering UnsupportedByBackendError (the contract suite fails a backend that lacks the method).
	/** Sets the priority; validated against the project's list when the backend was given one. The same value writes nothing. */
	setPriority?(id: string, priority: string, options?: WriteOptions): Promise<VersionedRecord>;
	/** Removes the priority (the project's default applies again). A task without one writes nothing. */
	clearPriority?(id: string, options?: WriteOptions): Promise<VersionedRecord>;
	/** Gives the task to a name by hand; the lease of a previous claim is dropped when the assignee changes. */
	setAssignee?(id: string, assignee: string, options?: WriteOptions): Promise<VersionedRecord>;
	/** Removes the assignee and its lease. A task nobody holds writes nothing. */
	clearAssignee?(id: string, options?: WriteOptions): Promise<VersionedRecord>;
	/**
	 * Claims a task under a lease: check and write are one step (local: under the project write lock; remote: the server queue).
	 * The clock is the caller's (`input.now`). Refused with TaskClaimedError (a TaskConflictError) while someone else holds a live lease.
	 */
	claim?(id: string, input: BackendClaimInput): Promise<BackendClaimResult>;
	/** Gives the task up (assignee, claimedAt, leaseUntil cleared). TaskNotClaimedError when nobody holds it. */
	release?(id: string, options?: ReleaseOptions): Promise<BackendReleaseResult>;

	// ---- delete ----
	/** True when the task existed and was removed (or closed, `capabilities.delete` = `close-only`), false when it was not found. */
	deleteTask(id: string, options?: WriteOptions): Promise<boolean>;

	// ---- optional: only a backend that keeps labels in a remote system ----
	/** Creates the labels the project's configuration needs (colour and description included); never deletes or changes one. */
	syncLabels?(options: { dryRun?: boolean }): Promise<LabelSyncReport>;
}
