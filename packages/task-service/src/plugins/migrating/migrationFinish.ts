// The two ways a migration ends: `finalize` (every task is in "new": the project switches to it alone) and `abort` (the project goes back to
// "current" alone). Both share the shape that makes them safe to repeat after a crash:
//   1. nothing that can be refused is done after something is written (the checks first, from the files, then from the stores for finalize),
//   2. what is about to happen is recorded in state.json BEFORE the project config is touched (fingerprints of the config before and after),
//   3. the config switch is the one step that changes what the project means; it is atomic (the host's writer) and keeps a backup,
//   4. the state moves to `finished` / `aborted` last. A process that dies between 3 and 4 is recognised by the fingerprints, and the
//      next run only completes the bookkeeping: it opens no side, creates nothing, and never switches twice.
// Nothing here deletes a task, a copy, a file of "current" or a file of "new": what stays behind is listed. The project config is a file
// of the host, so the plugin never reads it: the host gives a `ConfigSwitch` (fingerprints and the one `apply`).
import * as path from 'node:path';

import { BackendDataError, BackendRejectedError } from '@wadeck-app/task-core';

import { listIds, verifyStores } from './finalizeVerify.js';
import { liveWorker, readIndexRows } from './migrationControl.js';
import type { ControlInput } from './migrationControl.js';
import { MigrationJournal } from './migrationJournal.js';
import { LOCK_FILE, MigrationStateStore } from './migrationState.js';
import type { AbortRecord, AbortedTask, MigrationState } from './migrationState.js';
import type { MigrationToolkit } from './migrationToolkit.js';
import { WorkerLock } from './workerLock.js';

/** What the plugin needs to know about the project config: whether it is as it was, as it will be, and how to replace it. */
export interface ConfigSwitch {
	/** Fingerprint of the config as it is NOW (read at every call). `absent` when the project has no config file. */
	current(): string;
	/** The fingerprint of the config the host found when it prepared the switch, and of the one `apply` writes. */
	original: string;
	target: string;
	/**
	 * Keeps the old config next to the new one and replaces it, atomically. Calls `markStarted(true)` right BEFORE the write (a failure
	 * of that call must stop the switch) and `markStarted(false)` when the write failed and left the old config in place.
	 */
	apply(markStarted: (started: boolean) => void): { config: string; backup?: string };
}

export interface Blocker {
	text: string;
	fix: string;
	/** The tasks concerned (the first ones). */
	ids?: string[];
}

export interface FinalizeOutcome {
	outcome: 'finished' | 'already-finished' | 'bookkeeping-completed';
	/** Tasks that were copied out of "current" and tasks created in "new" while the migration ran. */
	moved: number;
	madeInNew: number;
	idMap: { file: string; entries: number; changed: number };
	/** The summary event is due: the caller raises it (once: the state records that it was handed over). */
	eventDue: boolean;
	config?: string;
	backup?: string;
	notes: string[];
	warnings: string[];
}

export interface AbortOutcome {
	outcome: 'aborted' | 'already-aborted' | 'bookkeeping-completed';
	keepMoved: boolean;
	leftovers: AbortedTask[];
	moved: Array<AbortedTask & { madeInNew: boolean }>;
	unsettled: Array<{ task: string; op: string }>;
	config?: string;
	backup?: string;
	notes: string[];
	warnings: string[];
}

export type FinalizeStage =
	{ kind: 'already-finished'; outcome: FinalizeOutcome } | { kind: 'interrupted' } | { kind: 'verify' };

export type AbortStage = { kind: 'already-aborted'; outcome: AbortOutcome } | { kind: 'interrupted' } | { kind: 'run' };

export interface AbortOptions {
	/** Allow tasks whose truth is in "new" (they stay there, listed, and stop being part of the project). */
	keepMoved: boolean;
	switch: ConfigSwitch;
	sleep: (ms: number) => Promise<void>;
	/** How long to wait for a worker that was asked to stop. */
	waitMs: number;
}

