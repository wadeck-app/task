import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { TaskConflictError, TaskNotFoundError } from './errors';
import { WriteLockTimeoutError } from './projectLock';
import {
	InvalidTaskFieldError,
	TaskClaimedError,
	TaskNotClaimedError,
	TaskReleaseRefusedError,
	UnknownPriorityError,
} from './taskFields';
import { TaskStore } from './TaskStore';
import type { TaskStoreOptions } from './TaskStore';

const NOW = '2026-11-14T10:00:00.000Z';
const LATER = '2026-11-14T10:30:00.000Z';
const MUCH_LATER = '2026-11-14T12:00:00.000Z';

describe('TaskStore priority, assignee and claim', () => {
	let rootDir: string;
	let tasksDir: string;
	let store: TaskStore;

	const open = (options: TaskStoreOptions = {}) => new TaskStore(tasksDir, options);
	const indexOf = (id: string) => {
		const index = JSON.parse(fs.readFileSync(path.join(rootDir, 'task-index.json'), 'utf8')) as {
			tasks: Array<Record<string, unknown>>;
		};
		return index.tasks.find(t => t.id === id)!;
	};
	const fileOf = (id: string) =>
		JSON.parse(fs.readFileSync(path.join(tasksDir, `${id}.json`), 'utf8')) as Record<string, unknown>;

	beforeEach(() => {
		rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-store-claim-'));
		tasksDir = path.join(rootDir, 'tasks');
		fs.mkdirSync(tasksDir, { recursive: true });
		store = open({ priorities: ['urgent', 'high', 'medium', 'low'] });
	});

	afterEach(() => {
		fs.rmSync(rootDir, { recursive: true, force: true });
	});

	describe('priority', () => {
		it('sets the priority in the file and in the index, with an activity entry', () => {
			const task = store.create('t', 'backlog');
			const updated = store.setPriority(task.id, ' high ');
			expect(updated.priority).toBe('high');
			expect(fileOf(task.id).priority).toBe('high');
			expect(indexOf(task.id).priority).toBe('high');
			expect(updated.activity).toEqual([
				expect.objectContaining({ kind: 'priority', newValue: 'high', at: updated.updatedAt }),
			]);
			expect(updated.activity![0]).not.toHaveProperty('oldValue');
		});

		it('records the old priority when it changes', () => {
			const task = store.create('t', 'backlog');
			store.setPriority(task.id, 'high');
			const updated = store.setPriority(task.id, 'low');
			expect(updated.activity!.at(-1)).toMatchObject({ kind: 'priority', oldValue: 'high', newValue: 'low' });
		});

		it('writes nothing and logs nothing when the priority is already that value', () => {
			const task = store.create('t', 'backlog');
			const first = store.setPriority(task.id, 'high');
			const before = fs.readFileSync(path.join(tasksDir, `${task.id}.json`), 'utf8');
			const again = store.setPriority(task.id, 'high');
			expect(fs.readFileSync(path.join(tasksDir, `${task.id}.json`), 'utf8')).toBe(before);
			expect(again.updatedAt).toBe(first.updatedAt);
			expect(again.activity).toHaveLength(1);
		});

		it('refuses an unknown priority naming the valid ones, and writes nothing', () => {
			const task = store.create('t', 'backlog');
			let caught: unknown;
			try {
				store.setPriority(task.id, 'critical');
			} catch (error) {
				caught = error;
			}
			expect(caught).toBeInstanceOf(UnknownPriorityError);
			expect((caught as UnknownPriorityError).validPriorities).toEqual(['urgent', 'high', 'medium', 'low']);
			expect((caught as Error).message).toContain('Valid priorities: urgent, high, medium, low');
			expect(fileOf(task.id)).not.toHaveProperty('priority');
		});

		it('accepts any non-empty text of at most 50 characters when no list is given', () => {
			const open1 = open();
			const task = open1.create('t', 'backlog');
			expect(open1.setPriority(task.id, 'p0').priority).toBe('p0');
			expect(() => open1.setPriority(task.id, '   ')).toThrow(InvalidTaskFieldError);
			expect(() => open1.setPriority(task.id, 'x'.repeat(51))).toThrow(/at most 50/);
			expect(() => open1.setPriority(task.id, 'a\nb')).toThrow(/control characters/);
			expect(open1.setPriority(task.id, 'x'.repeat(50)).priority).toHaveLength(50);
		});

		it('clears the priority (file, index, activity); clearing an unset priority writes nothing', () => {
			const task = store.create('t', 'backlog');
			store.setPriority(task.id, 'high');
			const cleared = store.clearPriority(task.id);
			expect(cleared).not.toHaveProperty('priority');
			expect(indexOf(task.id)).not.toHaveProperty('priority');
			expect(cleared.activity!.at(-1)).toMatchObject({ kind: 'priority', oldValue: 'high' });
			expect(cleared.activity!.at(-1)).not.toHaveProperty('newValue');
			const before = fs.readFileSync(path.join(tasksDir, `${task.id}.json`), 'utf8');
			store.clearPriority(task.id);
			expect(fs.readFileSync(path.join(tasksDir, `${task.id}.json`), 'utf8')).toBe(before);
		});

		it('throws TaskNotFoundError for an unknown task', () => {
			expect(() => store.setPriority('nope1234', 'high')).toThrow(TaskNotFoundError);
			expect(() => store.clearPriority('nope1234')).toThrow(TaskNotFoundError);
		});

		it('other mutators keep the priority, and an index written before the field existed stays valid', () => {
			const task = store.create('t', 'backlog');
			store.setPriority(task.id, 'high');
			store.addLabel(task.id, 'x');
			store.updateStatus(task.id, 'done');
			store.setTitle(task.id, 'renamed');
			expect(store.get(task.id).priority).toBe('high');
			expect(indexOf(task.id).priority).toBe('high');
			expect(store.list()).toHaveLength(1);
		});
	});

	describe('assignee', () => {
		it('sets and clears the assignee in the file and the index, with activity entries', () => {
			const task = store.create('t', 'backlog');
			const set = store.setAssignee(task.id, ' worker-1 ');
			expect(set.assignee).toBe('worker-1');
			expect(indexOf(task.id).assignee).toBe('worker-1');
			expect(set.activity!.at(-1)).toMatchObject({ kind: 'assignee', newValue: 'worker-1' });
			const cleared = store.clearAssignee(task.id);
			expect(cleared).not.toHaveProperty('assignee');
			expect(indexOf(task.id)).not.toHaveProperty('assignee');
			expect(cleared.activity!.at(-1)).toMatchObject({ kind: 'assignee', oldValue: 'worker-1' });
		});

		it('writes nothing when nothing changes', () => {
			const task = store.create('t', 'backlog');
			store.setAssignee(task.id, 'a');
			const before = fs.readFileSync(path.join(tasksDir, `${task.id}.json`), 'utf8');
			store.setAssignee(task.id, 'a');
			store.clearAssignee(store.create('other', 'backlog').id);
			expect(fs.readFileSync(path.join(tasksDir, `${task.id}.json`), 'utf8')).toBe(before);
		});

		it('refuses a blank, too long or multi-line assignee', () => {
			const task = store.create('t', 'backlog');
			expect(() => store.setAssignee(task.id, '')).toThrow(InvalidTaskFieldError);
			expect(() => store.setAssignee(task.id, 'x'.repeat(101))).toThrow(/at most 100/);
			expect(() => store.setAssignee(task.id, 'a\tb')).toThrow(/control characters/);
		});

		it('changing the assignee by hand drops the lease of the previous claim; clearing it drops the whole claim', () => {
			const task = store.create('t', 'backlog');
			store.claim(task.id, { assignee: 'a', leaseUntil: LATER, now: NOW });
			const handed = store.setAssignee(task.id, 'b');
			expect(handed.assignee).toBe('b');
			expect(handed).not.toHaveProperty('leaseUntil');
			expect(handed).not.toHaveProperty('claimedAt');
			store.claim(task.id, { assignee: 'b', leaseUntil: LATER, now: NOW, renew: true });
			const cleared = store.clearAssignee(task.id);
			expect(cleared).not.toHaveProperty('leaseUntil');
			expect(cleared).not.toHaveProperty('claimedAt');
			expect(indexOf(task.id)).not.toHaveProperty('leaseUntil');
		});
	});

	describe('claim', () => {
		it('claims a free task: assignee, claimedAt, leaseUntil, index mirror (not claimedAt), claim activity', () => {
			const task = store.create('t', 'backlog');
			const result = store.claim(task.id, { assignee: 'w1', leaseUntil: LATER, now: NOW });
			expect(result.outcome).toBe('claimed');
			expect(result.previousAssignee).toBeUndefined();
			expect(result.task).toMatchObject({ assignee: 'w1', claimedAt: NOW, leaseUntil: LATER });
			expect(indexOf(task.id)).toMatchObject({ assignee: 'w1', leaseUntil: LATER });
			expect(indexOf(task.id)).not.toHaveProperty('claimedAt');
			expect(result.task.activity!.at(-1)).toEqual({
				at: result.task.updatedAt,
				kind: 'claim',
				field: LATER,
				newValue: 'w1',
			});
		});

		it('refuses the same assignee without renew while the lease is live', () => {
			const task = store.create('t', 'backlog');
			store.claim(task.id, { assignee: 'w1', leaseUntil: LATER, now: NOW });
			let caught: unknown;
			try {
				store.claim(task.id, { assignee: 'w1', leaseUntil: MUCH_LATER, now: NOW });
			} catch (error) {
				caught = error;
			}
			expect(caught).toBeInstanceOf(TaskClaimedError);
			expect((caught as TaskClaimedError).hint).toContain('--renew');
			expect((caught as Error).message).toContain('already claimed by "w1"');
			expect(store.get(task.id).leaseUntil).toBe(LATER);
		});

		it('renews: the lease is replaced and claimedAt is kept', () => {
			const task = store.create('t', 'backlog');
			store.claim(task.id, { assignee: 'w1', leaseUntil: LATER, now: NOW });
			const result = store.claim(task.id, {
				assignee: 'w1',
				leaseUntil: MUCH_LATER,
				now: '2026-11-14T10:10:00.000Z',
				renew: true,
			});
			expect(result.outcome).toBe('renewed');
			expect(result.task).toMatchObject({ assignee: 'w1', claimedAt: NOW, leaseUntil: MUCH_LATER });
			expect(indexOf(task.id).leaseUntil).toBe(MUCH_LATER);
			expect(result.task.activity!.at(-1)).toMatchObject({
				kind: 'claim',
				oldValue: 'w1',
				newValue: 'w1',
				field: MUCH_LATER,
			});
		});

		it('refuses another assignee on a live lease with holder, lease end and remaining time', () => {
			const task = store.create('t', 'backlog');
			store.claim(task.id, { assignee: 'w1', leaseUntil: LATER, now: NOW });
			let caught: unknown;
			try {
				store.claim(task.id, {
					assignee: 'w2',
					leaseUntil: MUCH_LATER,
					now: '2026-11-14T10:10:00.000Z',
				});
			} catch (error) {
				caught = error;
			}
			expect(caught).toBeInstanceOf(TaskClaimedError);
			expect(caught).toBeInstanceOf(TaskConflictError);
			const error = caught as TaskClaimedError;
			expect(error.holder).toBe('w1');
			expect(error.leaseUntil).toBe(LATER);
			expect(error.remainingMs).toBe(20 * 60 * 1000);
			expect(error.message).toContain('claimed by "w1"');
			expect(error.message).toContain('20m left');
			expect(error.hint).toContain('--force');
			expect(store.get(task.id).assignee).toBe('w1');
		});

		it('a renew by someone else is no renew: the normal rules apply', () => {
			const task = store.create('t', 'backlog');
			store.claim(task.id, { assignee: 'w1', leaseUntil: LATER, now: NOW });
			expect(() =>
				store.claim(task.id, { assignee: 'w2', leaseUntil: MUCH_LATER, now: NOW, renew: true })
			).toThrow(TaskClaimedError);
		});

		it('takes over an expired lease and names the previous holder', () => {
			const task = store.create('t', 'backlog');
			store.claim(task.id, { assignee: 'w1', leaseUntil: LATER, now: NOW });
			const result = store.claim(task.id, { assignee: 'w2', leaseUntil: MUCH_LATER, now: LATER });
			expect(result.outcome).toBe('takeover');
			expect(result.previousAssignee).toBe('w1');
			expect(result.task).toMatchObject({ assignee: 'w2', claimedAt: LATER, leaseUntil: MUCH_LATER });
			expect(result.task.activity!.at(-1)).toMatchObject({ kind: 'claim', oldValue: 'w1', newValue: 'w2' });
		});

		it('takes over an assignee that has no lease', () => {
			const task = store.create('t', 'backlog');
			store.setAssignee(task.id, 'w1');
			const result = store.claim(task.id, { assignee: 'w2', leaseUntil: LATER, now: NOW });
			expect(result.outcome).toBe('takeover');
			expect(result.previousAssignee).toBe('w1');
		});

		it('force overrides a live lease', () => {
			const task = store.create('t', 'backlog');
			store.claim(task.id, { assignee: 'w1', leaseUntil: MUCH_LATER, now: NOW });
			const result = store.claim(task.id, { assignee: 'w2', leaseUntil: MUCH_LATER, now: LATER, force: true });
			expect(result.outcome).toBe('takeover');
			expect(result.previousAssignee).toBe('w1');
			expect(result.task.assignee).toBe('w2');
		});

		it('the same assignee after its lease ended claims again (claimedAt moves)', () => {
			const task = store.create('t', 'backlog');
			store.claim(task.id, { assignee: 'w1', leaseUntil: LATER, now: NOW });
			const result = store.claim(task.id, { assignee: 'w1', leaseUntil: MUCH_LATER, now: LATER });
			expect(result.outcome).toBe('claimed');
			expect(result.task.claimedAt).toBe(LATER);
		});

		it('refuses a lease that does not end after now, and an instant that is not ISO', () => {
			const task = store.create('t', 'backlog');
			expect(() => store.claim(task.id, { assignee: 'w1', leaseUntil: NOW, now: NOW })).toThrow(
				/not after the claim instant/
			);
			expect(() => store.claim(task.id, { assignee: 'w1', leaseUntil: 'soon', now: NOW })).toThrow(
				InvalidTaskFieldError
			);
			expect(() => store.claim(task.id, { assignee: 'w1', leaseUntil: LATER, now: 'yesterday' })).toThrow(
				/not an ISO 8601 instant/
			);
			expect(() => store.claim(task.id, { assignee: '', leaseUntil: LATER, now: NOW })).toThrow(
				InvalidTaskFieldError
			);
			expect(store.get(task.id)).not.toHaveProperty('assignee');
		});

		it('never reads the clock: claimedAt and leaseUntil are the instants given, written canonically', () => {
			const task = store.create('t', 'backlog');
			const result = store.claim(task.id, {
				assignee: 'w1',
				leaseUntil: '2099-01-01T00:00:00Z',
				now: '2098-12-31T00:00:00Z',
			});
			expect(result.task.claimedAt).toBe('2098-12-31T00:00:00.000Z');
			expect(result.task.leaseUntil).toBe('2099-01-01T00:00:00.000Z');
		});

		it('throws TaskNotFoundError for an unknown task', () => {
			expect(() => store.claim('nope1234', { assignee: 'w', leaseUntil: LATER, now: NOW })).toThrow(
				TaskNotFoundError
			);
		});
	});

	describe('release', () => {
		it('clears assignee, claimedAt and leaseUntil (file and index) and logs the holder', () => {
			const task = store.create('t', 'backlog');
			store.claim(task.id, { assignee: 'w1', leaseUntil: LATER, now: NOW });
			const result = store.release(task.id);
			expect(result.previousAssignee).toBe('w1');
			expect(result.task).not.toHaveProperty('assignee');
			expect(result.task).not.toHaveProperty('claimedAt');
			expect(result.task).not.toHaveProperty('leaseUntil');
			expect(indexOf(task.id)).not.toHaveProperty('assignee');
			expect(indexOf(task.id)).not.toHaveProperty('leaseUntil');
			expect(result.task.activity!.at(-1)).toMatchObject({ kind: 'release', oldValue: 'w1' });
		});

		it('refuses a task nobody holds', () => {
			const task = store.create('t', 'backlog');
			let caught: unknown;
			try {
				store.release(task.id);
			} catch (error) {
				caught = error;
			}
			expect(caught).toBeInstanceOf(TaskNotClaimedError);
			expect(caught).toBeInstanceOf(TaskConflictError);
			expect((caught as TaskNotClaimedError).hint).toContain('claim');
		});

		it('a release on behalf of another assignee needs force, and the refusal names the holder', () => {
			const task = store.create('t', 'backlog');
			store.claim(task.id, { assignee: 'w1', leaseUntil: LATER, now: NOW });
			let caught: unknown;
			try {
				store.release(task.id, { assignee: 'w2' });
			} catch (error) {
				caught = error;
			}
			expect(caught).toBeInstanceOf(TaskReleaseRefusedError);
			expect((caught as Error).message).toContain('held by "w1"');
			expect(store.get(task.id).assignee).toBe('w1');
			expect(store.release(task.id, { assignee: 'w1' }).previousAssignee).toBe('w1');
			store.claim(task.id, { assignee: 'w1', leaseUntil: LATER, now: NOW });
			expect(store.release(task.id, { assignee: 'w2', force: true }).previousAssignee).toBe('w1');
		});
	});

	describe('write lock', () => {
		const lockPath = () => path.join(rootDir, '.write-lock');

		it('every mutation takes the project lock and leaves none behind', () => {
			const seen: boolean[] = [];
			const spying = open({
				writeFile: (file, content) => {
					seen.push(fs.existsSync(lockPath()));
					fs.writeFileSync(file, content, 'utf8');
				},
			});
			const task = spying.create('t', 'backlog');
			spying.setPriority(task.id, 'high');
			spying.claim(task.id, { assignee: 'w', leaseUntil: LATER, now: NOW });
			spying.addLabel(task.id, 'x');
			spying.deleteTask(task.id);
			expect(seen.length).toBeGreaterThan(5);
			expect(seen.every(Boolean)).toBe(true);
			expect(fs.existsSync(lockPath())).toBe(false);
		});

		it('a held lock stops every kind of mutation with the lock error, and reads still work', () => {
			const task = store.create('t', 'backlog');
			const other = store.create('o', 'backlog');
			fs.writeFileSync(lockPath(), JSON.stringify({ pid: 99999, host: 'elsewhere', at: NOW, token: 'x' }));
			let clock = Date.parse(NOW);
			const blocked = open({ lock: { timeoutMs: 50, now: () => clock, sleep: ms => (clock += ms) } });
			expect(blocked.get(task.id).title).toBe('t');
			expect(blocked.list()).toHaveLength(2);
			const mutations: Array<() => unknown> = [
				() => blocked.create('x', 'backlog'),
				() => blocked.updateStatus(task.id, 'done'),
				() => blocked.setTitle(task.id, 'n'),
				() => blocked.addLabel(task.id, 'l'),
				() => blocked.setMeta(task.id, 'k', 'v'),
				() => blocked.setParent(task.id, other.id),
				() => blocked.addLink(task.id, 'blockedBy', other.id),
				() => blocked.addComment(task.id, 'c'),
				() => blocked.setPriority(task.id, 'high'),
				() => blocked.setAssignee(task.id, 'a'),
				() => blocked.claim(task.id, { assignee: 'a', leaseUntil: LATER, now: NOW }),
				() => blocked.deleteTask(task.id),
			];
			for (const mutation of mutations) {
				expect(mutation).toThrow(WriteLockTimeoutError);
			}
			expect(store.get(task.id)).toMatchObject({ title: 't', status: 'backlog' });
		});

		it('a mutation that calls others (deleteTask orphaning children) takes the lock once and does not deadlock', () => {
			const parent = store.create('p', 'backlog');
			const child = store.create('c', 'backlog', parent.id);
			expect(store.deleteTask(parent.id)).toBe(true);
			expect(store.get(child.id)).not.toHaveProperty('parentId');
		});

		it('releases the lock when a mutation throws', () => {
			const task = store.create('t', 'backlog');
			expect(() => store.setPriority(task.id, 'nonsense')).toThrow(UnknownPriorityError);
			expect(() => store.removeParent(task.id)).toThrow(TaskConflictError);
			expect(fs.existsSync(lockPath())).toBe(false);
		});

		it('takes over the lock of a dead process of this host and says so', () => {
			const task = store.create('t', 'backlog');
			const warnings: string[] = [];
			fs.writeFileSync(lockPath(), JSON.stringify({ pid: 31337, host: 'this-host', at: NOW, token: 'dead' }));
			const taking = open({
				lock: { hostname: 'this-host', isProcessAlive: () => false, onWarning: m => warnings.push(m) },
			});
			taking.setPriority(task.id, 'low');
			expect(warnings).toHaveLength(1);
			expect(warnings[0]).toContain('31337');
			expect(taking.get(task.id).priority).toBe('low');
		});
	});
});
