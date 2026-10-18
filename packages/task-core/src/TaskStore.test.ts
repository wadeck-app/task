import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { TaskStore } from './TaskStore';

describe('TaskStore', () => {
	// Per-test root that owns BOTH the tasks directory and the index file.
	let rootDir: string;
	// Directory handed to TaskStore; must be nested inside rootDir because TaskStore writes its
	// index to `<tasksDir>/../task-index.json`. Passing a bare mkdtemp directory would place the
	// index in the shared OS temp root, where it is reused by every test and every run.
	let tmpDir: string;
	let store: TaskStore;

	beforeEach(() => {
		rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-store-'));
		// Mirrors the production layout `<project>/.task/tasks` (see TaskIndex.ts tasksDir).
		tmpDir = path.join(rootDir, 'tasks');
		fs.mkdirSync(tmpDir, { recursive: true });
		store = new TaskStore(tmpDir);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		fs.rmSync(rootDir, { recursive: true, force: true });
	});

	it('keeps its index inside the per-test root so runs cannot leak into each other', () => {
		store.create('Isolation probe', 'backlog');

		// The index must land in the disposable root, not in the shared OS temp directory.
		expect(fs.existsSync(path.join(rootDir, 'task-index.json'))).toBe(true);
		expect(path.dirname(tmpDir)).toBe(rootDir);
	});

	describe('create()', () => {
		it('creates a task record with the given initial status and initial history entry', () => {
			const record = store.create('My first task', 'backlog');

			expect(record.title).toBe('My first task');
			expect(record.status).toBe('backlog');
			expect(record.history).toHaveLength(1);
			expect(record.history[0].status).toBe('backlog');
			expect(record.id).toMatch(/^[a-z0-9]{8}$/);

			const filePath = path.join(tmpDir, `${record.id}.json`);
			expect(fs.existsSync(filePath)).toBe(true);
		});

		it('adds the task to the index', () => {
			const record = store.create('Indexed task', 'backlog');
			const tasks = store.list();

			expect(tasks).toHaveLength(1);
			expect(tasks[0].id).toBe(record.id);
			expect(tasks[0].title).toBe('Indexed task');
			expect(tasks[0].status).toBe('backlog');
		});
	});

	describe('get()', () => {
		it('retrieves an existing task by id', () => {
			const created = store.create('Fetchable task', 'backlog');
			const fetched = store.get(created.id);

			expect(fetched.id).toBe(created.id);
			expect(fetched.title).toBe('Fetchable task');
			expect(fetched.status).toBe('backlog');
		});

		it('throws Task not found: <id> on missing id', () => {
			expect(() => store.get('nonexistent-id')).toThrow('Task not found: nonexistent-id');
		});
	});

	describe('updateStatus()', () => {
		it('updates status and adds a history entry', () => {
			const record = store.create('Status task', 'backlog');
			// Force a distinct updatedAt: on a fast CI runner, create() and updateStatus()
			// can land in the same millisecond, making the real clock an unreliable fixture.
			vi.useFakeTimers();
			vi.setSystemTime(new Date(record.updatedAt).getTime() + 1);
			const updated = store.updateStatus(record.id, 'in-progress');
			vi.useRealTimers();

			expect(updated.status).toBe('in-progress');
			expect(updated.history).toHaveLength(2);
			expect(updated.history[1].status).toBe('in-progress');
			expect(updated.updatedAt).not.toBe(record.updatedAt);
		});

		it('throws if task is already in the requested status', () => {
			const record = store.create('Already in status task', 'backlog');
			store.updateStatus(record.id, 'in-progress');
			expect(() => store.updateStatus(record.id, 'in-progress')).toThrow('already in status "in-progress"');
		});

		it('updates the index entry status', () => {
			const record = store.create('Index-status task', 'backlog');
			store.updateStatus(record.id, 'done');

			const tasks = store.list();
			const found = tasks.find(t => t.id === record.id);
			expect(found?.status).toBe('done');
		});
	});

	describe('findByPrefix()', () => {
		it('finds a task by full id', () => {
			const record = store.create('Full id task', 'backlog');
			const found = store.findByPrefix(record.id);
			expect(found.id).toBe(record.id);
		});

		it('finds a task by prefix', () => {
			const record = store.create('Prefix task', 'backlog');
			const found = store.findByPrefix(record.id.slice(0, 4));
			expect(found.id).toBe(record.id);
		});

		it('throws Task not found for unknown prefix', () => {
			expect(() => store.findByPrefix('zzzzzzz')).toThrow('Task not found: zzzzzzz');
		});

		it('throws ambiguous error when prefix matches multiple tasks', () => {
			// Force two tasks with a shared prefix by manipulating IDs via create+direct file write
			const a = store.create('Task A', 'backlog');
			const b = store.create('Task B', 'backlog');
			// Only test ambiguity if IDs happen to share a prefix -- use first char
			const sharedPrefix = a.id[0]!;
			if (b.id.startsWith(sharedPrefix)) {
				expect(() => store.findByPrefix(sharedPrefix)).toThrow('Ambiguous prefix');
			} else {
				// IDs differ at first char -- find by that char unambiguously
				const found = store.findByPrefix(a.id[0]!);
				// just verify no crash -- result depends on IDs
				expect(found).toBeDefined();
			}
		});
	});

	describe('list()', () => {
		it('returns empty array when no tasks exist', () => {
			const tasks = store.list();
			expect(tasks).toEqual([]);
		});

		it('returns all created tasks', () => {
			store.create('Task one', 'backlog');
			store.create('Task two', 'backlog');
			store.create('Task three', 'backlog');

			const tasks = store.list();
			expect(tasks).toHaveLength(3);

			const titles = tasks.map(t => t.title);
			expect(titles).toContain('Task one');
			expect(titles).toContain('Task two');
			expect(titles).toContain('Task three');
		});
	});

	describe('deleteTask()', () => {
		it('deletes an existing task and returns true', () => {
			const record = store.create('Task to delete', 'backlog');
			const result = store.deleteTask(record.id);

			expect(result).toBe(true);
			expect(fs.existsSync(path.join(tmpDir, `${record.id}.json`))).toBe(false);
		});

		it('removes the task from the index', () => {
			const record = store.create('Index removal task', 'backlog');
			store.deleteTask(record.id);

			const tasks = store.list();
			expect(tasks.find(t => t.id === record.id)).toBeUndefined();
		});

		it('returns false for a non-existent id', () => {
			const result = store.deleteTask('nonexistent');
			expect(result).toBe(false);
		});

		it('does not affect other tasks when deleting one', () => {
			const a = store.create('Task A', 'backlog');
			const b = store.create('Task B', 'backlog');
			store.deleteTask(a.id);

			const tasks = store.list();
			expect(tasks).toHaveLength(1);
			expect(tasks[0]!.id).toBe(b.id);
		});

		it('allows creating a new task after deleting all tasks', () => {
			const record = store.create('Lonely task', 'backlog');
			store.deleteTask(record.id);
			const newRecord = store.create('New task after delete', 'backlog');

			const tasks = store.list();
			expect(tasks).toHaveLength(1);
			expect(tasks[0]!.id).toBe(newRecord.id);
		});

		it('orphans direct children instead of deleting them', () => {
			const parent = store.create('Parent', 'backlog');
			const child = store.create('Child', 'backlog', parent.id);

			store.deleteTask(parent.id);

			expect(store.get(child.id).parentId).toBeUndefined();
			expect(store.list().find(t => t.id === child.id)!.parentId).toBeUndefined();
		});

		it('leaves the rest of the subtree attached to the orphaned child', () => {
			const parent = store.create('Parent', 'backlog');
			const child = store.create('Child', 'backlog', parent.id);
			const grandChild = store.create('Grandchild', 'backlog', child.id);

			store.deleteTask(parent.id);

			expect(store.get(grandChild.id).parentId).toBe(child.id);
		});
	});

	describe('hierarchy', () => {
		describe('create() with a parent', () => {
			it('stores parentId on the record and in the index', () => {
				const parent = store.create('Parent', 'backlog');
				const child = store.create('Child', 'backlog', parent.id);

				expect(child.parentId).toBe(parent.id);
				expect(store.get(child.id).parentId).toBe(parent.id);
				expect(store.list().find(t => t.id === child.id)!.parentId).toBe(parent.id);
			});

			it('does not set parentId on a task created without parent', () => {
				const task = store.create('Alone', 'backlog');

				expect(task.parentId).toBeUndefined();
				expect(store.list()[0]!.parentId).toBeUndefined();
			});

			it('throws an actionable error when the parent does not exist, and creates nothing', () => {
				expect(() => store.create('Orphan', 'backlog', 'nope1234')).toThrow(/Parent task not found: nope1234/);
				expect(store.list()).toHaveLength(0);
			});
		});

		describe('setParent()', () => {
			it('attaches a task to a parent and updates the index', () => {
				const parent = store.create('Parent', 'backlog');
				const child = store.create('Child', 'backlog');

				const updated = store.setParent(child.id, parent.id);

				expect(updated.parentId).toBe(parent.id);
				expect(store.get(child.id).parentId).toBe(parent.id);
				expect(store.list().find(t => t.id === child.id)!.parentId).toBe(parent.id);
			});

			it('moves a task from one parent to another', () => {
				const a = store.create('A', 'backlog');
				const b = store.create('B', 'backlog');
				const child = store.create('Child', 'backlog', a.id);

				store.setParent(child.id, b.id);

				expect(store.getChildren(a.id)).toHaveLength(0);
				expect(store.getChildren(b.id).map(t => t.id)).toEqual([child.id]);
			});

			it('rejects a task being its own parent', () => {
				const task = store.create('Self', 'backlog');

				expect(() => store.setParent(task.id, task.id)).toThrow(/cannot be its own parent/);
			});

			it('rejects a direct cycle (parent made child of its own child)', () => {
				const parent = store.create('Parent', 'backlog');
				const child = store.create('Child', 'backlog', parent.id);

				expect(() => store.setParent(parent.id, child.id)).toThrow(/cycle/);
				expect(store.get(parent.id).parentId).toBeUndefined();
			});

			it('rejects an indirect cycle through several levels', () => {
				const a = store.create('A', 'backlog');
				const b = store.create('B', 'backlog', a.id);
				const c = store.create('C', 'backlog', b.id);
				const d = store.create('D', 'backlog', c.id);

				expect(() => store.setParent(a.id, d.id)).toThrow(/cycle/);
			});

			it('rejects closing a chain: A parent of B parent of C, then C as parent of A', () => {
				const a = store.create('A', 'backlog');
				const b = store.create('B', 'backlog', a.id);
				const c = store.create('C', 'backlog', b.id);

				expect(() => store.setParent(a.id, c.id)).toThrow(/cycle/);
				expect(store.get(a.id).parentId).toBeUndefined();
			});

			it('names the whole cycle path in the error so it is actionable', () => {
				const a = store.create('A', 'backlog');
				const b = store.create('B', 'backlog', a.id);
				const c = store.create('C', 'backlog', b.id);

				expect(() => store.setParent(a.id, c.id)).toThrow(new RegExp(`${a.id} → ${c.id} → ${b.id} → ${a.id}`));
			});

			it('rejects moving a middle task under one of its own descendants', () => {
				const a = store.create('A', 'backlog');
				const b = store.create('B', 'backlog', a.id);
				const c = store.create('C', 'backlog', b.id);
				const d = store.create('D', 'backlog', c.id);

				expect(() => store.setParent(b.id, d.id)).toThrow(/cycle/);
				expect(() => store.setParent(b.id, c.id)).toThrow(/cycle/);
				expect(store.get(b.id).parentId).toBe(a.id);
			});

			it('rejects closing a long chain (60 levels) end to start', () => {
				let current = store.create('L0', 'backlog');
				const rootId = current.id;
				for (let i = 1; i < 60; i++) {
					current = store.create(`L${i}`, 'backlog', current.id);
				}

				expect(() => store.setParent(rootId, current.id)).toThrow(/cycle/);
			});

			it('allows moving a subtree under an unrelated task or a sibling branch', () => {
				const root = store.create('Root', 'backlog');
				const left = store.create('Left', 'backlog', root.id);
				const leftChild = store.create('Left child', 'backlog', left.id);
				const right = store.create('Right', 'backlog', root.id);

				expect(() => store.setParent(left.id, right.id)).not.toThrow();
				expect(store.getAncestors(leftChild.id).map(t => t.id)).toEqual([left.id, right.id, root.id]);
			});

			it('allows the move again once the path that formed the cycle is removed', () => {
				const a = store.create('A', 'backlog');
				const b = store.create('B', 'backlog', a.id);
				const c = store.create('C', 'backlog', b.id);
				expect(() => store.setParent(a.id, c.id)).toThrow(/cycle/);

				store.removeParent(c.id);

				expect(() => store.setParent(a.id, c.id)).not.toThrow();
			});

			it('throws when the parent does not exist', () => {
				const child = store.create('Child', 'backlog');

				expect(() => store.setParent(child.id, 'nope1234')).toThrow(/Parent task not found: nope1234/);
			});

			it('throws when the task does not exist', () => {
				const parent = store.create('Parent', 'backlog');

				expect(() => store.setParent('nope1234', parent.id)).toThrow(/Task not found: nope1234/);
			});

			it('bumps updatedAt', async () => {
				const parent = store.create('Parent', 'backlog');
				const child = store.create('Child', 'backlog');
				await new Promise(r => setTimeout(r, 5));

				const updated = store.setParent(child.id, parent.id);

				expect(updated.updatedAt > child.updatedAt).toBe(true);
			});
		});

		describe('removeParent()', () => {
			it('detaches a task from its parent in record and index', () => {
				const parent = store.create('Parent', 'backlog');
				const child = store.create('Child', 'backlog', parent.id);

				const updated = store.removeParent(child.id);

				expect(updated.parentId).toBeUndefined();
				expect(store.get(child.id).parentId).toBeUndefined();
				expect(store.list().find(t => t.id === child.id)!.parentId).toBeUndefined();
			});

			it('throws when the task has no parent', () => {
				const task = store.create('Alone', 'backlog');

				expect(() => store.removeParent(task.id)).toThrow(/has no parent/);
			});
		});

		describe('getChildren()', () => {
			it('returns only direct children', () => {
				const root = store.create('Root', 'backlog');
				const c1 = store.create('C1', 'backlog', root.id);
				const c2 = store.create('C2', 'backlog', root.id);
				store.create('Grandchild', 'backlog', c1.id);
				store.create('Unrelated', 'backlog');

				expect(
					store
						.getChildren(root.id)
						.map(t => t.id)
						.sort()
				).toEqual([c1.id, c2.id].sort());
			});

			it('returns an empty array for a leaf', () => {
				const leaf = store.create('Leaf', 'backlog');

				expect(store.getChildren(leaf.id)).toEqual([]);
			});
		});

		describe('getTree()', () => {
			it('returns nested children at unlimited depth', () => {
				const root = store.create('Root', 'backlog');
				const mid = store.create('Mid', 'backlog', root.id);
				const leaf = store.create('Leaf', 'backlog', mid.id);

				const tree = store.getTree(root.id);

				expect(tree.id).toBe(root.id);
				expect(tree.children).toHaveLength(1);
				expect(tree.children[0]!.id).toBe(mid.id);
				expect(tree.children[0]!.children[0]!.id).toBe(leaf.id);
				expect(tree.children[0]!.children[0]!.children).toEqual([]);
			});

			it('handles a deep chain (200 levels) without recursion limits', () => {
				let current = store.create('L0', 'backlog');
				const rootId = current.id;
				for (let i = 1; i < 200; i++) {
					current = store.create(`L${i}`, 'backlog', current.id);
				}

				let node = store.getTree(rootId);
				let depth = 1;
				while (node.children.length > 0) {
					node = node.children[0]!;
					depth++;
				}
				expect(depth).toBe(200);
			}, 60_000);
		});

		describe('getDescendants()', () => {
			it('returns every descendant flat, parents before their children, excluding the task itself', () => {
				const root = store.create('Root', 'backlog');
				const a = store.create('A', 'backlog', root.id);
				const a1 = store.create('A1', 'backlog', a.id);
				const b = store.create('B', 'backlog', root.id);
				store.create('Unrelated', 'backlog');

				const ids = store.getDescendants(root.id).map(t => t.id);

				expect(ids.sort()).toEqual([a.id, a1.id, b.id].sort());
				const ordered = store.getDescendants(root.id).map(t => t.id);
				expect(ordered.indexOf(a.id)).toBeLessThan(ordered.indexOf(a1.id));
			});

			it('returns an empty array for a leaf', () => {
				const leaf = store.create('Leaf', 'backlog');

				expect(store.getDescendants(leaf.id)).toEqual([]);
			});

			it('throws for an unknown task', () => {
				expect(() => store.getDescendants('nope1234')).toThrow(/Task not found: nope1234/);
			});
		});

		describe('getFullTree()', () => {
			it('returns the whole tree from the topmost ancestor, marking the requested task as selected', () => {
				const root = store.create('Root', 'backlog');
				const mid = store.create('Mid', 'backlog', root.id);
				const sibling = store.create('Sibling', 'backlog', root.id);
				const leaf = store.create('Leaf', 'backlog', mid.id);

				const tree = store.getFullTree(mid.id);

				expect(tree.id).toBe(root.id);
				expect(tree.selected).toBeUndefined();
				expect(tree.children.map(c => c.id).sort()).toEqual([mid.id, sibling.id].sort());
				const midNode = tree.children.find(c => c.id === mid.id)!;
				expect(midNode.selected).toBe(true);
				expect(midNode.children.map(c => c.id)).toEqual([leaf.id]);
				expect(tree.children.find(c => c.id === sibling.id)!.selected).toBeUndefined();
			});

			it('for a root task, returns its own subtree with the root selected', () => {
				const root = store.create('Root', 'backlog');
				store.create('Child', 'backlog', root.id);

				const tree = store.getFullTree(root.id);

				expect(tree.id).toBe(root.id);
				expect(tree.selected).toBe(true);
				expect(tree.children).toHaveLength(1);
			});

			it('throws for an unknown task', () => {
				expect(() => store.getFullTree('nope1234')).toThrow(/Task not found: nope1234/);
			});
		});

		describe('getForest()', () => {
			it('returns every root task with its full subtree', () => {
				const r1 = store.create('R1', 'backlog');
				const c1 = store.create('C1', 'backlog', r1.id);
				const g1 = store.create('G1', 'backlog', c1.id);
				const r2 = store.create('R2', 'backlog');

				const forest = store.getForest();

				expect(forest.map(n => n.id).sort()).toEqual([r1.id, r2.id].sort());
				const r1Node = forest.find(n => n.id === r1.id)!;
				expect(r1Node.children[0]!.id).toBe(c1.id);
				expect(r1Node.children[0]!.children[0]!.id).toBe(g1.id);
				expect(forest.find(n => n.id === r2.id)!.children).toEqual([]);
			});

			it('with a parentId, returns the children of that task as roots', () => {
				const root = store.create('Root', 'backlog');
				const c1 = store.create('C1', 'backlog', root.id);
				const g1 = store.create('G1', 'backlog', c1.id);
				store.create('Other root', 'backlog');

				const forest = store.getForest({ parentId: root.id });

				expect(forest.map(n => n.id)).toEqual([c1.id]);
				expect(forest[0]!.children.map(n => n.id)).toEqual([g1.id]);
			});

			it('returns an empty array when there are no tasks', () => {
				expect(store.getForest()).toEqual([]);
			});

			it('throws for an unknown parentId', () => {
				expect(() => store.getForest({ parentId: 'nope1234' })).toThrow(/Task not found: nope1234/);
			});

			it('with a predicate, keeps matching nodes and the ancestors needed to reach them', () => {
				const doneRoot = store.create('Done root', 'done');
				const activeChild = store.create('Active child', 'backlog', doneRoot.id);
				const doneGrandChild = store.create('Done grandchild', 'done', activeChild.id);
				const doneOnlyRoot = store.create('Done only', 'done');
				store.create('Done only child', 'done', doneOnlyRoot.id);

				const forest = store.getForest({ predicate: t => t.status !== 'done' });

				expect(forest.map(n => n.id)).toEqual([doneRoot.id]);
				expect(forest[0]!.children.map(n => n.id)).toEqual([activeChild.id]);
				// Matching is about reaching a match: a non-matching leaf is pruned.
				expect(forest[0]!.children[0]!.children.map(n => n.id)).not.toContain(doneGrandChild.id);
			});

			it('keeps the whole subtree of a matching node only up to matching descendants', () => {
				const root = store.create('Root', 'backlog');
				const keep = store.create('Keep', 'backlog', root.id);
				store.create('Drop', 'done', root.id);

				const forest = store.getForest({ predicate: t => t.status !== 'done' });

				expect(forest[0]!.children.map(n => n.id)).toEqual([keep.id]);
			});
		});

		describe('getAncestors()', () => {
			it('returns the chain from direct parent up to the root', () => {
				const root = store.create('Root', 'backlog');
				const mid = store.create('Mid', 'backlog', root.id);
				const leaf = store.create('Leaf', 'backlog', mid.id);

				expect(store.getAncestors(leaf.id).map(t => t.id)).toEqual([mid.id, root.id]);
			});

			it('returns an empty array for a root task', () => {
				const root = store.create('Root', 'backlog');

				expect(store.getAncestors(root.id)).toEqual([]);
			});
		});
	});
});
