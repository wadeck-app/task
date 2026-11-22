// The backend of a strategy that holds two others (`current` and `new`). READS are routed by the index (routedReads.ts); WRITES go to the
// side that holds the truth of each task and, while a task is moving, are mirrored to its copy (routedWrites.ts); a task moves with
// `moves.moveTask` (taskMover.ts) and an interrupted operation is settled by `moves.recover` (migrationRecovery.ts). The wrapper
// promises only what BOTH sides do (the intersection of their capabilities): an operation whose capability one side lacks is refused
// here, loudly, even though `current` could do it, because a task made that way could not be moved to `new` later. It reads
// capabilities, traits and the TaskBackend port only; it knows no storage kind.
import { BackendRejectedError, UnsupportedByBackendError } from '@wadeck-app/task-core';
import type {
	AddCommentOptions,
	BackendCapabilities,
	BackendClaimInput,
	BackendClaimResult,
	BackendCommentChange,
	BackendCommentEdit,
	BackendReleaseResult,
	BackendTraits,
	CreateTaskInput,
	LabelCount,
	LabelSyncReport,
	LinkType,
	ListQuery,
	Page,
	ReleaseOptions,
	ResolvedTask,
	TaskBackend,
	TaskLink,
	TaskLinks,
	TaskStatus,
	TaskSummary,
	TaskTreeNode,
	VersionedRecord,
	WriteOptions,
} from '@wadeck-app/task-core';

import type { TaskCopier } from '../kinds.js';
import { KeyedMutex } from './keyedMutex.js';
import type { BoundaryHook, EngineDeps } from './engineSupport.js';
import type { Translator } from './idTranslation.js';
import { isIdentityKey } from './identityBlock.js';
import type { MigrationJournal } from './migrationJournal.js';
import { Recovery } from './migrationRecovery.js';
import type { RecoveryReport } from './migrationRecovery.js';
import { RoutedReads } from './routedReads.js';
import { RoutedWrites, forMirror } from './routedWrites.js';
import type { WriteSpec } from './routedWrites.js';
import type { RoutingIndex } from './routingIndex.js';
import { TaskMover } from './taskMover.js';
import type { CatchUpOutcome, MoveOptions, MoveOutcome } from './taskMover.js';

export interface MigratingBackendInput {
	/** Where the tasks are. */
	current: TaskBackend;
	/** Where the tasks go: new tasks are created here, and a task is authoritative here once it is `in-b`. */
	next: TaskBackend;
	/** Which side holds which task (see routingIndex.ts). */
	index: RoutingIndex;
	/** The intersection of the capabilities of both sides: what this backend declares and enforces. */
	capabilities: BackendCapabilities;
	/**
	 * For each capability the intersection holds back, the slots (`current`, `new`) that hold it back: the refusal names them so the
	 * person knows which side to change. A capability not in it is not held back.
	 */
	heldBackBy: Readonly<Partial<Record<keyof BackendCapabilities, readonly string[]>>>;
	/** The names of the statuses of the project: a side that maps statuses knows these and no other. */
	statuses: readonly string[];
	/** What `new` keeps and its limits (a creation that carries its fields, hierarchy limits). */
	nextTraits: BackendTraits;
	/** The write-ahead log and the migration log. */
	journal: MigrationJournal;
	/** The per-task copy of `task migrate` between the two sides (the host gives it: `StrategyContext.copyTasks`). */
	copier: TaskCopier;
	/** The clock in milliseconds (tests drive it). Default `Date.now`. */
	now?: () => number;
	/** Tests: told at every boundary of a transaction, to simulate a crash there. */
	boundary?: BoundaryHook;
	/** Tests: whether a process is alive (a recovery leaves alone what a live process of this machine is doing). */
	isAlive?: (pid: number) => boolean;
}

/** The operations that move tasks and settle what a crash left (used by the background worker and by the opening of the project). */
export interface MigrationMoves {
	/** Moves one task to `new` (see taskMover.ts). Safe to call again after a failure. */
	moveTask(publicId: string, options: MoveOptions): Promise<MoveOutcome>;
	/** Brings the copy of a moving task equal, without switching authority. */
	catchUp(publicId: string, options?: MoveOptions): Promise<CatchUpOutcome>;
	/** Settles every transaction a crash left open (done at the opening of the project). */
	recover(): Promise<RecoveryReport>;
	/** Tasks whose unfinished change could not be settled, and why: writes to them are refused. */
	unsettled(): ReadonlyMap<string, string>;
	/** How many transactions the write-ahead log shows as begun and not ended (throws for a damaged log). */
	openTransactions(): number;
}

