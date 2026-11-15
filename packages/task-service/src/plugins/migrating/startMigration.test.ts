import * as path from 'node:path';

import { BackendRejectedError, LOCAL_TRAITS } from '@wadeck-app/task-core';
import { afterEach, describe, expect, it } from 'vitest';

import { MigrationStateStore } from './migrationState.js';
import { startMigration } from './startMigration.js';
import {
	FakeClock,
	MIGRATING_DIR,
	PAIR_KINDS,
	memoryWorkerFiles,
	seedCurrent,
	toolkitOf,
	wrap,
} from './testHelpers.js';
import type { Pair, Wrapped } from './testHelpers.js';

const STATE_FILE = path.join(MIGRATING_DIR, 'state.json');
const INDEX_FILE = path.join(MIGRATING_DIR, 'index.json');

describe.each(PAIR_KINDS)('startMigration over $name', kind => {
	let pair: Pair;
	let wrapped: Wrapped;
	const clock = new FakeClock();

	const setup = async () => {
		pair = await kind.open();
		wrapped = wrap(pair, { clock: clock.now });
		return { pair, wrapped };
	};
	afterEach(async () => {
		await pair.dispose();
	});

	const files = () => memoryWorkerFiles();

	it('routes every task of current as in-a at once and stores what was decided', async () => {
		await setup();
		const seed = await seedCurrent(pair.a);
		const workerFiles = files();
		const toolkit = toolkitOf(wrapped, pair, { clock, files: workerFiles });

		const result = await startMigration(toolkit, { acceptedLosses: ['all'] });

		expect(result.started).toBe(true);
		expect(result.dryRun).toBe(false);
		const rows = wrapped.index.snapshot().rows;
		expect(rows.map(row => [row.publicId, row.state]).sort()).toEqual(
			[seed.parent.id, seed.child1.id, seed.child2.id, seed.loose.id].map(id => [id, 'in-a']).sort()
		);
		const state = new MigrationStateStore({ dir: MIGRATING_DIR, files: workerFiles, now: clock.now }).readState();
		expect(state).toMatchObject({
			format: 1,
			status: 'running',
			acceptedLosses: ['all'],
			totals: { tasks: 4 },
			counters: { moved: 0 },
			parked: [],
			lastErrors: [],
		});
		expect(state?.startedAt).toBe(new Date(clock.now()).toISOString());
	});

	it('writes the routing index even when current holds no task, so a lost index is told from a start that never happened', async () => {
		await setup();
		const toolkit = toolkitOf(wrapped, pair, { clock });

		await startMigration(toolkit, { acceptedLosses: [] });

		expect(wrapped.files.text).toBeDefined();
		expect(wrapped.index.snapshot().rows).toEqual([]);
		expect(toolkit.files.read(STATE_FILE)).toContain('"tasks": 0');
	});

	it('writes nothing in a dry run, and answers the plan with its estimate', async () => {
		await setup();
		await seedCurrent(pair.a);
		const workerFiles = files();
		const toolkit = toolkitOf(wrapped, pair, { clock, files: workerFiles, budget: { requestsPerMinute: 2 } });

		const result = await startMigration(toolkit, { acceptedLosses: ['all'], dryRun: true });

		expect(result).toMatchObject({ dryRun: true, started: false, blocked: false });
		expect(result.plan.tasks).toBe(4);
		expect(result.plan.estimate.requests).toBeGreaterThanOrEqual(4);
		expect(result.plan.estimate.limitedBy).toBe('budget');
		expect(result.plan.estimate.minutes).toBeCloseTo(result.plan.estimate.requests / 2, 5);
		expect(wrapped.files.text).toBeUndefined();
		expect(workerFiles.writes).toEqual([]);
		expect(workerFiles.texts.has(STATE_FILE)).toBe(false);
	});

	it('refuses a start that would lose something nobody accepted, naming each kind, the number of tasks and the flag', async () => {
		await setup();
		await seedCurrent(pair.a);
		const toolkit = toolkitOf(wrapped, pair, { clock });

		let caught: unknown;
		try {
			await startMigration(toolkit, { acceptedLosses: [] });
		} catch (error) {
			caught = error;
		}

		expect(caught).toBeInstanceOf(BackendRejectedError);
		const error = caught as BackendRejectedError;
		expect(error.message).toMatch(/history/);
		expect(error.hint).toContain('--allow-loss');
		expect(error.hint).toContain('--dry-run');
		expect(wrapped.files.text).toBeUndefined();
		expect(toolkit.files.read(STATE_FILE)).toBeUndefined();
	});

	it('says in a dry run that the plan is blocked, without failing, and lists what blocks it', async () => {
		await setup();
		const seed = await seedCurrent(pair.a);
		const withActivity = [seed.parent, seed.child1, seed.child2, seed.loose].filter(
			task => (task.activity?.length ?? 0) > 0
		).length;
		const toolkit = toolkitOf(wrapped, pair, { clock });

		const result = await startMigration(toolkit, { acceptedLosses: [], dryRun: true });

		expect(result.blocked).toBe(true);
		expect(result.plan.blocking.map(loss => loss.kind)).toContain('history');
		expect(result.plan.blocking[0]?.fix).toBeTruthy();
		expect(result.plan.losses.find(loss => loss.kind === 'history')?.tasks).toBe(withActivity);
		expect(withActivity).toBeGreaterThan(0);
	});

	it('refuses a second start, whatever the first became, and points to status', async () => {
		await setup();
		await seedCurrent(pair.a);
		const toolkit = toolkitOf(wrapped, pair, { clock });
		await startMigration(toolkit, { acceptedLosses: ['all'] });

		await expect(startMigration(toolkit, { acceptedLosses: ['all'] })).rejects.toThrow(/already started/);
		await expect(startMigration(toolkit, { acceptedLosses: ['all'], dryRun: true })).rejects.toMatchObject({
			hint: expect.stringContaining('task strategy migrate status') as unknown,
		});
	});

	it('keeps the routing rows that exist: a task made in new before the start is not a task to move', async () => {
		await setup();
		await seedCurrent(pair.a);
		const made = await wrapped.backend.create({ title: 'Made in new', status: 'backlog' });
		const toolkit = toolkitOf(wrapped, pair, { clock });

		const result = await startMigration(toolkit, { acceptedLosses: ['all'] });

		expect(result.plan.tasks).toBe(4);
		const rows = wrapped.index.snapshot().rows;
		expect(rows.find(row => row.publicId === made.id)?.state).toBe('in-b');
		expect(rows).toHaveLength(5);
	});
});

