// The background worker of a migration: moves the tasks of `current` to `new` one after the other, at the pace the budget and the
// side's own caps allow, while every command of a person keeps working. It is a plain function over the toolkit with its clock and its
// sleep injected, so the same code runs in a detached process and, in a test, in memory with a clock the test drives.
//
// What it promises:
//  - one worker per project (the lock), taken before anything changes; it names the other one when it refuses;
//  - order: parents before children, then the oldest first; a pass lists `current` once, so a big project is not listed per task;
//  - pace: every move is charged to the sliding windows (rateWindowsOf) BEFORE it starts; a side that says "rate limited until X"
//    (RateLimitedError) makes it sleep until X, never fail;
//  - a task that cannot be moved now (claimed, waiting for a relation, busy, failing) never stops the others; what fails is recorded in
//    the state and the log, retried a few times, then set aside ("parked") with the reason;
//  - it stops by itself, with a status and the fix, after too many failures in a row, when only long leases are left, or when only
//    parked tasks are; it leaves `ready-to-finalize` when nothing is left to move (finalize itself is a later phase);
//  - between two tasks and every slice of a wait it looks at control.json: `pause` and `stop` end it cleanly within a slice.
import * as path from 'node:path';

import { RateLimitedError } from '@wadeck-app/task-core';

import { LOCK_FILE, MigrationStateStore, withError } from './migrationState.js';
import type { Heartbeat, MigrationState, MigrationStatus, WorkerPhase } from './migrationState.js';
import type { MigrationToolkit } from './migrationToolkit.js';
import { RateLimiter, moveCost, rateWindowsOf } from './moveRate.js';
import { WorkerLock } from './workerLock.js';

export interface WorkerOptions {
	/** Waits `ms` and advances the clock by that much (a test drives both). */
	sleep: (ms: number) => Promise<void>;
	/** Failures of tasks in a row (a success resets) after which the worker stops by itself. Default 5. */
	maxConsecutiveFailures?: number;
	/** Attempts one task gets in a run before it is parked. Default 3. */
	maxAttemptsPerTask?: number;
	/** Longest time between two heartbeats while it waits, milliseconds. Default 5000. */
	heartbeatMs?: number;
	/** The grain of a wait: how often it looks at the control file. Default 1000. */
	sliceMs?: number;
	/** The longest it waits for a claimed task before it stops and says so. Default 5 minutes. */
	maxIdleWaitMs?: number;
	/** Aborted when the process is asked to end: the worker finishes the move in progress and ends as a pause. */
	signal?: AbortSignal;
}

export interface WorkerResult {
	status: MigrationStatus;
	/** Tasks this run moved. */
	moved: number;
	/** Why it stopped, when `status` is `stopped`. */
	reason?: string;
}

const DEFAULTS = {
	maxConsecutiveFailures: 5,
	maxAttemptsPerTask: 3,
	heartbeatMs: 5_000,
	sliceMs: 1_000,
	maxIdleWaitMs: 300_000,
};
/** When a claimed task's lease cannot be read, or a side gives no instant: look again in a minute. */
const UNKNOWN_WAIT_MS = 60_000;
/** A task another process was moving. */
const BUSY_WAIT_MS = 5_000;
const STATUS_HINT = 'task strategy migrate status';
const RESUME_HINT = 'task strategy migrate resume';

type Interrupt = { interrupt: 'pause' | 'stop' };
type Step =
	| { kind: 'moved' }
	| { kind: 'gone' }
	| { kind: 'retry'; at: number; why: 'claimed' | 'deferred' | 'failed' | 'busy'; detail: string }
	| { kind: 'parked' }
	| { kind: 'again' }
	| { kind: 'tripped' }
	| Interrupt;

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const hintOf = (error: unknown): string | undefined =>
	typeof (error as { hint?: unknown } | null)?.hint === 'string' ? (error as { hint: string }).hint : undefined;
