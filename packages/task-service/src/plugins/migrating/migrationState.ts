// The files of a migration under `<data dir>/migrating/` that the background worker and the commands share:
//   state.json    what was decided at `start` (accepted losses, totals) and what the worker keeps up to date (status, counters, last errors)
//   control.json  what the person asked of the running worker (`pause`, `stop`, or `run` to cancel an earlier ask); read between two tasks
//   worker.json   the heartbeat of the worker (pid, what it is doing, the pace it keeps); `worker.lock` (workerLock.ts) says who may run
//
// Who writes what: `start` creates state.json; the worker updates it while it runs; the commands change it only when no worker is alive
// (`pause` and `resume` of a project whose worker is gone), otherwise they write control.json, so two writers never race on one file.
// A file that is damaged is a loud error naming the file; it is never recreated (the accepted losses live in it).
import * as path from 'node:path';

import { BackendDataError } from '@wadeck-app/task-core';

import type { RateUse, RateWindowSpec } from './moveRate.js';
import type { WorkerFiles } from './workerFiles.js';

export const MIGRATION_STATUSES = ['running', 'paused', 'stopped', 'ready-to-finalize', 'finished', 'aborted'] as const;
/** `finished` and `aborted` are written by `finalize` and `abort`; the worker never writes them. */
export type MigrationStatus = (typeof MIGRATION_STATUSES)[number];

export interface ErrorNote {
	at: string;
	task: string;
	kind: string;
	message: string;
	fix?: string;
}

/**
 * What `finalize` records BEFORE it changes the project config (write-ahead): the fingerprints of the config it found and of the one it
 * will write, so a run that dies between the config write and the state update is recognised and only completes its bookkeeping.
 */
export interface FinalizeRecord {
	startedAt: string;
	/** Fingerprint of the project config before the switch (`absent`: the project had none) and of what the switch writes. */
	original: string;
	target: string;
	/** True from right before the config is written until the state says `finished`. */
	switchStarted: boolean;
	/** Tasks that were moved (a copy was made out of "current"), and tasks created in "new" during the migration. */
	moved: number;
	madeInNew: number;
	idMapFile: string;
	/** Set when the summary event was handed to the caller: a bookkeeping run never hands it twice. */
	summaryEventRaised?: boolean;
}

export interface AbortedTask {
	task: string;
	/** Its id in "new". */
	copy: string;
}

/** What `abort` found and decided, kept in the state so `status` can still list the copies left in "new" after the config switch. */
export interface AbortRecord {
	startedAt: string;
	keepMoved: boolean;
	original: string;
	target: string;
	switchStarted: boolean;
	/** Copies in "new" of tasks that were being moved: "current" stays the truth, the copies are leftovers. */
	leftovers: AbortedTask[];
	/** Tasks whose truth is in "new" (moved, or created there): they are not visible in the project any more (a moved one shows its older copy of "current"). */
	moved: Array<AbortedTask & { madeInNew: boolean }>;
	/** Transactions that were open: a copy may exist in "new" that the index does not list. */
	unsettled: Array<{ task: string; op: string }>;
}

export interface MigrationState {
	format: 1;
	startedAt: string;
	/** Loss kinds (or groups, or `all`) accepted at `start`; every move is made under these terms. */
	acceptedLosses: string[];
	status: MigrationStatus;
	statusSince: string;
	/** Why the worker stopped by itself (status `stopped`), and what to do. */
	stop?: { text: string; fix: string };
	/** The tasks of `current` when it started, and the average cost of moving one (the estimate; the worker refines it). */
	totals: { tasks: number; requestsPerMove: number; writesPerMove: number };
	/** What the plan said would be lost, by kind: the number of tasks concerned. */
	plan: { losses: Record<string, number> };
	/** The windows the pace was bound by when it started (the budget and the caps of "new"): what the ETA is computed from before a worker ran. */
	pace: RateWindowSpec[];
	counters: { moved: number; skippedClaimed: number; deferred: number; failures: number; ratePauses: number };
	/** Tasks the worker gave up on for now (attempts used up): they need a person (see the last errors). */
	parked: Array<{ task: string; reason: string }>;
	/** The latest per-task errors, oldest first. */
	lastErrors: ErrorNote[];
	/** Written by `finalize` (see FinalizeRecord). */
	finalize?: FinalizeRecord;
	/** Written by `abort` (see AbortRecord). */
	abort?: AbortRecord;
}

