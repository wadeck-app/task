// The local adapter: today's synchronous TaskStore behind the async port (design 0.2). It DELEGATES: every rule (cycles,
// single duplicateOf, inverse links, activity, index mirror, errors) is the store's, so behaviour and bytes on disk are
// identical (LocalFileBackend.golden.test.ts). What it adds is the port's own surface: revisions, the expectedRevision
// check, getMany / listPage / listLabels and the capability declaration.
import * as crypto from 'node:crypto';

import { TaskNotFoundError } from '../errors.js';
import type { CommentChange, CommentEdit } from '../taskComments.js';
import type { LinkType, TaskRecord, TaskStatus, TaskStore, TaskSummary } from '../TaskStore.js';
import { StaleRevisionError } from './backendErrors.js';
import { LOCAL_CAPABILITIES } from './capabilities.js';
import type {
	BackendCommentChange,
	BackendCommentEdit,
	CreateTaskInput,
	LabelCount,
	ListQuery,
	Page,
	TaskBackend,
	VersionedRecord,
	WriteOptions,
} from './TaskBackend.js';

/** Content hash of a record as stored: any stored change gives another value, the same content the same value. */
export function revisionOf(record: TaskRecord): string {
	const { revision: _ignored, ...stored } = record as TaskRecord & { revision?: string };
	return crypto.createHash('sha256').update(JSON.stringify(stored)).digest('hex').slice(0, 16);
}

function versioned(record: TaskRecord): VersionedRecord {
	return { ...record, revision: revisionOf(record) };
}

function withVersion<T extends CommentChange | CommentEdit>(change: T): Omit<T, 'task'> & { task: VersionedRecord } {
	return { ...change, task: versioned(change.task) };
}

export class LocalFileBackend implements TaskBackend {
	readonly kind = 'local' as const;
	readonly capabilities = LOCAL_CAPABILITIES;

	constructor(private readonly store: TaskStore) {}

	/** Compares the revision right before the write; the store is synchronous and single-threaded, so nothing can slip in between. */
	private checked<T>(id: string, options: WriteOptions | undefined, write: () => T): T {
		const expected = options?.expectedRevision;
		if (expected !== undefined) {
			const actual = revisionOf(this.store.get(id));
			if (actual !== expected) {
				throw new StaleRevisionError(id, expected, actual);
			}
		}
		return write();
	}

	// ---- reads: records ----
	async list(): Promise<TaskSummary[]> {
		return this.store.list();
	}