type Ids = (publicId: string) => string;
type Field = 'setPriority' | 'clearPriority' | 'setAssignee' | 'clearAssignee' | 'claim' | 'release';

/** An optional operation of the port on a side, bound; a side that declares the capability and lacks it is a bug of that side. */
function field<K extends Field>(backend: TaskBackend, name: K): NonNullable<TaskBackend[K]> {
	const operation = backend[name] as ((...args: never[]) => unknown) | undefined;
	if (typeof operation !== 'function') {
		throw new Error(
			`A strategy of this project declares priority, assignee and claim but does not implement ${name}: this is a bug of that strategy`
		);
	}
	return operation.bind(backend) as NonNullable<TaskBackend[K]>;
}

const recordOf = (translator: Translator, side: 'a' | 'b', value: VersionedRecord): VersionedRecord =>
	translator.record(side, value);

export class MigratingBackend implements TaskBackend {
	readonly kind = 'migrating' as const;
	readonly capabilities: BackendCapabilities;
	/** The moves of tasks and the recovery (see {@link MigrationMoves}). */
	readonly moves: MigrationMoves;

	// Optional members of the port, present only when `current` has them (the proxies in front of this class tell absent from present).
	prepare?: (needs: { priority?: boolean }) => Promise<void>;
	syncLabels?: (options: { dryRun?: boolean }) => Promise<LabelSyncReport>;

	private readonly reads: RoutedReads;
	private readonly writes: RoutedWrites;
	private readonly heldBackBy: MigratingBackendInput['heldBackBy'];
	private readonly statuses: ReadonlySet<string>;

	constructor(input: MigratingBackendInput) {
		this.reads = new RoutedReads({ current: input.current, next: input.next, index: input.index });
		const deps: EngineDeps = {
			current: input.current,
			next: input.next,
			index: input.index,
			journal: input.journal,
			copier: input.copier,
			mutex: new KeyedMutex(),
			nextTraits: input.nextTraits,
			nextCapabilities: input.next.capabilities,
			now: input.now ?? Date.now,
			unsettled: new Map(),
			...(input.boundary === undefined ? {} : { boundary: input.boundary }),
		};
		this.writes = new RoutedWrites(deps);
		const recovery = new Recovery(deps, input.isAlive);
		const mover = new TaskMover(deps, recovery);
		this.moves = {
			moveTask: (publicId, options) => mover.moveTask(publicId, options),
			catchUp: (publicId, options) => mover.catchUp(publicId, options),
			recover: () => recovery.recoverAll(),
			unsettled: () => deps.unsettled,
			openTransactions: () => deps.journal.openTransactions().length,
		};
		this.capabilities = input.capabilities;
		this.heldBackBy = input.heldBackBy;
		this.statuses = new Set(input.statuses);
		const current = input.current;
		if (typeof current.prepare === 'function') this.prepare = needs => current.prepare!(needs);
		if (typeof current.syncLabels === 'function') this.syncLabels = options => current.syncLabels!(options);
	}

	// ---- the refusals of the intersection ----

	private refuse(capability: keyof BackendCapabilities, operation: string): never {
		const sides = this.heldBackBy[capability] ?? [];
		throw new UnsupportedByBackendError(
			this.kind,
			operation,
			capability,
			sides.length === 0
				? `The pair of strategies does not support ${operation}.`
				: `The strategy in ${sides.map(side => `"${side}"`).join(' and ')} does not support it, and a task made that way could not be moved there later. Change that strategy (a fill may enable it) or leave ${operation} undone while both are configured.`
		);
	}

	private needsWrites(operation: string): void {
		if (this.capabilities.writes === 'none') this.refuse('writes', operation);
	}

	private needs(capability: 'labels' | 'meta' | 'comments', operation: string): void {
		this.needsWrites(operation);
		if (!this.capabilities[capability]) this.refuse(capability, operation);
	}

	private needsField(capability: 'priority' | 'assignee' | 'claim', operation: string): void {
		this.needsWrites(operation);
		if (this.capabilities[capability] !== true) this.refuse(capability, operation);
	}

	private checkRevision(options: WriteOptions | undefined, operation: string): void {
		if (options?.expectedRevision !== undefined && this.capabilities.concurrency === 'none') {
			this.refuse('concurrency', `${operation} with an expected revision`);
		}
	}

	private checkStatus(status: TaskStatus, operation: string): void {
		if (this.capabilities.status !== 'free' && !this.statuses.has(status)) {
			this.refuse('status', `${operation} to the status "${status}", which the project does not list`);
		}
	}

	private checkLinkType(type: LinkType, operation: string): void {
		if (!this.capabilities.linkTypes.includes(type)) this.refuse('linkTypes', `${operation} of type ${type}`);
	}

