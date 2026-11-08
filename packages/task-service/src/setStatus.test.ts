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

	it('updates the status and returns the updated task, the old status and an onStatusChange event', async () => {
		const task = await t.ctx.store.create({ title: 'a', status: 'backlog' });
		await t.ctx.store.addLabel(task.id, 'x');

		const result = await setStatus(t.ctx, { id: task.id.slice(0, 4), status: 'in-progress' });

		expect(result.task.status).toBe('in-progress');
		expect(result.oldStatus).toBe('backlog');
		expect((await t.ctx.store.get(task.id)).status).toBe('in-progress');
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

	it('throws InvalidStatusError with the valid statuses and a suggestion, and changes nothing', async () => {
		const task = await t.ctx.store.create({ title: 'a', status: 'backlog' });

		let caught: unknown;
		try {
			await setStatus(t.ctx, { id: task.id, status: 'dnoe' });
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
		expect((await t.ctx.store.get(task.id)).status).toBe('backlog');
	});

	it('validates the status before looking the task up', async () => {
		await expect(setStatus(t.ctx, { id: 'zzzz', status: 'nope-nope-nope' })).rejects.toThrow(InvalidStatusError);
	});

	it('gives no suggestion when nothing is close', async () => {
		const task = await t.ctx.store.create({ title: 'a', status: 'backlog' });
		try {
			await setStatus(t.ctx, { id: task.id, status: 'qqqqqqqqqqqq' });
			expect.unreachable();
		} catch (error) {
			expect((error as InvalidStatusError).suggestions).toEqual([]);
			expect((error as InvalidStatusError).hint).toBe('Valid statuses: backlog, in-progress, done');
		}
	});

	it('throws TaskNotFoundError for an unknown id', async () => {
		await expect(setStatus(t.ctx, { id: 'zzzz', status: 'done' })).rejects.toThrow(TaskNotFoundError);
	});

	it('propagates the store error when the task is already in that status', async () => {
		const task = await t.ctx.store.create({ title: 'a', status: 'backlog' });
		await expect(setStatus(t.ctx, { id: task.id, status: 'backlog' })).rejects.toThrow('already in status');
	});

	it('reports the still-open blockers when a task is closed while blocked', async () => {
		const blocker = await t.ctx.store.create({ title: 'blocker', status: 'backlog' });
		const blocked = await t.ctx.store.create({ title: 'blocked', status: 'backlog' });
		await t.ctx.store.addLink(blocked.id, 'blockedBy', blocker.id);

		const result = await setStatus(t.ctx, { id: blocked.id, status: 'done' });

		expect(result.openBlockers.map(b => b.id)).toEqual([blocker.id]);
		expect(result.unblocked).toEqual([]);
	});

	it('does not report blockers when the new status is not terminal', async () => {
		const blocker = await t.ctx.store.create({ title: 'blocker', status: 'backlog' });
		const blocked = await t.ctx.store.create({ title: 'blocked', status: 'backlog' });
		await t.ctx.store.addLink(blocked.id, 'blockedBy', blocker.id);

		expect((await setStatus(t.ctx, { id: blocked.id, status: 'in-progress' })).openBlockers).toEqual([]);
	});

	it('does not report blockers when the task was already terminal', async () => {
		const custom = createTestContext({
			statuses: ['backlog', 'done', 'wontfix'],
			terminalStatuses: ['done', 'wontfix'],
		});
		try {
			const blocker = await custom.ctx.store.create({ title: 'blocker', status: 'backlog' });
			const closed = await custom.ctx.store.create({ title: 'closed', status: 'done' });
			await custom.ctx.store.addLink(closed.id, 'blockedBy', blocker.id);

			expect((await setStatus(custom.ctx, { id: closed.id, status: 'wontfix' })).openBlockers).toEqual([]);
		} finally {
			custom.cleanup();
		}
	});

	it('returns an onTaskUnblocked event for every task whose last open blocker was just closed', async () => {
		const blocker = await t.ctx.store.create({ title: 'blocker', status: 'backlog' });
		const other = await t.ctx.store.create({ title: 'other', status: 'backlog' });
		const a = await t.ctx.store.create({ title: 'a', status: 'backlog' });
		const b = await t.ctx.store.create({ title: 'b', status: 'backlog' });
		await t.ctx.store.addLink(a.id, 'blockedBy', blocker.id);
		await t.ctx.store.addLink(b.id, 'blockedBy', blocker.id);
		await t.ctx.store.addLink(b.id, 'blockedBy', other.id);
		await t.ctx.store.setType(a.id, 'bug');

		const result = await setStatus(t.ctx, { id: blocker.id, status: 'done' });

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

	it('a NEGATIVE terminal status (rejected) unblocks like a positive one: terminal means "no longer blocking"', async () => {
		const custom = createTestContext({
			statuses: ['backlog', 'done', 'rejected'],
			terminalStatuses: ['done', 'rejected'],
			negativeStatuses: ['rejected'],
		});
		try {
			const blocker = await custom.ctx.store.create({ title: 'blocker', status: 'backlog' });
			const a = await custom.ctx.store.create({ title: 'a', status: 'backlog' });
			await custom.ctx.store.addLink(a.id, 'blockedBy', blocker.id);

			const result = await setStatus(custom.ctx, { id: blocker.id, status: 'rejected' });

			expect(result.unblocked.map(x => x.id)).toEqual([a.id]);
			expect(result.events.map(e => e.name)).toEqual(['onStatusChange', 'onTaskUnblocked']);
		} finally {
			custom.cleanup();
		}
	});
});