const STATUS_COMMAND = 'task strategy migrate status';
const FINALIZE_COMMAND = 'task strategy migrate finalize';
const ABORT_COMMAND = 'task strategy migrate abort';
const ID_MAP_FILE = 'idmap.json';

function controlOf(toolkit: MigrationToolkit): ControlInput {
	return {
		dir: toolkit.dir,
		files: toolkit.files,
		now: toolkit.now,
		isAlive: toolkit.isAlive,
		host: toolkit.host,
		pid: toolkit.pid,
	};
}

const storeOf = (input: ControlInput): MigrationStateStore =>
	new MigrationStateStore({ dir: input.dir, files: input.files, now: input.now });

const iso = (input: ControlInput): string => new Date(input.now()).toISOString();
const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** One refusal for several blockers: every one with its tasks in the message, every fix in the hint. Nothing was changed. */
function refusal(operation: string, blockers: readonly Blocker[]): BackendRejectedError {
	const many = blockers.length > 1;
	const message = `${operation} refused: ${blockers.map((blocker, index) => `${many ? `(${index + 1}) ` : ''}${blocker.text}`).join('. ')}. Nothing was changed.`;
	const hint = blockers.map((blocker, index) => `${many ? `(${index + 1}) ` : ''}${blocker.fix}`).join(' ');
	return new BackendRejectedError('migrating', operation, message, hint);
}

function requireState(input: ControlInput, operation: string): MigrationState {
	const state = storeOf(input).readState();
	if (state === undefined) {
		throw new BackendRejectedError(
			'migrating',
			operation,
			`${operation} refused: no migration was started in this project. Nothing was changed.`,
			'Plan one with: task strategy migrate start --dry-run, then start it with: task strategy migrate start'
		);
	}
	return state;
}

function lockOf(input: ControlInput): WorkerLock {
	return new WorkerLock({
		file: path.join(input.dir, LOCK_FILE),
		files: input.files,
		pid: input.pid ?? process.pid,
		host: input.host,
		now: input.now,
		isAlive: input.isAlive,
	});
}

const journalOf = (input: ControlInput): MigrationJournal =>
	new MigrationJournal({ dir: input.dir, files: input.files });

/**
 * What stops a finalize, from the files alone (state, worker lock, routing index, write-ahead log). `underLock`: the caller holds the
 * worker lock itself, so the lock being held is no worker.
 */
export function finalizeBlockers(input: ControlInput, state: MigrationState, underLock = false): Blocker[] {
	const blockers: Blocker[] = [];
	const worker = liveWorker(input);
	if (!underLock && worker.alive && worker.holder !== undefined) {
		blockers.push({
			text: `a worker is running (pid ${worker.holder.pid}${worker.otherHost ? ` on ${worker.holder.host}` : ''})`,
			fix: `Wait for it to end by itself (see: ${STATUS_COMMAND}), or stop it with: task strategy migrate pause, then run: ${FINALIZE_COMMAND}`,
		});
	}
	switch (state.status) {
		case 'ready-to-finalize':
		case 'finished':
			break;
		case 'running':
			blockers.push({
				text: 'the migration is still running: tasks are still being moved',
				fix: `Wait until ${STATUS_COMMAND} says ready-to-finalize (follow it with: task strategy migrate log --follow), then run: ${FINALIZE_COMMAND}`,
			});
			break;
		case 'paused':
			blockers.push({
				text: 'the migration is paused: tasks are left to move',
				fix: `Continue it with: task strategy migrate resume, wait for ready-to-finalize, then run: ${FINALIZE_COMMAND}`,
			});
			break;
		case 'stopped':
			blockers.push({
				text: `the worker stopped before every task was moved${state.stop === undefined ? '' : ` (${state.stop.text})`}`,
				fix:
					state.stop?.fix ??
					`See why with: ${STATUS_COMMAND}, then continue with: task strategy migrate resume`,
			});
			break;
		case 'aborted':
			blockers.push({
				text: 'the migration was aborted: the project uses its "current" strategy again',
				fix: `There is nothing to finalize. See the notes of: ${STATUS_COMMAND}`,
			});
			break;
	}
	const rows = readIndexRows(input);
	const waiting = rows.filter(row => row.state === 'in-a').map(row => row.publicId);
	const moving = rows.filter(row => row.state === 'moving').map(row => row.publicId);
	if (waiting.length > 0) {
		blockers.push({
			text: `${waiting.length} task(s) are still in "current": ${listIds(waiting)}`,
			fix: `Move them with: task strategy migrate resume, then run: ${FINALIZE_COMMAND}`,
		});
	}
	if (moving.length > 0) {
		blockers.push({
			text: `${moving.length} task(s) are being moved (their copy in "new" is not the truth yet): ${listIds(moving)}`,
			fix: `Let the worker end the move: task strategy migrate resume, then run: ${FINALIZE_COMMAND}`,
		});
	}
	const open = journalOf(input).openTransactions({ readOnly: true });
	if (open.length > 0) {
		blockers.push({
			text: `${open.length} unfinished transaction(s) in the write-ahead log (${listIds(open.map(tx => `${tx.op} ${tx.task === '' ? '(creation)' : tx.task}`))})`,
			fix: `Open the project once so the recovery settles them (any task command, or: task strategy check), read what it did with: task strategy migrate log, then run: ${FINALIZE_COMMAND}`,
		});
	}
	return blockers;
}

