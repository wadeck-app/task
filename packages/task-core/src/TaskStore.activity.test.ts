import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { ACTIVITY_PREVIEW_MAX, TaskStore } from './TaskStore';
import type { ActivityEntry } from './TaskStore';

// The activity log: every mutator that changes a task appends its entry in the same write as the change.
describe('TaskStore activity', () => {
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

	const onDisk = (id: string): { activity?: ActivityEntry[]; updatedAt: string } =>
		JSON.parse(fs.readFileSync(path.join(tasksDir, `${id}.json`), 'utf8')) as {
			activity?: ActivityEntry[];
			updatedAt: string;
		};
	const activity = (id: string): ActivityEntry[] => onDisk(id).activity ?? [];
	const without = (entry: ActivityEntry | undefined): Omit<ActivityEntry, 'at'> => {
		const { at, ...rest } = entry!;
		expect(at).toMatch(/^\d{4}-\d\d-\d\dT/);
		return rest;
	};

	it('a new task has no activity key (the status history covers its creation)', () => {
		const task = store.create('A', 'backlog');

		expect(onDisk(task.id)).not.toHaveProperty('activity');
	});

	it('reads an old file without activity', () => {
		const task = store.create('A', 'backlog');

		expect(store.get(task.id).activity).toBeUndefined();
	});

	it('uses the same instant for the entry and updatedAt', () => {
		const task = store.create('A', 'backlog');
		store.setType(task.id, 'bug');

		expect(activity(task.id)[0]!.at).toBe(onDisk(task.id).updatedAt);
	});

	describe('type', () => {
		it('setType records the old and new type; the first type has no old value', () => {
			const task = store.create('A', 'backlog');
			store.setType(task.id, 'bug');
			store.setType(task.id, 'feature');

			expect(activity(task.id).map(without)).toEqual([
				{ kind: 'type', newValue: 'bug' },
				{ kind: 'type', oldValue: 'bug', newValue: 'feature' },
			]);
		});

		it('setType to the same type records nothing', () => {
			const task = store.create('A', 'backlog');
			store.setType(task.id, 'bug');
			store.setType(task.id, 'bug');

			expect(activity(task.id)).toHaveLength(1);
		});

		it('clearType records the old type, and nothing for a task without type', () => {
			const task = store.create('A', 'backlog');
			store.clearType(task.id);
			expect(activity(task.id)).toEqual([]);

			store.setType(task.id, 'bug');
			store.clearType(task.id);

			expect(activity(task.id).map(without)[1]).toEqual({ kind: 'type', oldValue: 'bug' });
		});
	});

	describe('labels', () => {
		it('records label-added and label-removed, and nothing for a duplicate or an absent label', () => {
			const task = store.create('A', 'backlog');
			store.addLabel(task.id, 'billing');
			store.addLabel(task.id, 'billing');
			store.removeLabel(task.id, 'nope');
			store.removeLabel(task.id, 'billing');

			expect(activity(task.id).map(without)).toEqual([
				{ kind: 'label-added', newValue: 'billing' },
				{ kind: 'label-removed', oldValue: 'billing' },
			]);
		});
	});

	describe('metadata', () => {
		it('records meta-set (old absent for a new key) and meta-removed; nothing when unchanged or absent', () => {
			const task = store.create('A', 'backlog');
			store.setMeta(task.id, 'owner', 'ann');
			store.setMeta(task.id, 'owner', 'ann');
			store.setMeta(task.id, 'owner', 'bob');
			store.removeMeta(task.id, 'missing');
			store.removeMeta(task.id, 'owner');

			expect(activity(task.id).map(without)).toEqual([
				{ kind: 'meta-set', field: 'owner', newValue: 'ann' },
				{ kind: 'meta-set', field: 'owner', oldValue: 'ann', newValue: 'bob' },
				{ kind: 'meta-removed', field: 'owner', oldValue: 'bob' },
			]);
		});

		it('keeps an existing empty value distinct from an absent key', () => {
			const task = store.create('A', 'backlog');
			store.setMeta(task.id, 'k', '');
			store.setMeta(task.id, 'k', 'v');

			expect(activity(task.id).map(without)[1]).toEqual({
				kind: 'meta-set',
				field: 'k',
				oldValue: '',
				newValue: 'v',
			});
		});
	});

	describe('parent', () => {
		it('records the old and new parent ids, and nothing when the parent is unchanged', () => {
			const a = store.create('A', 'backlog');
			const b = store.create('B', 'backlog');
			const child = store.create('C', 'backlog');
			store.setParent(child.id, a.id);
			store.setParent(child.id, a.id);
			store.setParent(child.id, b.id);
			store.removeParent(child.id);

			expect(activity(child.id).map(without)).toEqual([
				{ kind: 'parent', newValue: a.id },
				{ kind: 'parent', oldValue: a.id, newValue: b.id },
				{ kind: 'parent', oldValue: b.id },
			]);
		});

		it('records the detachment of the children of a deleted task', () => {
			const parent = store.create('P', 'backlog');
			const child = store.create('C', 'backlog', parent.id);
			store.deleteTask(parent.id);

			expect(activity(child.id).map(without)).toEqual([{ kind: 'parent', oldValue: parent.id }]);
		});
	});

	describe('links', () => {
		it('records link-added on the holder and an inverse entry on the target', () => {
			const a = store.create('A', 'backlog');
			const b = store.create('B', 'backlog');
			store.addLink(a.id, 'blockedBy', b.id);

			expect(activity(a.id).map(without)).toEqual([{ kind: 'link-added', field: 'blockedBy', target: b.id }]);
			expect(activity(b.id).map(without)).toEqual([
				{ kind: 'link-added', field: 'blockedBy', target: a.id, inverse: true },
			]);
		});

		it('records link-removed on both sides', () => {
			const a = store.create('A', 'backlog');
			const b = store.create('B', 'backlog');
			store.addLink(a.id, 'causedBy', b.id);
			store.removeLink(a.id, 'causedBy', b.id);

			expect(activity(a.id).map(without)[1]).toEqual({ kind: 'link-removed', field: 'causedBy', target: b.id });
			expect(activity(b.id).map(without)[1]).toEqual({
				kind: 'link-removed',
				field: 'causedBy',
				target: a.id,
				inverse: true,
			});
		});

		it('does not touch updatedAt of the target (its own fields did not change)', () => {
			const a = store.create('A', 'backlog');
			const b = store.create('B', 'backlog');
			const before = onDisk(b.id).updatedAt;
			store.addLink(a.id, 'blockedBy', b.id);

			expect(onDisk(b.id).updatedAt).toBe(before);
		});

		it('a refused link records nothing', () => {
			const a = store.create('A', 'backlog');
			expect(() => store.addLink(a.id, 'blockedBy', a.id)).toThrow();

			expect(activity(a.id)).toEqual([]);
		});

		it('unlinking a vanished target works and records only the holder side', () => {
			const a = store.create('A', 'backlog');
			const b = store.create('B', 'backlog');
			store.addLink(a.id, 'blockedBy', b.id);
			fs.unlinkSync(path.join(tasksDir, `${b.id}.json`));
			store.removeLink(a.id, 'blockedBy', b.id);

			expect(activity(a.id).map(without)[1]).toEqual({ kind: 'link-removed', field: 'blockedBy', target: b.id });
		});

		it('deleting a task records nothing on the holders of links to it', () => {
			const a = store.create('A', 'backlog');
			const b = store.create('B', 'backlog');
			store.addLink(a.id, 'blockedBy', b.id);
			store.deleteTask(b.id);

			expect(activity(a.id)).toHaveLength(1);
		});

		it('reports a failed write of the target side, saying the holder side is saved', () => {
			const a = store.create('A', 'backlog');
			const b = store.create('B', 'backlog');
			const failing = new TaskStore(tasksDir, {
				writeFile: (file, content) => {
					if (file.endsWith(`${b.id}.json`)) throw new Error('disk full');
					fs.writeFileSync(file, content, 'utf8');
				},
			});

			expect(() => failing.addLink(a.id, 'blockedBy', b.id)).toThrow(/saved on .*disk full/s);
			expect(activity(a.id)).toHaveLength(1);
			expect(activity(b.id)).toEqual([]);
		});
	});

	describe('title and description', () => {
		it('records a title edit with the old and new text', () => {
			const task = store.create('Old', 'backlog');
			store.setTitle(task.id, 'New');

			expect(activity(task.id).map(without)).toEqual([{ kind: 'title', oldValue: 'Old', newValue: 'New' }]);
		});

		it('records nothing for the same title', () => {
			const task = store.create('Same', 'backlog');
			store.setTitle(task.id, 'Same');

			expect(activity(task.id)).toEqual([]);
		});

		it('records a description edit; the old text of a task without description is its title', () => {
			const task = store.create('Head', 'backlog');
			store.setDescription(task.id, 'Body');
			store.setDescription(task.id, 'Body');
			store.setDescription(task.id, '');

			expect(activity(task.id).map(without)).toEqual([
				{ kind: 'description', oldValue: 'Head', newValue: 'Body' },
				{ kind: 'description', oldValue: 'Body', newValue: 'Head' },
			]);
		});

		it('stores previews cut to the maximum, never the full text', () => {
			const long = 'x'.repeat(ACTIVITY_PREVIEW_MAX * 3);
			const task = store.create('Head', 'backlog');
			store.setDescription(task.id, long);
			store.setDescription(task.id, `${long}y`.replace(/x/g, 'z'));

			const [first, second] = activity(task.id);
			expect(ACTIVITY_PREVIEW_MAX).toBe(200);
			expect(first!.newValue).toHaveLength(ACTIVITY_PREVIEW_MAX);
			expect(first!.newValue!.endsWith('...')).toBe(true);
			expect(second!.oldValue).toHaveLength(ACTIVITY_PREVIEW_MAX);
			expect(JSON.stringify(onDisk(task.id).activity)).not.toContain('x'.repeat(ACTIVITY_PREVIEW_MAX));
		});

		it('keeps a text of exactly the maximum unchanged', () => {
			const task = store.create('Head', 'backlog');
			const exact = 'a'.repeat(ACTIVITY_PREVIEW_MAX);
			store.setDescription(task.id, exact);

			expect(activity(task.id)[0]!.newValue).toBe(exact);
		});
	});

	describe('atomicity', () => {
		it('a failing write leaves no entry', () => {
			const task = store.create('A', 'backlog');
			const failing = new TaskStore(tasksDir, {
				writeFile: () => {
					throw new Error('disk full');
				},
			});

			expect(() => failing.setType(task.id, 'bug')).toThrow('disk full');
			expect(() => failing.addLabel(task.id, 'x')).toThrow('disk full');
			expect(onDisk(task.id)).not.toHaveProperty('activity');
			expect(store.get(task.id).type).toBeUndefined();
		});

		it('the change and its entry are one file write', () => {
			const task = store.create('A', 'backlog');
			const writes: string[] = [];
			const spying = new TaskStore(tasksDir, {
				writeFile: (file, content) => {
					writes.push(path.basename(file));
					fs.writeFileSync(file, content, 'utf8');
				},
			});
			spying.addLabel(task.id, 'x');

			expect(writes).toEqual([`${task.id}.json`]);
			expect(JSON.parse(fs.readFileSync(path.join(tasksDir, `${task.id}.json`), 'utf8'))).toMatchObject({
				labels: ['x'],
				activity: [{ kind: 'label-added', newValue: 'x' }],
			});
		});
	});

	it('status changes keep using the history, not the activity', () => {
		const task = store.create('A', 'backlog');
		store.updateStatus(task.id, 'done');

		expect(activity(task.id)).toEqual([]);
		expect(store.get(task.id).history).toHaveLength(2);
	});
});
