import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { AmbiguousTaskPrefixError, TaskConflictError, TaskNotFoundError } from './errors.js';
import {
	CommentNotFoundError,
	generateCommentId,
	normalizeCommentAuthor,
	normalizeCommentText,
	type CommentChange,
	type CommentEdit,
	type TaskComment,
} from './taskComments.js';

// Inlined from flow-cli/storage/ExecutionStore to avoid pulling in flow-specific dependencies.
function generateExecutionId(): string {
	const hex = crypto.randomUUID().replace(/-/g, '');
	return parseInt(hex.slice(0, 11), 16).toString(36).padStart(8, '0').slice(-8);
}

// Status is validated against the project's configured `statuses` list (see TaskConfigLoader),
// not a fixed enum: task-cli's status set is project-defined, unlike flow-cli's execution lifecycle.
export type TaskStatus = string;

// Directional links, stored on the source task only. Each type has a derived, read-only inverse name
// (see INVERSE_LINK_NAMES) computed from the other tasks' links: A blockedBy B <=> B blocks A.
export const LINK_TYPES = ['blockedBy', 'duplicateOf', 'causedBy'] as const;
export type LinkType = (typeof LINK_TYPES)[number];
export type InverseLinkName = 'blocks' | 'duplicates' | 'causes';
export const INVERSE_LINK_NAMES: Record<LinkType, InverseLinkName> = {
	blockedBy: 'blocks',
	duplicateOf: 'duplicates',
	causedBy: 'causes',
};
// A task is a duplicate of at most one canonical task.
const SINGLE_TARGET_LINK_TYPES: ReadonlySet<LinkType> = new Set<LinkType>(['duplicateOf']);

export interface TaskLink {
	type: LinkType;
	target: string;
}

export interface TaskSummary {
	id: string;
	title: string;
	status: TaskStatus;
	createdAt: string;
	// Absent when the task has no outgoing link. Mirrored from TaskRecord so graph queries never read task files.
	links?: TaskLink[];
	// Absent for root tasks. Mirrored from TaskRecord so hierarchy queries never need to read task files.
	parentId?: string;
}

export interface TaskTreeNode extends TaskSummary {
	children: TaskTreeNode[];
	// Only set by getFullTree(), on the requested task.
	selected?: true;
}

export type TaskLinks = Record<LinkType | InverseLinkName, TaskSummary[]>;

/** What an activity entry is about. Status changes are not here: they stay in `TaskRecord.history`. */
export type ActivityKind =
	| 'type'
	| 'label-added'
	| 'label-removed'
	| 'meta-set'
	| 'meta-removed'
	| 'parent'
	| 'link-added'
	| 'link-removed'
	// Mirror of a parent change, written on the PARENT (always `inverse`, `target` = the child).
	| 'child-added'
	| 'child-removed'
	| 'title'
	| 'description'
	// An event of a remote system (a forge) that has no task equivalent (assigned, locked...): `field` is its name, `newValue` its detail. Never written by the local store.
	| 'other'
	// Comments: an added one is not logged here (the comment itself is the record); `field` is the comment id.
	| 'comment-edited'
	| 'comment-removed';

/**
 * One change of a task, appended to `TaskRecord.activity` in the same write as the change. Only the keys that apply are
 * stored. `oldValue` / `newValue`: the type, the label (new for added, old for removed), the metadata value, the parent
 * id, or a preview of a title / description (see {@link ACTIVITY_PREVIEW_MAX}). `field`: the metadata key, or the stored
 * link type. `target`: the other task of a link. `inverse`: the entry is the mirror of a link (or, for `child-added` / `child-removed`, of a parent change) held by `target`.
 */
export interface ActivityEntry {
	at: string;
	kind: ActivityKind;
	field?: string;
	oldValue?: string;
	newValue?: string;
	target?: string;
	inverse?: true;
}

/** A stored title / description preview is at most this long (an ellipsis of three dots included): never the full text. */
export const ACTIVITY_PREVIEW_MAX = 200;

/** The text as stored in an activity entry: unchanged up to the maximum, else cut with a trailing `...`. */
export function activityPreview(text: string): string {
	return text.length <= ACTIVITY_PREVIEW_MAX ? text : `${text.slice(0, ACTIVITY_PREVIEW_MAX - 3)}...`;
}

type ActivityParts = Partial<Omit<ActivityEntry, 'at' | 'kind'>>;

