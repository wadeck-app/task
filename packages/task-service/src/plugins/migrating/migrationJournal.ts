// The write-ahead log and the log of a migration, both under `<data dir>/migrating/`.
//
//  - `wal.ndjson` is the protocol: a transaction (a move, a write to a task that is moving, a creation, a deletion, a catch-up) writes
//    `begin`, then for every step an `intent` BEFORE it applies the step and a `done` (or `failed`) after, then `end`. Every line is made
//    durable before the call returns, and a line that cannot be written stops the operation BEFORE the step it describes, so nothing is
//    applied that the log does not know. After a crash, the transactions that began and never ended are what recovery reads
//    (walRecovery.ts); every step is idempotent, so replaying a step is safe.
//  - `log.ndjson` is for people (`task strategy migrate log`, a support request): the same transitions with a sentence, plus notes that
//    are not steps (a task skipped because it is claimed, what a recovery did). It never stops an operation: a line that cannot be
//    written is reported once to the task log and the work goes on, since the write-ahead log is the one that protects the data.
//
// The write-ahead log is emptied (atomically) when it is opened with no transaction in flight; the human log only grows.
import * as crypto from 'node:crypto';
import * as path from 'node:path';

import { BackendDataError } from '@wadeck-app/task-core';

/** The file system under the journal; every method may throw, nothing is swallowed here. */
export interface WalFiles {
	/** Appends complete lines and makes them durable (flushed to the disk) before it returns. */
	append(file: string, text: string): void;
	/** The text of the file, or `undefined` when it does not exist (any other failure throws). */
	read(file: string): string | undefined;
	/** Creates the folder (and its parents) when missing. */
	ensureDir(dir: string): void;
	/** Replaces the whole file atomically (temp file and rename). */
	replace(file: string, text: string): void;
}

export const TX_OPS = ['move', 'write', 'create', 'delete', 'catch-up', 'cleanup'] as const;
export type TxOp = (typeof TX_OPS)[number];
export type JournalSide = 'current' | 'new' | 'index';
export type StepPhase = 'intent' | 'done' | 'failed';
export type LogLevel = 'info' | 'warn' | 'error';
export type EntryData = Record<string, string | number | boolean>;

export interface WalEntry {
	/** Counts the lines one process wrote, from where the file stopped; the ORDER of the file is the order of events. */
	seq: number;
	at: string;
	tx: string;
	/** The public id of the task ('' when it has none yet: a creation). */
	task: string;
	op: TxOp;
	event: 'begin' | 'step' | 'end';
	step?: string;
	side?: JournalSide;
	phase?: StepPhase;
	/** `end` only: how it ended (`ok`, `failed`, `skipped-claimed`...). */
	outcome?: string;
	error?: string;
	data?: EntryData;
}

/** A transaction that began and did not end: what recovery has to settle. */
export class OpenTx {
	constructor(
		readonly tx: string,
		readonly op: TxOp,
		readonly task: string,
		readonly begin: WalEntry,
		readonly steps: readonly WalEntry[]
	) {}

	/** The `done` line of a step, `undefined` when it did not get that far. */
	done(step: string): WalEntry | undefined {
		return this.steps.find(entry => entry.step === step && entry.phase === 'done');
	}

	/** True when the step was begun (its `intent` is logged), whether or not it was finished. */
	attempted(step: string): boolean {
		return this.steps.some(entry => entry.step === step);
	}

	failed(step: string): WalEntry | undefined {
		return this.steps.find(entry => entry.step === step && entry.phase === 'failed');
	}

	/** The data of the begin line and of every step line, later ones winning. */
	get data(): EntryData {
		return Object.assign({}, this.begin.data, ...this.steps.map(entry => entry.data ?? {}));
	}
}

export interface JournalInput {
	/** `<data dir>/migrating`. */
	dir: string;
	files: WalFiles;
	/** ISO instant. Tests drive it. */
	now?: () => string;
	/** A new transaction id. Tests drive it. */
	newTx?: () => string;
	/** Told when the human log cannot be written (each distinct text once). Default: nothing is told (the owner passes the task log). */
	onLogProblem?: (text: string) => void;
}

const HINT_WAL =
	'Nothing was changed by this attempt (the step was not started). Make the data folder writable and have free space, then run the command again. Do not delete the file: it is how a crash is recovered.';

const OPS: readonly string[] = TX_OPS;

