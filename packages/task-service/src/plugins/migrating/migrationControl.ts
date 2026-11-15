// What the commands of a person do about a migration, from the files under `<data dir>/migrating/` alone: no side is opened, so these work
// when a token is missing or a server is down, and `status` never writes (not even to repair a torn log: a worker may be appending).
//   status  the state, the routing index, the lock and the heartbeat of the worker, the write-ahead log, put together
//   pause   asks a live worker (control file) or, when none is alive, marks the migration paused itself
//   resume  relaunches the worker when none is alive (the caller supplies the launch), or cancels a pause that was asked
//   log     the migration log, whole, the last entries, or what came after a point (for `--follow`)
import * as path from 'node:path';

import { BackendDataError, BackendRejectedError } from '@wadeck-app/task-core';

import { MigrationJournal } from './migrationJournal.js';
import { LOCK_FILE, MigrationStateStore } from './migrationState.js';
import type { Heartbeat, MigrationState, MigrationStatus } from './migrationState.js';
import type { RateUse, RateWindowSpec } from './moveRate.js';
import { RoutingIndex } from './routingIndex.js';
import type { IndexRow } from './routingIndex.js';
import type { WorkerFiles } from './workerFiles.js';
import { WorkerLock } from './workerLock.js';
import type { LockHolder } from './workerLock.js';

export interface ControlInput {
	/** `<data dir>/migrating`. */
	dir: string;
	files: WorkerFiles;
	/** The clock in milliseconds. */
	now: () => number;
	/** Whether a process of this host exists. */
	isAlive: (pid: number) => boolean;
	host: string;
	/** The pid that takes the worker lock (finalize, abort). Default: this process. */
	pid?: number;
}

export interface MigrationStatusReport {
	started: boolean;
	status?: MigrationStatus;
	statusSince?: string;
	startedAt?: string;
	acceptedLosses?: string[];
	stop?: { text: string; fix: string };
	/** Absent when the routing index cannot be read (see `problems`). */
	counts?: {
		/** Tasks of "current" when the migration started. */
		total: number;
		/** In "new" and authoritative there (made in "new" later: not counted). */
		moved: number;
		inCurrent: number;
		moving: number;
		/** Moving copies that may differ from the task and need a catch-up. */
		stale: number;
		deleted: number;
		/** Tasks created in "new" since the routing started (not part of the move). */
		madeInNew: number;
		openTransactions: number;
	};
	percent?: number;
	worker?: {
		running: boolean;
		/** Launched less than half a minute ago and has not taken its lock yet. */
		starting: boolean;
		pid?: number;
		host?: string;
		since?: string;
		heartbeatAgeSeconds?: number;
		phase?: string;
		task?: string;
		pauseUntil?: string;
		pauseReason?: string;
	};
	/** What was asked of the worker (control.json) when it is not the default. */
	control?: { command: string; at: string };
	rate?: { limits: RateWindowSpec[]; used: RateUse };
	eta?: { minutes?: number; basis: 'pace' | 'unknown'; note?: string };
	counters?: MigrationState['counters'];
	parked?: MigrationState['parked'];
	lastErrors?: MigrationState['lastErrors'];
	/** Things that are wrong or odd, each with its fix. */
	problems: string[];
	/** The one thing to do next. */
	next: string;
}

const START_HINT = 'task strategy migrate start';
const STARTING_GRACE_MS = 30_000;
/** A worker beats at least every few seconds while it waits and after each task; this long without one is worth saying. */
const STALE_HEARTBEAT_MS = 120_000;
const NOT_MOVING: readonly MigrationStatus[] = ['ready-to-finalize', 'finished', 'aborted'];

const storeOf = (input: ControlInput): MigrationStateStore =>
	new MigrationStateStore({ dir: input.dir, files: input.files, now: input.now });

function lockOf(input: ControlInput): WorkerLock {
	return new WorkerLock({
		file: path.join(input.dir, LOCK_FILE),
		files: input.files,
		pid: 0,
		host: input.host,
		now: input.now,
		isAlive: input.isAlive,
	});
}

/** Whether a worker holds the lock: a holder on this host is judged by its pid, one on another host cannot be and counts as running. */
export function liveWorker(input: ControlInput): {
	holder: LockHolder | undefined;
	alive: boolean;
	otherHost: boolean;
} {
	const holder = lockOf(input).holder();
	if (holder === undefined) return { holder, alive: false, otherHost: false };
	if (holder.host !== input.host) return { holder, alive: true, otherHost: true };
	return { holder, alive: input.isAlive(holder.pid), otherHost: false };
}