const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`;

export async function runMigrationWorker(toolkit: MigrationToolkit, options: WorkerOptions): Promise<WorkerResult> {
	const store = new MigrationStateStore({ dir: toolkit.dir, files: toolkit.files, now: toolkit.now });
	const state = store.readState();
	if (state === undefined) {
		throw new Error(
			`${store.stateFile}: no migration was started in this project. Start it with: task strategy migrate start`
		);
	}
	if (state.status === 'finished' || state.status === 'aborted') {
		throw new Error(
			`the migration of this project is ${state.status} (since ${state.statusSince}): there is nothing for a worker to do`
		);
	}
	const lock = new WorkerLock({
		file: path.join(toolkit.dir, LOCK_FILE),
		files: toolkit.files,
		pid: toolkit.pid,
		host: toolkit.host,
		now: toolkit.now,
		isAlive: toolkit.isAlive,
	});
	const taken = lock.acquire();
	try {
		return await new Run(
			toolkit,
			store,
			options,
			taken.tookOver === undefined ? undefined : taken.tookOver.pid
		).run();
	} finally {
		lock.release();
	}
}

class Run {
	private readonly limiter: RateLimiter;
	private readonly windows;
	private readonly accepted: readonly string[];
	private readonly opts: Required<Omit<WorkerOptions, 'signal'>> & Pick<WorkerOptions, 'signal'>;
	private readonly startedAt: string;
	private readonly attempts = new Map<string, number>();
	private readonly parked = new Map<string, string>();
	private consecutive = 0;
	private movedHere = 0;
	private lastBeat = 0;
	private phase: WorkerPhase = 'starting';

	constructor(
		private readonly tk: MigrationToolkit,
		private readonly store: MigrationStateStore,
		options: WorkerOptions,
		private readonly tookOverFrom: number | undefined
	) {
		this.opts = { ...DEFAULTS, ...options };
		this.windows = rateWindowsOf(tk.budget, tk.nextTraits);
		this.limiter = new RateLimiter(this.windows, tk.now);
		this.accepted = store.readState()!.acceptedLosses;
		this.startedAt = this.iso();
	}

	private iso(): string {
		return new Date(this.tk.now()).toISOString();
	}

	private log(level: 'info' | 'warn' | 'error', message: string, outcome: string, task?: string): void {
		this.tk.journal.info(level, message, { step: 'worker', outcome, ...(task === undefined ? {} : { task }) });
	}

	private beat(phase: WorkerPhase, extra: { task?: string; pauseUntil?: number; pauseReason?: string } = {}): void {
		this.phase = phase;
		this.lastBeat = this.tk.now();
		const heartbeat: Heartbeat = {
			pid: this.tk.pid,
			host: this.tk.host,
			startedAt: this.startedAt,
			heartbeatAt: this.iso(),
			phase,
			...(extra.task === undefined ? {} : { task: extra.task }),
			...(extra.pauseUntil === undefined ? {} : { pauseUntil: new Date(extra.pauseUntil).toISOString() }),
			...(extra.pauseReason === undefined ? {} : { pauseReason: extra.pauseReason }),
			rate: { limits: [...this.windows], used: this.limiter.used() },
		};
		this.store.writeHeartbeat(heartbeat);
	}

	private patch(change: (state: MigrationState) => MigrationState): MigrationState {
		return this.store.updateState(change);
	}

	private setStatus(status: MigrationStatus, stop?: { text: string; fix: string }): void {
		this.patch(state => {
			const { stop: _old, ...rest } = state;
			void _old;
			return {
				...rest,
				status,
				statusSince: this.iso(),
				parked: [...this.parked].map(([task, reason]) => ({ task, reason })),
				...(stop === undefined ? {} : { stop }),
			};
		});
	}

	private control(): 'pause' | 'stop' | undefined {
		if (this.opts.signal?.aborted === true) return 'pause';
		const command = this.store.readControl()?.command;
		return command === 'pause' || command === 'stop' ? command : undefined;
	}

	/** Sleeps `ms` in slices, looking at the control file and keeping the heartbeat fresh; returns what interrupted it. */
	private async pauseFor(
		ms: number,
		phase: 'rate-pause' | 'waiting',
		reason: string
	): Promise<Interrupt | undefined> {
		const until = this.tk.now() + ms;
		this.beat(phase, { pauseUntil: until, pauseReason: reason });
		while (this.tk.now() < until) {
			await this.opts.sleep(Math.min(this.opts.sliceMs, until - this.tk.now()));
			const command = this.control();
			if (command !== undefined) return { interrupt: command };
			if (this.tk.now() - this.lastBeat >= this.opts.heartbeatMs) {
				this.beat(phase, { pauseUntil: until, pauseReason: reason });
			}
		}
		return undefined;
	}

	async run(): Promise<WorkerResult> {
		this.store.writeControl('run');
		this.beat('starting');
		this.parked.clear();
		this.patch(state => ({ ...state, status: 'running', statusSince: this.iso(), parked: [] }));
		const { stop: _stop, ...withoutStop } = this.store.readState()!;
		void _stop;
		this.store.writeState(withoutStop);
		this.log('info', `worker started (pid ${this.tk.pid}, host ${this.tk.host})`, 'worker-started');
		if (this.tookOverFrom !== undefined) {
			this.log(
				'warn',
				`took over the lock of the worker with pid ${this.tookOverFrom}, which is not running (crashed or killed)`,
				'lock-takeover'
			);
		}
		try {
			return await this.loop();
		} finally {
			this.beat('exiting');
		}
	}

	private done(status: MigrationStatus, stop?: { text: string; fix: string }): WorkerResult {
		this.setStatus(status, stop);
		const reason = stop?.text;
		this.log(
			status === 'stopped' ? 'warn' : 'info',
			status === 'ready-to-finalize'
				? 'every task is in "new": ready to finalize'
				: `worker ended: ${status}${reason === undefined ? '' : `: ${reason}`}`,
			status
		);
		return { status, moved: this.movedHere, ...(reason === undefined ? {} : { reason }) };
	}

	private interrupted(command: 'pause' | 'stop'): WorkerResult {
		if (command === 'pause') return this.done('paused');
		return this.done('stopped', {
			text: 'the worker was asked to stop',
			fix: `Continue with: ${RESUME_HINT}`,
		});
	}

	private async loop(): Promise<WorkerResult> {
		for (;;) {
			const asked = this.control();
			if (asked !== undefined) return this.interrupted(asked);

			const order = (await this.candidates()).filter(id => !this.parked.has(id));
			if (order.length === 0) break;

			let progress = false;
			const pending = new Map<string, Extract<Step, { kind: 'retry' }>>();
			for (const id of order) {
				const asked = this.control();
				if (asked !== undefined) return this.interrupted(asked);
				const row = this.tk.index.snapshot().byPublicId(id);
				if (row?.state === 'in-b' || row?.state === 'deleted' || this.parked.has(id)) continue;
				for (;;) {
					const step = await this.moveOne(id);
					if ('interrupt' in step) return this.interrupted(step.interrupt);
					if (step.kind === 'again') continue;
					if (step.kind === 'tripped') return this.tripped();
					if (step.kind === 'moved') progress = true;
					if (step.kind === 'retry') pending.set(id, step);
					break;
				}
			}

			if (pending.size === 0) {
				// Parked tasks (if any) are the only ones left; a task moved this pass leaves nothing pending.
				if (!progress || this.parked.size > 0) break;
				break;
			}
			if (!progress && [...pending.values()].every(step => step.why === 'deferred')) {
				for (const [id, step] of pending)
					this.park(id, `waits for a copy that cannot be made in this run: ${step.detail}`);
				break;
			}
			const earliest = Math.min(...[...pending.values()].map(step => step.at));
			const wait = earliest - this.tk.now();
			if (wait > this.opts.maxIdleWaitMs) return this.longLease(pending);
			if (wait > 0) {
				const why = [...pending.values()].find(step => step.at === earliest)?.detail ?? 'tasks to retry';
				const interrupted = await this.pauseFor(wait, 'waiting', why);
				if (interrupted !== undefined) return this.interrupted(interrupted.interrupt);
			}
		}

		if (this.parked.size > 0) {
			const named = [...this.parked].map(([task, reason]) => `${task} (${reason})`);
			return this.done('stopped', {
				text: `${plural(this.parked.size, 'task')} could not be moved and ${this.parked.size === 1 ? 'was' : 'were'} set aside: ${named.join('; ')}`,
				fix: `See the errors with: ${STATUS_HINT} (and task strategy migrate log). Fix the cause, then run: ${RESUME_HINT} (the tasks are tried again).`,
			});
		}
		return this.done('ready-to-finalize');
	}

	private tripped(): WorkerResult {
		const last = this.store.readState()!.lastErrors.at(-1);
		return this.done('stopped', {
			text: `${this.consecutive} failures in a row (last: ${last === undefined ? 'unknown' : `task ${last.task}: ${last.message}`})`,
			fix: `See the errors with: ${STATUS_HINT} (and task strategy migrate log), fix the cause, then run: ${RESUME_HINT}.`,
		});
	}

	private longLease(pending: ReadonlyMap<string, Extract<Step, { kind: 'retry' }>>): WorkerResult {
		const first = [...pending].sort((a, b) => a[1].at - b[1].at)[0]!;
		const more = pending.size - 1;
		return this.done('stopped', {
			text: `${plural(pending.size, 'task')} cannot be moved for now and the wait is longer than this worker waits (${Math.round(this.opts.maxIdleWaitMs / 60_000)} min): ${first[0]} ${first[1].detail}${more > 0 ? ` (and ${more} more)` : ''}`,
			fix: `Release the claim (task release ${first[0]} --force) or wait for the lease to end, then run: ${RESUME_HINT}.`,
		});
	}

	private park(id: string, reason: string): void {
		this.parked.set(id, reason);
		this.patch(state => ({ ...state, parked: [...this.parked].map(([task, why]) => ({ task, reason: why })) }));
		this.log('warn', `task ${id} is set aside: ${reason}`, 'parked', id);
	}

	/** The tasks of `current` still to move: those with no row, `in-a` or `moving`; parents first, then the oldest, then by id. */
	private async candidates(): Promise<string[]> {
		const summaries = await this.tk.current.list();
		const snapshot = this.tk.index.snapshot();
		const parents = new Map(summaries.map(summary => [summary.id, summary.parentId] as const));
		const depth = (id: string): number => {
			let level = 1;
			const seen = new Set([id]);
			for (
				let parent = parents.get(id);
				parent !== undefined && !seen.has(parent);
				parent = parents.get(parent)
			) {
				seen.add(parent);
				level++;
			}
			return level;
		};
		const todo = summaries.filter(summary => {
			const state = snapshot.byPublicId(summary.id)?.state;
			return state === undefined || state === 'in-a' || state === 'moving';
		});
		const sorted = todo
			.map(summary => ({ summary, depth: depth(summary.id) }))
			.sort(
				(a, b) =>
					a.depth - b.depth ||
					(a.summary.createdAt < b.summary.createdAt
						? -1
						: a.summary.createdAt > b.summary.createdAt
							? 1
							: 0) ||
					(a.summary.id < b.summary.id ? -1 : 1)
			)
			.map(entry => entry.summary);
		// A task that links to another goes after it (the link is written when both ends have a copy): the target comes first, so a move
		// is not made twice. A cycle of links (possible across link types) is broken where it closes.
		const byId = new Map(sorted.map(summary => [summary.id, summary] as const));
		const emitted = new Set<string>();
		const ordered: string[] = [];
		const emit = (id: string, path: ReadonlySet<string>): void => {
			if (emitted.has(id) || path.has(id)) return;
			const summary = byId.get(id);
			if (summary === undefined) return;
			const next = new Set(path).add(id);
			for (const link of summary.links ?? []) emit(link.target, next);
			emitted.add(id);
			ordered.push(id);
		};
		for (const summary of sorted) emit(summary.id, new Set());
		return ordered;
	}

	private async moveOne(id: string): Promise<Step> {
		const record = await this.tk.current.get(id).catch((error: unknown) => {
			// A task deleted while the worker ran is simply not there any more.
			if (error instanceof Error && error.name === 'TaskNotFoundError') return undefined;
			throw error;
		});
		if (record === undefined) {
			this.log('info', `task ${id} is no longer in "current": nothing to move`, 'gone', id);
			return { kind: 'gone' };
		}
		const cost = moveCost(record, this.tk.nextTraits);
		for (;;) {
			const wait = this.limiter.waitFor(cost);
			if (wait.ms === 0) break;
			this.bumpPause();
			this.log(
				'info',
				`rate pause of ${Math.ceil(wait.ms / 1000)} s: the ${wait.window ?? 'rate'} window is full (${this.limiter.used().requests} requests, ${this.limiter.used().writes} writes in the last minute)`,
				'rate-pause'
			);
			const interrupted = await this.pauseFor(
				wait.ms,
				'rate-pause',
				`the ${wait.window ?? 'rate'} window is full`
			);
			if (interrupted !== undefined) return interrupted;
		}
		this.limiter.record(cost);
		this.beat('moving', { task: id });

		let outcome;
		try {
			outcome = await this.tk.moves.moveTask(id, { acceptedLosses: this.accepted });
		} catch (error) {
			if (error instanceof RateLimitedError) return this.sideLimited(error);
			return this.failure(id, 'failed', errorText(error), hintOf(error));
		}
		switch (outcome.outcome) {
			case 'moved':
			case 'already-moved':
				this.consecutive = 0;
				if (outcome.outcome === 'moved') {
					this.movedHere++;
					this.patch(state => ({
						...state,
						counters: { ...state.counters, moved: state.counters.moved + 1 },
					}));
					this.log('info', `task ${id} moved to "new" as ${outcome.b}`, 'moved', id);
				}
				return { kind: 'moved' };
			case 'skipped-claimed': {
				this.patch(state => ({
					...state,
					counters: { ...state.counters, skippedClaimed: state.counters.skippedClaimed + 1 },
				}));
				this.log(
					'info',
					`task ${id} is claimed until ${outcome.leaseUntil}: left where it is for now`,
					'skipped-claimed',
					id
				);
				const until = Date.parse(outcome.leaseUntil);
				return {
					kind: 'retry',
					why: 'claimed',
					at: Number.isNaN(until) ? this.tk.now() + UNKNOWN_WAIT_MS : until,
					detail: `is claimed until ${outcome.leaseUntil}`,
				};
			}
			case 'deferred':
				this.patch(state => ({
					...state,
					counters: { ...state.counters, deferred: state.counters.deferred + 1 },
				}));
				this.log(
					'info',
					`task ${id} waits for ${outcome.waitingFor.join(', ')} to be moved first`,
					'deferred',
					id
				);
				return {
					kind: 'retry',
					why: 'deferred',
					at: this.tk.now(),
					detail: `waits for ${outcome.waitingFor.join(', ')}`,
				};
			case 'blocked-losses': {
				const text = outcome.losses.map(loss => `${loss.kind}: ${loss.text}`).join('; ');
				const step = this.failure(
					id,
					'blocked-losses',
					text,
					outcome.losses.map(loss => loss.fix).join('; '),
					true
				);
				return step;
			}
			case 'verify-failed':
				return this.failure(
					id,
					'verify-failed',
					`the copy read back differs: ${outcome.differences.join('; ')}`,
					undefined
				);
			case 'busy':
				return this.busy(id, outcome.reason);
		}
	}

	private bumpPause(): void {
		this.patch(state => ({ ...state, counters: { ...state.counters, ratePauses: state.counters.ratePauses + 1 } }));
	}

	private async sideLimited(error: RateLimitedError): Promise<Step> {
		const wait =
			error.retryAt === undefined ? UNKNOWN_WAIT_MS : Math.max(0, error.retryAt.getTime() - this.tk.now());
		this.bumpPause();
		this.log(
			'info',
			`rate pause of ${Math.ceil(wait / 1000)} s: the side's rate limit is reached${error.retryAt === undefined ? '' : ` until ${error.retryAt.toISOString()}`} (${error.hint})`,
			'rate-pause'
		);
		const interrupted = await this.pauseFor(wait, 'rate-pause', `the side's rate limit (${error.scope})`);
		return interrupted ?? { kind: 'again' };
	}

	private busy(id: string, reason: string): Step {
		const attempts = this.countAttempt(id);
		this.log(
			'info',
			`task ${id} is being changed by another process (${reason}); tried ${attempts} time(s)`,
			'busy',
			id
		);
		if (attempts >= this.opts.maxAttemptsPerTask) {
			this.park(id, `another process kept changing it (${reason})`);
			return { kind: 'parked' };
		}
		return {
			kind: 'retry',
			why: 'busy',
			at: this.tk.now() + BUSY_WAIT_MS,
			detail: `is being changed by another process`,
		};
	}

	private countAttempt(id: string): number {
		const attempts = (this.attempts.get(id) ?? 0) + 1;
		this.attempts.set(id, attempts);
		return attempts;
	}

	/** A task that could not be moved: recorded in the state and the log, retried until its attempts are used up, then parked. */
	private failure(id: string, kind: string, message: string, fix?: string, parkNow = false): Step {
		const attempts = this.countAttempt(id);
		this.consecutive++;
		this.patch(state =>
			withError(
				{ ...state, counters: { ...state.counters, failures: state.counters.failures + 1 } },
				{ at: this.iso(), task: id, kind, message, ...(fix === undefined ? {} : { fix }) }
			)
		);
		this.log('error', `task ${id}: ${kind}: ${message}${fix === undefined ? '' : ` (${fix})`}`, kind, id);
		if (parkNow || attempts >= this.opts.maxAttemptsPerTask) {
			this.park(id, parkNow ? `${kind}: ${message}` : `${attempts} attempts failed, last: ${message}`);
			return this.consecutive >= this.opts.maxConsecutiveFailures ? { kind: 'tripped' } : { kind: 'parked' };
		}
		if (this.consecutive >= this.opts.maxConsecutiveFailures) return { kind: 'tripped' };
		return { kind: 'retry', why: 'failed', at: this.tk.now(), detail: `failed: ${message}` };
	}
}
