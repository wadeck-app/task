import {
	InvalidTaskFieldError,
	TaskClaimedError,
	TaskNotClaimedError,
	TaskReleaseRefusedError,
	UnsupportedByBackendError,
} from '@wadeck-app/task-core';

import { claimTask, releaseTask } from './taskClaim.js';
import { TaskClosedError } from './taskClosedError.js';
import { describeError } from './describeError.js';
import { setTaskAssignee } from './taskAssignee.js';
import { createTestContext, type TestContext } from './testHelpers.js';

const T0 = new Date('2026-11-14T10:00:00.000Z');
const minutes = (base: Date, count: number): Date => new Date(base.getTime() + count * 60_000);

describe('claimTask / releaseTask', () => {
	let t: TestContext;
	let id: string;
	beforeEach(async () => {
		t = createTestContext({ defaults: { priority: 'medium', leaseMinutes: 45 } });
		id = (await t.ctx.store.create({ title: 'a', status: 'backlog' })).id;
	});
	afterEach(() => t.cleanup());

	const env = () => ({ taskProjectName: 'proj', taskProjectPath: t.rootDir });

	it('claims a free task with the lease of the config, exposes the revision and fires onTaskAssigneeChanged claimed', async () => {
		const result = await claimTask(t.ctx, { id: id.slice(0, 4), assignee: ' w1 ', now: T0 });

		expect(result.outcome).toBe('claimed');
		expect(result.leaseUntil).toBe(minutes(T0, 45).toISOString());
		expect(result.task).toMatchObject({
			id,
			assignee: 'w1',
			claimedAt: T0.toISOString(),
			leaseUntil: minutes(T0, 45).toISOString(),
		});
		// The one record that carries its revision: the worker hands it back to detect a concurrent change.
		expect(typeof result.task.revision).toBe('string');
		expect(result.task.revision).toBe((await t.ctx.store.get(id)).revision);
		expect(result.previousAssignee).toBeUndefined();
		expect(result.events).toEqual([
			{
				name: 'onTaskAssigneeChanged',
				payload: { taskId: id, newAssignee: 'w1', outcome: 'claimed', ...env() },
			},
		]);
	});

	it('the lease of the call wins over the config, and is limited to 1..10080 whole minutes', async () => {
		const ok = await claimTask(t.ctx, { id, assignee: 'w1', leaseMinutes: 5, now: T0 });
		expect(ok.leaseUntil).toBe(minutes(T0, 5).toISOString());

		for (const bad of [0, -1, 1.5, 10081, Number.NaN]) {
			const failure = await claimTask(t.ctx, {
				id,
				assignee: 'w2',
				leaseMinutes: bad,
				now: T0,
				force: true,
			}).catch((error: unknown) => error);
			expect(failure, String(bad)).toBeInstanceOf(InvalidTaskFieldError);
			expect((failure as Error).message).toContain('1 to 10080');
		}
		expect((await t.ctx.store.get(id)).assignee).toBe('w1');
	});

	it('a live lease of someone else is a conflict naming the holder and the time left; --force takes over', async () => {
		await claimTask(t.ctx, { id, assignee: 'w1', now: T0 });

		const failure = await claimTask(t.ctx, { id, assignee: 'w2', now: minutes(T0, 15) }).catch((e: unknown) => e);
		expect(failure).toBeInstanceOf(TaskClaimedError);
		expect((failure as TaskClaimedError).holder).toBe('w1');
		expect((failure as Error).message).toContain('30m');

		const taken = await claimTask(t.ctx, { id, assignee: 'w2', now: minutes(T0, 15), force: true });
		expect(taken.outcome).toBe('takeover');
		expect(taken.previousAssignee).toBe('w1');
		expect(taken.events).toEqual([
			{
				name: 'onTaskAssigneeChanged',
				payload: { taskId: id, oldAssignee: 'w1', newAssignee: 'w2', outcome: 'takeover', ...env() },
			},
		]);
	});

	it('an expired lease is taken over without force', async () => {
		await claimTask(t.ctx, { id, assignee: 'w1', now: T0 });

		const taken = await claimTask(t.ctx, { id, assignee: 'w2', now: minutes(T0, 46) });

		expect(taken.outcome).toBe('takeover');
		expect(taken.previousAssignee).toBe('w1');
	});

	it('the same name needs --renew, then extends the lease and fires with old = new', async () => {
		await claimTask(t.ctx, { id, assignee: 'w1', now: T0 });

		const refused = await claimTask(t.ctx, { id, assignee: 'w1', now: minutes(T0, 10) }).catch((e: unknown) => e);
		expect(refused).toBeInstanceOf(TaskClaimedError);
		expect((refused as TaskClaimedError).ownLease).toBe(true);

		const renewed = await claimTask(t.ctx, { id, assignee: 'w1', now: minutes(T0, 10), renew: true });
		expect(renewed.outcome).toBe('renewed');
		expect(renewed.task.claimedAt).toBe(T0.toISOString());
		expect(renewed.leaseUntil).toBe(minutes(T0, 55).toISOString());
		expect(renewed.events).toEqual([
			{
				name: 'onTaskAssigneeChanged',
				payload: { taskId: id, oldAssignee: 'w1', newAssignee: 'w1', outcome: 'renewed', ...env() },
			},
		]);
	});

	it('a refused claim writes nothing', async () => {
		await claimTask(t.ctx, { id, assignee: 'w1', now: T0 });
		const before = await t.ctx.store.get(id);

		await claimTask(t.ctx, { id, assignee: 'w2', now: minutes(T0, 1) }).catch(() => undefined);

		expect(await t.ctx.store.get(id)).toEqual(before);
	});

	it('defaults the clock to the current time', async () => {
		const before = Date.now();
		const result = await claimTask(t.ctx, { id, assignee: 'w1', leaseMinutes: 1 });

		const claimedAt = Date.parse(result.task.claimedAt!);
		expect(claimedAt).toBeGreaterThanOrEqual(before - 1000);
		expect(Date.parse(result.leaseUntil)).toBe(claimedAt + 60_000);
	});

	describe('releaseTask', () => {
		it('releases a claimed task: assignee and lease gone, event released with the old holder, no revision in the answer', async () => {
			await claimTask(t.ctx, { id, assignee: 'w1', now: T0 });

			const result = await releaseTask(t.ctx, { id: id.slice(0, 4) });

			expect(result.previousAssignee).toBe('w1');
			expect(result.task).not.toHaveProperty('assignee');
			expect(result.task).not.toHaveProperty('leaseUntil');
			expect(result.task).not.toHaveProperty('revision');
			expect(result.events).toEqual([
				{
					name: 'onTaskAssigneeChanged',
					payload: { taskId: id, oldAssignee: 'w1', outcome: 'released', ...env() },
				},
			]);
			expect(JSON.parse(JSON.stringify(result.events[0]!.payload))).not.toHaveProperty('newAssignee');
		});

		it('refuses a task nobody holds, and another holder without --force', async () => {
			await expect(releaseTask(t.ctx, { id })).rejects.toBeInstanceOf(TaskNotClaimedError);

			await claimTask(t.ctx, { id, assignee: 'w1', now: T0 });
			await expect(releaseTask(t.ctx, { id, assignee: 'w2' })).rejects.toBeInstanceOf(TaskReleaseRefusedError);
			expect((await t.ctx.store.get(id)).assignee).toBe('w1');

			const forced = await releaseTask(t.ctx, { id, assignee: 'w2', force: true });
			expect(forced.previousAssignee).toBe('w1');
		});
	});

	describe('a backend without the capability', () => {
		it('both are refused loudly, naming the strategy kind and the local alternative', async () => {
			const noClaim = Object.create(t.ctx.store, {
				capabilities: { value: { ...t.ctx.store.capabilities, claim: false } },
				kind: { value: 'remote' },
			}) as typeof t.ctx.store;
			const ctx = { ...t.ctx, store: noClaim };

			for (const run of [() => claimTask(ctx, { id, assignee: 'w1', now: T0 }), () => releaseTask(ctx, { id })]) {
				const failure = await run().catch((error: unknown) => error);
				expect(failure).toBeInstanceOf(UnsupportedByBackendError);
				expect((failure as UnsupportedByBackendError).capability).toBe('claim');
				expect((failure as UnsupportedByBackendError).message).toContain('remote');
				expect((failure as UnsupportedByBackendError).hint).toMatch(/local strategy/);
			}
		});
	});

	describe('a closed task', () => {
		it('cannot be claimed, with or without --force: a conflict naming the task, the status and set-status; nothing written, no event', async () => {
			await t.ctx.store.updateStatus(id, 'done');
			const before = await t.ctx.store.get(id);

			for (const force of [false, true]) {
				const failure = await claimTask(t.ctx, {
					id,
					assignee: 'w1',
					now: T0,
					...(force ? { force } : {}),
				}).catch((error: unknown) => error);

				expect(failure).toBeInstanceOf(TaskClosedError);
				const error = failure as TaskClosedError;
				expect(error.message).toContain(id);
				expect(error.message).toContain('"done"');
				expect(error.hint).toContain('--force does not apply');
				expect(error.hint).toContain(`task set-status ${id}`);
			}
			const after = await t.ctx.store.get(id);
			expect(after).toEqual(before);
			expect(after.assignee).toBeUndefined();
		});

		it('is a conflict for describeError, and can be claimed again once reopened', async () => {
			await t.ctx.store.updateStatus(id, 'done');
			const failure = await claimTask(t.ctx, { id, assignee: 'w1', now: T0 }).catch((error: unknown) => error);
			expect(describeError(failure)).toMatchObject({ kind: 'conflict', details: { taskId: id, status: 'done' } });

			await t.ctx.store.updateStatus(id, 'backlog');
			const result = await claimTask(t.ctx, { id, assignee: 'w1', now: T0 });
			expect(result.outcome).toBe('claimed');
		});

		it('a non-terminal status is claimable, and set-assignee still works on a closed task', async () => {
			await t.ctx.store.updateStatus(id, 'in-progress');
			expect((await claimTask(t.ctx, { id, assignee: 'w1', now: T0 })).outcome).toBe('claimed');

			await t.ctx.store.updateStatus(id, 'done');
			const result = await setTaskAssignee(t.ctx, { id, assignee: 'w2' });
			expect(result.task.assignee).toBe('w2');
		});
	});
});
