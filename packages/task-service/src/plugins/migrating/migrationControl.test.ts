import * as path from 'node:path';

import { BackendDataError, BackendRejectedError } from '@wadeck-app/task-core';
import { describe, expect, it } from 'vitest';

import {
	pauseMigration,
	readMigrationLog,
	readMigrationStatus,
	resumeMigration,
	waitForWorker,
} from './migrationControl.js';
import type { ControlInput } from './migrationControl.js';
import { MigrationJournal } from './migrationJournal.js';
import { MigrationStateStore } from './migrationState.js';
import type { Heartbeat, MigrationState } from './migrationState.js';
import { memoryWorkerFiles } from './testHelpers.js';
import type { IndexRow } from './routingIndex.js';
import { WorkerLock } from './workerLock.js';

const DIR = '/data/migrating';
const INDEX = path.join(DIR, 'index.json');
const LOCK = path.join(DIR, 'worker.lock');
const LOG = path.join(DIR, 'log.ndjson');
const NOW = Date.UTC(2026, 10, 16, 10, 0, 0);
const iso = (ms: number): string => new Date(ms).toISOString();

const STATE = (extra: Partial<MigrationState> = {}): MigrationState => ({
	format: 1,
	startedAt: iso(NOW - 3_600_000),
	acceptedLosses: ['history'],
	status: 'running',
	statusSince: iso(NOW - 600_000),
	totals: { tasks: 7, requestsPerMove: 2, writesPerMove: 1 },
	plan: { losses: { history: 7 } },
	pace: [],
	counters: { moved: 3, skippedClaimed: 1, deferred: 0, failures: 1, ratePauses: 2 },
	parked: [],
	lastErrors: [],
	...extra,
});

const row = (publicId: string, state: IndexRow['state'], extra: Partial<IndexRow> = {}): IndexRow => ({
	publicId,
	state,
	since: iso(NOW),
	version: 1,
	...(state === 'in-a' || state === 'deleted' ? { a: publicId } : {}),
	...(state === 'moving' ? { a: publicId, b: `b-${publicId}` } : {}),
	...(state === 'in-b' ? { a: publicId, b: `b-${publicId}` } : {}),
	...extra,
});

const BEAT = (extra: Partial<Heartbeat> = {}): Heartbeat => ({
	pid: 4242,
	host: 'box',
	startedAt: iso(NOW - 300_000),
	heartbeatAt: iso(NOW - 4_000),
	phase: 'moving',
	task: 'x1',
	rate: {
		limits: [{ name: 'budget', unit: 'requests', limit: 30, windowMs: 60_000 }],
		used: { requests: 12, writes: 4 },
	},
	...extra,
});

function setup(
	state: MigrationState | null = STATE(),
	rows: IndexRow[] = [],
	alive: (pid: number) => boolean = () => true
) {
	const files = memoryWorkerFiles();
	const input: ControlInput = { dir: DIR, files, now: () => NOW, isAlive: alive, host: 'box' };
	const store = new MigrationStateStore({ dir: DIR, files, now: () => NOW });
	if (state !== null) store.writeState(state);
	files.texts.set(INDEX, JSON.stringify({ format: 1, rows }));
	files.writes.length = 0;
	const holdLock = (pid = 4242): void => {
		new WorkerLock({
			file: LOCK,
			files,
			pid,
			host: 'box',
			now: () => NOW - 300_000,
			isAlive: () => true,
		}).acquire();
	};
	return { files, input, store, holdLock };
}