// Only the keys that have a value (an undefined key would be dropped by JSON anyway, but not by toEqual-style readers).
function activityEntry(at: string, kind: ActivityKind, parts: ActivityParts = {}): ActivityEntry {
	const defined = Object.entries(parts).filter(([, value]) => value !== undefined);
	return { at, kind, ...Object.fromEntries(defined) };
}

export interface TaskRecord {
	id: string;
	title: string;
	// Stored only when it differs from `title` (a task without body has none); read it as `description ?? title`.
	// Files written before this rule hold the title twice and stay valid.
	description?: string;
	status: TaskStatus;
	// Outgoing links only; absent when empty. Acyclic per link type (enforced by addLink()).
	links?: TaskLink[];
	// Absent for root tasks. Hierarchy depth is unlimited; cycles are rejected by setParent().
	parentId?: string;
	type?: string;
	labels?: string[];
	meta?: Record<string, string>;
	createdAt: string;
	updatedAt: string;
	history: Array<{ status: TaskStatus; timestamp: string }>;
	/** Changes other than status, oldest first; absent in files written before the log existed (no migration). */
	activity?: ActivityEntry[];
	/** Free-text notes, oldest first; absent when there are none (and in files written before comments existed). */
	comments?: TaskComment[];
}

interface TaskIndex {
	tasks: TaskSummary[];
}

export interface TaskStoreOptions {
	/** Writes `content` to `file` (the directory exists). A failure must throw. */
	writeFile?: (file: string, content: string) => void;
}

export class TaskStore {
	/**
	 * @param tasksDir where the task files live; the index is `<tasksDir>/../task-index.json` (so a data dir holds `tasks/` and `task-index.json`).
	 * @param options.writeFile how a file is written (default: plain `fs.writeFileSync`); task-service injects an atomic write.
	 */
	constructor(
		private readonly tasksDir: string,
		options: TaskStoreOptions = {}
	) {
		this.writeFile = options.writeFile ?? ((file, content) => fs.writeFileSync(file, content, 'utf8'));
	}

	private readonly writeFile: (file: string, content: string) => void;

	/**
	 * @param description stored only when it differs from `title`.
	 * @param createdAt ISO instant to record instead of now (a task migrated from another system); not validated here.
	 */
	create(
		title: string,
		initialStatus: TaskStatus,
		parentId?: string,
		description?: string,
		createdAt?: string
	): TaskRecord {
		if (parentId !== undefined) {
			this.requireParent(parentId);
		}
		this.ensureDirectory();

		const now = createdAt ?? new Date().toISOString();
		const id = generateExecutionId();

		const record: TaskRecord = {
			id,
			title,
			...(description !== undefined && description !== title && { description }),
			status: initialStatus,
			...(parentId !== undefined && { parentId }),
			createdAt: now,
			updatedAt: now,
			history: [{ status: initialStatus, timestamp: now }],
		};

		this.writeFile(this.taskFilePath(id), JSON.stringify(record, null, 2));
		this.addToIndex({
			id,
			title,
			status: initialStatus,
			createdAt: now,
			...(parentId !== undefined && { parentId }),
		});

		return record;
	}

	/**
	 * Attaches a task under a parent. Throws if either task is missing, if the task would be its own
	 * parent, or if the parent is already a descendant of the task (which would create a cycle).
	 */
	setParent(id: string, parentId: string): TaskRecord {
		const record = this.get(id);
		if (id === parentId) {
			throw new TaskConflictError(`Task "${id}" cannot be its own parent`);
		}
		this.requireParent(parentId);
		const parentAncestors = this.ancestorIds(parentId);
		if (parentAncestors.includes(id)) {
			// Each arrow reads "has as parent": id -> parentId -> ... -> id.
			const cyclePath = [id, parentId, ...parentAncestors.slice(0, parentAncestors.indexOf(id) + 1)];
			throw new TaskConflictError(
				`Cannot set parent of "${id}" to "${parentId}": it would create a cycle (${cyclePath.join(' -> ')}); "${parentId}" is a descendant of "${id}"`
			);
		}
		return this.writeParent(record, parentId);
	}

	removeParent(id: string, options: { mirror?: boolean } = {}): TaskRecord {
		const record = this.get(id);
		if (record.parentId === undefined) {
			throw new TaskConflictError(`Task "${id}" has no parent`);
		}
		return this.writeParent(record, undefined, options.mirror !== false);
	}