function describeProblem(error: unknown): string {
	if (error instanceof BackendDataError) return `${error.message} (${error.hint})`;
	return error instanceof Error ? error.message : String(error);
}

function countRows(rows: readonly IndexRow[]): NonNullable<MigrationStatusReport['counts']> {
	const count = (test: (row: IndexRow) => boolean): number => rows.filter(test).length;
	return {
		total: 0,
		moved: count(row => row.state === 'in-b' && row.a !== undefined),
		inCurrent: count(row => row.state === 'in-a'),
		moving: count(row => row.state === 'moving'),
		stale: count(row => row.state === 'moving' && row.stale === true),
		deleted: count(row => row.state === 'deleted'),
		madeInNew: count(row => row.state === 'in-b' && row.a === undefined),
		openTransactions: 0,
	};
}

/** The rows of the routing index, read only: this never writes (a worker or a command may be writing it). A damaged index is a loud error. */
export function readIndexRows(input: ControlInput): readonly IndexRow[] {
	const index = new RoutingIndex({
		file: path.join(input.dir, 'index.json'),
		files: {
			read: file => input.files.read(file),
			write: () => {
				throw new Error('a read never writes the routing index');
			},
			ensureDir: () => undefined,
		},
	});
	return index.snapshot().rows;
}

export function readMigrationStatus(input: ControlInput): MigrationStatusReport {
	const store = storeOf(input);
	const state = store.readState();
	if (state === undefined) {
		return {
			started: false,
			problems: [],
			next: `No migration was started in this project. See what it would do with: ${START_HINT} --dry-run`,
		};
	}
	const problems: string[] = [];
	const now = input.now();

	let counts: MigrationStatusReport['counts'];
	try {
		counts = { ...countRows(readIndexRows(input)), total: state.totals.tasks, openTransactions: 0 };
	} catch (error) {
		problems.push(describeProblem(error));
	}
	try {
		const open = new MigrationJournal({ dir: input.dir, files: input.files }).openTransactions({ readOnly: true });
		if (counts !== undefined) counts.openTransactions = open.length;
	} catch (error) {
		problems.push(describeProblem(error));
	}

	const { holder, alive, otherHost } = liveWorker(input);
	let heartbeat: Heartbeat | undefined;
	try {
		heartbeat = store.readHeartbeat();
	} catch (error) {
		problems.push(describeProblem(error));
	}
	const starting = !alive && state.status === 'running' && now - Date.parse(state.statusSince) < STARTING_GRACE_MS;
	const age =
		heartbeat === undefined ? undefined : Math.max(0, Math.round((now - Date.parse(heartbeat.heartbeatAt)) / 1000));
	if (alive && !otherHost && age !== undefined && age * 1000 >= STALE_HEARTBEAT_MS) {
		problems.push(
			`worker pid ${holder?.pid} is alive but has not written its heartbeat for ${age} s: it may be stuck. If it is, stop that process, then run: task strategy migrate resume`
		);
	}
	if (otherHost) {
		problems.push(
			`the worker lock was taken on another computer (${holder?.host}, pid ${holder?.pid}): task cannot tell whether it is alive`
		);
	}
	if (!alive && !starting && state.status === 'running') {
		problems.push(
			`the status says running but no worker is alive${holder === undefined ? '' : ` (the last one, pid ${holder.pid}, is gone: it crashed or was killed)`}`
		);
	}
	// A finalize or an abort that began switching the project config and did not say it finished: the next run only completes it.
	const interrupted = interruptedEnd(state);
	if (interrupted !== undefined) problems.push(interrupted.problem);
	const control = store.readControl();
	const asked = control !== undefined && control.command !== 'run' ? control : undefined;

	const report: MigrationStatusReport = {
		started: true,
		status: state.status,
		statusSince: state.statusSince,
		startedAt: state.startedAt,
		acceptedLosses: state.acceptedLosses,
		...(state.stop === undefined ? {} : { stop: state.stop }),
		...(counts === undefined ? {} : { counts }),
		worker: {
			running: alive,
			starting,
			...(holder === undefined ? {} : { pid: holder.pid, host: holder.host, since: holder.startedAt }),
			...(alive && age !== undefined ? { heartbeatAgeSeconds: age } : {}),
			...(alive && heartbeat !== undefined
				? {
						phase: heartbeat.phase,
						...(heartbeat.task === undefined ? {} : { task: heartbeat.task }),
						...(heartbeat.pauseUntil === undefined ? {} : { pauseUntil: heartbeat.pauseUntil }),
						...(heartbeat.pauseReason === undefined ? {} : { pauseReason: heartbeat.pauseReason }),
					}
				: {}),
		},
		...(asked === undefined ? {} : { control: { command: asked.command, at: asked.at } }),
		...(heartbeat === undefined ? {} : { rate: heartbeat.rate }),
		counters: state.counters,
		parked: state.parked,
		lastErrors: state.lastErrors,
		problems,
		next: '',
	};
	if (counts !== undefined) {
		report.percent = counts.total === 0 ? 100 : Math.round((counts.moved / counts.total) * 100);
	}
	report.eta = etaOf(state, heartbeat, counts);
	report.next = interrupted?.next ?? nextAction(state, { alive, starting, asked: asked?.command });
	return report;
}

