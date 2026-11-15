import * as path from 'node:path';

import { BackendDataError, BackendRejectedError } from '@wadeck-app/task-core';
import { describe, expect, it } from 'vitest';

import { LAST_ERRORS_MAX, MigrationStateStore, withError } from './migrationState.js';
import type { Heartbeat, MigrationState } from './migrationState.js';
import { memoryWorkerFiles } from './testHelpers.js';
import { WorkerLock } from './workerLock.js';

const DIR = '/data/migrating';
const STATE = path.join(DIR, 'state.json');
const LOCK = path.join(DIR, 'worker.lock');

const STATE_OF = (extra: Partial<MigrationState> = {}): MigrationState => ({
	format: 1,
	startedAt: '2026-11-16T08:00:00.000Z',
	acceptedLosses: ['history'],
	status: 'running',
	statusSince: '2026-11-16T08:00:00.000Z',
	totals: { tasks: 3, requestsPerMove: 4, writesPerMove: 2 },
	plan: { losses: { history: 3 } },
	pace: [],
	counters: { moved: 0, skippedClaimed: 0, deferred: 0, failures: 0, ratePauses: 0 },
	parked: [],
	lastErrors: [],
	...extra,
});

const BEAT: Heartbeat = {
	pid: 4242,
	host: 'box',
	startedAt: '2026-11-16T08:00:00.000Z',
	heartbeatAt: '2026-11-16T08:00:05.000Z',
	phase: 'moving',
	rate: {
		limits: [{ name: 'budget', unit: 'requests', limit: 30, windowMs: 60_000 }],
		used: { requests: 3, writes: 1 },
	},
};

function open() {
	const files = memoryWorkerFiles();
	const store = new MigrationStateStore({ dir: DIR, files, now: () => Date.UTC(2026, 10, 16, 8, 1, 0) });
	return { files, store };
}

describe('MigrationStateStore', () => {
	it('answers undefined for a migration that never started, and reads back what it wrote', () => {
		const { store, files } = open();
		expect(store.readState()).toBeUndefined();

		store.writeState(STATE_OF());

		expect(store.readState()).toEqual(STATE_OF());
		expect(files.writes).toEqual([STATE]);
	});

	it('updates the state from what it holds now', () => {
		const { store } = open();
		store.writeState(STATE_OF());

		const next = store.updateState(state => ({ ...state, status: 'paused' }));

		expect(next.status).toBe('paused');
		expect(store.readState()?.status).toBe('paused');
	});

	it('refuses to update a migration that never started, with the command that starts it', () => {
		const { store } = open();
		let caught: unknown;
		try {
			store.updateState(state => state);
		} catch (error) {
			caught = error;
		}
		expect((caught as BackendDataError).message).toMatch(/no migration was started/);
		expect((caught as BackendDataError).hint).toContain('task strategy migrate start');
	});

	it('names the file and a fix when the state is damaged, and never replaces it', () => {
		const { store, files } = open();
		files.texts.set(STATE, '{ not json');

		let caught: unknown;
		try {
			store.readState();
		} catch (error) {
			caught = error;
		}

		expect(caught).toBeInstanceOf(BackendDataError);
		expect((caught as BackendDataError).message).toContain(STATE);
		expect((caught as BackendDataError).hint).toMatch(/do not delete|restore/i);
		expect(files.texts.get(STATE)).toBe('{ not json');
	});

	it.each([
		['an unknown status', { ...STATE_OF(), status: 'weird' }],
		['a format that is not 1', { ...STATE_OF(), format: 2 }],
		['totals that are not numbers', { ...STATE_OF(), totals: { tasks: 'many' } }],
		['accepted losses that are not a list', { ...STATE_OF(), acceptedLosses: 'all' }],
	])('refuses a state with %s', (_name, value) => {
		const { store, files } = open();
		files.texts.set(STATE, JSON.stringify(value));
		expect(() => store.readState()).toThrow(BackendDataError);
	});

	it('writes the control command with its time, and reads it back', () => {
		const { store } = open();
		expect(store.readControl()).toBeUndefined();

		store.writeControl('pause');

		expect(store.readControl()).toEqual({ command: 'pause', at: '2026-11-16T08:01:00.000Z' });
	});

	it('refuses a control file with an unknown command', () => {
		const { store, files } = open();
		files.texts.set(path.join(DIR, 'control.json'), JSON.stringify({ command: 'explode', at: 'x' }));
		expect(() => store.readControl()).toThrow(BackendDataError);
	});

	it('writes and reads the heartbeat of the worker', () => {
		const { store } = open();
		expect(store.readHeartbeat()).toBeUndefined();
		store.writeHeartbeat(BEAT);
		expect(store.readHeartbeat()).toEqual(BEAT);
	});
});