	async listPage(query: ListQuery = {}): Promise<Page<TaskSummary>> {
		const { parentId, statusIn, text, limit, cursor } = query;
		if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
			throw new Error(`Invalid page request: limit must be a positive integer (got ${String(limit)})`);
		}
		let offset = 0;
		if (cursor !== undefined) {
			if (!/^\d+$/.test(cursor)) {
				throw new Error(
					`Invalid page request: cursor "${cursor}" was not issued by this backend; use the nextCursor of a previous page`
				);
			}
			offset = Number(cursor);
		}
		const needle = text?.toLowerCase();
		const matching = this.store.list().filter(task => {
			if (parentId === null && task.parentId !== undefined) return false;
			if (typeof parentId === 'string' && task.parentId !== parentId) return false;
			if (statusIn !== undefined && !statusIn.includes(task.status)) return false;
			return needle === undefined || task.title.toLowerCase().includes(needle);
		});
		if (limit === undefined) {
			return { items: matching.slice(offset) };
		}
		const items = matching.slice(offset, offset + limit);
		return offset + limit < matching.length ? { items, nextCursor: String(offset + limit) } : { items };
	}

	async get(id: string): Promise<VersionedRecord> {
		return versioned(this.store.get(id));
	}

	async getMany(ids: readonly string[]): Promise<VersionedRecord[]> {
		return ids.map(id => versioned(this.store.get(id)));
	}

	async findByPrefix(prefix: string): Promise<VersionedRecord> {
		return versioned(this.store.findByPrefix(prefix));
	}

	async listLabels(): Promise<LabelCount[]> {
		const counts = new Map<string, number>();
		for (const summary of this.store.list()) {
			for (const label of new Set(this.store.get(summary.id).labels ?? [])) {
				counts.set(label, (counts.get(label) ?? 0) + 1);
			}
		}
		return [...counts]
			.map(([label, count]) => ({ label, count }))
			.sort((a, b) => b.count - a.count || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
	}

	// ---- reads: graph ----
	async getLinks(id: string) {
		return this.store.getLinks(id);
	}

	async getLinksLenient(id: string) {
		return this.store.getLinksLenient(id);
	}

	async getOpenBlockers(id: string, isTerminal: (status: TaskStatus) => boolean) {
		return this.store.getOpenBlockers(id, isTerminal);
	}

	async getUnblockedBy(blockerId: string, isTerminal: (status: TaskStatus) => boolean) {
		return this.store.getUnblockedBy(blockerId, isTerminal);
	}

	async getChildren(id: string) {
		return this.store.getChildren(id);
	}

	async getTree(id: string) {
		return this.store.getTree(id);
	}

	async getForest(options: { parentId?: string; predicate?: (task: TaskSummary) => boolean } = {}) {
		return this.store.getForest(options);
	}

	async getDescendants(id: string) {
		return this.store.getDescendants(id);
	}

	async getFullTree(id: string) {
		return this.store.getFullTree(id);
	}

	async getAncestors(id: string) {
		return this.store.getAncestors(id);
	}

	// ---- writes: fields ----
	async create(input: CreateTaskInput): Promise<VersionedRecord> {
		return versioned(this.store.create(input.title, input.status, input.parentId, input.description));
	}

	async updateStatus(id: string, status: TaskStatus, options?: WriteOptions): Promise<VersionedRecord> {
		return versioned(this.checked(id, options, () => this.store.updateStatus(id, status)));
	}

	async setTitle(id: string, title: string, options?: WriteOptions): Promise<VersionedRecord> {
		return versioned(this.checked(id, options, () => this.store.setTitle(id, title)));
	}

	async setDescription(id: string, description: string, options?: WriteOptions): Promise<VersionedRecord> {
		return versioned(this.checked(id, options, () => this.store.setDescription(id, description)));
	}

	async setType(id: string, type: string, options?: WriteOptions): Promise<VersionedRecord> {
		return versioned(this.checked(id, options, () => this.store.setType(id, type)));
	}

	async clearType(id: string, options?: WriteOptions): Promise<VersionedRecord> {
		return versioned(this.checked(id, options, () => this.store.clearType(id)));
	}

	async addLabel(id: string, label: string, options?: WriteOptions): Promise<VersionedRecord> {
		return versioned(this.checked(id, options, () => this.store.addLabel(id, label)));
	}

	async removeLabel(id: string, label: string, options?: WriteOptions): Promise<VersionedRecord> {
		return versioned(this.checked(id, options, () => this.store.removeLabel(id, label)));
	}

	async setMeta(id: string, key: string, value: string, options?: WriteOptions): Promise<VersionedRecord> {
		return versioned(this.checked(id, options, () => this.store.setMeta(id, key, value)));
	}

	async removeMeta(id: string, key: string, options?: WriteOptions): Promise<VersionedRecord> {
		return versioned(this.checked(id, options, () => this.store.removeMeta(id, key)));
	}

	// ---- writes: graph ----
	async setParent(id: string, parentId: string, options?: WriteOptions): Promise<VersionedRecord> {
		return versioned(this.checked(id, options, () => this.store.setParent(id, parentId)));
	}

	async removeParent(id: string, options?: WriteOptions): Promise<VersionedRecord> {
		return versioned(this.checked(id, options, () => this.store.removeParent(id)));
	}

	async addLink(id: string, type: LinkType, targetId: string, options?: WriteOptions): Promise<VersionedRecord> {
		return versioned(this.checked(id, options, () => this.store.addLink(id, type, targetId)));
	}

	async removeLink(id: string, type: LinkType, targetId: string, options?: WriteOptions): Promise<VersionedRecord> {
		return versioned(this.checked(id, options, () => this.store.removeLink(id, type, targetId)));
	}

	// ---- writes: comments ----
	async addComment(
		id: string,
		text: string,
		options?: WriteOptions & { author?: string }
	): Promise<BackendCommentChange> {
		return withVersion(this.checked(id, options, () => this.store.addComment(id, text, options?.author)));
	}

	async editComment(
		id: string,
		commentId: string,
		text: string,
		options?: WriteOptions
	): Promise<BackendCommentEdit> {
		return withVersion(this.checked(id, options, () => this.store.editComment(id, commentId, text)));
	}

	async removeComment(id: string, commentId: string, options?: WriteOptions): Promise<BackendCommentChange> {
		return withVersion(this.checked(id, options, () => this.store.removeComment(id, commentId)));
	}

	// ---- delete ----
	async deleteTask(id: string, options?: WriteOptions): Promise<boolean> {
		try {
			return this.checked(id, options, () => this.store.deleteTask(id));
		} catch (error) {
			// A task already gone has no revision to compare: the store answers false for it, so does the port.
			if (error instanceof TaskNotFoundError) {
				return false;
			}
			throw error;
		}
	}
}