	/**
	 * Adds an outgoing link `id <type> targetId`. Throws on an unknown type, a missing task, a
	 * self-link, a duplicate, a second duplicateOf target, or if it would close a cycle in the
	 * graph of that link type (checked transitively over the whole graph).
	 */
	addLink(id: string, type: LinkType, targetId: string): TaskRecord {
		if (!(LINK_TYPES as readonly string[]).includes(type)) {
			throw new Error(`Unknown link type "${type}". Valid types: ${LINK_TYPES.join(', ')}`);
		}
		const record = this.get(id);
		if (id === targetId) {
			throw new TaskConflictError(`Task "${id}" cannot be linked to itself`);
		}
		if (!fs.existsSync(this.taskFilePath(targetId))) {
			throw new Error(`Target task not found: ${targetId}`);
		}
		const links = record.links ?? [];
		if (links.some(l => l.type === type && l.target === targetId)) {
			throw new TaskConflictError(`Task "${id}" is already ${type} "${targetId}"`);
		}
		const sameType = links.find(l => l.type === type);
		if (SINGLE_TARGET_LINK_TYPES.has(type) && sameType) {
			throw new TaskConflictError(
				`Task "${id}" is already a ${type} of "${sameType.target}". Run: task unlink ${id} ${type} ${sameType.target} first`
			);
		}
		const cyclePath = this.findLinkPath(type, targetId, id);
		if (cyclePath) {
			throw new TaskConflictError(
				`Cannot link "${id}" ${type} "${targetId}": it would create a cycle (${[id, ...cyclePath].join(' -> ')})`
			);
		}
		const result = this.writeLinks(record, [...links, { type, target: targetId }], 'link-added', type, targetId);
		this.logInverseLink(id, 'link-added', type, targetId);
		return result;
	}

	removeLink(id: string, type: LinkType, targetId: string): TaskRecord {
		const record = this.get(id);
		const links = record.links ?? [];
		if (!links.some(l => l.type === type && l.target === targetId)) {
			throw new TaskConflictError(`Task "${id}" is not ${type} "${targetId}"`);
		}
		const result = this.writeLinks(
			record,
			links.filter(l => !(l.type === type && l.target === targetId)),
			'link-removed',
			type,
			targetId
		);
		this.logInverseLink(id, 'link-removed', type, targetId);
		return result;
	}

	/** Outgoing links (by type) and their derived inverses (blocks, duplicates, causes) as summaries. */
	getLinks(id: string): TaskLinks {
		const { links, dangling } = this.getLinksLenient(id);
		const first = dangling[0];
		if (first) {
			throw new Error(`Task index is corrupted: link target "${first.target}" of "${id}" not found`);
		}
		return links;
	}

	/**
	 * Like {@link getLinks}, but a link whose target is not in the index (data edited outside task) is reported in
	 * `dangling` instead of failing: the other links are still returned, so the task stays readable and repairable.
	 */
	getLinksLenient(id: string): { links: TaskLinks; dangling: TaskLink[] } {
		const tasks = this.readIndex().tasks;
		const byId = new Map(tasks.map(t => [t.id, t]));
		if (!byId.has(id)) {
			throw new TaskNotFoundError(id);
		}
		const result: TaskLinks = {
			blockedBy: [],
			blocks: [],
			duplicateOf: [],
			duplicates: [],
			causedBy: [],
			causes: [],
		};
		const dangling: TaskLink[] = [];
		for (const task of tasks) {
			for (const link of task.links ?? []) {
				if (task.id === id) {
					const target = byId.get(link.target);
					if (target) {
						result[link.type].push(target);
					} else {
						dangling.push(link);
					}
				}
				if (link.target === id) {
					result[INVERSE_LINK_NAMES[link.type]].push(task);
				}
			}
		}
		return { links: result, dangling };
	}

	/** Direct blockers of a task that are not in a terminal status. */
	getOpenBlockers(id: string, isTerminal: (status: TaskStatus) => boolean): TaskSummary[] {
		// A dangling blockedBy link blocks nothing (there is no task): it is skipped, not a failure.
		return this.getLinksLenient(id).links.blockedBy.filter(t => !isTerminal(t.status));
	}

	/**
	 * Tasks that `blockerId` was the last open blocker of: still open themselves, blocked by it, and
	 * with every blocker (including it) now terminal. Empty while `blockerId` itself is not terminal.
	 */
	getUnblockedBy(blockerId: string, isTerminal: (status: TaskStatus) => boolean): TaskSummary[] {
		const tasks = this.readIndex().tasks;
		const byId = new Map(tasks.map(t => [t.id, t]));
		const blocker = byId.get(blockerId);
		if (!blocker) {
			throw new TaskNotFoundError(blockerId);
		}
		if (!isTerminal(blocker.status)) {
			return [];
		}
		return tasks.filter(t => {
			const blockerIds = (t.links ?? []).filter(l => l.type === 'blockedBy').map(l => l.target);
			return (
				blockerIds.includes(blockerId) &&
				!isTerminal(t.status) &&
				blockerIds.every(b => {
					const other = byId.get(b);
					return other !== undefined && isTerminal(other.status);
				})
			);
		});
	}

