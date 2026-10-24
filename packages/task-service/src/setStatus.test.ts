import { TaskNotFoundError } from '@wadeck-app/task-core';

import { InvalidStatusError } from './errors.js';
import { setStatus } from './setStatus.js';
import { createTestContext, type TestContext } from './testHelpers.js';

describe('setStatus', () => {
	let t: TestContext;
	beforeEach(() => {
		t = createTestContext();
	});
	afterEach(() => t.cleanup());

	it('updates the status and returns the updated task, the old status and an onStatusChange event', () => {
		const task = t.ctx.store.create('a', 'backlog');
		t.ctx.store.addLabel(task.id, 'x');

		const result = setStatus(t.ctx, { id: task.id.slice(0, 4), status: 'in-progress' });

		expect(result.task.status).toBe('in-progress');
		expect(result.oldStatus).toBe('backlog');
		expect(t.ctx.store.get(task.id).status).toBe('in-progress');
		expect(result.events).toEqual([
			{
				name: 'onStatusChange',
				payload: {
					taskId: task.id,
					oldStatus: 'backlog',
					newStatus: 'in-progress',
					status: 'in-progress',
					type: undefined,
					labels: ['x'],
					taskProjectName: 'proj',
					taskProjectPath: t.rootDir,
				},
			},
		]);
		expect(result.openBlockers).toEqual([]);
		expect(result.unblocked).toEqual([]);
	});

	it('throws InvalidStatusError with the valid statuses and a suggestion, and changes nothing', () => {
		const task = t.ctx.store.create('a', 'backlog');

		let caught: unknown;
		try {
			setStatus(t.ctx, { id: task.id, status: 'dnoe' });
		} catch (error) {
			caught = error;
		}

		expect(caught).toBeInstanceOf(InvalidStatusError);
		const err = caught as InvalidStatusError;
		expect(err.status).toBe('dnoe');
		expect(err.validStatuses).toEqual(['backlog', 'in-progress', 'done']);
		expect(err.suggestions).toEqual(['done']);
		expect(err.message).toBe('unknown status "dnoe"');
		expect(err.hint).toBe('Valid statuses: backlog, in-progress, done\nDid you mean: done?');
		expect(t.ctx.store.get(task.id).status).toBe('backlog');
	});

	it('validates the status before looking the task up', () => {
		expect(() => setStatus(t.ctx, { id: 'zzzz', status: 'nope-nope-nope' })).toThrow(InvalidStatusError);
	});

	it('gives no suggestion when nothing is close', () => {
		const task = t.ctx.store.create('a', 'backlog');
		try {
			setStatus(t.ctx, { id: task.id, status: 'qqqqqqqqqqqq' });
			expect.unreachable();
		} catch (error) {
			expect((error as InvalidStatusError).suggestions).toEqual([]);
			expect((error as InvalidStatusError).hint).toBe('Valid statuses: backlog, in-progress, done');
		}
	});

	it('throws TaskNotFoundError for an unknown id', () => {
		expect(() => setStatus(t.ctx, { id: 'zzzz', status: 'done' })).toThrow(TaskNotFoundError);
	});

	it('propagates the store error when the task is already in that status', () => {
		const task = t.ctx.store.create('a', 'backlog');
		expect(() => setStatus(t.ctx, { id: task.id, status: 'backlog' })).toThrow('already in status');
	});

	it('reports the still-open blockers when a task is closed while blocked', () => {
		const blocker = t.ctx.store.create('blocker', 'backlog');
		const blocked = t.ctx.store.create('blocked', 'backlog');
		t.ctx.store.addLink(blocked.id, 'blockedBy', blocker.id);

		const result = setStatus(t.ctx, { id: blocked.id, status: 'done' });

		expect(result.openBlockers.map(b => b.id)).toEqual([blocker.id]);
		expect(result.unblocked).toEqual([]);
	});

	it('does not report blockers when the new status is not terminal', () => {
		const blocker = t.ctx.store.create('blocker', 'backlog');
		const blocked = t.ctx.store.create('blocked', 'backlog');
		t.ctx.store.addLink(blocked.id, 'blockedBy', blocker.id);

		expect(setStatus(t.ctx, { id: blocked.id, status: 'in-progress' }).openBlockers).toEqual([]);
	});

	it('does not report blockers when the task was already terminal', () => {
		const custom = createTestContext({
			statuses: ['backlog', 'done', 'wontfix'],
			terminalStatuses: ['done', 'wontfix'],
		});
		try {
			const blocker = custom.ctx.store.create('blocker', 'backlog');
			const closed = custom.ctx.store.create('closed', 'done');
			custom.ctx.store.addLink(closed.id, 'blockedBy', blocker.id);

			expect(setStatus(custom.ctx, { id: closed.id, status: 'wontfix' }).openBlockers).toEqual([]);
		} finally {
			custom.cleanup();
		}
	});

	it('returns an onTaskUnblocked event for every task whose last open blocker was just closed', () => {
		const blocker = t.ctx.store.create('blocker', 'backlog');
		const other = t.ctx.store.create('other', 'backlog');
		const a = t.ctx.store.create('a', 'backlog');
		const b = t.ctx.store.create('b', 'backlog');
		t.ctx.store.addLink(a.id, 'blockedBy', blocker.id);
		t.ctx.store.addLink(b.id, 'blockedBy', blocker.id);
		t.ctx.store.addLink(b.id, 'blockedBy', other.id);
		t.ctx.store.setType(a.id, 'bug');

		const result = setStatus(t.ctx, { id: blocker.id, status: 'done' });

		expect(result.unblocked.map(x => x.id)).toEqual([a.id]);
		expect(result.events.map(e => e.name)).toEqual(['onStatusChange', 'onTaskUnblocked']);
		expect(result.events[1]).toEqual({
			name: 'onTaskUnblocked',
			payload: {
				taskId: a.id,
				blockerId: blocker.id,
				status: 'backlog',
				type: 'bug',
				labels: [],
				taskProjectName: 'proj',
				taskProjectPath: t.rootDir,
			},
		});
	});
});