function idMapWarnings(file: string, changed: number): string[] {
	return changed === 0
		? []
		: [
				`${changed} task(s) have a new id: the old id no longer resolves (\`task show <old id>\` says it is not found), because the project now reads "new" alone. The map old id -> new id is in ${file}.`,
			];
}

function finalizeOutcomeOf(
	input: ControlInput,
	state: MigrationState,
	outcome: FinalizeOutcome['outcome'],
	eventDue: boolean
): FinalizeOutcome {
	const record = state.finalize;
	const idMapFile = record?.idMapFile ?? path.join(input.dir, ID_MAP_FILE);
	let entries = 0;
	let changed = 0;
	const text = input.files.read(idMapFile);
	if (text !== undefined) {
		try {
			const map = JSON.parse(text) as Array<{ from: string; to: string }>;
			entries = map.length;
			changed = map.filter(entry => entry.from !== entry.to).length;
		} catch {
			// A damaged id map is reported by whoever needs it; the outcome only counts what it can read.
		}
	}
	return {
		outcome,
		moved: record?.moved ?? 0,
		madeInNew: record?.madeInNew ?? 0,
		idMap: { file: idMapFile, entries, changed },
		eventDue,
		notes: [],
		warnings: idMapWarnings(idMapFile, changed),
	};
}

/** What a `finalize` should do now, from the files and the fingerprint of the project config (no side is opened). */
export function finalizeStage(input: ControlInput, currentConfig: string): FinalizeStage {
	const state = requireState(input, 'finalize');
	if (state.status === 'finished') {
		return { kind: 'already-finished', outcome: finalizeOutcomeOf(input, state, 'already-finished', false) };
	}
	if (state.finalize?.switchStarted === true && state.finalize.target === currentConfig)
		return { kind: 'interrupted' };
	if (state.abort?.switchStarted === true && state.abort.target === currentConfig && state.status !== 'aborted') {
		throw refusal('finalize', [
			{
				text: 'an abort was interrupted after it switched the project config back to "current"',
				fix: `Complete it with: ${ABORT_COMMAND} (it only completes the bookkeeping)`,
			},
		]);
	}
	const blockers = finalizeBlockers(input, state);
	if (blockers.length > 0) throw refusal('finalize', blockers);
	return { kind: 'verify' };
}

/** A failed save of the state is told with the file and the fix; a BackendDataError (damaged file) is already told. */
function saveState(
	store: MigrationStateStore,
	change: (state: MigrationState) => MigrationState,
	what: string,
	hint: string
): void {
	try {
		store.updateState(change);
	} catch (error) {
		if (error instanceof BackendDataError) throw error;
		throw new BackendDataError(
			'migrating',
			store.stateFile,
			`${store.stateFile}: cannot save ${what}: ${errorText(error)}`,
			hint
		);
	}
}

