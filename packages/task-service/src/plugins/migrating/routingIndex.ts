// The routing index of the migrating strategy: `<data dir>/migrating/index.json`, one row per task that is not simply "in current".
// It says, for each task, where it lives (`in-a`: current only; `moving`: a copy in new, current authoritative; `in-b`: new
// authoritative, the copy in current kept as the backup; `deleted`) and under which id each side knows it. The id the person sees
// (`publicId`) is the id in current for a task that was there, the id in new for one that never was.
//
// A task of current that has NO row is in current and its public id is its own id: the index lists only what departs from that, so a
// project that never moved a task needs no file. The index is the source of routing but can be rebuilt from the identity blocks the
// copies in new carry (rebuildIndex.ts). A damaged file is a loud error naming it, never silently recreated: recreating would send
// every moved task back to current's stale copy.
//
// Writes are atomic (the writer is injected: the host's atomic writer) and run inside a lock when one is given, with the rows re-read
// INSIDE it, so two processes cannot lose each other's change. Limit: the lock is the one of task-core with its own lock file; it waits
// up to its timeout and blocks the event loop meanwhile.
import * as path from 'node:path';

import { BackendDataError } from '@wadeck-app/task-core';

export const INDEX_FORMAT = 1;
export const ROW_STATES = ['in-a', 'moving', 'in-b', 'deleted'] as const;
export type RowState = (typeof ROW_STATES)[number];

export interface IndexRow {
	/** The id the person sees. */
	publicId: string;
	/** The id of the task in `current`, when it has a copy there. */
	a?: string;
	/** The id of the task in `new`, when it has a copy there. */
	b?: string;
	state: RowState;
	/** ISO instant of the last change of `state`. */
	since: string;
	/** Counts the changes of this row, from 1. */
	version: number;
	/**
	 * Only for a `moving` row: the copy in `new` may differ from the task in `current` (a mirror of a write failed, or the index was
	 * rebuilt), so it must be caught up before authority switches. Absent = no known difference.
	 */
	stale?: boolean;
	/**
	 * Only for a `moving` row: the loss kinds the person accepted when this task was copied (`task migrate --allow-loss`), so a later
	 * change of the task is copied under the same terms and never loses more in silence.
	 */
	accepted?: string[];
}

/** The file system the index needs; every method may throw, nothing is swallowed. */
/** The row of a task changed (or is missing) since the caller read it: another process moved or changed the task. Nothing was written. */
export class IndexConflictError extends BackendDataError {}

export interface IndexFiles {
	/** The text of the file, or `undefined` when it does not exist (any other failure throws). */
	read(file: string): string | undefined;
	/** Replaces the whole file atomically (the folder exists). */
	write(file: string, content: string): void;
	/** Creates the folder (and its parents) when missing. */
	ensureDir(dir: string): void;
}

export interface IndexLock {
	run<T>(operation: () => T): T;
}

const ROW_KEYS: readonly string[] = ['publicId', 'a', 'b', 'state', 'since', 'version', 'stale', 'accepted'];
const FIX_REBUILD =
	'Do not delete it: that would send every moved task back to its stale copy in "current". Restore it from a backup, or rebuild it from the identity blocks of the tasks in "new" (rebuildIndex), then run the command again.';

