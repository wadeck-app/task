import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { TaskNotFoundError } from './errors';
import { TaskStore } from './TaskStore';

// Title / description split (D1), removal of a metadata key and of a type.
describe('TaskStore text and removals', () => {
	let rootDir: string;
	let tasksDir: string;
	let store: TaskStore;

	beforeEach(() => {
		rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-store-'));
		tasksDir = path.join(rootDir, 'tasks');
		fs.mkdirSync(tasksDir, { recursive: true });
		store = new TaskStore(tasksDir);
	});

	afterEach(() => {
		fs.rmSync(rootDir, { recursive: true, force: true });
	});

	const onDisk = (id: string): Record<string, unknown> =>
		JSON.parse(fs.readFileSync(path.join(tasksDir, `${id}.json`), 'utf8')) as Record<string, unknown>;

	describe('create() with a description', () => {
		it('stores no description key when none is given', () => {
			const record = store.create('Fix login', 'backlog');

			expect(onDisk(record.id)).not.toHaveProperty('description');
			expect(record.description).toBeUndefined();
		});

		it('stores the description when it differs from the title', () => {
			const record = store.create('Fix login', 'backlog', undefined, 'The redirect loops after a logout.');

			expect(onDisk(record.id)['description']).toBe('The redirect loops after a logout.');
		});

		it('stores no description key when it equals the title', () => {
			const record = store.create('Fix login', 'backlog', undefined, 'Fix login');

			expect(onDisk(record.id)).not.toHaveProperty('description');
		});

		it('keeps reading an old file whose description equals its title', () => {
			const record = store.create('Old task', 'backlog');
			const file = path.join(tasksDir, `${record.id}.json`);
			fs.writeFileSync(file, JSON.stringify({ ...onDisk(record.id), description: 'Old task' }));

			expect(store.get(record.id).description).toBe('Old task');
			expect(store.get(record.id).title).toBe('Old task');
		});
	});

	describe('setTitle()', () => {
		it('rewrites the title in the file and in the index, and bumps updatedAt', async () => {
			const record = store.create('Old', 'backlog');
			await new Promise(resolve => setTimeout(resolve, 5));

			const updated = store.setTitle(record.id, 'New');

			expect(updated.title).toBe('New');
			expect(onDisk(record.id)['title']).toBe('New');
			expect(store.list().find(t => t.id === record.id)?.title).toBe('New');
			expect(updated.updatedAt > record.updatedAt).toBe(true);
		});

		it('drops a stored description that now equals the title', () => {
			const record = store.create('Old', 'backlog', undefined, 'New');

			store.setTitle(record.id, 'New');

			expect(onDisk(record.id)).not.toHaveProperty('description');
		});

		it('keeps a stored description that differs from the new title', () => {
			const record = store.create('Old', 'backlog', undefined, 'Body');

			store.setTitle(record.id, 'New');

			expect(onDisk(record.id)['description']).toBe('Body');
		});

		it('goes through the injected writeFile (atomic path) for the file and the index', () => {
			const writes: string[] = [];
			const spied = new TaskStore(tasksDir, {
				writeFile: (file, content) => {
					writes.push(path.basename(file));
					fs.writeFileSync(file, content);
				},
			});
			const record = spied.create('Old', 'backlog');
			writes.length = 0;

			spied.setTitle(record.id, 'New');

			expect(writes).toEqual([`${record.id}.json`, 'task-index.json']);
		});

		it('throws TaskNotFoundError for an unknown id', () => {
			expect(() => store.setTitle('zzzzzzzz', 'x')).toThrow(TaskNotFoundError);
		});
	});

	describe('setDescription()', () => {
		it('stores a description that differs from the title', () => {
			const record = store.create('Title', 'backlog');

			store.setDescription(record.id, 'Body');

			expect(onDisk(record.id)['description']).toBe('Body');
		});

		it('removes the key when the new description equals the title', () => {
			const record = store.create('Title', 'backlog', undefined, 'Body');

			store.setDescription(record.id, 'Title');

			expect(onDisk(record.id)).not.toHaveProperty('description');
		});

		it('removes the key when the description is empty (the body is the title again)', () => {
			const record = store.create('Title', 'backlog', undefined, 'Body');

			store.setDescription(record.id, '');

			expect(onDisk(record.id)).not.toHaveProperty('description');
		});

		it('does not touch the index title', () => {
			const record = store.create('Title', 'backlog');

			store.setDescription(record.id, 'Body');

			expect(store.list()[0]?.title).toBe('Title');
		});
	});

	describe('removeMeta()', () => {
		it('removes the key and the meta object once empty', () => {
			const record = store.create('t', 'backlog');
			store.setMeta(record.id, 'a', '1');
			store.setMeta(record.id, 'b', '2');

			expect(store.removeMeta(record.id, 'a').meta).toEqual({ b: '2' });
			store.removeMeta(record.id, 'b');

			expect(onDisk(record.id)).not.toHaveProperty('meta');
		});

		it('does not fail on an absent key (like removeLabel) and keeps the others', () => {
			const record = store.create('t', 'backlog');
			store.setMeta(record.id, 'a', '1');

			expect(store.removeMeta(record.id, 'zzz').meta).toEqual({ a: '1' });
			expect(store.removeMeta(record.id, 'constructor').meta).toEqual({ a: '1' });
		});
	});

	describe('clearType()', () => {
		it('removes the type key', () => {
			const record = store.create('t', 'backlog');
			store.setType(record.id, 'bug');

			store.clearType(record.id);

			expect(onDisk(record.id)).not.toHaveProperty('type');
			expect(store.get(record.id).type).toBeUndefined();
		});
	});
});