function assertConfigUnchanged(config: ConfigSwitch): void {
	const now = config.current();
	if (now !== config.original && now !== config.target) {
		throw refusal('finalize', [
			{
				text: 'the project config changed since it was read for the switch (somebody edited it): replacing it now would overwrite that change',
				fix: `Review the change, then run: ${FINALIZE_COMMAND}. The config is untouched.`,
			},
		]);
	}
}

export async function finalizeMigration(toolkit: MigrationToolkit, config: ConfigSwitch): Promise<FinalizeOutcome> {
	const input = controlOf(toolkit);
	const store = storeOf(input);
	const log = (level: 'info' | 'warn' | 'error', message: string, outcome: string): void =>
		toolkit.journal.info(level, message, { step: 'finalize', outcome });

	const first = requireState(input, 'finalize');
	if (first.status === 'finished') {
		throw refusal('finalize', [
			{
				text: 'the migration is already finished',
				fix: 'Nothing to do: the project uses the new strategy alone.',
			},
		]);
	}
	const early = finalizeBlockers(input, first);
	if (early.length > 0) throw refusal('finalize', early);
	assertConfigUnchanged(config);

	// One worker, one finalize: the lock is also what keeps a worker from starting while the stores are being compared.
	const lock = lockOf(input);
	lock.acquire();
	try {
		const state = requireState(input, 'finalize');
		const again = finalizeBlockers(input, state, true);
		if (again.length > 0) throw refusal('finalize', again);

		log('info', 'finalize: verifying the stores (index, copies in "new", tasks in "current")', 'verifying');
		const verified = await verifyStores(toolkit);
		if (verified.blockers.length > 0) {
			log(
				'warn',
				`finalize refused by the verification: ${verified.blockers.map(blocker => blocker.text).join('; ')}`,
				'refused'
			);
			throw refusal('finalize', verified.blockers);
		}
		log('info', `verified: ${verified.moved} moved task(s), ${verified.madeInNew} made in "new"`, 'verified');

		// The old ids, before anything changes: a crash after the switch must still find them.
		const idMapFile = path.join(toolkit.dir, ID_MAP_FILE);
		try {
			toolkit.files.ensureDir(toolkit.dir);
			toolkit.files.replace(idMapFile, `${JSON.stringify(verified.map, null, 2)}\n`);
		} catch (error) {
			log('error', `finalize: the id map cannot be written: ${errorText(error)}`, 'idmap-failed');
			throw new BackendDataError(
				'migrating',
				idMapFile,
				`${idMapFile}: cannot write the id map (old id -> new id): ${errorText(error)}`,
				'Make the data folder writable and have free space, then run finalize again. The project config was not touched.'
			);
		}

		// Write-ahead: what is about to happen, before the config is touched.
		const startedAt = iso(input);
		saveState(
			store,
			current => ({
				...current,
				finalize: {
					startedAt,
					original: config.original,
					target: config.target,
					switchStarted: false,
					moved: verified.moved,
					madeInNew: verified.madeInNew,
					idMapFile,
				},
			}),
			'the record of the finalize that is about to switch the project config',
			'Make the data folder writable and have free space, then run finalize again. The project config was not touched.'
		);
		log('info', `finalize recorded: config ${config.original} -> ${config.target}`, 'recorded');

		assertConfigUnchanged(config);
		const applied: { config?: string; backup?: string } = {};
		if (config.current() === config.target) {
			log('warn', 'the project config already is the new one: nothing to write', 'config-already');
		} else {
			const result = config.apply(started => {
				if (started) {
					saveState(
						store,
						current => ({ ...current, finalize: { ...current.finalize!, switchStarted: true } }),
						'the mark "the config switch begins"',
						'Make the data folder writable, then run finalize again. The project config was not touched.'
					);
				} else {
					try {
						store.updateState(current => ({
							...current,
							finalize: { ...current.finalize!, switchStarted: false },
						}));
					} catch (error) {
						log(
							'warn',
							`the state could not record that the switch failed: ${errorText(error)}`,
							'state-not-reset'
						);
					}
				}
			});
			applied.config = result.config;
			if (result.backup !== undefined) applied.backup = result.backup;
		}
		log(
			'info',
			`project config switched${applied.config === undefined ? '' : `: ${applied.config}`}${applied.backup === undefined ? '' : ` (the old one is kept as ${applied.backup})`}`,
			'switched'
		);

		try {
			store.updateState(current => ({
				...current,
				status: 'finished',
				statusSince: iso(input),
				finalize: { ...current.finalize!, switchStarted: true, summaryEventRaised: true },
			}));
		} catch (error) {
			log(
				'error',
				`the config was switched but the state could not be updated: ${errorText(error)}`,
				'state-not-updated'
			);
			throw new BackendDataError(
				'migrating',
				store.stateFile,
				`${store.stateFile}: the project config was switched${applied.config === undefined ? '' : ` (${applied.config})`}, but the migration state could not be updated: ${errorText(error)}`,
				`Nothing is lost: the project already uses the new strategy. Run ${FINALIZE_COMMAND} again once the data folder is writable: it only completes the bookkeeping (no store is opened).`
			);
		}
		log(
			'info',
			`migration finished: ${verified.moved} moved, ${verified.madeInNew} made in "new"; id map in ${idMapFile}`,
			'finished'
		);
		const changed = verified.map.filter(entry => entry.from !== entry.to).length;
		return {
			outcome: 'finished',
			moved: verified.moved,
			madeInNew: verified.madeInNew,
			idMap: { file: idMapFile, entries: verified.map.length, changed },
			eventDue: true,
			...(applied.config === undefined ? {} : { config: applied.config }),
			...(applied.backup === undefined ? {} : { backup: applied.backup }),
			notes: verified.notes,
			warnings: idMapWarnings(idMapFile, changed),
		};
	} finally {
		lock.release();
	}
}

