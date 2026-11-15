import * as path from 'node:path';

import { BackendRejectedError, RateLimitedError } from '@wadeck-app/task-core';
import { afterEach, describe, expect, it } from 'vitest';

import { MigrationStateStore } from './migrationState.js';
import { runMigrationWorker } from './migrationWorker.js';
import type { MigrationToolkit } from './migrationToolkit.js';
import { RateLimiter, moveCost, rateWindowsOf } from './moveRate.js';
import { startMigration } from './startMigration.js';
import { FakeClock, MIGRATING_DIR, PAIR_KINDS, seedCurrent, toolkitOf, wrap } from './testHelpers.js';
import type { MemoryWorkerFiles } from './testHelpers.js';
import type { Pair, ToolkitOptions, Wrapped } from './testHelpers.js';
import { WorkerLock } from './workerLock.js';

const LOCK = path.join(MIGRATING_DIR, 'worker.lock');

const logLines = (toolkit: MigrationToolkit): Array<Record<string, unknown>> =>
	(toolkit.files.read(path.join(MIGRATING_DIR, 'log.ndjson')) ?? '')
		.split('\n')
		.filter(line => line !== '')
		.map(line => JSON.parse(line) as Record<string, unknown>);

describe.each(PAIR_KINDS)('the migration worker over $name', kind => {
	let pair: Pair;
	let wrapped: Wrapped;
	let clock: FakeClock;
	let toolkit: MigrationToolkit & { files: MemoryWorkerFiles };
	let store: MigrationStateStore;
	let seed: Awaited<ReturnType<typeof seedCurrent>>;
	const ids = (): string[] => [seed.parent.id, seed.child1.id, seed.child2.id, seed.loose.id];

	const begin = async (options: Partial<ToolkitOptions> = {}, accepted: string[] = ['all']) => {
		clock = new FakeClock();
		pair = await kind.open();
		wrapped = wrap(pair, { clock: clock.now });
		seed = await seedCurrent(pair.a);
		toolkit = toolkitOf(wrapped, pair, { clock, ...options });
		store = new MigrationStateStore({ dir: MIGRATING_DIR, files: toolkit.files, now: clock.now });
		await startMigration(toolkit, { acceptedLosses: accepted });
	};
	afterEach(async () => {
		await pair.dispose();
	});

	const run = (extra: Record<string, unknown> = {}) => runMigrationWorker(toolkit, { sleep: clock.sleep, ...extra });
	// A creation goes through `create`, or `createMigrated` for a side that folds the fields of a copy into it.
	const failCreates = (error: Error, times = 1): void => {
		for (let n = 0; n < times; n++) {
			for (const method of ['create', 'createMigrated']) wrapped.faults.failOn('b', method, { error });
		}
	};
	const states = (): string[] => wrapped.index.snapshot().rows.map(row => row.state);

	it('moves every task, parents before children, and ends ready to finalize with everything in new', async () => {
		await begin();
		const order: string[] = [];
		const move = toolkit.moves.moveTask.bind(toolkit.moves);
		toolkit.moves = {
			...toolkit.moves,
			moveTask: (id, options) => {
				order.push(id);
				return move(id, options);
			},
		};

		const result = await run();

		expect(result).toMatchObject({ status: 'ready-to-finalize', moved: 4 });
		expect(states()).toEqual(['in-b', 'in-b', 'in-b', 'in-b']);
		// a parent before its children, a blocker before the task it blocks, each task asked once (nothing deferred)
		expect([...order].sort()).toEqual(ids().sort());
		expect(order.indexOf(seed.parent.id)).toBeLessThan(order.indexOf(seed.child1.id));
		expect(order.indexOf(seed.parent.id)).toBeLessThan(order.indexOf(seed.child2.id));
		expect(order.indexOf(seed.child1.id)).toBeLessThan(order.indexOf(seed.loose.id));
		const state = store.readState();
		expect(state).toMatchObject({ status: 'ready-to-finalize', counters: { moved: 4, failures: 0 } });
		expect(toolkit.files.texts.has(LOCK)).toBe(false);
		expect(store.readHeartbeat()).toMatchObject({ pid: 4242, host: 'box', phase: 'exiting' });
	});

	it('logs what it does in the migration log, one line per task and one for the end', async () => {
		await begin();

		await run();

		const worker = logLines(toolkit).filter(line => line['step'] === 'worker');
		expect(worker.map(line => line['outcome'])).toEqual([
			'worker-started',
			...Array(4).fill('moved'),
			'ready-to-finalize',
		]);
		expect(
			worker
				.filter(line => line['outcome'] === 'moved')
				.map(line => line['task'])
				.sort()
		).toEqual(ids().sort());
	});

	it('keeps the pace of the budget: after the window is spent it sleeps until a charge leaves it, and says so', async () => {
		await begin({ budget: { requestsPerMinute: 2 } });
		const beats: Array<string | undefined> = [];
		clock.onSleep = () => {
			beats.push(store.readHeartbeat()?.phase);
		};
		const order: string[] = [];
		const move = toolkit.moves.moveTask.bind(toolkit.moves);
		toolkit.moves = {
			...toolkit.moves,
			moveTask: (id, options) => {
				order.push(id);
				return move(id, options);
			},
		};

		const result = await run();

		expect(result.status).toBe('ready-to-finalize');
		// What the limiter says about the same charges in the same order, on a clock that only the waits advance (the number of
		// requests a move costs depends on the side: one for a side with no cost, the counted calls for a priced one).
		let simulated = 0;
		let episodes = 0;
		const limiter = new RateLimiter(rateWindowsOf({ requestsPerMinute: 2 }, pair.bTraits), () => simulated);
		for (const id of order) {
			const cost = moveCost(await pair.a.get(id), pair.bTraits);
			for (let wait = limiter.waitFor(cost).ms; wait > 0; wait = limiter.waitFor(cost).ms) {
				simulated += wait;
				episodes++;
			}
			limiter.record(cost);
		}
		expect(episodes).toBeGreaterThan(0);
		expect(clock.sleeps.reduce((sum, ms) => sum + ms, 0)).toBe(simulated);
		expect(beats).toContain('rate-pause');
		const pauses = logLines(toolkit).filter(line => line['outcome'] === 'rate-pause');
		expect(pauses).toHaveLength(episodes);
		expect(String(pauses[0]?.['message'])).toContain('budget');
		expect(store.readState()?.counters.ratePauses).toBe(episodes);
	});

	it('sleeps until the instant a side says its limit ends, never counts that as a failure, and goes on', async () => {
		await begin();
		const retryAt = new Date(clock.now() + 120_000);
		failCreates(new RateLimitedError('github', 'primary', retryAt));

		const result = await run();

		expect(result.status).toBe('ready-to-finalize');
		expect(clock.sleeps.reduce((sum, ms) => sum + ms, 0)).toBeGreaterThanOrEqual(120_000);
		const state = store.readState();
		expect(state?.counters).toMatchObject({ failures: 0, ratePauses: 1 });
		expect(state?.lastErrors).toEqual([]);
		expect(logLines(toolkit).some(line => /rate limit/.test(String(line['message'])))).toBe(true);
		expect(states()).toEqual(['in-b', 'in-b', 'in-b', 'in-b']);
	});

	it('records the error of one task and goes on with the others, then retries that task', async () => {
		await begin();
		failCreates(new Error('the API said no'));

		const result = await run();

		expect(result).toMatchObject({ status: 'ready-to-finalize', moved: 4 });
		const state = store.readState();
		expect(state?.counters.failures).toBe(1);
		expect(state?.lastErrors).toHaveLength(1);
		expect(state?.lastErrors[0]).toMatchObject({ kind: 'failed' });
		expect(state?.lastErrors[0]?.message).toContain('the API said no');
		expect(ids()).toContain(state?.lastErrors[0]?.task);
	});

	it('stops after the consecutive failures it allows, with a status and the fix, leaving the tasks where they are', async () => {
		await begin();
		failCreates(new Error('the API is down'), 10);

		const result = await run({ maxConsecutiveFailures: 3 });

		expect(result.status).toBe('stopped');
		const state = store.readState();
		expect(state?.status).toBe('stopped');
		expect(state?.stop?.text).toContain('3 failures in a row');
		expect(state?.stop?.text).toContain('the API is down');
		expect(state?.stop?.fix).toContain('task strategy migrate status');
		expect(state?.stop?.fix).toContain('task strategy migrate resume');
		expect(states()).toEqual(['in-a', 'in-a', 'in-a', 'in-a']);
		expect(toolkit.files.texts.has(LOCK)).toBe(false);
	});

	it('parks a task that keeps failing after its attempts, moves the rest, and stops naming it', async () => {
		await begin();
		const bad = seed.child2.id;
		const move = toolkit.moves.moveTask.bind(toolkit.moves);
		toolkit.moves = {
			...toolkit.moves,
			moveTask: (id, options) => (id === bad ? Promise.reject(new Error('cannot be moved')) : move(id, options)),
		};

		const result = await run();

		expect(result.status).toBe('stopped');
		const state = store.readState();
		expect(state?.parked).toEqual([{ task: bad, reason: expect.stringContaining('cannot be moved') as unknown }]);
		expect(state?.stop?.text).toContain(bad);
		expect(states().filter(value => value === 'in-b')).toHaveLength(3);
		expect(state?.lastErrors.filter(note => note.task === bad)).toHaveLength(3);
	});

	it('skips a claimed task, moves the others, waits for a lease that ends soon, then moves it', async () => {
		await begin();
		await pair.a.claim!(seed.loose.id, {
			assignee: 'w1',
			now: new Date(clock.now()).toISOString(),
			leaseUntil: new Date(clock.now() + 3 * 60_000).toISOString(),
		});

		const result = await run();

		expect(result).toMatchObject({ status: 'ready-to-finalize', moved: 4 });
		expect(store.readState()?.counters.skippedClaimed).toBeGreaterThanOrEqual(1);
		expect(clock.sleeps.reduce((sum, ms) => sum + ms, 0)).toBeGreaterThanOrEqual(3 * 60_000 - 2_000);
		expect(
			logLines(toolkit).some(line => line['outcome'] === 'skipped-claimed' && line['task'] === seed.loose.id)
		).toBe(true);
	});

	it('stops, saying which task and until when, rather than wait hours for a long lease', async () => {
		await begin();
		const until = new Date(clock.now() + 2 * 3_600_000).toISOString();
		await pair.a.claim!(seed.loose.id, {
			assignee: 'w1',
			now: new Date(clock.now()).toISOString(),
			leaseUntil: until,
		});

		const result = await run();

		expect(result.status).toBe('stopped');
		const state = store.readState();
		expect(state?.stop?.text).toContain(seed.loose.id);
		expect(state?.stop?.text).toContain(until);
		expect(state?.stop?.fix).toContain('task release');
		expect(states().filter(value => value === 'in-b')).toHaveLength(3);
		expect(clock.sleeps.reduce((sum, ms) => sum + ms, 0)).toBeLessThan(10 * 60_000);
	});

	it('parks tasks that wait for a copy nothing can make in this run, instead of looping', async () => {
		await begin();
		toolkit.moves = {
			...toolkit.moves,
			moveTask: () => Promise.resolve({ outcome: 'deferred', waitingFor: ['elsewhere'] }),
		};

		const result = await run();

		expect(result.status).toBe('stopped');
		const state = store.readState();
		expect(state?.parked).toHaveLength(4);
		expect(state?.parked[0]?.reason).toContain('elsewhere');
	});

	it('pauses between two tasks when the control file says so, and a second run goes on from there', async () => {
		await begin();
		const move = toolkit.moves.moveTask.bind(toolkit.moves);
		toolkit.moves = {
			...toolkit.moves,
			moveTask: async (id, options) => {
				const outcome = await move(id, options);
				store.writeControl('pause');
				return outcome;
			},
		};

		const first = await run();

		expect(first).toMatchObject({ status: 'paused', moved: 1 });
		expect(store.readState()?.status).toBe('paused');
		expect(states().filter(value => value === 'in-b')).toHaveLength(1);
		expect(toolkit.files.texts.has(LOCK)).toBe(false);

		toolkit.moves = { ...toolkit.moves, moveTask: move };
		const second = await run();

		expect(second.status).toBe('ready-to-finalize');
		expect(states()).toEqual(['in-b', 'in-b', 'in-b', 'in-b']);
	});

	it('sees a pause asked during a long wait within a slice, not when the wait is over', async () => {
		await begin({ budget: { requestsPerMinute: 1 } });
		let slices = 0;
		clock.onSleep = () => {
			slices++;
			if (slices === 3) store.writeControl('pause');
		};

		const result = await run({ sliceMs: 1000 });

		expect(result.status).toBe('paused');
		expect(slices).toBe(3);
		expect(states().filter(value => value === 'in-b')).toHaveLength(1);
	});

	it('ends as a pause when the process is asked to end (Ctrl+C, SIGTERM): the signal is looked at between tasks and every slice', async () => {
		await begin({ budget: { requestsPerMinute: 1 } });
		const controller = new AbortController();
		clock.onSleep = () => {
			controller.abort();
		};

		const result = await run({ signal: controller.signal });

		expect(result).toMatchObject({ status: 'paused', moved: 1 });
		expect(store.readState()?.status).toBe('paused');
		expect(toolkit.files.texts.has(LOCK)).toBe(false);
	});

	it('stops on request, saying so, without calling it a failure', async () => {
		await begin();
		const move = toolkit.moves.moveTask.bind(toolkit.moves);
		toolkit.moves = {
			...toolkit.moves,
			moveTask: async (id, options) => {
				const outcome = await move(id, options);
				store.writeControl('stop');
				return outcome;
			},
		};

		const result = await run();

		expect(result).toMatchObject({ status: 'stopped', moved: 1 });
		const state = store.readState();
		expect(state?.stop?.text).toContain('asked to stop');
		expect(state?.stop?.fix).toContain('task strategy migrate resume');
		expect(state?.counters.failures).toBe(0);
	});

	it('refuses to run when another worker is alive, naming its pid, and changes nothing', async () => {
		await begin();
		new WorkerLock({
			file: LOCK,
			files: toolkit.files,
			pid: 999,
			host: 'box',
			now: clock.now,
			isAlive: () => true,
		}).acquire();

		await expect(run()).rejects.toThrow(BackendRejectedError);
		await expect(run()).rejects.toThrow(/pid 999/);
		expect(store.readState()?.status).toBe('running');
		expect(states()).toEqual(['in-a', 'in-a', 'in-a', 'in-a']);
	});

	it('takes over the lock of a worker that died and says so in the log', async () => {
		await begin({ isAlive: pid => pid !== 999 });
		new WorkerLock({
			file: LOCK,
			files: toolkit.files,
			pid: 999,
			host: 'box',
			now: clock.now,
			isAlive: () => true,
		}).acquire();

		const result = await run();

		expect(result.status).toBe('ready-to-finalize');
		expect(
			logLines(toolkit).some(line => line['level'] === 'warn' && /took over.*999/.test(String(line['message'])))
		).toBe(true);
	});

	it('refuses a project where no migration was started', async () => {
		await begin();
		toolkit.files.remove(path.join(MIGRATING_DIR, 'state.json'));

		await expect(run()).rejects.toThrow(/no migration was started/);
		expect(toolkit.files.texts.has(LOCK)).toBe(false);
	});

	it('ends at once, ready to finalize, when there is nothing left to move', async () => {
		await begin();
		await run();

		const again = await run();

		expect(again).toMatchObject({ status: 'ready-to-finalize', moved: 0 });
	});

	it('never writes finished or aborted: those belong to finalize and abort', async () => {
		await begin();
		const seen = new Set<string>();
		clock.onSleep = () => {
			seen.add(store.readState()?.status ?? '');
		};

		await run();

		expect([...seen].filter(status => status === 'finished' || status === 'aborted')).toEqual([]);
	});
});