describe('readMigrationStatus', () => {
	it('says no migration was started, and how to plan one, without failing', () => {
		const { input } = setup(null);
		const report = readMigrationStatus(input);
		expect(report).toMatchObject({ started: false, problems: [] });
		expect(report.next).toContain('task strategy migrate start --dry-run');
	});

	it('counts the tasks per state, the stale copies and the open transactions, and the share that is moved', () => {
		const rows = [
			row('a1', 'in-a'),
			row('a2', 'in-a'),
			row('m1', 'moving', { stale: true }),
			row('b1', 'in-b'),
			row('b2', 'in-b'),
			row('b3', 'in-b'),
			{ publicId: 'n1', b: 'n1', state: 'in-b', since: iso(NOW), version: 1 } as IndexRow,
			row('d1', 'deleted'),
		];
		const { input, files } = setup(STATE(), rows);
		new MigrationJournal({ dir: DIR, files }).begin('move', 'm1');

		const report = readMigrationStatus(input);

		expect(report.counts).toEqual({
			total: 7,
			moved: 3,
			inCurrent: 2,
			moving: 1,
			stale: 1,
			deleted: 1,
			madeInNew: 1,
			openTransactions: 1,
		});
		expect(report.percent).toBe(43);
		expect(report.counters).toMatchObject({ moved: 3, failures: 1 });
	});

	it('does not repair a torn write-ahead log while it counts the open transactions', () => {
		const { input, files } = setup();
		new MigrationJournal({ dir: DIR, files }).begin('move', 'm1');
		const wal = path.join(DIR, 'wal.ndjson');
		files.texts.set(wal, `${files.texts.get(wal) ?? ''}{"seq":2,"at":"2026`);
		files.writes.length = 0;

		expect(readMigrationStatus(input).counts?.openTransactions).toBe(1);
		expect(files.writes).toEqual([]);
	});

	it('shows a live worker: pid, what it does, the age of its heartbeat and the pace it keeps', () => {
		const { input, store, holdLock } = setup();
		holdLock();
		store.writeHeartbeat(BEAT());

		const report = readMigrationStatus(input);

		expect(report.worker).toMatchObject({
			running: true,
			starting: false,
			pid: 4242,
			phase: 'moving',
			task: 'x1',
			heartbeatAgeSeconds: 4,
		});
		expect(report.rate?.used).toEqual({ requests: 12, writes: 4 });
		expect(report.next).toContain('task strategy migrate log --follow');
		expect(report.problems).toEqual([]);
	});

	it('tells a status that says running while no worker is alive, and what to run', () => {
		const { input, holdLock } = setup(STATE(), [], pid => pid !== 4242);
		holdLock();

		const report = readMigrationStatus(input);

		expect(report.worker).toMatchObject({ running: false, starting: false, pid: 4242 });
		expect(report.problems.join('\n')).toMatch(/no worker is alive/);
		expect(report.problems.join('\n')).toContain('pid 4242');
		expect(report.next).toContain('task strategy migrate resume');
	});

	it('does not call a freshly launched worker dead: it has half a minute to take its lock', () => {
		const { input } = setup(STATE({ statusSince: iso(NOW - 5_000) }));

		const report = readMigrationStatus(input);

		expect(report.worker).toMatchObject({ running: false, starting: true });
		expect(report.problems).toEqual([]);
		expect(report.next).toMatch(/starting/);
	});

	it('warns when a live worker stopped writing its heartbeat', () => {
		const { input, store, holdLock } = setup();
		holdLock();
		store.writeHeartbeat(BEAT({ heartbeatAt: iso(NOW - 300_000) }));

		const report = readMigrationStatus(input);

		expect(report.worker?.running).toBe(true);
		expect(report.problems.join('\n')).toMatch(/pid 4242 is alive but has not written its heartbeat for 300 s/);
	});

	it.each([
		['paused', STATE({ status: 'paused' }), /task strategy migrate resume/],
		[
			'stopped',
			STATE({ status: 'stopped', stop: { text: '3 failures in a row', fix: 'Fix the API token, then run: x' } }),
			/Fix the API token/,
		],
		['ready to finalize', STATE({ status: 'ready-to-finalize' }), /finalize` is not available yet/],
	])('gives the next action for a migration that is %s', (_name, state, expected) => {
		const { input } = setup(state);
		expect(readMigrationStatus(input).next).toMatch(expected);
	});

	it('reports what was asked of the running worker, and says it stops after its task', () => {
		const { input, store, holdLock } = setup();
		holdLock();
		store.writeHeartbeat(BEAT());
		store.writeControl('pause');

		const report = readMigrationStatus(input);

		expect(report.control?.command).toBe('pause');
		expect(report.next).toMatch(/pause was asked/);
	});

	it('estimates the time from the pace and the tasks left, and says plainly when nothing limits the pace', () => {
		const pace = [{ name: 'budget', unit: 'requests' as const, limit: 30, windowMs: 60_000 }];
		const rows = [row('a1', 'in-a'), row('a2', 'in-a'), row('b1', 'in-b')];
		const withPace = readMigrationStatus(
			setup(STATE({ pace, totals: { tasks: 3, requestsPerMove: 15, writesPerMove: 1 } }), rows).input
		);
		// two tasks left, 15 requests each, 30 requests a minute
		expect(withPace.eta).toEqual({ minutes: 1, basis: 'pace' });

		const without = readMigrationStatus(
			setup(STATE({ totals: { tasks: 3, requestsPerMove: 1, writesPerMove: 1 } }), rows).input
		);
		expect(without.eta?.basis).toBe('unknown');
		expect(without.eta?.note).toMatch(/no limit/);
	});

	it('reports a damaged routing index as a problem with its fix, and still answers', () => {
		const { input, files } = setup();
		files.texts.set(INDEX, '{ nope');

		const report = readMigrationStatus(input);

		expect(report.started).toBe(true);
		expect(report.counts).toBeUndefined();
		expect(report.problems.join('\n')).toContain('index.json');
	});

	it('fails loudly for a damaged state, naming the file', () => {
		const { input, files } = setup();
		files.texts.set(path.join(DIR, 'state.json'), 'nope');
		expect(() => readMigrationStatus(input)).toThrow(BackendDataError);
	});
});

describe('pauseMigration', () => {
	it('asks a live worker to pause, through the control file, and writes no state', () => {
		const { input, store, files, holdLock } = setup();
		holdLock();
		files.writes.length = 0;

		expect(pauseMigration(input)).toEqual({ outcome: 'requested', pid: 4242 });

		expect(store.readControl()?.command).toBe('pause');
		expect(files.writes).toEqual([path.join(DIR, 'control.json')]);
	});

	it('pauses a migration whose worker is gone by changing the state itself', () => {
		const { input, store } = setup(STATE(), [], () => false);
		expect(pauseMigration(input)).toEqual({ outcome: 'paused' });
		expect(store.readState()?.status).toBe('paused');
	});

	it('is a no-op for a migration that is paused already', () => {
		const { input, files } = setup(STATE({ status: 'paused' }), [], () => false);
		files.writes.length = 0;
		expect(pauseMigration(input)).toEqual({ outcome: 'already-paused' });
		expect(files.writes).toEqual([]);
	});

	it('refuses where no migration was started, with the command to plan one', () => {
		const { input } = setup(null);
		let caught: unknown;
		try {
			pauseMigration(input);
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(BackendRejectedError);
		expect((caught as BackendRejectedError).hint).toContain('task strategy migrate start');
	});

	it.each(['ready-to-finalize', 'finished', 'aborted'] as const)(
		'refuses a migration that is %s: nothing is moving',
		status => {
			const { input } = setup(STATE({ status }));
			expect(() => pauseMigration(input)).toThrow(/nothing is moving/);
		}
	);
});

describe('resumeMigration', () => {
	it('launches the worker of a paused migration, then marks it running', async () => {
		const { input, store } = setup(STATE({ status: 'paused' }), [], () => false);
		const launch = async () => ({ pid: 777 });

		const result = await resumeMigration(input, launch);

		expect(result).toEqual({ outcome: 'launched', pid: 777 });
		expect(store.readState()).toMatchObject({ status: 'running' });
		expect(store.readControl()?.command).toBe('run');
	});

	it('relaunches after a stop and clears the reason that was shown', async () => {
		const { input, store } = setup(STATE({ status: 'stopped', stop: { text: 'x', fix: 'y' } }), [], () => false);

		await resumeMigration(input, async () => ({}));

		expect(store.readState()?.stop).toBeUndefined();
	});

	it('leaves the state alone when the launch fails, and passes the error on', async () => {
		const { input, store } = setup(STATE({ status: 'paused' }), [], () => false);

		await expect(resumeMigration(input, () => Promise.reject(new Error('cannot start a process')))).rejects.toThrow(
			'cannot start a process'
		);

		expect(store.readState()?.status).toBe('paused');
	});

	it('launches nothing while a worker is alive: it only cancels a pause that was asked', async () => {
		const { input, store, holdLock } = setup();
		holdLock();
		store.writeControl('pause');
		let launched = 0;
		const launch = async () => {
			launched++;
			return {};
		};

		expect(await resumeMigration(input, launch)).toEqual({ outcome: 'pause-cancelled', pid: 4242 });
		expect(store.readControl()?.command).toBe('run');
		expect(await resumeMigration(input, launch)).toEqual({ outcome: 'already-running', pid: 4242 });
		expect(launched).toBe(0);
	});

	it('refuses where no migration was started, and where nothing is left to move', async () => {
		await expect(resumeMigration(setup(null).input, async () => ({}))).rejects.toThrow(BackendRejectedError);
		await expect(
			resumeMigration(setup(STATE({ status: 'ready-to-finalize' })).input, async () => ({}))
		).rejects.toThrow(/nothing is left to move/);
	});
});

describe('readMigrationLog', () => {
	const lines = (...entries: Array<Record<string, unknown>>): string =>
		entries.map(entry => JSON.stringify(entry)).join('\n') + '\n';

	it('answers the last entries, oldest first, with the total, and only what is after a point', () => {
		const { input, files } = setup();
		files.texts.set(LOG, lines({ message: 'one' }, { message: 'two' }, { message: 'three' }));

		expect(readMigrationLog(input, { tail: 2 })).toEqual({
			entries: [{ message: 'two' }, { message: 'three' }],
			total: 3,
		});
		expect(readMigrationLog(input, { after: 1 })).toEqual({
			entries: [{ message: 'two' }, { message: 'three' }],
			total: 3,
		});
		expect(readMigrationLog(input, { after: 3 })).toEqual({ entries: [], total: 3 });
	});

	it('is empty for a migration that never wrote a line', () => {
		expect(readMigrationLog(setup().input)).toEqual({ entries: [], total: 0 });
	});

	it('does not read a line that is still being written, and shows an unreadable one instead of failing', () => {
		const { input, files } = setup();
		files.texts.set(LOG, `${lines({ message: 'one' })}not json\n{"message":"parti`);

		const answer = readMigrationLog(input);

		expect(answer.total).toBe(2);
		expect(answer.entries[1]).toMatchObject({ level: 'error' });
		expect(String(answer.entries[1]?.message)).toContain('not json');
	});
});

describe('waitForWorker', () => {
	it('is true as soon as a live worker holds the lock, and false after the time it was given', async () => {
		const { input, holdLock } = setup();
		let t = 0;
		const sleep = async (ms: number) => {
			t += ms;
			if (t >= 300) holdLock();
		};

		expect(await waitForWorker(input, { timeoutMs: 1000, sleep })).toBe(true);

		const none = setup(STATE(), [], () => false);
		const sleeps: number[] = [];
		expect(await waitForWorker(none.input, { timeoutMs: 1000, sleep: async ms => void sleeps.push(ms) })).toBe(
			false
		);
		expect(sleeps.reduce((sum, ms) => sum + ms, 0)).toBeGreaterThanOrEqual(1000);
	});
});