/** The run that switched the config and died before saying so: only the bookkeeping is left. No side is opened, nothing is created. */
export function completeFinalize(input: ControlInput, currentConfig: string): FinalizeOutcome {
	const state = requireState(input, 'finalize');
	const record = state.finalize;
	if (record?.switchStarted !== true || record.target !== currentConfig) {
		throw refusal('finalize', [
			{
				text: 'the migration state does not say that a config switch was under way, or the project config is not the one it was going to write',
				fix: `Run: ${FINALIZE_COMMAND} (it verifies everything again)`,
			},
		]);
	}
	const store = storeOf(input);
	const lock = lockOf(input);
	lock.acquire();
	try {
		const eventDue = record.summaryEventRaised !== true;
		saveState(
			store,
			current => ({
				...current,
				status: 'finished',
				statusSince: iso(input),
				finalize: { ...current.finalize!, summaryEventRaised: true },
			}),
			'the end of the migration',
			'Make the data folder writable, then run finalize again.'
		);
		journalOf(input).info(
			'info',
			'finalize: the project config already was the new one (a run stopped right after writing it): the migration is marked finished, no store was opened',
			{ step: 'finalize', outcome: 'bookkeeping-completed' }
		);
		const outcome = finalizeOutcomeOf(input, { ...state, status: 'finished' }, 'bookkeeping-completed', eventDue);
		return {
			...outcome,
			notes: [
				'the project config already was the new one: only the bookkeeping was completed (no store was opened, nothing was created or verified again)',
			],
		};
	} finally {
		lock.release();
	}
}

// ---- abort ----