	/** Direct children only. */
	getChildren(id: string): TaskSummary[] {
		return this.readIndex().tasks.filter(t => t.parentId === id);
	}

	/** The full subtree below a task (unlimited depth), built iteratively from the index. */
	getTree(id: string): TaskTreeNode {
		const tasks = this.readIndex().tasks;
		const root = tasks.find(t => t.id === id);
		if (!root) {
			throw new TaskNotFoundError(id);
		}
		const childrenByParent = new Map<string, TaskSummary[]>();
		for (const t of tasks) {
			if (t.parentId !== undefined) {
				const siblings = childrenByParent.get(t.parentId) ?? [];
				siblings.push(t);
				childrenByParent.set(t.parentId, siblings);
			}
		}
		const rootNode: TaskTreeNode = { ...root, children: [] };
		const pending: TaskTreeNode[] = [rootNode];
		const visited = new Set<string>([id]);
		while (pending.length > 0) {
			const node = pending.pop()!;
			for (const child of childrenByParent.get(node.id) ?? []) {
				if (visited.has(child.id)) {
					throw new Error(`Task index is corrupted: cycle detected at "${child.id}"`);
				}
				visited.add(child.id);
				const childNode: TaskTreeNode = { ...child, children: [] };
				node.children.push(childNode);
				pending.push(childNode);
			}
		}
		return rootNode;
	}

	/**
	 * All root tasks (or, with `parentId`, the children of that task) with their full subtrees.
	 * With `predicate`, a node is kept if it matches or if any of its descendants does, so a
	 * matching task is never detached from the ancestors that give it context.
	 */
	getForest(options: { parentId?: string; predicate?: (task: TaskSummary) => boolean } = {}): TaskTreeNode[] {
		const { parentId, predicate } = options;
		const tasks = this.readIndex().tasks;
		if (parentId !== undefined && !tasks.some(t => t.id === parentId)) {
			throw new TaskNotFoundError(parentId);
		}
		const childrenByParent = new Map<string | undefined, TaskSummary[]>();
		for (const t of tasks) {
			const siblings = childrenByParent.get(t.parentId) ?? [];
			siblings.push(t);
			childrenByParent.set(t.parentId, siblings);
		}
		const roots: TaskTreeNode[] = (childrenByParent.get(parentId) ?? []).map(t => ({ ...t, children: [] }));
		// Preorder list of every node: iterating it backwards visits children before their parents.
		const preorder: TaskTreeNode[] = [];
		const visited = new Set<string>();
		const pending = [...roots].reverse();
		while (pending.length > 0) {
			const node = pending.pop()!;
			if (visited.has(node.id)) {
				throw new Error(`Task index is corrupted: cycle detected at "${node.id}"`);
			}
			visited.add(node.id);
			preorder.push(node);
			node.children = (childrenByParent.get(node.id) ?? []).map(t => ({ ...t, children: [] }));
			pending.push(...[...node.children].reverse());
		}
		if (!predicate) {
			return roots;
		}
		const keep = new Set<string>();
		for (const node of [...preorder].reverse()) {
			node.children = node.children.filter(c => keep.has(c.id));
			if (node.children.length > 0 || predicate(node)) {
				keep.add(node.id);
			}
		}
		return roots.filter(r => keep.has(r.id));
	}

	/** Every descendant (unlimited depth), flat, each parent listed before its own children. */
	getDescendants(id: string): TaskSummary[] {
		const descendants: TaskSummary[] = [];
		const pending: TaskTreeNode[] = [...this.getTree(id).children].reverse();
		while (pending.length > 0) {
			const { children, ...summary } = pending.pop()!;
			descendants.push(summary);
			pending.push(...[...children].reverse());
		}
		return descendants;
	}

	/**
	 * The complete tree containing a task: rooted at its topmost ancestor, with the requested
	 * task flagged `selected` so it can be located in the output.
	 */
	getFullTree(id: string): TaskTreeNode {
		const ancestors = this.ancestorIds(id);
		const tree = this.getTree(ancestors[ancestors.length - 1] ?? id);
		const pending: TaskTreeNode[] = [tree];
		while (pending.length > 0) {
			const node = pending.pop()!;
			if (node.id === id) {
				node.selected = true;
				break;
			}
			pending.push(...node.children);
		}
		return tree;
	}

