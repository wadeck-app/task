import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

// Inlined from flow-cli/storage/ExecutionStore to avoid pulling in flow-specific dependencies.
function generateExecutionId(): string {
	const hex = crypto.randomUUID().replace(/-/g, '');
	return parseInt(hex.slice(0, 11), 16).toString(36).padStart(8, '0').slice(-8);
}

export type TaskStatus = 'created' | 'elaborating' | 'flow-review' | 'approved' | 'in-progress' | 'failed' | 'done';

export interface TaskSummary {
	id: string;
	title: string;
	status: TaskStatus;
	createdAt: string;
}

export interface TaskRecord {
	id: string;
	title: string;
	description: string;
	status: TaskStatus;
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

	create(title: string): TaskRecord {
		this.ensureDirectory();

		const now = new Date().toISOString();
		const id = generateExecutionId();

		const record: TaskRecord = {
			id,
			title,
			description: title,
			status: 'created',
			createdAt: now,
			updatedAt: now,
			history: [{ status: 'created', timestamp: now }],
		};

		fs.writeFileSync(this.taskFilePath(id), JSON.stringify(record, null, 2), 'utf8');
		this.addToIndex({ id, title, status: 'created', createdAt: now });

		return record;
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

	private ensureDirectory(): void {
		fs.mkdirSync(this.tasksDir, { recursive: true });
	}

	private taskFilePath(id: string): string {
		return path.join(this.tasksDir, `${id}.json`);
	}

	private indexFilePath(): string {
		return path.join(this.tasksDir, 'index.json');
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
}