function interruptedEnd(state: MigrationState): { problem: string; next: string } | undefined {
	if (state.finalize?.switchStarted === true && state.status !== 'finished') {
		const next =
			'The finalize was interrupted after the project config switch began. Complete it with: task strategy migrate finalize (it checks the config and only completes the bookkeeping when the switch happened).';
		return { problem: next, next };
	}
	if (state.abort?.switchStarted === true && state.status !== 'aborted') {
		const next =
			'The abort was interrupted after the project config switch began. Complete it with: task strategy migrate abort (it checks the config and only completes the bookkeeping when the switch happened).';
		return { problem: next, next };
	}
	return undefined;
}

function etaOf(
	state: MigrationState,
	heartbeat: Heartbeat | undefined,
	counts: MigrationStatusReport['counts']
): NonNullable<MigrationStatusReport['eta']> {
	if (counts === undefined) {
		return { basis: 'unknown', note: 'the routing index cannot be read, so the tasks left are not known' };
	}
	const remaining = counts.inCurrent + counts.moving;
	if (remaining === 0) return { minutes: 0, basis: 'pace' };
	const windows = heartbeat?.rate.limits ?? state.pace;
	let minutes: number | undefined;
	for (const window of windows) {
		const perMove = window.unit === 'requests' ? state.totals.requestsPerMove : state.totals.writesPerMove;
		const needed = ((remaining * perMove) / window.limit) * (window.windowMs / 60_000);
		if (minutes === undefined || needed > minutes) minutes = needed;
	}
	if (minutes === undefined) {
		return {
			basis: 'unknown',
			note: 'no limit on the pace (no budget, no cap declared by "new"): the time depends on the speed of the two strategies',
		};
	}
	return { minutes: Math.round(minutes * 100) / 100, basis: 'pace' };
}

function nextAction(
	state: MigrationState,
	worker: { alive: boolean; starting: boolean; asked: string | undefined }
): string {
	switch (state.status) {
		case 'running':
			if (worker.alive) {
				return worker.asked === 'pause'
					? 'A pause was asked: the worker stops after the task it is moving. Then continue with: task strategy migrate resume'
					: 'Nothing to do. Follow it with: task strategy migrate log --follow';
			}
			return worker.starting
				? 'The worker is starting. Look again in a few seconds with: task strategy migrate status'
				: 'No worker is running (it crashed or was killed). Relaunch it with: task strategy migrate resume';
		case 'paused':
			return 'The migration is paused. Continue with: task strategy migrate resume';
		case 'stopped':
			return (
				state.stop?.fix ??
				'The worker stopped. See the errors with: task strategy migrate log, then: task strategy migrate resume'
			);
		case 'ready-to-finalize':
			return 'Every task is moved. Switch the project to the new strategy with: task strategy migrate finalize (the copies in "current" are kept, the old config is backed up). To go back instead: task strategy migrate abort --keep-moved';
		case 'finished':
			return `The migration is finished: the project uses the new strategy alone. The copies in "current" were kept, nothing was deleted. Old id -> new id: ${state.finalize?.idMapFile ?? 'idmap.json in the migrating folder'}`;
		case 'aborted': {
			const copies = state.abort?.leftovers.length ?? 0;
			const moved = state.abort?.moved.length ?? 0;
			return `The migration was aborted: "current" is the truth again. ${copies} copy(ies) in "new" of tasks that were being moved and ${moved} task(s) whose truth is in "new" were left there, not deleted (the list is in state.json under "abort"). To migrate again, move the files of the migrating folder aside first.`;
		}
	}
}

export type PauseResult = { outcome: 'requested'; pid: number } | { outcome: 'paused' } | { outcome: 'already-paused' };