export type ControlCommand = 'run' | 'pause' | 'stop';
const CONTROL_COMMANDS: readonly string[] = ['run', 'pause', 'stop'];
export interface Control {
	command: ControlCommand;
	at: string;
}

export type WorkerPhase = 'starting' | 'moving' | 'rate-pause' | 'waiting' | 'exiting';
export interface Heartbeat {
	pid: number;
	host: string;
	startedAt: string;
	heartbeatAt: string;
	phase: WorkerPhase;
	/** The task being moved. */
	task?: string;
	/** While `rate-pause` or `waiting`: when the worker will look again, and why. */
	pauseUntil?: string;
	pauseReason?: string;
	/** The windows the worker keeps and what the last minute spent. */
	rate: { limits: RateWindowSpec[]; used: RateUse };
}

export const STATE_FILE = 'state.json';
export const CONTROL_FILE = 'control.json';
export const HEARTBEAT_FILE = 'worker.json';
export const LOCK_FILE = 'worker.lock';
export const LAST_ERRORS_MAX = 20;

const START_COMMAND = 'task strategy migrate start';
const HINT_DAMAGED =
	'Do not delete it: it holds what was decided at start (the accepted losses). Restore it from a backup; if there is none, move it aside only when no worker is running (task strategy migrate status), then start again.';

export interface StateStoreInput {
	/** `<data dir>/migrating`. */
	dir: string;
	files: WorkerFiles;
	/** The clock in milliseconds. */
	now: () => number;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;

export class MigrationStateStore {
	readonly stateFile: string;
	readonly controlFile: string;
	readonly heartbeatFile: string;
	private readonly files: WorkerFiles;
	private readonly now: () => number;

	constructor(input: StateStoreInput) {
		this.stateFile = path.join(input.dir, STATE_FILE);
		this.controlFile = path.join(input.dir, CONTROL_FILE);
		this.heartbeatFile = path.join(input.dir, HEARTBEAT_FILE);
		this.files = input.files;
		this.now = input.now;
	}

	/** The state, or `undefined` when no migration was ever started here. A damaged file is a loud error. */
	readState(): MigrationState | undefined {
		const text = this.files.read(this.stateFile);
		if (text === undefined) return undefined;
		return this.parseState(text);
	}

	writeState(state: MigrationState): void {
		this.files.ensureDir(path.dirname(this.stateFile));
		this.files.replace(this.stateFile, `${JSON.stringify(state, null, 2)}\n`);
	}

	/** Changes the state as it is on disk now. A migration that never started is an error naming the command that starts it. */
	updateState(change: (state: MigrationState) => MigrationState): MigrationState {
		const current = this.readState();
		if (current === undefined) {
			throw new BackendDataError(
				'migrating',
				this.stateFile,
				`${this.stateFile}: no migration was started in this project`,
				`Start it with: ${START_COMMAND}`
			);
		}
		const next = change(current);
		this.writeState(next);
		return next;
	}

	readControl(): Control | undefined {
		const text = this.files.read(this.controlFile);
		if (text === undefined) return undefined;
		const value = this.parseJson(this.controlFile, text);
		if (
			!isObject(value) ||
			typeof value['command'] !== 'string' ||
			!CONTROL_COMMANDS.includes(value['command']) ||
			typeof value['at'] !== 'string'
		) {
			throw this.damaged(
				this.controlFile,
				'must be { command: run|pause|stop, at }',
				'The file only carries a request to the running worker: it is safe to replace it with `task strategy migrate resume` or `pause`.'
			);
		}
		return { command: value['command'] as ControlCommand, at: value['at'] };
	}

	writeControl(command: ControlCommand): void {
		this.files.ensureDir(path.dirname(this.controlFile));
		const control: Control = { command, at: new Date(this.now()).toISOString() };
		this.files.replace(this.controlFile, `${JSON.stringify(control)}\n`);
	}