function problem(file: string, text: string, hint: string = HINT_WAL): BackendDataError {
	return new BackendDataError('migrating', file, `${file}: ${text}`, hint);
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function describeEntry(entry: WalEntry): string {
	const what = entry.step ?? entry.event;
	const side = entry.side === undefined ? '' : ` on ${entry.side}`;
	const result = entry.phase ?? entry.outcome ?? '';
	const subject = entry.task === '' ? entry.op : `${entry.op} ${entry.task}`;
	return `${subject}: ${what}${side}${result === '' ? '' : `: ${result}`}${entry.error === undefined ? '' : ` (${entry.error})`}`;
}

/** One transaction in flight: every call is written to the write-ahead log (and the human log) before it returns. */
export class JournalTx {
	constructor(
		private readonly journal: MigrationJournal,
		readonly id: string,
		readonly op: TxOp,
		private task: string
	) {}

	get taskId(): string {
		return this.task;
	}

	/** A creation learns the id of its task late: the lines that follow carry it. */
	setTask(task: string): void {
		this.task = task;
	}

	/** Logs a step. An `intent` goes BEFORE the step is applied; a failure to write it throws and the step must not run. */
	step(step: string, side: JournalSide, phase: StepPhase, data?: EntryData, error?: unknown): void {
		this.journal.write({
			tx: this.id,
			task: this.task,
			op: this.op,
			event: 'step',
			step,
			side,
			phase,
			...(data === undefined ? {} : { data }),
			...(error === undefined ? {} : { error: errorText(error) }),
		});
	}

	/** Like {@link step}, for the lines written after something was applied: a failure is reported and never thrown (the change stands). */
	stepAfterApply(step: string, side: JournalSide, phase: StepPhase, data?: EntryData, error?: unknown): boolean {
		try {
			this.step(step, side, phase, data, error);
			return true;
		} catch (failure) {
			this.journal.info(
				'error',
				`the log line of ${this.op} ${this.task} ${step} could not be written: ${errorText(failure)}`,
				{
					task: this.task,
					tx: this.id,
					op: this.op,
					step,
					side,
					phase,
				}
			);
			return false;
		}
	}

	end(outcome: string, error?: unknown): void {
		this.journal.write({
			tx: this.id,
			task: this.task,
			op: this.op,
			event: 'end',
			outcome,
			...(error === undefined ? {} : { error: errorText(error) }),
		});
	}

	endAfterApply(outcome: string, error?: unknown): boolean {
		try {
			this.end(outcome, error);
			return true;
		} catch (failure) {
			this.journal.info(
				'error',
				`the end of ${this.op} ${this.task} could not be logged: ${errorText(failure)}`,
				{
					task: this.task,
					tx: this.id,
					op: this.op,
					outcome,
				}
			);
			return false;
		}
	}
}

export class MigrationJournal {
	readonly walFile: string;
	readonly logFile: string;
	private readonly files: WalFiles;
	private readonly now: () => string;
	private readonly newTx: () => string;
	private readonly onLogProblem: (text: string) => void;
	private readonly reported = new Set<string>();
	private seq: number | undefined;
	private dirReady = false;

	constructor(input: JournalInput) {
		this.walFile = path.join(input.dir, 'wal.ndjson');
		this.logFile = path.join(input.dir, 'log.ndjson');
		this.files = input.files;
		this.now = input.now ?? ((): string => new Date().toISOString());
		this.newTx = input.newTx ?? ((): string => crypto.randomUUID());
		this.onLogProblem = input.onLogProblem ?? ((): void => undefined);
	}

	/** Begins a transaction. The line is durable before this returns. */
	begin(op: TxOp, task: string, data?: EntryData): JournalTx {
		const id = this.newTx();
		// The process that began it: a recovery leaves alone what a live process of this machine is still doing.
		this.write({ tx: id, task, op, event: 'begin', data: { ...data, pid: process.pid } });
		return new JournalTx(this, id, op, task);
	}

	/** A line for people that is not a step of a transaction. Never throws. */
	info(
		level: LogLevel,
		message: string,
		context: {
			task?: string;
			tx?: string;
			op?: TxOp;
			step?: string;
			side?: JournalSide;
			phase?: StepPhase;
			outcome?: string;
		} = {}
	): void {
		this.appendLog({ at: this.now(), level, ...context, message });
	}

	/** The transactions that began and did not end, oldest first. Throws loudly for a damaged log; a torn last line is dropped and said. */
	openTransactions(): OpenTx[] {
		const open = new Map<string, { begin: WalEntry; steps: WalEntry[] }>();
		for (const entry of this.load()) {
			if (entry.event === 'begin') open.set(entry.tx, { begin: entry, steps: [] });
			else if (entry.event === 'end') open.delete(entry.tx);
			else open.get(entry.tx)?.steps.push(entry);
		}
		return [...open.values()].map(({ begin, steps }) => new OpenTx(begin.tx, begin.op, begin.task, begin, steps));
	}

	/** Empties the write-ahead log when nothing is in flight. Returns whether it did. */
	compact(): boolean {
		if (this.openTransactions().length > 0) return false;
		// Nothing there: nothing to empty (and a project that never moved a task gets no file at all).
		const text = this.files.read(this.walFile);
		if (text === undefined || text === '') return true;
		this.files.replace(this.walFile, '');
		return true;
	}

	/** Appends one line to the write-ahead log (durably) and mirrors it to the human log. Used by {@link JournalTx}. */
	write(entry: Omit<WalEntry, 'seq' | 'at'>): void {
		this.ensureDir();
		if (this.seq === undefined) this.load();
		const line: WalEntry = { seq: (this.seq ?? 0) + 1, at: this.now(), ...entry };
		try {
			this.files.append(this.walFile, `${JSON.stringify(line)}\n`);
		} catch (error) {
			throw problem(this.walFile, `cannot write the write-ahead log: ${errorText(error)}`);
		}
		this.seq = line.seq;
		const failed =
			line.phase === 'failed' || (line.event === 'end' && line.outcome !== undefined && line.outcome !== 'ok');
		this.appendLog({
			at: line.at,
			level: failed ? 'warn' : 'info',
			tx: line.tx,
			task: line.task,
			op: line.op,
			event: line.event,
			...(line.step === undefined ? {} : { step: line.step }),
			...(line.side === undefined ? {} : { side: line.side }),
			...(line.phase === undefined ? {} : { phase: line.phase }),
			...(line.outcome === undefined ? {} : { outcome: line.outcome }),
			...(line.error === undefined ? {} : { error: line.error }),
			...(line.data === undefined ? {} : { data: line.data }),
			message: describeEntry(line),
		});
	}

	private ensureDir(): void {
		if (this.dirReady) return;
		try {
			this.files.ensureDir(path.dirname(this.walFile));
		} catch (error) {
			throw problem(this.walFile, `cannot create the folder of the write-ahead log: ${errorText(error)}`);
		}
		this.dirReady = true;
	}

	private appendLog(record: Record<string, unknown>): void {
		try {
			this.ensureDir();
			this.files.append(this.logFile, `${JSON.stringify(record)}\n`);
		} catch (error) {
			const text = `${this.logFile}: the migration log cannot be written (${errorText(error)}); the write-ahead log is not affected`;
			if (!this.reported.has(text)) {
				this.reported.add(text);
				this.onLogProblem(text);
			}
		}
	}

	/** Reads the write-ahead log: every line checked; a torn last line (a crash during an append) is cut off the file and reported. */
	private load(): WalEntry[] {
		const text = this.files.read(this.walFile);
		if (text === undefined || text === '') {
			this.seq ??= 0;
			return [];
		}
		const lines = text.split('\n');
		const complete = text.endsWith('\n');
		// `split` leaves an empty tail after the last newline.
		const last = lines.length - 1;
		const entries: WalEntry[] = [];
		let torn = false;
		for (let position = 0; position <= last; position++) {
			const raw = lines[position]!;
			if (raw === '' && position === last) continue;
			const parsed = parseEntry(raw);
			if (typeof parsed === 'string') {
				if (position === last && !complete) {
					torn = true;
					continue;
				}
				throw problem(
					this.walFile,
					`line ${position + 1} is damaged (${parsed})`,
					'Do not delete the file: it is how a crash is recovered. Restore it from a backup, or move it aside only when no migration is unfinished (check `task strategy migrate status`), then run the command again.'
				);
			}
			entries.push(parsed);
		}
		if (torn) {
			const kept = entries.map(entry => JSON.stringify(entry)).join('\n');
			this.files.replace(this.walFile, kept === '' ? '' : `${kept}\n`);
			const note = `${this.walFile}: the last line was cut short (a crash during a write); it is torn and was dropped, nothing before it was touched`;
			this.reported.add(note);
			this.onLogProblem(note);
		}
		this.seq = entries.reduce((max, entry) => Math.max(max, entry.seq), this.seq ?? 0);
		return entries;
	}
}

/** The entry on a line, or the reason it is not one. */
function parseEntry(raw: string): WalEntry | string {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch (error) {
		return `not JSON: ${errorText(error)}`;
	}
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return 'not an object';
	const entry = value as Record<string, unknown>;
	if (typeof entry['seq'] !== 'number') return 'no seq';
	for (const key of ['at', 'tx', 'task'] as const) {
		if (typeof entry[key] !== 'string') return `no ${key}`;
	}
	if (typeof entry['op'] !== 'string' || !OPS.includes(entry['op']))
		return `unknown op ${JSON.stringify(entry['op'])}`;
	if (entry['event'] !== 'begin' && entry['event'] !== 'step' && entry['event'] !== 'end') {
		return `unknown event ${JSON.stringify(entry['event'])}`;
	}
	return value as WalEntry;
}