function requireStarted(input: ControlInput, verb: string): MigrationState {
	const state = storeOf(input).readState();
	if (state === undefined) {
		throw new BackendRejectedError(
			'migrating',
			verb,
			'no migration was started in this project',
			`Plan one with: ${START_HINT} --dry-run, then start it with: ${START_HINT}`
		);
	}
	return state;
}

export function pauseMigration(input: ControlInput): PauseResult {
	const state = requireStarted(input, 'pause');
	if (NOT_MOVING.includes(state.status)) {
		throw new BackendRejectedError(
			'migrating',
			'pause',
			`the migration is ${state.status}: nothing is moving, so there is nothing to pause`,
			'See where it stands with: task strategy migrate status'
		);
	}
	const store = storeOf(input);
	const worker = liveWorker(input);
	if (worker.alive && worker.holder !== undefined) {
		store.writeControl('pause');
		return { outcome: 'requested', pid: worker.holder.pid };
	}
	if (state.status === 'paused') return { outcome: 'already-paused' };
	store.updateState(current => {
		const { stop: _stop, ...rest } = current;
		void _stop;
		return { ...rest, status: 'paused', statusSince: new Date(input.now()).toISOString() };
	});
	return { outcome: 'paused' };
}

export type ResumeResult =
	| { outcome: 'launched'; pid?: number }
	| { outcome: 'already-running'; pid: number }
	| { outcome: 'pause-cancelled'; pid: number };

export async function resumeMigration(
	input: ControlInput,
	launch: () => Promise<{ pid?: number }>
): Promise<ResumeResult> {
	const state = requireStarted(input, 'resume');
	if (NOT_MOVING.includes(state.status)) {
		throw new BackendRejectedError(
			'migrating',
			'resume',
			state.status === 'ready-to-finalize'
				? 'nothing is left to move: every task is in "new" (ready to finalize)'
				: `the migration is ${state.status}: there is nothing to resume`,
			'See where it stands with: task strategy migrate status'
		);
	}
	const store = storeOf(input);
	const worker = liveWorker(input);
	if (worker.alive && worker.holder !== undefined) {
		if (store.readControl()?.command === 'pause') {
			store.writeControl('run');
			return { outcome: 'pause-cancelled', pid: worker.holder.pid };
		}
		return { outcome: 'already-running', pid: worker.holder.pid };
	}
	store.writeControl('run');
	// The state is changed after the launch: a launch that fails leaves the migration as it was (paused or stopped, with its reason).
	const launched = await launch();
	store.updateState(current => {
		const { stop: _stop, ...rest } = current;
		void _stop;
		return { ...rest, status: 'running', statusSince: new Date(input.now()).toISOString() };
	});
	return { outcome: 'launched', ...(launched.pid === undefined ? {} : { pid: launched.pid }) };
}

export interface LogEntry {
	at?: string;
	level?: string;
	message?: string;
	task?: string;
	[key: string]: unknown;
}

/**
 * The migration log (`log.ndjson`): all of it, the last `tail` entries, or what comes after the first `after` ones. `total` is the
 * number of complete lines (the next `after`). A line still being written is not read; a line that is not JSON is shown as an error entry.
 */
export function readMigrationLog(
	input: ControlInput,
	options: { tail?: number; after?: number } = {}
): { entries: LogEntry[]; total: number } {
	const text = input.files.read(path.join(input.dir, 'log.ndjson')) ?? '';
	const complete = text.endsWith('\n') ? text : text.slice(0, text.lastIndexOf('\n') + 1);
	const lines = complete.split('\n').filter(line => line !== '');
	const entries = lines.map((line): LogEntry => {
		try {
			return JSON.parse(line) as LogEntry;
		} catch {
			return { level: 'error', message: `unreadable log line: ${line}` };
		}
	});
	if (options.after !== undefined) return { entries: entries.slice(options.after), total: entries.length };
	if (options.tail !== undefined) return { entries: entries.slice(-options.tail), total: entries.length };
	return { entries, total: entries.length };
}

/** True once a live worker holds the lock, false when `timeoutMs` (of the sleeps asked) passed without one. */
export async function waitForWorker(
	input: ControlInput,
	options: { timeoutMs: number; sleep: (ms: number) => Promise<void> }
): Promise<boolean> {
	let waited = 0;
	for (;;) {
		if (liveWorker(input).alive) return true;
		if (waited >= options.timeoutMs) return false;
		const step = Math.min(100, options.timeoutMs - waited);
		await options.sleep(step);
		waited += step;
	}
}
