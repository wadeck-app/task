import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { TaskConflictError, TaskNotFoundError } from '../errors';
import { TaskStore } from '../TaskStore';
import { StaleRevisionError } from './backendErrors';
import { LOCAL_CAPABILITIES } from './capabilities';
import { LocalFileBackend, revisionOf } from './LocalFileBackend';

describe('LocalFileBackend', () => {
	let root: string;
	let tasksDir: string;
	let store: TaskStore;
	let backend: LocalFileBackend;

	beforeEach(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-backend-contract-'));
		tasksDir = path.join(root, 'data', 'tasks');
		fs.mkdirSync(tasksDir, { recursive: true });
		store = new TaskStore(tasksDir);
		backend = new LocalFileBackend(store);
	});

	afterEach(() => {
		fs.rmSync(root, { recursive: true, force: true });
	});

	it('is the local kind with the full capability set', () => {
		expect(backend.kind).toBe('local');
		expect(backend.capabilities).toEqual(LOCAL_CAPABILITIES);
		expect(LOCAL_CAPABILITIES).toEqual({
			hierarchy: 'unlimited',
			linkTypes: ['blockedBy', 'duplicateOf', 'causedBy'],
			status: 'free',
			history: 'stored',
			activity: 'stored',
			delete: 'yes',
			search: 'index',
			concurrency: 'revision',
			ids: 'generated',
			labels: true,
			meta: true,
			comments: true,
			indexedGraph: true,
		});
	});

	it('delegates: a write through the backend is visible to the synchronous store, and the other way round', async () => {
		const created = await backend.create({ title: 'From backend', status: 'backlog' });
		expect(store.get(created.id).title).toBe('From backend');

		const fromStore = store.create('From store', 'backlog');
		expect((await backend.get(fromStore.id)).title).toBe('From store');
		expect((await backend.list()).map(t => t.id)).toEqual([created.id, fromStore.id]);
	});

	it('returns promises that are already resolved for reads and writes (no timer, no I/O wait)', async () => {
		const pending = backend.create({ title: 'x', status: 'backlog' });
		expect(pending).toBeInstanceOf(Promise);
		const record = await pending;
		const order: string[] = [];
		const read = backend.get(record.id).then(() => order.push('read'));
		order.push('sync');
		await read;
		expect(order).toEqual(['sync', 'read']);
	});

	it('rejects with the very same typed error the store throws', async () => {
		await expect(backend.get('nope1234')).rejects.toBeInstanceOf(TaskNotFoundError);
		const task = await backend.create({ title: 'a', status: 'backlog' });
		await expect(backend.updateStatus(task.id, 'backlog')).rejects.toBeInstanceOf(TaskConflictError);
		await expect(backend.updateStatus(task.id, 'backlog')).rejects.toThrow(
			`Task "${task.id}" is already in status "backlog"`
		);
	});

	describe('revision', () => {
		it('is a stable content hash: the same record gives the same revision, any stored change gives another', async () => {
			const task = await backend.create({ title: 'rev', status: 'backlog' });
			const again = await backend.get(task.id);
			expect(again.revision).toBe(task.revision);
			expect(again.revision).toBe(revisionOf(store.get(task.id)));
			expect(again.revision).toMatch(/^[0-9a-f]{16}$/);

			const changed = await backend.addLabel(task.id, 'x');
			expect(changed.revision).not.toBe(task.revision);
		});

		it('is not part of the stored file', async () => {
			const task = await backend.create({ title: 'rev', status: 'backlog' });
			await backend.addLabel(task.id, 'x');
			const raw = JSON.parse(fs.readFileSync(path.join(tasksDir, `${task.id}.json`), 'utf8')) as Record<
				string,
				unknown
			>;
			expect('revision' in raw).toBe(false);
		});

		it('a write with the current revision succeeds', async () => {
			const task = await backend.create({ title: 'rev', status: 'backlog' });
			const next = await backend.setTitle(task.id, 'renamed', { expectedRevision: task.revision });
			expect(next.title).toBe('renamed');
		});

		it('a write with an outdated revision is refused before anything is written', async () => {
			const task = await backend.create({ title: 'rev', status: 'backlog' });
			await backend.addLabel(task.id, 'x');
			const before = fs.readFileSync(path.join(tasksDir, `${task.id}.json`), 'utf8');

			const error = await backend
				.setTitle(task.id, 'renamed', { expectedRevision: task.revision })
				.catch((e: unknown) => e);

			expect(error).toBeInstanceOf(StaleRevisionError);
			expect(error).toBeInstanceOf(TaskConflictError);
			expect(fs.readFileSync(path.join(tasksDir, `${task.id}.json`), 'utf8')).toBe(before);
		});

		it.each([
			[
				'updateStatus',
				(b: LocalFileBackend, id: string, o: { expectedRevision: string }) => b.updateStatus(id, 'done', o),
			],
			[
				'setDescription',
				(b: LocalFileBackend, id: string, o: { expectedRevision: string }) => b.setDescription(id, 'd', o),
			],
			['setType', (b: LocalFileBackend, id: string, o: { expectedRevision: string }) => b.setType(id, 'bug', o)],
			['clearType', (b: LocalFileBackend, id: string, o: { expectedRevision: string }) => b.clearType(id, o)],
			['addLabel', (b: LocalFileBackend, id: string, o: { expectedRevision: string }) => b.addLabel(id, 'l', o)],
			[
				'removeLabel',
				(b: LocalFileBackend, id: string, o: { expectedRevision: string }) => b.removeLabel(id, 'l', o),
			],
			[
				'setMeta',
				(b: LocalFileBackend, id: string, o: { expectedRevision: string }) => b.setMeta(id, 'k', 'v', o),
			],
			[
				'removeMeta',
				(b: LocalFileBackend, id: string, o: { expectedRevision: string }) => b.removeMeta(id, 'k', o),
			],
			[
				'removeParent',
				(b: LocalFileBackend, id: string, o: { expectedRevision: string }) => b.removeParent(id, o),
			],
			[
				'addComment',
				(b: LocalFileBackend, id: string, o: { expectedRevision: string }) => b.addComment(id, 'hi', o),
			],
			[
				'editComment',
				(b: LocalFileBackend, id: string, o: { expectedRevision: string }) =>
					b.editComment(id, 'abcdef', 'hi', o),
			],
			[
				'removeComment',
				(b: LocalFileBackend, id: string, o: { expectedRevision: string }) => b.removeComment(id, 'abcdef', o),
			],
			['deleteTask', (b: LocalFileBackend, id: string, o: { expectedRevision: string }) => b.deleteTask(id, o)],
		])('%s honours expectedRevision', async (_name, write) => {
			const task = await backend.create({ title: 'rev', status: 'backlog' });
			const stale = { expectedRevision: 'not-the-revision' };
			await expect(write(backend, task.id, stale)).rejects.toBeInstanceOf(StaleRevisionError);
			// Nothing happened: the task is intact.
			expect(await backend.get(task.id)).toEqual(task);
		});

		it('setParent / addLink / removeLink check the revision of the task they change', async () => {
			const a = await backend.create({ title: 'a', status: 'backlog' });
			const b = await backend.create({ title: 'b', status: 'backlog' });
			const stale = { expectedRevision: 'nope' };
			await expect(backend.setParent(a.id, b.id, stale)).rejects.toBeInstanceOf(StaleRevisionError);
			await expect(backend.addLink(a.id, 'blockedBy', b.id, stale)).rejects.toBeInstanceOf(StaleRevisionError);
			await backend.addLink(a.id, 'blockedBy', b.id);
			await expect(backend.removeLink(a.id, 'blockedBy', b.id, stale)).rejects.toBeInstanceOf(StaleRevisionError);
			expect((await backend.getLinks(a.id)).blockedBy.map(t => t.id)).toEqual([b.id]);
		});

		it('a missing task is still TaskNotFoundError when a revision is given', async () => {
			await expect(backend.addLabel('nope1234', 'x', { expectedRevision: 'r' })).rejects.toBeInstanceOf(
				TaskNotFoundError
			);
		});
	});

	describe('listPage', () => {
		beforeEach(async () => {
			for (const title of ['Alpha', 'beta', 'ALPHA two', 'gamma']) {
				await backend.create({ title, status: title === 'gamma' ? 'done' : 'backlog' });
			}
		});

		it('returns everything in one page without a limit', async () => {
			const page = await backend.listPage();
			expect(page.items.map(t => t.title)).toEqual(['Alpha', 'beta', 'ALPHA two', 'gamma']);
			expect(page.nextCursor).toBeUndefined();
		});

		it('walks the pages with the cursor', async () => {
			const first = await backend.listPage({ limit: 3 });
			expect(first.items).toHaveLength(3);
			expect(first.nextCursor).toBeDefined();
			const second = await backend.listPage({ limit: 3, cursor: first.nextCursor });
			expect(second.items.map(t => t.title)).toEqual(['gamma']);
			expect(second.nextCursor).toBeUndefined();
		});

		it('filters on text (case-insensitive title substring) and on status', async () => {
			expect((await backend.listPage({ text: 'alpha' })).items.map(t => t.title)).toEqual(['Alpha', 'ALPHA two']);
			expect((await backend.listPage({ statusIn: ['done'] })).items.map(t => t.title)).toEqual(['gamma']);
		});

		it.each([[0], [-1], [1.5]])('refuses limit %s with an actionable message', async limit => {
			await expect(backend.listPage({ limit })).rejects.toThrow(/limit must be a positive integer/);
		});

		it('refuses a cursor it did not issue', async () => {
			await expect(backend.listPage({ cursor: 'abc' })).rejects.toThrow(/cursor/);
		});
	});

	describe('listLabels', () => {
		it('counts tasks per label (once per task), most used first then by name', async () => {
			const a = await backend.create({ title: 'a', status: 'backlog' });
			const b = await backend.create({ title: 'b', status: 'backlog' });
			await backend.addLabel(a.id, 'z');
			await backend.addLabel(b.id, 'z');
			await backend.addLabel(a.id, 'b');
			await backend.addLabel(b.id, 'a');
			expect(await backend.listLabels()).toEqual([
				{ label: 'z', count: 2 },
				{ label: 'a', count: 1 },
				{ label: 'b', count: 1 },
			]);
		});
	});

	describe('atomicity of the files', () => {
		it('a failing file write surfaces as a rejection and leaves the earlier state', async () => {
			let fail = false;
			const flaky = new LocalFileBackend(
				new TaskStore(tasksDir, {
					writeFile: (file, content) => {
						if (fail) throw new Error('disk full');
						fs.writeFileSync(file, content, 'utf8');
					},
				})
			);
			const task = await flaky.create({ title: 'keep', status: 'backlog' });
			fail = true;
			await expect(flaky.setTitle(task.id, 'lost')).rejects.toThrow('disk full');
			fail = false;
			expect((await flaky.get(task.id)).title).toBe('keep');
		});
	});
});