function fail(file: string, problem: string, hint: string = FIX_REBUILD): never {
	throw new BackendDataError('migrating', file, `${file}: ${problem}`, hint);
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateRow(file: string, raw: unknown, position: number): IndexRow {
	if (!isObject(raw)) fail(file, `row ${position} is not an object`);
	const where = `row ${position}${typeof raw['publicId'] === 'string' ? ` (publicId "${raw['publicId']}")` : ''}`;
	for (const key of Object.keys(raw)) {
		if (!ROW_KEYS.includes(key)) fail(file, `${where}: unknown key "${key}" (known: ${ROW_KEYS.join(', ')})`);
	}
	const publicId = raw['publicId'];
	if (typeof publicId !== 'string' || publicId === '') fail(file, `${where}: publicId must be a non-empty text`);
	for (const key of ['a', 'b'] as const) {
		const value = raw[key];
		if (value !== undefined && (typeof value !== 'string' || value === '')) {
			fail(file, `${where}: ${key} must be a non-empty text when present`);
		}
	}
	const state = raw['state'];
	if (typeof state !== 'string' || !(ROW_STATES as readonly string[]).includes(state)) {
		fail(file, `${where}: state "${String(state)}" is not one of ${ROW_STATES.join(', ')}`);
	}
	const since = raw['since'];
	if (typeof since !== 'string' || Number.isNaN(Date.parse(since))) {
		fail(file, `${where}: since must be an ISO date, found ${JSON.stringify(since)}`);
	}
	const version = raw['version'];
	if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
		fail(file, `${where}: version must be a whole number from 1, found ${JSON.stringify(version)}`);
	}
	const stale = raw['stale'];
	if (stale !== undefined && typeof stale !== 'boolean') {
		fail(file, `${where}: stale must be true or false when present, found ${JSON.stringify(stale)}`);
	}
	if (stale !== undefined && state !== 'moving') {
		fail(
			file,
			`${where}: only a moving task can be stale (the copy of an in-a task does not exist, an in-b task has no copy to follow)`
		);
	}
	const accepted = raw['accepted'];
	if (accepted !== undefined) {
		if (!Array.isArray(accepted) || accepted.some(kind => typeof kind !== 'string')) {
			fail(file, `${where}: accepted must be a list of loss kinds (texts) when present`);
		}
		if (state !== 'moving') fail(file, `${where}: accepted losses belong to a moving task only`);
	}
	const a = raw['a'] as string | undefined;
	const b = raw['b'] as string | undefined;
	if (state === 'in-a' && (a === undefined || b !== undefined)) {
		fail(file, `${where}: an in-a task is in "current" only (needs a, no b)`);
	}
	if (state === 'moving' && (a === undefined || b === undefined)) {
		fail(file, `${where}: a moving task has a copy in both (needs a and b)`);
	}
	if (state === 'in-b' && b === undefined) fail(file, `${where}: an in-b task needs its id in "new" (b)`);
	if (a !== undefined && a !== publicId) {
		fail(
			file,
			`${where}: publicId "${publicId}" must be the id in "current" ("${a}") for a task that has one there`
		);
	}
	return {
		publicId,
		...(a === undefined ? {} : { a }),
		...(b === undefined ? {} : { b }),
		state: state as RowState,
		since,
		version,
		...(stale === true ? { stale: true } : {}),
		...(accepted === undefined ? {} : { accepted: [...(accepted as string[])] }),
	};
}

/** An immutable view of the rows with the lookups the reads need. */
export class IndexSnapshot {
	private readonly byPublic = new Map<string, IndexRow>();
	private readonly bySideA = new Map<string, IndexRow>();
	private readonly bySideB = new Map<string, IndexRow>();

	constructor(
		readonly rows: readonly IndexRow[],
		file: string
	) {
		for (const row of rows) {
			if (this.byPublic.has(row.publicId)) fail(file, `publicId "${row.publicId}" appears twice`);
			this.byPublic.set(row.publicId, row);
			if (row.a !== undefined) {
				if (this.bySideA.has(row.a)) fail(file, `id "${row.a}" in "current" appears twice`);
				this.bySideA.set(row.a, row);
			}
			if (row.b !== undefined) {
				if (this.bySideB.has(row.b)) fail(file, `id "${row.b}" in "new" appears twice`);
				this.bySideB.set(row.b, row);
			}
		}
	}

	byPublicId(publicId: string): IndexRow | undefined {
		return this.byPublic.get(publicId);
	}

	/** The row of the task that has this id in `current`. */
	byA(id: string): IndexRow | undefined {
		return this.bySideA.get(id);
	}

	/** The row of the task that has this id in `new`. */
	byB(id: string): IndexRow | undefined {
		return this.bySideB.get(id);
	}

	/** True when nothing is routed to `new` and nothing is hidden: every read may go straight to `current`. */
	get isTrivial(): boolean {
		return this.rows.every(row => row.state === 'in-a');
	}

	/** True when some task is authoritative in `new` (its summaries must be read there). */
	get hasInB(): boolean {
		return this.rows.some(row => row.state === 'in-b');
	}
}

export interface RoutingIndexInput {
	file: string;
	files: IndexFiles;
	lock?: IndexLock;
}

function parse(file: string, text: string): IndexSnapshot {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch (error) {
		return fail(file, `the index is not valid JSON (${error instanceof Error ? error.message : String(error)})`);
	}
	if (!isObject(value)) return fail(file, 'the index must be an object { format, rows }');
	if (value['format'] !== INDEX_FORMAT) {
		return fail(
			file,
			`the index has format ${JSON.stringify(value['format'])}, this version reads format ${INDEX_FORMAT}`,
			'Update task to the version that wrote it, or restore a backup of the file.'
		);
	}
	const rows = value['rows'];
	if (!Array.isArray(rows)) return fail(file, 'rows must be a list');
	return new IndexSnapshot(
		rows.map((raw, position) => validateRow(file, raw, position + 1)),
		file
	);
}

export class RoutingIndex {
	private readonly file: string;
	private readonly files: IndexFiles;
	private readonly lock: IndexLock | undefined;
	private cachedText: string | undefined;
	private cached: IndexSnapshot | undefined;

	constructor(input: RoutingIndexInput) {
		this.file = input.file;
		this.files = input.files;
		this.lock = input.lock;
	}

