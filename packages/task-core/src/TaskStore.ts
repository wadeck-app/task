import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

// Inlined from flow-cli/storage/ExecutionStore to avoid pulling in flow-specific dependencies.
function generateExecutionId(): string {
	const hex = crypto.randomUUID().replace(/-/g, '');
	return parseInt(hex.slice(0, 11), 16).toString(36).padStart(8, '0').slice(-8);
}

// Status is validated against the project's configured `statuses` list (see TaskConfigLoader),
// not a fixed enum: task-cli's status set is project-defined, unlike flow-cli's execution lifecycle.
export type TaskStatus = string;

export interface TaskSummary {
	id: string;
	title: string;
	status: TaskStatus;
	createdAt: string;
	// Absent for root tasks. Mirrored from TaskRecord so hierarchy queries never need to read task files.
	parentId?: string;
}

export interface TaskTreeNode extends TaskSummary {
	children: TaskTreeNode[];
	// Only set by getFullTree(), on the requested task.
	selected?: true;
}

export interface TaskRecord {
	id: string;
	title: string;
	description: string;
	status: TaskStatus;
	// Absent for root tasks. Hierarchy depth is unlimited; cycles are rejected by setParent().
	parentId?: string;
	type?: string;
	labels?: string[];
	meta?: Record<string, string>;
	createdAt: string;
	updatedAt: string;
	history: Array<{ status: TaskStatus; timestamp: string }>;
}

interface TaskIndex {
	tasks: TaskSummary[];
}

export class TaskStore {
	constructor(private readonly tasksDir: string) {}

	create(title: string, initialStatus: TaskStatus, parentId?: string): TaskRecord {
		if (parentId !== undefined) {
			this.requireParent(parentId);
		}
		this.ensureDirectory();

		const now = new Date().toISOString();
		const id = generateExecutionId();

		const record: TaskRecord = {
			id,
			title,
			description: title,
			status: initialStatus,
			...(parentId !== undefined && { parentId }),
			createdAt: now,
			updatedAt: now,
			history: [{ status: initialStatus, timestamp: now }],
		};

		fs.writeFileSync(this.taskFilePath(id), JSON.stringify(record, null, 2), 'utf8');
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
			throw new Error(`Task "${id}" cannot be its own parent`);
		}
		this.requireParent(parentId);
		if (this.ancestorIds(parentId).includes(id)) {
			throw new Error(
				`Cannot set parent of "${id}" to "${parentId}": it would create a cycle ("${parentId}" is a descendant of "${id}")`
			);
		}
		return this.writeParent(record, parentId);
	}

	removeParent(id: string): TaskRecord {
		const record = this.get(id);
		if (record.parentId === undefined) {
			throw new Error(`Task "${id}" has no parent`);
		}
		return this.writeParent(record, undefined);
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
			throw new Error(`Task not found: ${id}`);
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
			throw new Error(`Task not found: ${parentId}`);
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
			throw new Error(`Task not found: ${id}`);
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
			throw new Error(`Task not found: ${prefix}`);
		}
		if (matches.length > 1) {
			throw new Error(`Ambiguous prefix "${prefix}" matches: ${matches.map(t => t.id).join(', ')}`);
		}
		return this.get(matches[0]!.id);
	}

	updateStatus(id: string, status: TaskStatus, existing?: TaskRecord): TaskRecord {
		const record = existing ?? this.get(id);
		if (record.status === status) {
			throw new Error(`Task "${id}" is already in status "${status}"`);
		}
		const now = new Date().toISOString();

		record.status = status;
		record.updatedAt = now;
		record.history.push({ status, timestamp: now });

		fs.writeFileSync(this.taskFilePath(id), JSON.stringify(record, null, 2), 'utf8');
		this.updateIndexEntry(id, status);

		return record;
	}

	list(): TaskSummary[] {
		const index = this.readIndex();
		return index.tasks;
	}

	setType(id: string, type: string): TaskRecord {
		const record = this.get(id);
		record.type = type;
		record.updatedAt = new Date().toISOString();
		fs.writeFileSync(this.taskFilePath(id), JSON.stringify(record, null, 2), 'utf8');
		return record;
	}

	addLabel(id: string, label: string): TaskRecord {
		const record = this.get(id);
		record.labels = record.labels ?? [];
		if (!record.labels.includes(label)) {
			record.labels.push(label);
		}
		record.updatedAt = new Date().toISOString();
		fs.writeFileSync(this.taskFilePath(id), JSON.stringify(record, null, 2), 'utf8');
		return record;
	}

	removeLabel(id: string, label: string): TaskRecord {
		const record = this.get(id);
		record.labels = (record.labels ?? []).filter(l => l !== label);
		record.updatedAt = new Date().toISOString();
		fs.writeFileSync(this.taskFilePath(id), JSON.stringify(record, null, 2), 'utf8');
		return record;
	}

	setMeta(id: string, key: string, value: string): TaskRecord {
		const record = this.get(id);
		record.meta = record.meta ?? {};
		record.meta[key] = value;
		record.updatedAt = new Date().toISOString();
		fs.writeFileSync(this.taskFilePath(id), JSON.stringify(record, null, 2), 'utf8');
		return record;
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
		return true;
	}

	// Children of a deleted task become roots; their own subtrees stay attached to them.
	private orphanChildrenOf(parentId: string): void {
		for (const child of this.getChildren(parentId)) {
			this.removeParent(child.id);
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

	private writeParent(record: TaskRecord, parentId: string | undefined): TaskRecord {
		if (parentId === undefined) {
			delete record.parentId;
		} else {
			record.parentId = parentId;
		}
		record.updatedAt = new Date().toISOString();
		fs.writeFileSync(this.taskFilePath(record.id), JSON.stringify(record, null, 2), 'utf8');

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
		return record;
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
		fs.writeFileSync(this.indexFilePath(), JSON.stringify(index, null, 2), 'utf8');
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