	/** Ancestors ordered from the direct parent up to the root. */
	getAncestors(id: string): TaskSummary[] {
		const byId = new Map(this.readIndex().tasks.map(t => [t.id, t]));
		return this.ancestorIds(id).map(ancestorId => byId.get(ancestorId)!);
	}

	get(id: string): TaskRecord {
		const filePath = this.taskFilePath(id);
		if (!fs.existsSync(filePath)) {
			throw new TaskNotFoundError(id);
		}
		try {
			return JSON.parse(fs.readFileSync(filePath, 'utf8')) as TaskRecord;
		} catch (err) {
			throw new Error(`Corrupted task record for ${id}: ${String(err)}`);
		}
	}

	findByPrefix(prefix: string): TaskRecord {
		const lower = prefix.toLowerCase();
		const matches = this.readIndex().tasks.filter(t => t.id.toLowerCase().startsWith(lower));
		if (matches.length === 0) {
			throw new TaskNotFoundError(prefix);
		}
		if (matches.length > 1) {
			throw new AmbiguousTaskPrefixError(
				prefix,
				matches.map(t => t.id)
			);
		}
		return this.get(matches[0]!.id);
	}

	updateStatus(id: string, status: TaskStatus, existing?: TaskRecord): TaskRecord {
		const record = existing ?? this.get(id);
		if (record.status === status) {
			throw new TaskConflictError(`Task "${id}" is already in status "${status}"`);
		}
		const now = new Date().toISOString();

		record.status = status;
		record.updatedAt = now;
		record.history.push({ status, timestamp: now });

		this.writeFile(this.taskFilePath(id), JSON.stringify(record, null, 2));
		this.updateIndexEntry(id, status);

		return record;
	}

	list(): TaskSummary[] {
		const index = this.readIndex();
		return index.tasks;
	}

	setType(id: string, type: string): TaskRecord {
		const record = this.get(id);
		const oldType = record.type;
		record.type = type;
		record.updatedAt = new Date().toISOString();
		if (oldType !== type) {
			this.appendActivity(record, activityEntry(record.updatedAt, 'type', { oldValue: oldType, newValue: type }));
		}
		this.writeFile(this.taskFilePath(id), JSON.stringify(record, null, 2));
		return record;
	}

	addLabel(id: string, label: string): TaskRecord {
		const record = this.get(id);
		record.labels = record.labels ?? [];
		record.updatedAt = new Date().toISOString();
		if (!record.labels.includes(label)) {
			record.labels.push(label);
			this.appendActivity(record, activityEntry(record.updatedAt, 'label-added', { newValue: label }));
		}
		this.writeFile(this.taskFilePath(id), JSON.stringify(record, null, 2));
		return record;
	}

	removeLabel(id: string, label: string): TaskRecord {
		const record = this.get(id);
		const had = (record.labels ?? []).includes(label);
		record.labels = (record.labels ?? []).filter(l => l !== label);
		record.updatedAt = new Date().toISOString();
		if (had) {
			this.appendActivity(record, activityEntry(record.updatedAt, 'label-removed', { oldValue: label }));
		}
		this.writeFile(this.taskFilePath(id), JSON.stringify(record, null, 2));
		return record;
	}

	/** Replaces the title (file and index). A stored description that now equals it is dropped (it would be the title twice). */
	setTitle(id: string, title: string): TaskRecord {
		const record = this.get(id);
		const oldTitle = record.title;
		record.title = title;
		if (record.description === title) {
			delete record.description;
		}
		record.updatedAt = new Date().toISOString();
		if (oldTitle !== title) {
			this.appendActivity(
				record,
				activityEntry(record.updatedAt, 'title', {
					oldValue: activityPreview(oldTitle),
					newValue: activityPreview(title),
				})
			);
		}
		this.writeFile(this.taskFilePath(id), JSON.stringify(record, null, 2));
		const index = this.readIndex();
		const entry = index.tasks.find(t => t.id === id);
		if (!entry) {
			throw new Error(`Task index out of sync: entry for "${id}" not found. The index may be corrupted.`);
		}
		entry.title = title;
		this.writeIndex(index);
		return record;
	}

	/** Replaces the description. An empty one, or one equal to the title, removes the key (the body is the title again). */
	setDescription(id: string, description: string): TaskRecord {
		const record = this.get(id);
		const oldBody = record.description ?? record.title;
		if (description === '' || description === record.title) {
			delete record.description;
		} else {
			record.description = description;
		}
		record.updatedAt = new Date().toISOString();
		const newBody = record.description ?? record.title;
		if (oldBody !== newBody) {
			this.appendActivity(
				record,
				activityEntry(record.updatedAt, 'description', {
					oldValue: activityPreview(oldBody),
					newValue: activityPreview(newBody),
				})
			);
		}
		this.writeFile(this.taskFilePath(id), JSON.stringify(record, null, 2));
		return record;
	}