function abortWarnings(record: AbortRecord): string[] {
	const warnings: string[] = [];
	if (record.moved.length > 0) {
		const made = record.moved.filter(task => task.madeInNew);
		const kept = record.moved.filter(task => !task.madeInNew);
		warnings.push(
			`${record.moved.length} task(s) have their truth in "new" and STAY there (not deleted): they are no longer part of this project. ${
				made.length === 0
					? ''
					: `${made.length} were created in "new" and are not visible in the project at all (${listIds(made.map(task => `${task.task} = ${task.copy}`))}). `
			}${
				kept.length === 0
					? ''
					: `${kept.length} were moved and now show their older copy kept in "current", WITHOUT the changes made in "new" since the move (${listIds(kept.map(task => `${task.task} -> ${task.copy}`))}). `
			}The full list is in state.json under "abort.moved".`
		);
	}
	if (record.leftovers.length > 0) {
		warnings.push(
			`${record.leftovers.length} copy(ies) in "new" of tasks that were being moved are left there, NOT deleted: ${listIds(record.leftovers.map(task => `${task.task} -> ${task.copy}`))}. "current" is the truth of those tasks; remove the copies by hand when you do not need them.`
		);
	}
	if (record.unsettled.length > 0) {
		warnings.push(
			`${record.unsettled.length} unfinished transaction(s) were open (${listIds(record.unsettled.map(tx => `${tx.op} ${tx.task === '' ? '(creation)' : tx.task}`))}): a copy may exist in "new" that the index does not list. Nothing was deleted.`
		);
	}
	return warnings;
}

function abortOutcomeOf(state: MigrationState, outcome: AbortOutcome['outcome']): AbortOutcome {
	const record = state.abort;
	return {
		outcome,
		keepMoved: record?.keepMoved ?? false,
		leftovers: record?.leftovers ?? [],
		moved: record?.moved ?? [],
		unsettled: record?.unsettled ?? [],
		notes: [],
		warnings: record === undefined ? [] : abortWarnings(record),
	};
}

/** What an `abort` should do now, from the files and the fingerprint of the project config (no side is opened). */
export function abortStage(input: ControlInput, currentConfig: string): AbortStage {
	const state = requireState(input, 'abort');
	if (state.status === 'aborted')
		return { kind: 'already-aborted', outcome: abortOutcomeOf(state, 'already-aborted') };
	if (state.status === 'finished') {
		throw refusal('abort', [
			{
				text: 'the migration is finished: the project already uses the new strategy alone',
				fix: 'To go back anyway, put the backup of the project config back (config.yml.before-migration next to config.yml). Tasks changed or created in "new" since are NOT in "current".',
			},
		]);
	}
	if (state.finalize?.switchStarted === true && state.finalize.target === currentConfig) {
		throw refusal('abort', [
			{
				text: 'a finalize was interrupted after it switched the project config to the new strategy',
				fix: `Complete it with: ${FINALIZE_COMMAND} (it only completes the bookkeeping). To go back instead, put the backup of the project config back (config.yml.before-migration).`,
			},
		]);
	}
	if (state.abort?.switchStarted === true && state.abort.target === currentConfig) return { kind: 'interrupted' };
	return { kind: 'run' };
}

async function waitForWorkerToStop(
	input: ControlInput,
	options: { sleep: (ms: number) => Promise<void>; waitMs: number }
): Promise<boolean> {
	let waited = 0;
	for (;;) {
		if (!liveWorker(input).alive) return true;
		if (waited >= options.waitMs) return false;
		const step = Math.min(1000, options.waitMs - waited);
		await options.sleep(step);
		waited += step;
	}
}

function keepMovedBlocker(moved: readonly string[]): Blocker {
	return {
		text: `${moved.length} task(s) already live in "new" (their truth is there, not in "current"): ${listIds(moved)}. Going back to "current" would hide the changes made to them since, and the tasks created in "new"`,
		fix: `Either finish the migration (task strategy migrate resume, then ${FINALIZE_COMMAND}), or abort and leave those tasks in "new" (they stop being part of this project, nothing is deleted): ${ABORT_COMMAND} --keep-moved`,
	};
}

