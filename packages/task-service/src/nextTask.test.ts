import { TaskClaimedError } from '@wadeck-app/task-core';
import type { TaskBackend } from '@wadeck-app/task-core';

import { describeError } from './describeError.js';
import { NextTaskContentionError } from './errors.js';
import { NEXT_MAX_ATTEMPTS, nextTask } from './nextTask.js';
import { createTestContext, type TestContext } from './testHelpers.js';

const NOW = new Date('2026-11-14T12:00:00.000Z');
const later = (ms: number): string => new Date(NOW.getTime() + ms).toISOString();

describe('nextTask', () => {
	let t: TestContext;
	beforeEach(() => {
		t = createTestContext({ defaults: { priority: 'medium', leaseMinutes: 30 } });
	});
	afterEach(() => t.cleanup());

	async function add(title: string, priority: string, createdAt: string, status = 'backlog'): Promise<string> {
		const task = await t.ctx.store.create({ title, status, createdAt });
		await t.ctx.store.setPriority!(task.id, priority);
		return task.id;
	}

	/** A store whose `claim` is replaced; every other operation is the real one. */
	function withClaim(claim: TaskBackend['claim']): TaskBackend {
		const wrapped = Object.create(t.ctx.store) as TaskBackend;
		wrapped.claim = claim;
		return wrapped;
	}

	it('claims the most urgent, oldest available task and returns the events of the claim', async () => {
		await add('low', 'low', '2026-01-01T00:00:00.000Z');
		const best = await add('urgent', 'urgent', '2026-03-01T00:00:00.000Z');
		await add('newer urgent', 'urgent', '2026-04-01T00:00:00.000Z');

		const result = await nextTask(t.ctx, { assignee: 'w1', now: NOW });

		expect(result.claim!.task).toMatchObject({ id: best, assignee: 'w1' });
		expect(result.claim!.leaseUntil).toBe(later(30 * 60_000));
		expect(result.claim!.events.map(event => event.name)).toEqual(['onTaskAssigneeChanged']);
		expect(result.lost).toBe(0);
		expect((await t.ctx.store.get(best)).assignee).toBe('w1');
	});

	it('skips tasks held under a live lease, takes over an expired one, and never offers terminal statuses by default', async () => {
		const held = await add('held', 'urgent', '2026-01-01T00:00:00.000Z');
		await t.ctx.store.claim!(held, { assignee: 'w9', leaseUntil: later(600_000), now: NOW.toISOString() });
		await add('finished', 'urgent', '2026-01-01T00:00:00.000Z', 'done');
		const over = await add('expired', 'high', '2026-01-01T00:00:00.000Z');
		await t.ctx.store.claim!(over, { assignee: 'w8', leaseUntil: later(-60_000), now: later(-3_600_000) });

		const result = await nextTask(t.ctx, { assignee: 'w1', now: NOW });

		expect(result.claim!.task.id).toBe(over);
		expect(result.claim!.outcome).toBe('takeover');
	});

	it('honours statuses, priorities and a lease of the call', async () => {
		await add('a', 'urgent', '2026-01-01T00:00:00.000Z');
		const wanted = await add('b', 'low', '2026-02-01T00:00:00.000Z', 'in-progress');

		const result = await nextTask(t.ctx, {
			assignee: 'w1',
			statuses: ['in-progress'],
			priorities: ['low'],
			leaseMinutes: 5,
			now: NOW,
		});

		expect(result.claim!.task.id).toBe(wanted);
		expect(result.claim!.leaseUntil).toBe(later(5 * 60_000));
	});

	it('answers no claim when nothing is available', async () => {
		await add('done', 'urgent', '2026-01-01T00:00:00.000Z', 'done');

		expect(await nextTask(t.ctx, { assignee: 'w1', now: NOW })).toEqual({ lost: 0, skippedBlocked: 0 });
	});

	it('an unknown order or status is an error before any claim', async () => {
		await add('a', 'urgent', '2026-01-01T00:00:00.000Z');
		await expect(nextTask(t.ctx, { assignee: 'w1', order: 'nope' })).rejects.toThrow(
			'unknown ordering plugin "nope"'
		);
		await expect(nextTask(t.ctx, { assignee: 'w1', statuses: ['nope'] })).rejects.toThrow('unknown status "nope"');
	});

	it('when another worker wins the first candidate between the list and the claim, claims the second', async () => {
		const first = await add('first', 'urgent', '2026-01-01T00:00:00.000Z');
		const second = await add('second', 'high', '2026-01-01T00:00:00.000Z');
		const real = t.ctx.store;
		let raced = false;
		// The listing is already answered when the rival claims: the first candidate is taken just before our claim.
		const racing = withClaim(async (id, input) => {
			if (!raced && id === first) {
				raced = true;
				await real.claim!(id, { assignee: 'rival', leaseUntil: later(600_000), now: NOW.toISOString() });
			}
			return real.claim!(id, input);
		});

		const result = await nextTask({ ...t.ctx, store: racing }, { assignee: 'w1', now: NOW });

		expect(result.claim!.task.id).toBe(second);
		expect(result.lost).toBe(1);
		expect((await real.get(first)).assignee).toBe('rival');
	});

	it('gives up after ten lost races with a conflict naming the count', async () => {
		for (let i = 0; i < NEXT_MAX_ATTEMPTS + 2; i++) {
			await add(`t${i}`, 'high', `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00.000Z`);
		}
		let calls = 0;
		const losing = withClaim(() => {
			calls++;
			return Promise.reject(new TaskClaimedError('x', 'rival', later(0), 1000, false));
		});

		const failure = await nextTask({ ...t.ctx, store: losing }, { assignee: 'w1', now: NOW }).catch(
			(error: unknown) => error
		);

		expect(failure).toBeInstanceOf(NextTaskContentionError);
		expect(calls).toBe(NEXT_MAX_ATTEMPTS);
		expect((failure as Error).message).toContain('10 candidates were claimed by other workers first');
		expect(describeError(failure).kind).toBe('conflict');
	});

	it('stops at once on an error that is not a lost race', async () => {
		await add('a', 'high', '2026-01-01T00:00:00.000Z');
		await add('b', 'high', '2026-01-02T00:00:00.000Z');
		let calls = 0;
		const broken = withClaim(() => {
			calls++;
			return Promise.reject(new Error('disk on fire'));
		});

		await expect(nextTask({ ...t.ctx, store: broken }, { assignee: 'w1', now: NOW })).rejects.toThrow(
			'disk on fire'
		);
		expect(calls).toBe(1);
	});

	it('every candidate lost with fewer than ten candidates is "nothing available", not an error', async () => {
		await add('only', 'high', '2026-01-01T00:00:00.000Z');
		const losing = withClaim(() => Promise.reject(new TaskClaimedError('x', 'rival', later(0), 1000, false)));

		expect(await nextTask({ ...t.ctx, store: losing }, { assignee: 'w1', now: NOW })).toEqual({
			lost: 1,
			skippedBlocked: 0,
		});
	});

	describe('blocked work', () => {
		it('skips a candidate with an open blockedBy link, counts it, and claims the next one', async () => {
			const blocker = await add('blocker', 'low', '2026-01-05T00:00:00.000Z');
			const blocked = await add('blocked', 'urgent', '2026-01-01T00:00:00.000Z');
			await t.ctx.store.addLink(blocked, 'blockedBy', blocker);

			const result = await nextTask(t.ctx, { assignee: 'w1', now: NOW });

			expect(result.claim!.task.id).toBe(blocker);
			expect(result.skippedBlocked).toBe(1);
			expect((await t.ctx.store.get(blocked)).assignee).toBeUndefined();
		});

		it('a blocker that is closed no longer blocks', async () => {
			const blocker = await add('blocker', 'low', '2026-01-05T00:00:00.000Z', 'done');
			const was = await add('was blocked', 'urgent', '2026-01-01T00:00:00.000Z');
			await t.ctx.store.addLink(was, 'blockedBy', blocker);

			const result = await nextTask(t.ctx, { assignee: 'w1', now: NOW });

			expect(result.claim!.task.id).toBe(was);
			expect(result.skippedBlocked).toBe(0);
		});

		it('includeBlocked claims a blocked task', async () => {
			const blocker = await add('blocker', 'low', '2026-01-05T00:00:00.000Z');
			const blocked = await add('blocked', 'urgent', '2026-01-01T00:00:00.000Z');
			await t.ctx.store.addLink(blocked, 'blockedBy', blocker);

			const result = await nextTask(t.ctx, { assignee: 'w1', now: NOW, includeBlocked: true });

			expect(result.claim!.task.id).toBe(blocked);
			expect(result.skippedBlocked).toBe(0);
		});

		it('skipped tasks do not count toward the attempt cap and are looked at one at a time', async () => {
			const blocker = await add('blocker', 'low', '2026-06-01T00:00:00.000Z');
			for (let i = 0; i < NEXT_MAX_ATTEMPTS + 3; i++) {
				const id = await add(
					`blocked ${i}`,
					'urgent',
					`2026-01-${String(i + 1).padStart(2, '0')}T00:00:00.000Z`
				);
				await t.ctx.store.addLink(id, 'blockedBy', blocker);
			}
			const real = t.ctx.store;
			let checks = 0;
			const counting = Object.create(real) as TaskBackend;
			counting.getOpenBlockers = (id, isTerminal) => {
				checks++;
				return real.getOpenBlockers(id, isTerminal);
			};

			const result = await nextTask({ ...t.ctx, store: counting }, { assignee: 'w1', now: NOW });

			expect(result.claim!.task.id).toBe(blocker);
			expect(result.skippedBlocked).toBe(NEXT_MAX_ATTEMPTS + 3);
			// Lazy: the free task is the last candidate, so every one before it was checked, none after it.
			expect(checks).toBe(NEXT_MAX_ATTEMPTS + 4);
		});

		it('checks nothing after the claim succeeded', async () => {
			await add('first', 'urgent', '2026-01-01T00:00:00.000Z');
			await add('second', 'high', '2026-01-02T00:00:00.000Z');
			const real = t.ctx.store;
			let checks = 0;
			const counting = Object.create(real) as TaskBackend;
			counting.getOpenBlockers = (id, isTerminal) => {
				checks++;
				return real.getOpenBlockers(id, isTerminal);
			};

			await nextTask({ ...t.ctx, store: counting }, { assignee: 'w1', now: NOW });

			expect(checks).toBe(1);
		});

		it('only blocked candidates: nothing available, with the skipped count', async () => {
			const blocker = await add('blocker', 'low', '2026-01-05T00:00:00.000Z');
			await t.ctx.store.claim!(blocker, { assignee: 'w9', leaseUntil: later(600_000), now: NOW.toISOString() });
			const blocked = await add('blocked', 'urgent', '2026-01-01T00:00:00.000Z');
			await t.ctx.store.addLink(blocked, 'blockedBy', blocker);

			expect(await nextTask(t.ctx, { assignee: 'w1', now: NOW })).toEqual({ lost: 0, skippedBlocked: 1 });
		});
	});

	it('reports lost races even when the candidates fit within the attempt cap', async () => {
		await add('a', 'high', '2026-01-01T00:00:00.000Z');
		await add('b', 'high', '2026-01-02T00:00:00.000Z');
		const losing = withClaim(() => Promise.reject(new TaskClaimedError('x', 'rival', later(0), 1000, false)));

		expect(await nextTask({ ...t.ctx, store: losing }, { assignee: 'w1', now: NOW })).toEqual({
			lost: 2,
			skippedBlocked: 0,
		});
	});
});