	/** Clears the type (the task has none afterwards). */
	clearType(id: string): TaskRecord {
		const record = this.get(id);
		const oldType = record.type;
		delete record.type;
		record.updatedAt = new Date().toISOString();
		if (oldType !== undefined) {
			this.appendActivity(record, activityEntry(record.updatedAt, 'type', { oldValue: oldType }));
		}
		this.writeFile(this.taskFilePath(id), JSON.stringify(record, null, 2));
		return record;
	}

	/** Removes a metadata key (an absent key changes nothing but `updatedAt`, like removeLabel); the object goes with its last key. */
	removeMeta(id: string, key: string): TaskRecord {
		const record = this.get(id);
		record.updatedAt = new Date().toISOString();
		if (record.meta !== undefined && Object.hasOwn(record.meta, key)) {
			this.appendActivity(
				record,
				activityEntry(record.updatedAt, 'meta-removed', { field: key, oldValue: record.meta[key] })
			);
			delete record.meta[key];
			if (Object.keys(record.meta).length === 0) {
				delete record.meta;
			}
		}
		this.writeFile(this.taskFilePath(id), JSON.stringify(record, null, 2));
		return record;
	}

	setMeta(id: string, key: string, value: string): TaskRecord {
		const record = this.get(id);
		// Own property only: a key such as "constructor" must not read as already set.
		const oldValue = Object.hasOwn(record.meta ?? {}, key) ? record.meta![key] : undefined;
		record.meta = record.meta ?? {};
		record.meta[key] = value;
		record.updatedAt = new Date().toISOString();
		if (oldValue !== value) {
			this.appendActivity(
				record,
				activityEntry(record.updatedAt, 'meta-set', { field: key, oldValue, newValue: value })
			);
		}
		this.writeFile(this.taskFilePath(id), JSON.stringify(record, null, 2));
		return record;
	}

	/** Appends a comment (text trimmed; blank or over the maximum refused, see taskComments.ts). Not logged in `activity`. */
	addComment(id: string, text: string, author?: string): CommentChange {
		const normalizedText = normalizeCommentText(text);
		const normalizedAuthor = normalizeCommentAuthor(author);
		const record = this.get(id);
		const comments = record.comments ?? [];
		const now = new Date().toISOString();
		const comment: TaskComment = {
			id: generateCommentId(comments.map(c => c.id)),
			at: now,
			text: normalizedText,
			...(normalizedAuthor !== undefined && { author: normalizedAuthor }),
		};
		record.comments = [...comments, comment];
		record.updatedAt = now;
		this.writeFile(this.taskFilePath(id), JSON.stringify(record, null, 2));
		return { task: record, comment };
	}

	/**
	 * Replaces the text of a comment and sets its `editedAt`. A text equal to the current one (after trimming) writes
	 * nothing and answers `changed: false`.
	 */
	editComment(id: string, commentId: string, text: string): CommentEdit {
		const normalizedText = normalizeCommentText(text);
		const record = this.get(id);
		const comments = record.comments ?? [];
		const existing = comments.find(c => c.id === commentId);
		if (existing === undefined) {
			throw new CommentNotFoundError(
				id,
				commentId,
				comments.map(c => c.id)
			);
		}
		if (existing.text === normalizedText) {
			return { task: record, comment: existing, oldText: existing.text, changed: false };
		}
		const now = new Date().toISOString();
		const edited: TaskComment = { ...existing, text: normalizedText, editedAt: now };
		record.comments = comments.map(c => (c.id === commentId ? edited : c));
		record.updatedAt = now;
		this.appendActivity(
			record,
			activityEntry(now, 'comment-edited', {
				field: commentId,
				oldValue: activityPreview(existing.text),
				newValue: activityPreview(normalizedText),
			})
		);
		this.writeFile(this.taskFilePath(id), JSON.stringify(record, null, 2));
		return { task: record, comment: edited, oldText: existing.text, changed: true };
	}