export async function abortMigration(input: ControlInput, options: AbortOptions): Promise<AbortOutcome> {
	const store = storeOf(input);
	const journal = journalOf(input);
	const log = (level: 'info' | 'warn' | 'error', message: string, outcome: string): void =>
		journal.info(level, message, { step: 'abort', outcome });
	const config = options.switch;
	const unchanged = (): void => {
		const now = config.current();
		if (now !== config.original && now !== config.target) {
			throw refusal('abort', [
				{
					text: 'the project config changed since it was read for the switch (somebody edited it): replacing it now would overwrite that change',
					fix: `Review the change, then run: ${ABORT_COMMAND}. The config is untouched.`,
				},
			]);
		}
	};

	const state = requireState(input, 'abort');
	if (state.status === 'aborted' || state.status === 'finished') {
		throw abortStageError(input, config.current());
	}
	unchanged();

	// What cannot be done is refused BEFORE the worker is touched.
	const inNew = (): string[] =>
		readIndexRows(input)
			.filter(row => row.state === 'in-b')
			.map(row => row.publicId);
	if (!options.keepMoved && inNew().length > 0) throw refusal('abort', [keepMovedBlocker(inNew())]);

	const worker = liveWorker(input);
	if (worker.alive && worker.holder !== undefined) {
		if (worker.otherHost) {
			throw refusal('abort', [
				{
					text: `a worker holds the lock on another computer (${worker.holder.host}, pid ${worker.holder.pid}): task cannot stop it from here`,
					fix: `Stop it there (task strategy migrate pause, run on that computer), then run: ${ABORT_COMMAND}`,
				},
			]);
		}
		store.writeControl('stop');
		log('info', `abort: the worker (pid ${worker.holder.pid}) was asked to stop`, 'stop-requested');
		if (!(await waitForWorkerToStop(input, options))) {
			log(
				'warn',
				`abort: the worker (pid ${worker.holder.pid}) did not stop within ${options.waitMs / 1000} s`,
				'worker-still-running'
			);
			throw refusal('abort', [
				{
					text: `the worker (pid ${worker.holder.pid}) did not stop within ${Math.round(options.waitMs / 1000)} s: it ends the task it is moving first, which can take a while on a slow side`,
					fix: `The stop request stays: wait for the worker to end (see: ${STATUS_COMMAND}), then run: ${ABORT_COMMAND} again`,
				},
			]);
		}
	}

	const lock = lockOf(input);
	lock.acquire();
	try {
		// The worker may have finished a move while it was stopping: what was refused or allowed above is judged again on what is there now.
		const rows = readIndexRows(input);
		const moved = rows
			.filter(row => row.state === 'in-b')
			.map(row => ({ task: row.publicId, copy: row.b!, madeInNew: row.a === undefined }));
		if (!options.keepMoved && moved.length > 0) {
			throw refusal('abort', [keepMovedBlocker(moved.map(task => task.task))]);
		}
		const leftovers = rows
			.filter(row => row.state === 'moving' && row.b !== undefined)
			.map(row => ({ task: row.publicId, copy: row.b! }));
		const unsettled = journal.openTransactions({ readOnly: true }).map(tx => ({ task: tx.task, op: tx.op }));
		unchanged();

		const record: AbortRecord = {
			startedAt: iso(input),
			keepMoved: options.keepMoved,
			original: config.original,
			target: config.target,
			switchStarted: false,
			leftovers,
			moved,
			unsettled,
		};
		saveState(
			store,
			current => ({ ...current, abort: record }),
			'the record of the abort that is about to switch the project config',
			'Make the data folder writable and have free space, then run abort again. The project config was not touched.'
		);
		log(
			'info',
			`abort recorded: ${leftovers.length} copy(ies) left in "new", ${moved.length} task(s) kept in "new"${unsettled.length === 0 ? '' : `, ${unsettled.length} open transaction(s)`}; config ${config.original} -> ${config.target}`,
			'recorded'
		);

		const applied: { config?: string; backup?: string } = {};
		if (config.current() === config.target) {
			log('warn', 'the project config already is the old one: nothing to write', 'config-already');
		} else {
			const result = config.apply(started => {
				if (started) {
					saveState(
						store,
						current => ({ ...current, abort: { ...current.abort!, switchStarted: true } }),
						'the mark "the config switch begins"',
						'Make the data folder writable, then run abort again. The project config was not touched.'
					);
				} else {
					try {
						store.updateState(current => ({
							...current,
							abort: { ...current.abort!, switchStarted: false },
						}));
					} catch (error) {
						log(
							'warn',
							`the state could not record that the switch failed: ${errorText(error)}`,
							'state-not-reset'
						);
					}
				}
			});
			applied.config = result.config;
			if (result.backup !== undefined) applied.backup = result.backup;
		}
		log(
			'info',
			`project config switched back to "current"${applied.config === undefined ? '' : `: ${applied.config}`}${applied.backup === undefined ? '' : ` (the config it replaced is kept as ${applied.backup})`}`,
			'switched'
		);

		try {
			store.updateState(current => {
				const { stop: _stop, ...rest } = current;
				void _stop;
				return {
					...rest,
					status: 'aborted',
					statusSince: iso(input),
					abort: { ...current.abort!, switchStarted: true },
				};
			});
		} catch (error) {
			log(
				'error',
				`the config was switched but the state could not be updated: ${errorText(error)}`,
				'state-not-updated'
			);
			throw new BackendDataError(
				'migrating',
				store.stateFile,
				`${store.stateFile}: the project config was switched back to "current"${applied.config === undefined ? '' : ` (${applied.config})`}, but the migration state could not be updated: ${errorText(error)}`,
				`Nothing is lost: the project already uses "current". Run ${ABORT_COMMAND} again once the data folder is writable: it only completes the bookkeeping (no store is opened).`
			);
		}
		log('info', 'migration aborted: "current" is the truth again; nothing was deleted', 'aborted');
		const final = { ...record, switchStarted: true };
		return {
			outcome: 'aborted',
			keepMoved: options.keepMoved,
			leftovers,
			moved,
			unsettled,
			...(applied.config === undefined ? {} : { config: applied.config }),
			...(applied.backup === undefined ? {} : { backup: applied.backup }),
			notes: [],
			warnings: abortWarnings(final),
		};
	} finally {
		lock.release();
	}
}