	/** The rows as they are on disk now (re-read every time, parsed only when the text changed). A missing file is no row. */
	snapshot(): IndexSnapshot {
		const text = this.files.read(this.file);
		if (text === undefined) {
			this.cachedText = undefined;
			this.cached = new IndexSnapshot([], this.file);
			return this.cached;
		}
		if (this.cached === undefined || text !== this.cachedText) {
			// A damaged file throws here and the previous snapshot is dropped: nothing stale is ever served after a failure.
			this.cached = undefined;
			this.cachedText = undefined;
			const parsed = parse(this.file, text);
			this.cached = parsed;
			this.cachedText = text;
		}
		return this.cached;
	}

	/**
	 * Replaces the rows with what `change` returns, given the rows as they are now (read inside the lock). The result is validated
	 * BEFORE anything is written; a damaged file on disk is an error here too and is never overwritten.
	 */
	mutate(change: (rows: readonly IndexRow[]) => readonly IndexRow[]): IndexSnapshot {
		const operation = (): IndexSnapshot => {
			const current = this.snapshot();
			const next = change(current.rows);
			const checked = new IndexSnapshot(
				next.map((row, position) => validateRow(this.file, row, position + 1)),
				this.file
			);
			const text = JSON.stringify({ format: INDEX_FORMAT, rows: checked.rows }, null, 2);
			this.files.ensureDir(path.dirname(this.file));
			this.files.write(this.file, text);
			this.cachedText = text;
			this.cached = checked;
			return checked;
		};
		return this.lock === undefined ? operation() : this.lock.run(operation);
	}

	/**
	 * Changes ONE row (or creates it) inside the lock, the rows re-read there: the other rows are kept as the other process left them.
	 * `change` gets the row as it is now (`undefined` when there is none) and returns the new one; its `version` is set here (the
	 * old one plus one, 1 for a new row). `expectedVersion` refuses the write when another change got in between (a task moved by a
	 * second process); `mustExist` refuses an unknown task. Both are loud errors naming the task.
	 */
	mutateRow(
		publicId: string,
		guard: { expectedVersion?: number; mustExist?: boolean },
		change: (row: IndexRow | undefined) => IndexRow
	): IndexSnapshot {
		return this.mutate(rows => {
			const position = rows.findIndex(row => row.publicId === publicId);
			const current = position === -1 ? undefined : rows[position];
			if (current === undefined && guard.mustExist === true) {
				throw new IndexConflictError(
					'migrating',
					publicId,
					`${this.file}: task ${publicId} has no row (it is in current only, or the index was rebuilt meanwhile)`,
					'Run the command again.'
				);
			}
			if (guard.expectedVersion !== undefined && current?.version !== guard.expectedVersion) {
				throw new IndexConflictError(
					'migrating',
					publicId,
					`${this.file}: the row of task ${publicId} changed meanwhile (version ${String(current?.version)}, expected ${guard.expectedVersion}): another process moved or changed the task`,
					'Run the command again; nothing was written for this attempt.'
				);
			}
			const changed = { ...change(current), version: (current?.version ?? 0) + 1 };
			if (changed.publicId !== publicId)
				fail(this.file, `a change of the row of task ${publicId} renamed it to ${changed.publicId}`);
			const next = [...rows];
			if (position === -1) next.push(changed);
			else next[position] = changed;
			return next;
		});
	}

	/**
	 * Replaces the whole index with rows rebuilt from the stores (the only way past a damaged file). The rows are checked first; a
	 * damaged file is then kept byte for byte beside it (`<file>.damaged-<stamp>`) BEFORE the new one is written, so nothing the person
	 * could have recovered by hand is lost. `stamp` is an ISO instant.
	 */
	replaceFromRebuild(rows: readonly IndexRow[], stamp: string): { snapshot: IndexSnapshot; setAside?: string } {
		const operation = (): { snapshot: IndexSnapshot; setAside?: string } => {
			const checked = new IndexSnapshot(
				rows.map((row, position) => validateRow(this.file, row, position + 1)),
				this.file
			);
			const old = this.files.read(this.file);
			let setAside: string | undefined;
			if (old !== undefined) {
				try {
					parse(this.file, old);
				} catch (error) {
					if (!(error instanceof BackendDataError)) throw error;
					setAside = `${this.file}.damaged-${stamp.replace(/:/g, '-')}`;
					this.files.ensureDir(path.dirname(this.file));
					this.files.write(setAside, old);
				}
			}
			const text = JSON.stringify({ format: INDEX_FORMAT, rows: checked.rows }, null, 2);
			this.files.ensureDir(path.dirname(this.file));
			this.files.write(this.file, text);
			this.cachedText = text;
			this.cached = checked;
			return { snapshot: checked, ...(setAside === undefined ? {} : { setAside }) };
		};
		return this.lock === undefined ? operation() : this.lock.run(operation);
	}
}