	readHeartbeat(): Heartbeat | undefined {
		const text = this.files.read(this.heartbeatFile);
		if (text === undefined) return undefined;
		const value = this.parseJson(this.heartbeatFile, text);
		if (!isObject(value) || typeof value['pid'] !== 'number' || typeof value['heartbeatAt'] !== 'string') {
			throw this.damaged(
				this.heartbeatFile,
				'must be a heartbeat { pid, host, heartbeatAt, ... }',
				'The worker rewrites it every few seconds while it runs: it is safe to move it aside when no worker is running.'
			);
		}
		return value as unknown as Heartbeat;
	}

	writeHeartbeat(heartbeat: Heartbeat): void {
		this.files.ensureDir(path.dirname(this.heartbeatFile));
		this.files.replace(this.heartbeatFile, `${JSON.stringify(heartbeat)}\n`);
	}

	private parseJson(file: string, text: string): unknown {
		try {
			return JSON.parse(text);
		} catch (error) {
			throw this.damaged(file, `is not valid JSON (${error instanceof Error ? error.message : String(error)})`);
		}
	}

	private damaged(file: string, problem: string, hint: string = HINT_DAMAGED): BackendDataError {
		return new BackendDataError('migrating', file, `${file}: ${problem}`, hint);
	}

	private parseState(text: string): MigrationState {
		const file = this.stateFile;
		const value = this.parseJson(file, text);
		if (!isObject(value)) throw this.damaged(file, 'must be an object');
		if (value['format'] !== 1) {
			throw this.damaged(
				file,
				`has format ${JSON.stringify(value['format'])}, this version reads format 1`,
				'Update task to the version that wrote it, or restore a backup of the file.'
			);
		}
		const status = value['status'];
		if (typeof status !== 'string' || !(MIGRATION_STATUSES as readonly string[]).includes(status)) {
			throw this.damaged(file, `status ${JSON.stringify(status)} is not one of ${MIGRATION_STATUSES.join(', ')}`);
		}
		const { acceptedLosses, totals, counters } = value;
		if (!Array.isArray(acceptedLosses) || !acceptedLosses.every(kind => typeof kind === 'string')) {
			throw this.damaged(file, 'acceptedLosses must be a list of loss kinds');
		}
		if (
			!isObject(totals) ||
			![totals['tasks'], totals['requestsPerMove'], totals['writesPerMove']].every(isCount)
		) {
			throw this.damaged(file, 'totals must be { tasks, requestsPerMove, writesPerMove }, all numbers');
		}
		if (!isObject(counters) || !Object.values(counters).every(isCount)) {
			throw this.damaged(file, 'counters must be numbers');
		}
		for (const key of ['startedAt', 'statusSince'] as const) {
			if (typeof value[key] !== 'string') throw this.damaged(file, `${key} must be an instant`);
		}
		if (
			!Array.isArray(value['parked']) ||
			!Array.isArray(value['lastErrors']) ||
			!Array.isArray(value['pace']) ||
			!isObject(value['plan'])
		) {
			throw this.damaged(file, 'plan, pace, parked and lastErrors are missing or of the wrong shape');
		}
		const finalize = value['finalize'];
		if (
			finalize !== undefined &&
			!(
				isObject(finalize) &&
				typeof finalize['original'] === 'string' &&
				typeof finalize['target'] === 'string' &&
				typeof finalize['switchStarted'] === 'boolean'
			)
		) {
			throw this.damaged(file, 'finalize must be { original, target, switchStarted, ... } (written by finalize)');
		}
		const abort = value['abort'];
		if (
			abort !== undefined &&
			!(
				isObject(abort) &&
				typeof abort['original'] === 'string' &&
				typeof abort['target'] === 'string' &&
				typeof abort['switchStarted'] === 'boolean' &&
				Array.isArray(abort['leftovers']) &&
				Array.isArray(abort['moved']) &&
				Array.isArray(abort['unsettled'])
			)
		) {
			throw this.damaged(
				file,
				'abort must be { original, target, switchStarted, leftovers, moved, unsettled, ... } (written by abort)'
			);
		}
		return value as unknown as MigrationState;
	}
}

/** The state with one more error at the end of `lastErrors` (the oldest ones beyond {@link LAST_ERRORS_MAX} are dropped). */
export function withError(state: MigrationState, note: ErrorNote): MigrationState {
	return { ...state, lastErrors: [...state.lastErrors, note].slice(-LAST_ERRORS_MAX) };
}