	/** Removes a comment; the `comments` key goes with the last one. */
	removeComment(id: string, commentId: string): CommentChange {
		const record = this.get(id);
		const comments = record.comments ?? [];
		const existing = comments.find(c => c.id === commentId);
		if (existing === undefined) {
			throw new CommentNotFoundError(
				id,
				commentId,
				comments.map(c => c.id)
			);
		}
		const remaining = comments.filter(c => c.id !== commentId);
		if (remaining.length === 0) {
			delete record.comments;
		} else {
			record.comments = remaining;
		}
		record.updatedAt = new Date().toISOString();
		this.appendActivity(
			record,
			activityEntry(record.updatedAt, 'comment-removed', {
				field: commentId,
				oldValue: activityPreview(existing.text),
			})
		);
		this.writeFile(this.taskFilePath(id), JSON.stringify(record, null, 2));
		return { task: record, comment: existing };
	}

	/**
	 * Deletes a task by its full ID.
	 * Returns true if the task existed and was deleted, false if it was not found.
	 */
	deleteTask(id: string): boolean {
		const filePath = this.taskFilePath(id);
		if (!fs.existsSync(filePath)) {
			return false;
		}
		fs.unlinkSync(filePath);
		this.removeFromIndex(id);
		this.orphanChildrenOf(id);
		this.removeLinksTo(id);
		return true;
	}

	// Links pointing to a deleted task would dangle: drop them from the tasks that held them.
	private removeLinksTo(targetId: string): void {
		for (const holder of this.readIndex().tasks.filter(t => t.links?.some(l => l.target === targetId))) {
			const record = this.get(holder.id);
			this.writeLinks(
				record,
				(record.links ?? []).filter(l => l.target !== targetId)
			);
		}
	}

	/**
	 * Breadth-first search along `type` links from `from` to `to`, over the whole graph in the index.
	 * Returns the path [from, ..., to], or undefined when `to` is unreachable.
	 */
	private findLinkPath(type: LinkType, from: string, to: string): string[] | undefined {
		const edges = new Map<string, string[]>();
		for (const task of this.readIndex().tasks) {
			const targets = (task.links ?? []).filter(l => l.type === type).map(l => l.target);
			if (targets.length > 0) {
				edges.set(task.id, targets);
			}
		}
		const cameFrom = new Map<string, string | undefined>([[from, undefined]]);
		const queue = [from];
		for (let head = 0; head < queue.length; head++) {
			const node = queue[head]!;
			if (node === to) {
				const path: string[] = [];
				for (let step: string | undefined = node; step !== undefined; step = cameFrom.get(step)) {
					path.unshift(step);
				}
				return path;
			}
			for (const next of edges.get(node) ?? []) {
				if (!cameFrom.has(next)) {
					cameFrom.set(next, node);
					queue.push(next);
				}
			}
		}
		return undefined;
	}

	// `kind` / `type` / `target`: the activity entry of a link the user added or removed; none when the link goes because its target was deleted.
	private writeLinks(
		record: TaskRecord,
		links: TaskLink[],
		kind?: 'link-added' | 'link-removed',
		type?: LinkType,
		target?: string
	): TaskRecord {
		if (links.length === 0) {
			delete record.links;
		} else {
			record.links = links;
		}
		record.updatedAt = new Date().toISOString();
		if (kind !== undefined) {
			this.appendActivity(record, activityEntry(record.updatedAt, kind, { field: type, target }));
		}
		this.writeFile(this.taskFilePath(record.id), JSON.stringify(record, null, 2));

		const index = this.readIndex();
		const entry = index.tasks.find(t => t.id === record.id);
		if (!entry) {
			throw new Error(`Task index out of sync: entry for "${record.id}" not found. The index may be corrupted.`);
		}
		if (links.length === 0) {
			delete entry.links;
		} else {
			entry.links = links;
		}
		this.writeIndex(index);
		return record;
	}

	// Children of a deleted task become roots; their own subtrees stay attached to them.
	private orphanChildrenOf(parentId: string): void {
		for (const child of this.getChildren(parentId)) {
			// The parent is already gone: nothing to mirror on it.
			this.removeParent(child.id, { mirror: false });
		}
	}

	private requireParent(parentId: string): void {
		if (!fs.existsSync(this.taskFilePath(parentId))) {
			throw new Error(`Parent task not found: ${parentId}`);
		}
	}

	/** Walks parentId links via the index; the visited guard turns a corrupted (cyclic) index into an error. */
	private ancestorIds(id: string): string[] {
		const parentOf = new Map(this.readIndex().tasks.map(t => [t.id, t.parentId]));
		const ancestors: string[] = [];
		const visited = new Set<string>([id]);
		let current = parentOf.get(id);
		while (current !== undefined) {
			if (visited.has(current)) {
				throw new Error(`Task index is corrupted: parent cycle detected at "${current}"`);
			}
			visited.add(current);
			ancestors.push(current);
			current = parentOf.get(current);
		}
		return ancestors;
	}

