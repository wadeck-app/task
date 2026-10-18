import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { AmbiguousTaskPrefixError, TaskConflictError, TaskNotFoundError } from './errors';
import { TaskStore } from './TaskStore';

describe('TaskStore typed errors', () => {
	let rootDir: string;
	let store: TaskStore;

	beforeEach(() => {
		rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-store-errors-'));
		const tasksDir = path.join(rootDir, 'tasks');
		fs.mkdirSync(tasksDir, { recursive: true });
		store = new TaskStore(tasksDir);
	});

	afterEach(() => {
		fs.rmSync(rootDir, { recursive: true, force: true });
	});

	it('get() throws TaskNotFoundError carrying the id, with the historical message', () => {
		let caught: unknown;
		try {
			store.get('nope1234');
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(TaskNotFoundError);
		expect((caught as TaskNotFoundError).taskId).toBe('nope1234');
		expect((caught as Error).message).toBe('Task not found: nope1234');
	});

	it('findByPrefix() throws TaskNotFoundError for an unknown prefix', () => {
		expect(() => store.findByPrefix('zzzz')).toThrow(TaskNotFoundError);
	});

	it('findByPrefix() throws AmbiguousTaskPrefixError listing the matching ids', () => {
		const ids = [store.create('a', 'backlog').id, store.create('b', 'backlog').id];
		let caught: unknown;
		try {
			// The empty prefix matches every task.
			store.findByPrefix('');
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(AmbiguousTaskPrefixError);
		expect([...(caught as AmbiguousTaskPrefixError).matches].sort()).toEqual([...ids].sort());
		expect((caught as Error).message).toContain('Ambiguous prefix ""');
	});

	it('getLinks() on an unknown id throws TaskNotFoundError', () => {
		expect(() => store.getLinks('nope1234')).toThrow(TaskNotFoundError);
	});

	describe('TaskConflictError (state conflicts the caller can resolve: HTTP 409 for the app-module)', () => {
		it('setParent() on itself', () => {
			const a = store.create('a', 'backlog');
			expect(() => store.setParent(a.id, a.id)).toThrow(TaskConflictError);
		});

		it('setParent() creating a cycle', () => {
			const a = store.create('a', 'backlog');
			const b = store.create('b', 'backlog', a.id);
			expect(() => store.setParent(a.id, b.id)).toThrow(TaskConflictError);
		});

		it('removeParent() of a root task', () => {
			const a = store.create('a', 'backlog');
			expect(() => store.removeParent(a.id)).toThrow(TaskConflictError);
		});

		it('addLink() to itself, duplicate, second duplicateOf, cycle', () => {
			const a = store.create('a', 'backlog');
			const b = store.create('b', 'backlog');
			const c = store.create('c', 'backlog');
			expect(() => store.addLink(a.id, 'blockedBy', a.id)).toThrow(TaskConflictError);
			store.addLink(a.id, 'blockedBy', b.id);
			expect(() => store.addLink(a.id, 'blockedBy', b.id)).toThrow(TaskConflictError);
			expect(() => store.addLink(b.id, 'blockedBy', a.id)).toThrow(TaskConflictError);
			store.addLink(a.id, 'duplicateOf', b.id);
			expect(() => store.addLink(a.id, 'duplicateOf', c.id)).toThrow(TaskConflictError);
		});

		it('removeLink() of a link that does not exist', () => {
			const a = store.create('a', 'backlog');
			const b = store.create('b', 'backlog');
			expect(() => store.removeLink(a.id, 'blockedBy', b.id)).toThrow(TaskConflictError);
		});

		it('updateStatus() to the current status', () => {
			const a = store.create('a', 'backlog');
			expect(() => store.updateStatus(a.id, 'backlog')).toThrow(TaskConflictError);
		});

		it('keeps the historical message', () => {
			const a = store.create('a', 'backlog');
			expect(() => store.updateStatus(a.id, 'backlog')).toThrow(`Task "${a.id}" is already in status "backlog"`);
		});
	});
});