describe('withError', () => {
	it('keeps the last errors only, newest last', () => {
		let state = STATE_OF();
		for (let n = 1; n <= LAST_ERRORS_MAX + 5; n++) {
			state = withError(state, { at: `t${n}`, task: `task${n}`, kind: 'failed', message: `m${n}` });
		}
		expect(state.lastErrors).toHaveLength(LAST_ERRORS_MAX);
		expect(state.lastErrors[0]?.task).toBe('task6');
		expect(state.lastErrors.at(-1)?.task).toBe(`task${LAST_ERRORS_MAX + 5}`);
	});
});

describe('WorkerLock', () => {
	const lockOf = (files: ReturnType<typeof memoryWorkerFiles>, pid: number, alive: (pid: number) => boolean) =>
		new WorkerLock({
			file: LOCK,
			files,
			pid,
			host: 'box',
			now: () => Date.UTC(2026, 10, 16, 8, 0, 0),
			isAlive: alive,
			token: `token-${pid}`,
		});

	it('is taken by the first worker and released by it', () => {
		const files = memoryWorkerFiles();
		const lock = lockOf(files, 100, () => true);

		expect(lock.acquire()).toEqual({});
		expect(lock.holder()).toMatchObject({ pid: 100, host: 'box' });

		lock.release();
		expect(files.texts.has(LOCK)).toBe(false);
	});

	it('refuses a second worker while the first is alive, naming its pid and what to do', () => {
		const files = memoryWorkerFiles();
		lockOf(files, 100, () => true).acquire();

		let caught: unknown;
		try {
			lockOf(files, 200, () => true).acquire();
		} catch (error) {
			caught = error;
		}

		expect(caught).toBeInstanceOf(BackendRejectedError);
		expect((caught as BackendRejectedError).message).toContain('pid 100');
		expect((caught as BackendRejectedError).hint).toContain('task strategy migrate status');
		expect(files.texts.get(LOCK)).toContain('token-100');
	});

	it('takes over the lock of a worker that is dead, and says so', () => {
		const files = memoryWorkerFiles();
		lockOf(files, 100, () => true).acquire();

		const second = lockOf(files, 200, pid => pid !== 100);
		const result = second.acquire();

		expect(result.tookOver).toMatchObject({ pid: 100 });
		expect(second.holder()).toMatchObject({ pid: 200 });
	});

	it('never judges a lock taken on another host: it refuses and says it cannot tell', () => {
		const files = memoryWorkerFiles();
		new WorkerLock({
			file: LOCK,
			files,
			pid: 100,
			host: 'other-box',
			now: () => 0,
			isAlive: () => false,
			token: 't',
		}).acquire();

		expect(() => lockOf(files, 200, () => false).acquire()).toThrow(/other-box/);
	});

	it('does not remove a lock that is no longer its own when it releases', () => {
		const files = memoryWorkerFiles();
		const first = lockOf(files, 100, () => true);
		first.acquire();
		// somebody else took it over meanwhile (the first was judged dead by a slow clock)
		files.texts.set(LOCK, JSON.stringify({ pid: 300, host: 'box', startedAt: 'x', token: 'token-300' }));

		first.release();

		expect(files.texts.get(LOCK)).toContain('token-300');
	});

	it('refuses a lock file it cannot read, without taking over', () => {
		const files = memoryWorkerFiles();
		files.texts.set(LOCK, 'garbage');
		expect(() => lockOf(files, 200, () => false).acquire()).toThrow(/worker\.lock/);
		expect(files.texts.get(LOCK)).toBe('garbage');
	});
});
