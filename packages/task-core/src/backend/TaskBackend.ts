// The async port every task store implements (design 1.1/1.2). Types only: no Node module is imported here, so a
// forge or remote adapter can be written against it without the local file API (architecture.test.ts checks it).
//
// v0 mirrors the operations of the synchronous TaskStore one for one (same names, same errors), so moving a caller
// is `await` and nothing else. Two shape changes, both deliberate:
//  - `create` takes one object (the positional list grew by one optional every time);
//  - `updateStatus` has no `existing` record (the backend re-reads; a remote cannot mutate the caller's object).
// Domain rules (cycles, single duplicateOf, inverse links, activity entries) still live in the local TaskStore; step 0.7
// of the design lifts them into a shared layer over a thinner port.
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
}

export interface BackendCommentChange extends Omit<CommentChange, 'task'> {
	task: VersionedRecord;
}

export interface BackendCommentEdit extends Omit<CommentEdit, 'task'> {
	task: VersionedRecord;
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

	// ---- delete ----
	/** True when the task existed and was removed (or closed, `capabilities.delete` = `close-only`), false when it was not found. */
	deleteTask(id: string, options?: WriteOptions): Promise<boolean>;
}