/** `abortMigration` called on a migration that already ended: the refusal `abortStage` gives. */
function abortStageError(input: ControlInput, currentConfig: string): BackendRejectedError {
	try {
		const stage = abortStage(input, currentConfig);
		return refusal('abort', [
			{
				text: `the migration is already ${stage.kind === 'already-aborted' ? 'aborted' : 'ended'}`,
				fix: 'Nothing to do.',
			},
		]);
	} catch (error) {
		return error as BackendRejectedError;
	}
}

/** The run that switched the config back and died before saying so: only the bookkeeping is left. No side is opened. */
export function completeAbort(input: ControlInput, currentConfig: string): AbortOutcome {
	const state = requireState(input, 'abort');
	const record = state.abort;
	if (record?.switchStarted !== true || record.target !== currentConfig) {
		throw refusal('abort', [
			{
				text: 'the migration state does not say that a config switch was under way, or the project config is not the one it was going to write',
				fix: `Run: ${ABORT_COMMAND} (it checks everything again)`,
			},
		]);
	}
	const store = storeOf(input);
	const lock = lockOf(input);
	lock.acquire();
	try {
		saveState(
			store,
			current => {
				const { stop: _stop, ...rest } = current;
				void _stop;
				return { ...rest, status: 'aborted', statusSince: iso(input) };
			},
			'the end of the abort',
			'Make the data folder writable, then run abort again.'
		);
		journalOf(input).info(
			'info',
			'abort: the project config already was the old one (a run stopped right after writing it): the migration is marked aborted, no store was opened',
			{ step: 'abort', outcome: 'bookkeeping-completed' }
		);
		return {
			...abortOutcomeOf({ ...state, status: 'aborted' }, 'bookkeeping-completed'),
			notes: [
				'the project config already was the old one: only the bookkeeping was completed (no store was opened, nothing was deleted)',
			],
		};
	} finally {
		lock.release();
	}
}
