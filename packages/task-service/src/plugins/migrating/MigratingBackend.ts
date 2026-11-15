// The backend of a strategy that holds two others (`current` and `new`). Phase P0, state `in-a` only: every operation goes to `current`;
// `new` is opened and checked and nothing is ever written to it. The wrapper promises only what BOTH sides do (the intersection of their
// capabilities): an operation whose capability one side lacks is refused here, loudly, even though `current` could do it, because a task
// made that way could not be moved to `new` later. It reads capabilities, traits and the TaskBackend port only; it knows no storage kind.
import { UnsupportedByBackendError } from '@wadeck-app/task-core';
import type {
	BackendCapabilities,
	BackendClaimInput,
	BackendClaimResult,
	BackendCommentChange,
	BackendCommentEdit,
	BackendReleaseResult,
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

export interface MigratingBackendInput {
	/** Where the tasks are. Every operation goes here. */
	current: TaskBackend;
	/** The intersection of the capabilities of both sides: what this backend declares and enforces. */
	capabilities: BackendCapabilities;
	/**
	 * For each capability the intersection holds back, the slots (`current`, `new`) that hold it back: the refusal names them so the
	 * person knows which side to change. A capability not in it is not held back.
	 */
	heldBackBy: Readonly<Partial<Record<keyof BackendCapabilities, readonly string[]>>>;
	/** The names of the statuses of the project: a side that maps statuses knows these and no other. */
	statuses: readonly string[];
}

export class MigratingBackend implements TaskBackend {
	readonly kind = 'migrating' as const;
	readonly capabilities: BackendCapabilities;

	// Optional members of the port, present only when `current` has them (the proxies in front of this class tell absent from present).
	prepare?: (needs: { priority?: boolean }) => Promise<void>;
	syncLabels?: (options: { dryRun?: boolean }) => Promise<LabelSyncReport>;

	private readonly a: TaskBackend;
	private readonly heldBackBy: MigratingBackendInput['heldBackBy'];
	private readonly statuses: ReadonlySet<string>;

	constructor(input: MigratingBackendInput) {
		this.a = input.current;
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

	private optional<K extends 'setPriority' | 'clearPriority' | 'setAssignee' | 'clearAssignee' | 'claim' | 'release'>(
		name: K
	): NonNullable<TaskBackend[K]> {
		const operation = this.a[name] as ((...args: never[]) => unknown) | undefined;
		if (typeof operation !== 'function') {
			throw new Error(
				`The strategy in "current" declares priority, assignee and claim but does not implement ${name}: this is a bug of that strategy`
			);
		}
		return operation.bind(this.a) as NonNullable<TaskBackend[K]>;
	}

	// ---- reads: records ----

	async list(): Promise<TaskSummary[]> {
		return this.a.list();
	}

	async listPage(query?: ListQuery): Promise<Page<TaskSummary>> {
		if (query?.text !== undefined && this.capabilities.search === 'none')
			this.refuse('search', 'searching by text');
		return this.a.listPage(query);
	}

	async get(id: string): Promise<VersionedRecord> {
		return this.a.get(id);
	}

	async getMany(ids: readonly string[]): Promise<VersionedRecord[]> {
		return this.a.getMany(ids);
	}

	async findByPrefix(prefix: string): Promise<VersionedRecord> {
		return this.a.findByPrefix(prefix);
	}

	async resolve(prefix: string): Promise<ResolvedTask> {
		return this.a.resolve(prefix);
	}

	async listLabels(): Promise<LabelCount[]> {
		if (!this.capabilities.labels) this.refuse('labels', 'listing labels');
		return this.a.listLabels();
	}

	// ---- reads: graph ----

	async getLinks(id: string): Promise<TaskLinks> {
		return this.a.getLinks(id);
	}

	async getLinksLenient(id: string): Promise<{ links: TaskLinks; dangling: TaskLink[] }> {
		return this.a.getLinksLenient(id);
	}

	async getOpenBlockers(id: string, isTerminal: (status: TaskStatus) => boolean): Promise<TaskSummary[]> {
		return this.a.getOpenBlockers(id, isTerminal);
	}

	async getUnblockedBy(blockerId: string, isTerminal: (status: TaskStatus) => boolean): Promise<TaskSummary[]> {
		return this.a.getUnblockedBy(blockerId, isTerminal);
	}

	async getChildren(id: string): Promise<TaskSummary[]> {
		return this.a.getChildren(id);
	}

	async getTree(id: string): Promise<TaskTreeNode> {
		return this.a.getTree(id);
	}

	async getForest(options?: {
		parentId?: string;
		predicate?: (task: TaskSummary) => boolean;
	}): Promise<TaskTreeNode[]> {
		return this.a.getForest(options);
	}

	async getDescendants(id: string): Promise<TaskSummary[]> {
		return this.a.getDescendants(id);
	}

	async getFullTree(id: string): Promise<TaskTreeNode> {
		return this.a.getFullTree(id);
	}

	async getAncestors(id: string): Promise<TaskSummary[]> {
		return this.a.getAncestors(id);
	}

	// ---- writes: fields ----

	async create(input: CreateTaskInput): Promise<VersionedRecord> {
		this.needsWrites('creating a task');
		this.checkStatus(input.status, 'creating a task');
		if (input.parentId !== undefined && this.capabilities.hierarchy === 'none') {
			this.refuse('hierarchy', 'creating a task under a parent');
		}
		return this.a.create(input);
	}

	async updateStatus(id: string, status: TaskStatus, options?: WriteOptions): Promise<VersionedRecord> {
		this.needsWrites('changing a status');
		this.checkStatus(status, 'changing a status');
		this.checkRevision(options, 'changing a status');
		return this.a.updateStatus(id, status, options);
	}

	async setTitle(id: string, title: string, options?: WriteOptions): Promise<VersionedRecord> {
		this.needsWrites('changing a title');
		this.checkRevision(options, 'changing a title');
		return this.a.setTitle(id, title, options);
	}

	async setDescription(id: string, description: string, options?: WriteOptions): Promise<VersionedRecord> {
		this.needsWrites('changing a description');
		this.checkRevision(options, 'changing a description');
		return this.a.setDescription(id, description, options);
	}

	async setType(id: string, type: string, options?: WriteOptions): Promise<VersionedRecord> {
		this.needsWrites('setting a type');
		this.checkRevision(options, 'setting a type');
		return this.a.setType(id, type, options);
	}

	async clearType(id: string, options?: WriteOptions): Promise<VersionedRecord> {
		this.needsWrites('clearing a type');
		this.checkRevision(options, 'clearing a type');
		return this.a.clearType(id, options);
	}

	async addLabel(id: string, label: string, options?: WriteOptions): Promise<VersionedRecord> {
		this.needs('labels', 'adding a label');
		this.checkRevision(options, 'adding a label');
		return this.a.addLabel(id, label, options);
	}

	async removeLabel(id: string, label: string, options?: WriteOptions): Promise<VersionedRecord> {
		this.needs('labels', 'removing a label');
		this.checkRevision(options, 'removing a label');
		return this.a.removeLabel(id, label, options);
	}

	async setMeta(id: string, key: string, value: string, options?: WriteOptions): Promise<VersionedRecord> {
		this.needs('meta', 'setting metadata');
		this.checkRevision(options, 'setting metadata');
		return this.a.setMeta(id, key, value, options);
	}

	async removeMeta(id: string, key: string, options?: WriteOptions): Promise<VersionedRecord> {
		this.needs('meta', 'removing metadata');
		this.checkRevision(options, 'removing metadata');
		return this.a.removeMeta(id, key, options);
	}

	// ---- writes: graph ----

	async setParent(id: string, parentId: string, options?: WriteOptions): Promise<VersionedRecord> {
		this.needsWrites('setting a parent');
		if (this.capabilities.hierarchy === 'none') this.refuse('hierarchy', 'setting a parent');
		this.checkRevision(options, 'setting a parent');
		return this.a.setParent(id, parentId, options);
	}

	async removeParent(id: string, options?: WriteOptions): Promise<VersionedRecord> {
		this.needsWrites('removing a parent');
		this.checkRevision(options, 'removing a parent');
		return this.a.removeParent(id, options);
	}

	async addLink(id: string, type: LinkType, targetId: string, options?: WriteOptions): Promise<VersionedRecord> {
		this.needsWrites('adding a link');
		this.checkLinkType(type, 'adding a link');
		this.checkRevision(options, 'adding a link');
		return this.a.addLink(id, type, targetId, options);
	}

	async removeLink(id: string, type: LinkType, targetId: string, options?: WriteOptions): Promise<VersionedRecord> {
		this.needsWrites('removing a link');
		this.checkLinkType(type, 'removing a link');
		this.checkRevision(options, 'removing a link');
		return this.a.removeLink(id, type, targetId, options);
	}

	// ---- writes: comments ----

	async addComment(
		id: string,
		text: string,
		options?: WriteOptions & { author?: string }
	): Promise<BackendCommentChange> {
		this.needs('comments', 'adding a comment');
		this.checkRevision(options, 'adding a comment');
		return this.a.addComment(id, text, options);
	}

	async editComment(
		id: string,
		commentId: string,
		text: string,
		options?: WriteOptions
	): Promise<BackendCommentEdit> {
		this.needs('comments', 'editing a comment');
		this.checkRevision(options, 'editing a comment');
		return this.a.editComment(id, commentId, text, options);
	}

	async removeComment(id: string, commentId: string, options?: WriteOptions): Promise<BackendCommentChange> {
		this.needs('comments', 'removing a comment');
		this.checkRevision(options, 'removing a comment');
		return this.a.removeComment(id, commentId, options);
	}

	// ---- priority, assignee and claim ----

	async setPriority(id: string, priority: string, options?: WriteOptions): Promise<VersionedRecord> {
		this.needsField('priority', 'setting a priority');
		this.checkRevision(options, 'setting a priority');
		return this.optional('setPriority')(id, priority, options);
	}

	async clearPriority(id: string, options?: WriteOptions): Promise<VersionedRecord> {
		this.needsField('priority', 'clearing a priority');
		this.checkRevision(options, 'clearing a priority');
		return this.optional('clearPriority')(id, options);
	}

	async setAssignee(id: string, assignee: string, options?: WriteOptions): Promise<VersionedRecord> {
		this.needsField('assignee', 'setting an assignee');
		this.checkRevision(options, 'setting an assignee');
		return this.optional('setAssignee')(id, assignee, options);
	}

	async clearAssignee(id: string, options?: WriteOptions): Promise<VersionedRecord> {
		this.needsField('assignee', 'clearing an assignee');
		this.checkRevision(options, 'clearing an assignee');
		return this.optional('clearAssignee')(id, options);
	}

	async claim(id: string, input: BackendClaimInput): Promise<BackendClaimResult> {
		this.needsField('claim', 'claiming a task');
		this.checkRevision(input, 'claiming a task');
		return this.optional('claim')(id, input);
	}

	async release(id: string, options?: ReleaseOptions): Promise<BackendReleaseResult> {
		this.needsField('claim', 'releasing a task');
		this.checkRevision(options, 'releasing a task');
		return this.optional('release')(id, options);
	}

	// ---- delete ----

	async deleteTask(id: string, options?: WriteOptions): Promise<boolean> {
		this.needsWrites('deleting a task');
		if (this.capabilities.delete === 'no') this.refuse('delete', 'deleting a task');
		this.checkRevision(options, 'deleting a task');
		return this.a.deleteTask(id, options);
	}
}