	/** The identity block of a copy is the strategy's own: a person cannot set or remove one of its entries. */
	private checkMetaKey(key: string, operation: string): void {
		if (isIdentityKey(key)) {
			throw new BackendRejectedError(
				this.kind,
				operation,
				`Cannot ${operation}: "${key}" is reserved. Metadata keys starting with "migrating." hold the identity block the migrating strategy writes in every copy`,
				'Use another metadata key.'
			);
		}
	}

	/** One write that changes a task and answers with its record. */
	private record(
		operation: string,
		id: string,
		related: readonly string[],
		call: (backend: TaskBackend, ids: Ids, mirror: boolean) => Promise<VersionedRecord>,
		mirror: WriteSpec<VersionedRecord>['mirror'] = 'op'
	): Promise<VersionedRecord> {
		return this.writes.run({ operation, id, related, apply: call, result: recordOf, mirror });
	}

	// ---- reads: every one is routed by the index (see routedReads.ts); with nothing routed to `new` it is current's own answer ----

	async list(): Promise<TaskSummary[]> {
		return this.reads.list();
	}

	async listPage(query?: ListQuery): Promise<Page<TaskSummary>> {
		if (query?.text !== undefined && this.capabilities.search === 'none')
			this.refuse('search', 'searching by text');
		return this.reads.listPage(query);
	}

	async get(id: string): Promise<VersionedRecord> {
		return this.reads.get(id);
	}

	async getMany(ids: readonly string[]): Promise<VersionedRecord[]> {
		return this.reads.getMany(ids);
	}

	async findByPrefix(prefix: string): Promise<VersionedRecord> {
		return this.reads.findByPrefix(prefix);
	}

	async resolve(prefix: string): Promise<ResolvedTask> {
		return this.reads.resolve(prefix);
	}

	async listLabels(): Promise<LabelCount[]> {
		if (!this.capabilities.labels) this.refuse('labels', 'listing labels');
		return this.reads.listLabels();
	}

	// ---- reads: graph ----

	async getLinks(id: string): Promise<TaskLinks> {
		return this.reads.getLinks(id);
	}

	async getLinksLenient(id: string): Promise<{ links: TaskLinks; dangling: TaskLink[] }> {
		return this.reads.getLinksLenient(id);
	}

	async getOpenBlockers(id: string, isTerminal: (status: TaskStatus) => boolean): Promise<TaskSummary[]> {
		return this.reads.getOpenBlockers(id, isTerminal);
	}

	async getUnblockedBy(blockerId: string, isTerminal: (status: TaskStatus) => boolean): Promise<TaskSummary[]> {
		return this.reads.getUnblockedBy(blockerId, isTerminal);
	}

	async getChildren(id: string): Promise<TaskSummary[]> {
		return this.reads.getChildren(id);
	}

	async getTree(id: string): Promise<TaskTreeNode> {
		return this.reads.getTree(id);
	}

	async getForest(options?: {
		parentId?: string;
		predicate?: (task: TaskSummary) => boolean;
	}): Promise<TaskTreeNode[]> {
		return this.reads.getForest(options);
	}

	async getDescendants(id: string): Promise<TaskSummary[]> {
		return this.reads.getDescendants(id);
	}

	async getFullTree(id: string): Promise<TaskTreeNode> {
		return this.reads.getFullTree(id);
	}

	async getAncestors(id: string): Promise<TaskSummary[]> {
		return this.reads.getAncestors(id);
	}

	// ---- writes: fields ----

	async create(input: CreateTaskInput): Promise<VersionedRecord> {
		this.needsWrites('creating a task');
		this.checkStatus(input.status, 'creating a task');
		if (input.parentId !== undefined && this.capabilities.hierarchy === 'none') {
			this.refuse('hierarchy', 'creating a task under a parent');
		}
		return this.writes.create(input);
	}

	async updateStatus(id: string, status: TaskStatus, options?: WriteOptions): Promise<VersionedRecord> {
		this.needsWrites('changing a status');
		this.checkStatus(status, 'changing a status');
		this.checkRevision(options, 'changing a status');
		return this.record('updateStatus', id, [], (backend, ids, mirror) =>
			backend.updateStatus(ids(id), status, forMirror(options, mirror))
		);
	}

	async setTitle(id: string, title: string, options?: WriteOptions): Promise<VersionedRecord> {
		this.needsWrites('changing a title');
		this.checkRevision(options, 'changing a title');
		return this.record('setTitle', id, [], (backend, ids, mirror) =>
			backend.setTitle(ids(id), title, forMirror(options, mirror))
		);
	}

