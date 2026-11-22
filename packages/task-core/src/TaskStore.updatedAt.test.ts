import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { TaskStore } from './TaskStore';

// `updatedAt` on the index entry: the instant of the LAST CHANGE of the task (any edit, status, comment, label, link...).
// The Tasks page orders by it and reads only the index. It mirrors `record.updatedAt` of every write of a task record.

describe('TaskStore updatedAt in the index', () => {
	let rootDir: string;
	let tasksDir: string;
	let store: TaskStore;
	const T0 = '2026-11-01T10:00:00.000Z';
	const T1 = '2026-11-02T10:00:00.000Z';

	const indexUpdatedAt = (id: string): string | undefined => store.list().find(entry => entry.id === id)?.updatedAt;
	const at = (iso: string): void => {
		vi.setSystemTime(new Date(iso));
	};

	beforeEach(() => {
		rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-store-updated-'));
		tasksDir = path.join(rootDir, 'tasks');
		fs.mkdirSync(tasksDir, { recursive: true });
		store = new TaskStore(tasksDir);
		vi.useFakeTimers();
		at(T0);
	});
	afterEach(() => {
		vi.useRealTimers();
		fs.rmSync(rootDir, { recursive: true, force: true });
	});

	it('a new task has updatedAt = its creation instant', () => {
		const record = store.create('first', 'backlog');

		expect(indexUpdatedAt(record.id)).toBe(record.createdAt);
	});

	const mutations: Array<[string, (store: TaskStore, id: string) => unknown]> = [
		['status', (s, id) => s.updateStatus(id, 'done')],
		['type', (s, id) => s.setType(id, 'bug')],
		['label added', (s, id) => s.addLabel(id, 'x')],
		['label removed', (s, id) => s.removeLabel(id, 'x')],
		['title', (s, id) => s.setTitle(id, 'new title')],
		['description', (s, id) => s.setDescription(id, 'a body')],
		['type cleared', (s, id) => s.clearType(id)],
		['meta set', (s, id) => s.setMeta(id, 'k', 'v')],
		['meta removed', (s, id) => s.removeMeta(id, 'k')],
		['comment added', (s, id) => s.addComment(id, 'hello')],
		['assignee', (s, id) => s.setAssignee(id, 'ann')],
		['assignee cleared', (s, id) => s.clearAssignee(id)],
		['claim', (s, id) => s.claim(id, { assignee: 'bob', leaseUntil: '2026-11-03T00:00:00.000Z', now: T1 })],
		['release', (s, id) => { s.claim(id, { assignee: 'bob', leaseUntil: '2026-11-03T00:00:00.000Z', now: T1 }); s.release(id, { force: true }); }],
	];

	it.each(mutations)('%s moves the index updatedAt to the instant of the write', (_name, mutate) => {
		const record = store.create('t', 'backlog');
		// a precondition for the removal / clear cases: something to remove
		store.addLabel(record.id, 'x');
		store.setMeta(record.id, 'k', 'v');
		store.setAssignee(record.id, 'zed');
		store.setType(record.id, 'task');
		at(T1);

		mutate(store, record.id);

		expect(indexUpdatedAt(record.id)).toBe(T1);
		expect(indexUpdatedAt(record.id)).toBe(store.get(record.id).updatedAt);
	});

	it('priority, edit and removal of a comment move it too', () => {
		const store2 = new TaskStore(tasksDir, { priorities: ['low', 'high'] });
		const record = store2.create('t', 'backlog');
		const { comment } = store2.addComment(record.id, 'one');
		at(T1);
		store2.setPriority(record.id, 'high');
		expect(store2.list()[0]!.updatedAt).toBe(T1);
		at('2026-11-03T10:00:00.000Z');
		store2.editComment(record.id, comment.id, 'two');
		expect(store2.list()[0]!.updatedAt).toBe('2026-11-03T10:00:00.000Z');
		at('2026-11-04T10:00:00.000Z');
		store2.removeComment(record.id, comment.id);
		expect(store2.list()[0]!.updatedAt).toBe('2026-11-04T10:00:00.000Z');
	});

	it('a link moves the source only, not the mirrored task (its updatedAt stays)', () => {
		const a = store.create('a', 'backlog');
		const b = store.create('b', 'backlog');
		at(T1);

		store.addLink(a.id, 'blockedBy', b.id);

		expect(indexUpdatedAt(a.id)).toBe(T1);
		expect(indexUpdatedAt(b.id)).toBe(T0);
		expect(store.get(b.id).updatedAt).toBe(T0);
		at('2026-11-03T10:00:00.000Z');
		store.removeLink(a.id, 'blockedBy', b.id);
		expect(indexUpdatedAt(a.id)).toBe('2026-11-03T10:00:00.000Z');
		expect(indexUpdatedAt(b.id)).toBe(T0);
	});

	it('a parent change moves the child only, not the parent', () => {
		const parent = store.create('p', 'backlog');
		const child = store.create('c', 'backlog');
		at(T1);

		store.setParent(child.id, parent.id);

		expect(indexUpdatedAt(child.id)).toBe(T1);
		expect(indexUpdatedAt(parent.id)).toBe(T0);
		at('2026-11-03T10:00:00.000Z');
		store.removeParent(child.id);
		expect(indexUpdatedAt(child.id)).toBe('2026-11-03T10:00:00.000Z');
		expect(indexUpdatedAt(parent.id)).toBe(T0);
	});

	it('a status change keeps the statusSince and the title keeps its index fields', () => {
		const record = store.create('t', 'backlog');
		at(T1);

		store.setTitle(record.id, 'renamed');

		const entry = store.list()[0]!;
		expect(entry.title).toBe('renamed');
		expect(entry.updatedAt).toBe(T1);
		expect(entry.statusSince).toBe(T0);
	});

	function stripFromIndex(keys: string[]): void {
		const indexFile = path.join(rootDir, 'task-index.json');
		const index = JSON.parse(fs.readFileSync(indexFile, 'utf8')) as { tasks: Array<Record<string, unknown>> };
		for (const entry of index.tasks) for (const key of keys) delete entry[key];
		fs.writeFileSync(indexFile, JSON.stringify(index));
	}

	it('backfillUpdatedAt fills a legacy index from the task files, once, and leaves an unreadable file without a date', () => {
		const a = store.create('old a', 'backlog');
		at(T1);
		store.addLabel(a.id, 'x');
		const b = store.create('broken', 'backlog');
		stripFromIndex(['updatedAt']);
		fs.writeFileSync(path.join(tasksDir, `${b.id}.json`), '{ not json');
		expect(store.list().every(entry => entry.updatedAt === undefined)).toBe(true);

		expect(store.backfillUpdatedAt()).toBe(1);

		const byId = new Map(store.list().map(entry => [entry.id, entry.updatedAt]));
		expect(byId.get(a.id)).toBe(T1);
		expect(byId.get(b.id)).toBeUndefined();
		expect(store.backfillUpdatedAt()).toBe(0);
	});
});
