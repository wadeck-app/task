import { LOCAL_TRAITS } from '@wadeck-app/task-core';
import type { BackendTraits, VersionedRecord } from '@wadeck-app/task-core';
import { describe, expect, it } from 'vitest';

import { RateLimiter, moveCost, rateWindowsOf } from './moveRate.js';

const record = (extra: Partial<VersionedRecord> = {}): VersionedRecord =>
	({
		id: 't1',
		title: 'A',
		status: 'backlog',
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
		history: [],
		revision: 'r1',
		...extra,
	}) as VersionedRecord;

const PRICED: BackendTraits = {
	keepsCreatedAt: false,
	authoredComments: false,
	cost: { requests: 3, seconds: 1 },
};

describe('rateWindowsOf', () => {
	it('is a window of requests per minute from the budget, and nothing without one', () => {
		expect(rateWindowsOf(undefined, LOCAL_TRAITS)).toEqual([]);
		expect(rateWindowsOf({ requestsPerMinute: 30 }, LOCAL_TRAITS)).toEqual([
			{ name: 'budget', unit: 'requests', limit: 30, windowMs: 60_000 },
		]);
	});

	it('adds the windows of writes of the content cap of the side, whatever the system is', () => {
		const traits: BackendTraits = {
			...PRICED,
			cost: { requests: 3, seconds: 1, contentCap: { perHour: 500, perMinute: 80, source: 'documented cap' } },
		};
		expect(
			rateWindowsOf({ requestsPerMinute: 30 }, traits).map(w => [w.name, w.unit, w.limit, w.windowMs])
		).toEqual([
			['budget', 'requests', 30, 60_000],
			['content cap per minute', 'writes', 80, 60_000],
			['content cap per hour', 'writes', 500, 3_600_000],
		]);
	});
});

describe('moveCost', () => {
	it('charges one request for a side that declares no cost, so that a budget still bounds the pace', () => {
		expect(moveCost(record(), LOCAL_TRAITS)).toEqual({ requests: 1, writes: 1, basis: 'unit' });
	});

	it('counts the writes of a task from its facts and prices them with the cost per write', () => {
		const cost = moveCost(
			record({ type: 'bug', labels: ['a', 'b'], comments: [{ id: 'c1', at: 'x', text: 'hi' }] }),
			PRICED
		);
		// create 1 + type 1 + labels 2 + identity 4 + comment 1 + the two markers of the switch 2
		expect(cost).toEqual({ requests: 11 * 3, writes: 11, basis: 'per-write' });
	});

	it('folds the fields of a task into its creation when the side says it does', () => {
		const cost = moveCost(record({ type: 'bug', labels: ['a', 'b'] }), { ...PRICED, foldsCreate: true });
		// create 1 + the two markers of the switch 2
		expect(cost.writes).toBe(3);
	});

	it('asks the cost model of the side when it has one', () => {
		const seen: unknown[] = [];
		const traits: BackendTraits = {
			...PRICED,
			cost: {
				requests: 3,
				seconds: 1,
				model: tasks => {
					seen.push(tasks);
					return { writes: 2, requests: 9, verifyRequests: 1, notes: [] };
				},
			},
		};
		expect(moveCost(record({ parentId: 'p', labels: ['x'] }), traits)).toEqual({
			requests: 9,
			writes: 2,
			basis: 'model',
		});
		expect(seen[0]).toMatchObject([
			{ state: 'new', status: 'backlog', hasParent: true, labels: ['x'], marker: true },
		]);
	});
});

describe('RateLimiter', () => {
	it('lets a charge through while the window has room and says how long to wait when it has not', () => {
		let now = 1_000_000;
		const limiter = new RateLimiter([{ name: 'budget', unit: 'requests', limit: 10, windowMs: 60_000 }], () => now);
		const cost = { requests: 4, writes: 1, basis: 'unit' as const };
		expect(limiter.waitFor(cost).ms).toBe(0);
		limiter.record(cost);
		now += 10_000;
		limiter.record(cost);
		// 8 used, 4 more would be 12: the first charge (at 0) must leave the window, 60 s after it, i.e. 50 s from now
		expect(limiter.waitFor(cost)).toEqual({ ms: 50_000, window: 'budget' });
		now += 50_000;
		expect(limiter.waitFor(cost).ms).toBe(0);
	});

	it('lets a charge larger than the whole limit through once the window is empty', () => {
		let now = 0;
		const limiter = new RateLimiter([{ name: 'budget', unit: 'requests', limit: 5, windowMs: 60_000 }], () => now);
		const big = { requests: 12, writes: 1, basis: 'model' as const };
		expect(limiter.waitFor(big).ms).toBe(0);
		limiter.record(big);
		now += 1000;
		expect(limiter.waitFor({ requests: 1, writes: 1, basis: 'unit' }).ms).toBe(59_000);
	});

	it('waits for the slowest window and names it', () => {
		let now = 0;
		const limiter = new RateLimiter(
			[
				{ name: 'budget', unit: 'requests', limit: 100, windowMs: 60_000 },
				{ name: 'content cap per hour', unit: 'writes', limit: 2, windowMs: 3_600_000 },
			],
			() => now
		);
		const cost = { requests: 1, writes: 1, basis: 'unit' as const };
		limiter.record(cost);
		now += 1000;
		limiter.record(cost);
		now += 1000;
		expect(limiter.waitFor(cost)).toEqual({ ms: 3_598_000, window: 'content cap per hour' });
	});

	it('reports what the last minute used, whatever the windows are', () => {
		let now = 0;
		const limiter = new RateLimiter([], () => now);
		limiter.record({ requests: 5, writes: 2, basis: 'unit' });
		now += 30_000;
		limiter.record({ requests: 3, writes: 1, basis: 'unit' });
		expect(limiter.used()).toEqual({ requests: 8, writes: 3 });
		now += 40_000;
		expect(limiter.used()).toEqual({ requests: 3, writes: 1 });
	});
});