	private writeParent(record: TaskRecord, parentId: string | undefined, mirror = true): TaskRecord {
		const oldParentId = record.parentId;
		if (parentId === undefined) {
			delete record.parentId;
		} else {
			record.parentId = parentId;
		}
		record.updatedAt = new Date().toISOString();
		if (oldParentId !== parentId) {
			this.appendActivity(
				record,
				activityEntry(record.updatedAt, 'parent', { oldValue: oldParentId, newValue: parentId })
			);
		}
		this.writeFile(this.taskFilePath(record.id), JSON.stringify(record, null, 2));

		const index = this.readIndex();
		const entry = index.tasks.find(t => t.id === record.id);
		if (!entry) {
			throw new Error(`Task index out of sync: entry for "${record.id}" not found. The index may be corrupted.`);
		}
		if (parentId === undefined) {
			delete entry.parentId;
		} else {
			entry.parentId = parentId;
		}
		this.writeIndex(index);
		if (mirror && oldParentId !== parentId) {
			if (oldParentId !== undefined) this.logInverse(oldParentId, record.id, 'child-removed', 'Parent');
			if (parentId !== undefined) this.logInverse(parentId, record.id, 'child-added', 'Parent');
		}
		return record;
	}

	private appendActivity(record: TaskRecord, entry: ActivityEntry): void {
		record.activity = [...(record.activity ?? []), entry];
	}

	/**
	 * The mirror entry of a link on the task it points to ("blocks" read from the other side). A second file, so not in the
	 * holder's write: the holder is saved first and a failure here says so. A vanished target gets none (it has no file).
	 * The target's `updatedAt` stays: none of its own fields changed.
	 */
	private logInverseLink(
		holderId: string,
		kind: 'link-added' | 'link-removed',
		type: LinkType,
		targetId: string
	): void {
		this.logInverse(targetId, holderId, kind, 'Link', type);
	}

	/**
	 * A mirror entry (`inverse`, `target` = the task that changed) on a SECOND task file, written after the change itself.
	 * A vanished task gets none; its `updatedAt` stays. `what` names the change in the failure message.
	 */
	private logInverse(
		mirrorId: string,
		changedId: string,
		kind: ActivityKind,
		what: 'Link' | 'Parent',
		field?: string
	): void {
		if (!fs.existsSync(this.taskFilePath(mirrorId))) {
			return;
		}
		try {
			const mirror = this.get(mirrorId);
			this.appendActivity(
				mirror,
				activityEntry(new Date().toISOString(), kind, { field, target: changedId, inverse: true })
			);
			this.writeFile(this.taskFilePath(mirrorId), JSON.stringify(mirror, null, 2));
		} catch (err) {
			throw new Error(
				`${what} change saved on "${changedId}" but the activity entry of "${mirrorId}" could not be written: ${err instanceof Error ? err.message : String(err)}`
			);
		}
	}

	private ensureDirectory(): void {
		fs.mkdirSync(this.tasksDir, { recursive: true });
	}

	private taskFilePath(id: string): string {
		return path.join(this.tasksDir, `${id}.json`);
	}

	private indexFilePath(): string {
		return path.join(this.tasksDir, '..', 'task-index.json');
	}

	private readIndex(): TaskIndex {
		const indexPath = this.indexFilePath();
		if (!fs.existsSync(indexPath)) {
			return { tasks: [] };
		}
		try {
			return JSON.parse(fs.readFileSync(indexPath, 'utf8')) as TaskIndex;
		} catch (err) {
			throw new Error(`Corrupted task index: ${String(err)}`);
		}
	}

	private writeIndex(index: TaskIndex): void {
		this.ensureDirectory();
		this.writeFile(this.indexFilePath(), JSON.stringify(index, null, 2));
	}

	private addToIndex(summary: TaskSummary): void {
		const index = this.readIndex();
		index.tasks.push(summary);
		this.writeIndex(index);
	}

	private updateIndexEntry(id: string, status: TaskStatus): void {
		const index = this.readIndex();
		const entry = index.tasks.find(t => t.id === id);
		if (!entry) {
			throw new Error(`Task index out of sync: entry for "${id}" not found. The index may be corrupted.`);
		}
		entry.status = status;
		this.writeIndex(index);
	}

	private removeFromIndex(id: string): void {
		const index = this.readIndex();
		index.tasks = index.tasks.filter(t => t.id !== id);
		this.writeIndex(index);
	}
}