	async setDescription(id: string, description: string, options?: WriteOptions): Promise<VersionedRecord> {
		this.needsWrites('changing a description');
		this.checkRevision(options, 'changing a description');
		return this.record('setDescription', id, [], (backend, ids, mirror) =>
			backend.setDescription(ids(id), description, forMirror(options, mirror))
		);
	}

	async setType(id: string, type: string, options?: WriteOptions): Promise<VersionedRecord> {
		this.needsWrites('setting a type');
		this.checkRevision(options, 'setting a type');
		return this.record('setType', id, [], (backend, ids, mirror) =>
			backend.setType(ids(id), type, forMirror(options, mirror))
		);
	}

	async clearType(id: string, options?: WriteOptions): Promise<VersionedRecord> {
		this.needsWrites('clearing a type');
		this.checkRevision(options, 'clearing a type');
		return this.record('clearType', id, [], (backend, ids, mirror) =>
			backend.clearType(ids(id), forMirror(options, mirror))
		);
	}

	async addLabel(id: string, label: string, options?: WriteOptions): Promise<VersionedRecord> {
		this.needs('labels', 'adding a label');
		this.checkRevision(options, 'adding a label');
		return this.record('addLabel', id, [], (backend, ids, mirror) =>
			backend.addLabel(ids(id), label, forMirror(options, mirror))
		);
	}

	async removeLabel(id: string, label: string, options?: WriteOptions): Promise<VersionedRecord> {
		this.needs('labels', 'removing a label');
		this.checkRevision(options, 'removing a label');
		return this.record('removeLabel', id, [], (backend, ids, mirror) =>
			backend.removeLabel(ids(id), label, forMirror(options, mirror))
		);
	}

	async setMeta(id: string, key: string, value: string, options?: WriteOptions): Promise<VersionedRecord> {
		this.needs('meta', 'setting metadata');
		this.checkRevision(options, 'setting metadata');
		this.checkMetaKey(key, 'set metadata');
		return this.record('setMeta', id, [], (backend, ids, mirror) =>
			backend.setMeta(ids(id), key, value, forMirror(options, mirror))
		);
	}

	async removeMeta(id: string, key: string, options?: WriteOptions): Promise<VersionedRecord> {
		this.needs('meta', 'removing metadata');
		this.checkRevision(options, 'removing metadata');
		this.checkMetaKey(key, 'remove metadata');
		return this.record('removeMeta', id, [], (backend, ids, mirror) =>
			backend.removeMeta(ids(id), key, forMirror(options, mirror))
		);
	}

	// ---- writes: graph ----

	async setParent(id: string, parentId: string, options?: WriteOptions): Promise<VersionedRecord> {
		this.needsWrites('setting a parent');
		if (this.capabilities.hierarchy === 'none') this.refuse('hierarchy', 'setting a parent');
		this.checkRevision(options, 'setting a parent');
		return this.record('setParent', id, [parentId], (backend, ids, mirror) =>
			backend.setParent(ids(id), ids(parentId), forMirror(options, mirror))
		);
	}

	async removeParent(id: string, options?: WriteOptions): Promise<VersionedRecord> {
		this.needsWrites('removing a parent');
		this.checkRevision(options, 'removing a parent');
		return this.record('removeParent', id, [], (backend, ids, mirror) =>
			backend.removeParent(ids(id), forMirror(options, mirror))
		);
	}

	async addLink(id: string, type: LinkType, targetId: string, options?: WriteOptions): Promise<VersionedRecord> {
		this.needsWrites('adding a link');
		this.checkLinkType(type, 'adding a link');
		this.checkRevision(options, 'adding a link');
		return this.record('addLink', id, [targetId], (backend, ids, mirror) =>
			backend.addLink(ids(id), type, ids(targetId), forMirror(options, mirror))
		);
	}

	async removeLink(id: string, type: LinkType, targetId: string, options?: WriteOptions): Promise<VersionedRecord> {
		this.needsWrites('removing a link');
		this.checkLinkType(type, 'removing a link');
		this.checkRevision(options, 'removing a link');
		return this.record('removeLink', id, [targetId], (backend, ids, mirror) =>
			backend.removeLink(ids(id), type, ids(targetId), forMirror(options, mirror))
		);
	}

	// ---- writes: comments ----

