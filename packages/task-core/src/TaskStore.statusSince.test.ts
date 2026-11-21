import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { TaskStore } from './TaskStore';

// `statusSince` on the index entry: the instant the task entered its CURRENT status (decision D23). The board needs it to hide a
// finished task after a delay; `updatedAt` is not that date (a comment moves it), and the index is the only thing the board reads.

describe('TaskStore statusSince', () => {
	let rootDir: string;
	let tasksDir: string;
	let store: TaskStore;

	beforeEach(() => {
		rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-store-since-'));
		tasksDir = path.join(rootDir, 'tasks');
		fs.mkdirSync(tasksDir, { recursive: true });
		store = new TaskStore(tasksDir);
	});
	afterEach(() => {
		vi.useRealTimers();
		fs.rmSync(rootDir, { recursive: true, force: true });
	});

	it('a new task has statusSince = its creation instant', () => {
		const record = store.create('first', 'backlog');

		expect(store.list()[0]!.statusSince).toBe(record.createdAt);
	});

	it('a status change moves it to the instant of the change (the one written in the history)', () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-11-01T10:00:00.000Z'));
		const record = store.create('second', 'backlog');
		vi.setSystemTime(new Date('2026-11-05T12:30:00.000Z'));

		const moved = store.updateStatus(record.id, 'done');

		expect(store.list()[0]!.statusSince).toBe('2026-11-05T12:30:00.000Z');
		expect(moved.history.at(-1)!.timestamp).toBe('2026-11-05T12:30:00.000Z');
	});

	it('a priority, an assignee or a comment does not move it', () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-11-01T10:00:00.000Z'));
		const record = store.create('third', 'backlog');
		vi.setSystemTime(new Date('2026-11-09T09:00:00.000Z'));

		store.setAssignee(record.id, 'ann');

		expect(store.list()[0]!.statusSince).toBe('2026-11-01T10:00:00.000Z');
	});

	it('a legacy index entry has none until backfillStatusSince reads the history of its file, once', () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-11-01T10:00:00.000Z'));
		const a = store.create('old a', 'backlog');
		vi.setSystemTime(new Date('2026-11-03T08:00:00.000Z'));
		store.updateStatus(a.id, 'done');
		const b = store.create('old b', 'backlog');
		// make the index look like one written before the field existed
		const indexFile = path.join(rootDir, 'task-index.json');
		const index = JSON.parse(fs.readFileSync(indexFile, 'utf8')) as { tasks: Array<Record<string, unknown>> };
		for (const entry of index.tasks) delete entry['statusSince'];
		fs.writeFileSync(indexFile, JSON.stringify(index));
		expect(store.list().every(entry => entry.statusSince === undefined)).toBe(true);

		expect(store.backfillStatusSince()).toBe(2);

		const byId = new Map(store.list().map(entry => [entry.id, entry.statusSince]));
		expect(byId.get(a.id)).toBe('2026-11-03T08:00:00.000Z');
		expect(byId.get(b.id)).toBe('2026-11-03T08:00:00.000Z');
		// nothing left to do: a second call writes nothing
		expect(store.backfillStatusSince()).toBe(0);
	});

	it('backfill skips an entry whose file is unreadable and says how many it could not fill, never failing the others', () => {
		const a = store.create('readable', 'backlog');
		const b = store.create('broken', 'backlog');
		const indexFile = path.join(rootDir, 'task-index.json');
		const index = JSON.parse(fs.readFileSync(indexFile, 'utf8')) as { tasks: Array<Record<string, unknown>> };
		for (const entry of index.tasks) delete entry['statusSince'];
		fs.writeFileSync(indexFile, JSON.stringify(index));
		fs.writeFileSync(path.join(tasksDir, `${b.id}.json`), '{ not json');

		expect(store.backfillStatusSince()).toBe(1);

		const byId = new Map(store.list().map(entry => [entry.id, entry.statusSince]));
		expect(byId.get(a.id)).toBe(a.createdAt);
		expect(byId.get(b.id)).toBeUndefined();
	});
});