describe('startMigration: what the new side must be able to hold', () => {
	it('refuses, with the fix, when the new side cannot carry the identity block, and writes nothing', async () => {
		const pair = await PAIR_KINDS[0]!.open();
		try {
			const wrapped = wrap(pair);
			await seedCurrent(pair.a);
			const toolkit = toolkitOf(wrapped, pair, {
				nextCapabilities: { ...pair.b.capabilities, meta: false },
			});

			let caught: unknown;
			try {
				await startMigration(toolkit, { acceptedLosses: ['all'] });
			} catch (error) {
				caught = error;
			}

			expect(caught).toBeInstanceOf(BackendRejectedError);
			expect((caught as BackendRejectedError).message).toContain('cannot store metadata');
			expect((caught as BackendRejectedError).hint).toMatch(/meta fill|choose another strategy/);
			expect(wrapped.files.text).toBeUndefined();
			expect(toolkit.files.read(STATE_FILE)).toBeUndefined();
		} finally {
			await pair.dispose();
		}
	});

	it('prices the plan from the cost per write of the new side', async () => {
		const pair = await PAIR_KINDS[0]!.open();
		try {
			const wrapped = wrap(pair);
			await seedCurrent(pair.a);
			const toolkit = toolkitOf(wrapped, pair, {
				nextTraits: { ...LOCAL_TRAITS, cost: { requests: 2, seconds: 1 } },
				budget: { requestsPerMinute: 10 },
			});

			const result = await startMigration(toolkit, { acceptedLosses: ['all'], dryRun: true });

			expect(result.plan.estimate.basis).toBe('per-write');
			expect(result.plan.estimate.requests).toBe(result.plan.estimate.writes * 2);
			expect(result.plan.estimate.minutes).toBeCloseTo(result.plan.estimate.requests / 10, 5);
			expect(INDEX_FILE).toBeTruthy();
		} finally {
			await pair.dispose();
		}
	});
});