	async addComment(id: string, text: string, options?: AddCommentOptions): Promise<BackendCommentChange> {
		this.needs('comments', 'adding a comment');
		if (options?.attachments !== undefined && options.attachments.length > 0) {
			// The copy of a comment to the other side would upload the images twice and the migration moves no image: refused, not dropped.
			throw new UnsupportedByBackendError(
				this.kind,
				'adding a comment with attachments',
				'commentAttachments',
				'A project that is migrating writes to two strategies and task does not attach images to both. Finish or abort the migration (task migrate ...), then attach the image on a project whose strategy stores images (task strategy show), or leave --attach out.'
			);
		}
		this.checkRevision(options, 'adding a comment');
		return this.writes.run<BackendCommentChange>({
			operation: 'addComment',
			id,
			apply: (backend, ids, mirror) => backend.addComment(ids(id), text, forMirror(options, mirror)),
			result: (translator, side, value) => ({ ...value, task: translator.record(side, value.task) }),
			mirror: 'sync',
		});
	}

	async editComment(
		id: string,
		commentId: string,
		text: string,
		options?: WriteOptions
	): Promise<BackendCommentEdit> {
		this.needs('comments', 'editing a comment');
		this.checkRevision(options, 'editing a comment');
		return this.writes.run<BackendCommentEdit>({
			operation: 'editComment',
			id,
			apply: (backend, ids, mirror) => backend.editComment(ids(id), commentId, text, forMirror(options, mirror)),
			result: (translator, side, value) => ({ ...value, task: translator.record(side, value.task) }),
			mirror: 'sync',
		});
	}

	async removeComment(id: string, commentId: string, options?: WriteOptions): Promise<BackendCommentChange> {
		this.needs('comments', 'removing a comment');
		this.checkRevision(options, 'removing a comment');
		return this.writes.run<BackendCommentChange>({
			operation: 'removeComment',
			id,
			apply: (backend, ids, mirror) => backend.removeComment(ids(id), commentId, forMirror(options, mirror)),
			result: (translator, side, value) => ({ ...value, task: translator.record(side, value.task) }),
			mirror: 'sync',
		});
	}

	// ---- priority, assignee and claim ----

	async setPriority(id: string, priority: string, options?: WriteOptions): Promise<VersionedRecord> {
		this.needsField('priority', 'setting a priority');
		this.checkRevision(options, 'setting a priority');
		return this.record('setPriority', id, [], (backend, ids, mirror) =>
			field(backend, 'setPriority')(ids(id), priority, forMirror(options, mirror))
		);
	}

	async clearPriority(id: string, options?: WriteOptions): Promise<VersionedRecord> {
		this.needsField('priority', 'clearing a priority');
		this.checkRevision(options, 'clearing a priority');
		return this.record('clearPriority', id, [], (backend, ids, mirror) =>
			field(backend, 'clearPriority')(ids(id), forMirror(options, mirror))
		);
	}

	async setAssignee(id: string, assignee: string, options?: WriteOptions): Promise<VersionedRecord> {
		this.needsField('assignee', 'setting an assignee');
		this.checkRevision(options, 'setting an assignee');
		return this.record('setAssignee', id, [], (backend, ids, mirror) =>
			field(backend, 'setAssignee')(ids(id), assignee, forMirror(options, mirror))
		);
	}

	async clearAssignee(id: string, options?: WriteOptions): Promise<VersionedRecord> {
		this.needsField('assignee', 'clearing an assignee');
		this.checkRevision(options, 'clearing an assignee');
		return this.record('clearAssignee', id, [], (backend, ids, mirror) =>
			field(backend, 'clearAssignee')(ids(id), forMirror(options, mirror))
		);
	}

	async claim(id: string, input: BackendClaimInput): Promise<BackendClaimResult> {
		this.needsField('claim', 'claiming a task');
		this.checkRevision(input, 'claiming a task');
		return this.writes.run<BackendClaimResult>({
			operation: 'claim',
			id,
			apply: (backend, ids, mirror) => field(backend, 'claim')(ids(id), forMirror(input, mirror)),
			result: (translator, side, value) => ({ ...value, task: translator.record(side, value.task) }),
		});
	}

	async release(id: string, options?: ReleaseOptions): Promise<BackendReleaseResult> {
		this.needsField('claim', 'releasing a task');
		this.checkRevision(options, 'releasing a task');
		return this.writes.run<BackendReleaseResult>({
			operation: 'release',
			id,
			apply: (backend, ids, mirror) => field(backend, 'release')(ids(id), forMirror(options, mirror)),
			result: (translator, side, value) => ({ ...value, task: translator.record(side, value.task) }),
		});
	}

	// ---- delete ----

	async deleteTask(id: string, options?: WriteOptions): Promise<boolean> {
		this.needsWrites('deleting a task');
		if (this.capabilities.delete === 'no') this.refuse('delete', 'deleting a task');
		this.checkRevision(options, 'deleting a task');
		return this.writes.deleteTask(id, options);
	}
}
