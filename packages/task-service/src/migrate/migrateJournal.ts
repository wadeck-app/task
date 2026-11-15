// The journal and the lock of a migration, as files in the data folder of the TARGET project (design 1.8): the journal says which target
// task each source task became and how far it got, so a run that stopped (crash, rate limit) continues and a second run creates nothing;
// the lock keeps two runs from writing the same target at once. Atomic writes through the SDK, like every other file of task.
import * as fs from 'node:fs';
import * as path from 'node:path';

import { writeFileAtomic } from '@wadeck-app/project-sdk';

import { MigrationStateError } from './migrateErrors.js';
import type { MigrationMismatch } from './migrateTypes.js';

/** How far a source task got: created (and recorded), fields set, links set, comments written (done). */
export const PHASES = ['created', 'fielded', 'linked', 'done'] as const;
export type Phase = (typeof PHASES)[number];

export interface JournalTask {
	/** The id of the task on the target. */
	target: string;
	phase: Phase;
	/** In-place: the hash of what the source task held when it was copied (see sourceContent.ts), to notice a later edit. */
	content?: string;
	/** The hash of each part (see sourceContent.ts), to name what changed. */
	parts?: Record<string, string>;
}

export type JournalStatus = 'running' | 'stopped' | 'completed';

export interface Journal {
	version: 1;
	from: { id: string; name: string };
	to: { id: string; name: string };
	startedAt: string;
	updatedAt: string;
	status: JournalStatus;
	tasks: Record<string, JournalTask>;
	/** Why the last run stopped, when it did. */
	lastError?: { sourceId?: string; step: string; message: string };
	/**
	 * A creation that was started and whose answer was not recorded (the run stopped between the request and the journal): the task may
	 * exist on the target without the journal knowing. The next run looks for it before creating anything.
	 */
	pending?: PendingCreate;
	/** In-place migration only: what the run migrates to, and how far the switch of the config got. */
	inPlace?: InPlaceState;
}

/**
 * The target an in-place run is for: a hash of what defines it (the strategy section, the status and type names; not comments or
 * other keys), the same split per part to say what changed, and its storage location (a changed definition at the same location may be
 * accepted, another location never). `verified`: every task was read back with no difference (or the differences accepted) and the
 * id map saved, so only the switch is left. `switched`: config.yml is the draft.
 */
export interface InPlaceState {
	targetHash: string;
	parts: Record<string, string>;
	location: string;
	kinds: { from: string; to: string };
	/** The config is replaced (or was, and the journal knows). */
	switched: boolean;
	/** Everything is written, read back and the source unchanged: only the switch is left. */
	verified: boolean;
	/** The write of config.yml began (set right before it, cleared when it failed without writing): the only state a bookkeeping-only resume trusts. */
	switchStarted: boolean;
	/** The storage the tasks were read from when the run started: a resume with another source is refused. Absent in journals of older runs. */
	source?: { kind: string; location: string };
	/** The ids of the tasks already on the target that `--allow-non-empty-target` accepted: only these are accepted on a resume. */
	acceptedForeignIds?: string[];
	/** The summary event of the switch was raised (best effort: written when the result that carries it is returned). */
	summaryEventRaised?: boolean;
	acceptedDifferences?: MigrationMismatch[];
}

export interface PendingCreate {
	sourceId: string;
	/** The title the task is created with: how the next run recognises it. */
	title: string;
	/** ISO instant the creation was started (the clock of this machine; for the log). */
	at: string;
	/**
	 * The latest creation instant the target had when this creation started, on the TARGET's own clock: the lost task is not older than
	 * it. Absent when the target held no task yet.
	 */
	after?: string;
}

export function journalFileName(fromId: string, toId: string): string {
	return `migrate-journal-${fromId}-${toId}.json`;
}

/** The journal of an in-place migration of a project (one project, no second side). */
export function inPlaceJournalFileName(projectId: string): string {
	return `migrate-journal-${projectId}-inplace.json`;
}

/** The persistent id map of an in-place migration, next to its journal. */
export function idMapFileName(projectId: string): string {
	return `migrate-idmap-${projectId}.json`;
}

export interface IdMapEntry {
	from: string;
	to: string;
	url?: string;
}

/** Writes the id map whole or not at all, in the order the tasks were created. */
export function writeIdMap(file: string, entries: readonly IdMapEntry[]): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	writeFileAtomic(file, JSON.stringify(entries, null, 2));
}

export const LOCK_FILE_NAME = 'migrate.lock';

function corrupt(file: string, reason: string): MigrationStateError {
	return new MigrationStateError(
		`the migration journal ${file} is damaged: ${reason}`,
		'It is the only record of which target tasks this migration created, so it is not replaced silently. Restore it from a copy; or, if the target keeps the migratedFrom marker (a target with metadata), move the file away and run again: the marker rebuilds it. Otherwise check the target for the tasks of the earlier run before deleting it.'
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The journal at `file`, or undefined when there is none. A file that cannot be trusted throws MigrationStateError. */
export function readJournal(file: string, expected: { fromId: string; toId: string }): Journal | undefined {
	let text: string;
	try {
		text = fs.readFileSync(file, 'utf8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
		throw new MigrationStateError(
			`the migration journal ${file} cannot be read: ${(error as Error).message}`,
			'Fix the permissions of the file, then run again.'
		);
	}
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch (error) {
		throw corrupt(file, `it is not JSON (${(error as Error).message})`);
	}
	if (!isRecord(value)) throw corrupt(file, 'it does not hold an object');
	if (value['version'] !== 1) throw corrupt(file, `unknown version ${JSON.stringify(value['version'])}`);
	const side = (key: 'from' | 'to', id: string): { id: string; name: string } => {
		const entry = value[key];
		if (!isRecord(entry) || typeof entry['id'] !== 'string' || typeof entry['name'] !== 'string') {
			throw corrupt(file, `"${key}" is not {id, name}`);
		}
		if (entry['id'] !== id) throw corrupt(file, `"${key}" is project ${entry['id']}, the file name says ${id}`);
		return { id: entry['id'], name: entry['name'] };
	};
	const from = side('from', expected.fromId);
	const to = side('to', expected.toId);
	const status = value['status'];
	if (status !== 'running' && status !== 'stopped' && status !== 'completed') {
		throw corrupt(file, `unknown status ${JSON.stringify(status)}`);
	}
	if (typeof value['startedAt'] !== 'string' || typeof value['updatedAt'] !== 'string') {
		throw corrupt(file, 'startedAt / updatedAt are missing');
	}
	const rawTasks = value['tasks'];
	if (!isRecord(rawTasks)) throw corrupt(file, '"tasks" is not an object');
	const tasks: Record<string, JournalTask> = {};
	for (const [sourceId, entry] of Object.entries(rawTasks)) {
		if (
			!isRecord(entry) ||
			typeof entry['target'] !== 'string' ||
			typeof entry['phase'] !== 'string' ||
			!(PHASES as readonly string[]).includes(entry['phase'])
		) {
			throw corrupt(file, `the entry of task ${sourceId} is not {target, phase}`);
		}
		tasks[sourceId] = {
			target: entry['target'],
			phase: entry['phase'] as Phase,
			...(typeof entry['content'] === 'string' ? { content: entry['content'] } : {}),
			...(isRecord(entry['parts']) ? { parts: entry['parts'] as Record<string, string> } : {}),
		};
	}
	const last = value['lastError'];
	const rawPending = value['pending'];
	let pending: PendingCreate | undefined;
	if (rawPending !== undefined) {
		const { sourceId, title, at, after } = isRecord(rawPending) ? rawPending : ({} as Record<string, unknown>);
		if (
			typeof sourceId !== 'string' ||
			typeof title !== 'string' ||
			typeof at !== 'string' ||
			(after !== undefined && typeof after !== 'string')
		) {
			throw corrupt(file, '"pending" is not {sourceId, title, at, after?}');
		}
		pending = { sourceId, title, at, ...(after === undefined ? {} : { after }) };
	}
	const inPlace = readInPlaceState(file, value['inPlace']);
	return {
		version: 1,
		from,
		to,
		startedAt: value['startedAt'],
		updatedAt: value['updatedAt'],
		status,
		tasks,
		...(isRecord(last) && typeof last['step'] === 'string' && typeof last['message'] === 'string'
			? {
					lastError: {
						step: last['step'],
						message: last['message'],
						...(typeof last['sourceId'] === 'string' ? { sourceId: last['sourceId'] } : {}),
					},
				}
			: {}),
		...(pending === undefined ? {} : { pending }),
		...(inPlace === undefined ? {} : { inPlace }),
	};
}

const MISMATCH_KEYS = ['sourceId', 'targetId', 'field', 'expected', 'actual'] as const;

function readInPlaceState(file: string, raw: unknown): InPlaceState | undefined {
	if (raw === undefined) return undefined;
	const bad = (): MigrationStateError =>
		corrupt(file, '"inPlace" is not {targetHash, parts, location, kinds, switched, verified}');
	if (!isRecord(raw)) throw bad();
	const { targetHash, parts, location, kinds, switched, verified, switchStarted, acceptedDifferences } = raw;
	if (
		typeof targetHash !== 'string' ||
		!isRecord(parts) ||
		!Object.values(parts).every(part => typeof part === 'string') ||
		typeof location !== 'string' ||
		!isRecord(kinds) ||
		typeof kinds['from'] !== 'string' ||
		typeof kinds['to'] !== 'string' ||
		typeof switched !== 'boolean' ||
		typeof verified !== 'boolean' ||
		(switchStarted !== undefined && typeof switchStarted !== 'boolean') ||
		(raw['source'] !== undefined &&
			!(
				isRecord(raw['source']) &&
				typeof raw['source']['kind'] === 'string' &&
				typeof raw['source']['location'] === 'string'
			)) ||
		(raw['acceptedForeignIds'] !== undefined &&
			!(
				Array.isArray(raw['acceptedForeignIds']) &&
				raw['acceptedForeignIds'].every(id => typeof id === 'string')
			)) ||
		(raw['summaryEventRaised'] !== undefined && typeof raw['summaryEventRaised'] !== 'boolean')
	) {
		throw bad();
	}
	let accepted: MigrationMismatch[] | undefined;
	if (acceptedDifferences !== undefined) {
		if (
			!Array.isArray(acceptedDifferences) ||
			!acceptedDifferences.every(
				item => isRecord(item) && MISMATCH_KEYS.every(key => typeof item[key] === 'string')
			)
		) {
			throw corrupt(file, '"inPlace.acceptedDifferences" is not a list of differences');
		}
		accepted = acceptedDifferences as MigrationMismatch[];
	}
	return {
		targetHash,
		parts: parts as Record<string, string>,
		location,
		kinds: { from: kinds['from'], to: kinds['to'] },
		switched,
		verified,
		switchStarted: switchStarted === true,
		...(isRecord(raw['source'])
			? { source: { kind: raw['source']['kind'] as string, location: raw['source']['location'] as string } }
			: {}),
		...(Array.isArray(raw['acceptedForeignIds'])
			? { acceptedForeignIds: raw['acceptedForeignIds'] as string[] }
			: {}),
		...(raw['summaryEventRaised'] === true ? { summaryEventRaised: true } : {}),
		...(accepted === undefined ? {} : { acceptedDifferences: accepted }),
	};
}

/**
 * Renames files (journal, id map) of a finished in-place migration to `<name>.archived-<stamp>.json` so the next migration of the project
 * starts clean and the old-id -> new-id mapping is never overwritten nor deleted. All or nothing: every file first moves to a temporary
 * name, then to its archived name; a failure puts everything back where it was. Returns the new names, in the order given; a file that
 * is not there is skipped. `rename` is injectable for tests.
 */
export function archiveFiles(
	files: readonly string[],
	stamp: string,
	rename: (from: string, to: string) => void = fs.renameSync
): string[] {
	const safe = stamp.replaceAll(':', '-').replaceAll('.', '-');
	const present = files.filter(file => fs.existsSync(file));
	const plan = present.map(file => ({
		file,
		// The stamp is in the temp name: a crash between the two renames leaves enough to finish the job (recoverArchives).
		temp: `${file}.archiving-${safe}`,
		target: file.replace(/\.json$/, `.archived-${safe}.json`),
	}));
	for (const { file, target } of plan) {
		if (fs.existsSync(target)) {
			throw new MigrationStateError(
				`cannot archive ${file}: ${target} already exists`,
				'Move that file away, then run again.'
			);
		}
	}
	const done: Array<[string, string]> = [];
	const move = (from: string, to: string): void => {
		rename(from, to);
		done.push([from, to]);
	};
	try {
		for (const { file, temp } of plan) move(file, temp);
		for (const { temp, target } of plan) move(temp, target);
	} catch (error) {
		// Put everything back, newest move first, with the real rename: a half-archived pair would lose the link between the two files.
		for (const [from, to] of done.reverse()) {
			try {
				fs.renameSync(to, from);
			} catch {
				/* what could not be put back is named below */
			}
		}
		throw new MigrationStateError(
			`cannot archive the files of the finished migration (${present.join(', ')}): ${(error as Error).message}`,
			'Nothing was changed: they are where they were. Fix the cause, then run again.'
		);
	}
	return plan.map(entry => entry.target);
}

/**
 * Completes an archive a crash interrupted: a `<file>.archiving-<stamp>` left by {@link archiveFiles} becomes
 * `<file>.archived-<stamp>.json`, and the other file of the pair, still under its canonical name, is archived with the same stamp (the
 * pair is never split). Returns what was done, one sentence each. An archived name that already exists is an error: nothing is overwritten.
 */
export function recoverArchives(
	files: readonly string[],
	rename: (from: string, to: string) => void = fs.renameSync
): string[] {
	const found: Array<{ file: string; stray: string; stamp: string }> = [];
	for (const file of files) {
		const dir = path.dirname(file);
		const prefix = `${path.basename(file)}.archiving-`;
		let names: string[] = [];
		try {
			names = fs.readdirSync(dir);
		} catch (error) {
			// A folder that does not exist has no stray; any other failure means the check cannot be trusted: stop, never go on.
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
			throw new MigrationStateError(
				`cannot look for an interrupted archive in ${dir}: ${(error as Error).message}`,
				`Fix the permissions of ${dir} (or what is in the way), then run again: a run that cannot see the files of an earlier migration there must not start.`
			);
		}
		for (const name of names) {
			if (name.startsWith(prefix))
				found.push({ file, stray: path.join(dir, name), stamp: name.slice(prefix.length) });
		}
	}
	if (found.length === 0) return [];
	const stamp = found[0]!.stamp;
	const archivedOf = (file: string): string => file.replace(/\.json$/, `.archived-${stamp}.json`);
	const moves = [
		...found.map(entry => ({ from: entry.stray, to: archivedOf(entry.file) })),
		...files
			.filter(file => fs.existsSync(file) && !found.some(entry => entry.file === file))
			.map(file => ({ from: file, to: archivedOf(file) })),
	];
	for (const move of moves) {
		if (fs.existsSync(move.to)) {
			throw new MigrationStateError(
				`cannot finish the interrupted archive of ${move.from}: ${move.to} already exists`,
				'Move that file away, then run again.'
			);
		}
	}
	// All or nothing, like archiveFiles: a rename that fails puts the ones already done back and stops the run.
	const done: Array<[string, string]> = [];
	try {
		for (const move of moves) {
			rename(move.from, move.to);
			done.push([move.from, move.to]);
		}
	} catch (error) {
		for (const [from, to] of done.reverse()) {
			try {
				fs.renameSync(to, from);
			} catch {
				/* what could not be put back stays under its archived name, which the error names below */
			}
		}
		throw new MigrationStateError(
			`cannot finish the interrupted archive (${moves.map(move => move.from).join(', ')}): ${(error as Error).message}`,
			'Nothing was changed: the files are where they were. Fix the cause, then run again; the run does not start until the archive is complete.'
		);
	}
	return moves.map(move => `an interrupted archive was completed: ${move.from} -> ${move.to}`);
}

/** Writes the journal whole or not at all. */
export function writeJournal(file: string, journal: Journal): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	writeFileAtomic(file, JSON.stringify(journal, null, 2));
}

export interface LockOwner {
	pid: number;
	startedAt: string;
	from: string;
	to: string;
}

export interface HeldLock {
	file: string;
	/** Removes the lock; returns a warning when that failed (the result of the run stays what it was). */
	release(): string | undefined;
	/** Set when the lock of a dead process was taken over. */
	tookOver?: string;
}

/** True when a process with this id exists (also when we may not signal it). */
export function processIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === 'EPERM';
	}
}

/**
 * Takes the lock of the target data folder. A lock held by a live process is refused; one left by a process that no longer exists is
 * taken over (and said so); a lock file that cannot be read is refused, it may belong to a run we cannot see.
 */
export function acquireLock(
	dir: string,
	owner: LockOwner,
	isAlive: (pid: number) => boolean = processIsAlive
): HeldLock {
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, LOCK_FILE_NAME);
	let tookOver: string | undefined;
	let released = false;
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const fd = fs.openSync(file, 'wx');
			try {
				fs.writeSync(fd, JSON.stringify(owner));
			} finally {
				fs.closeSync(fd);
			}
			return {
				file,
				...(tookOver === undefined ? {} : { tookOver }),
				release: () => {
					// Idempotent: a second call must never remove the lock of the run that took it after us.
					if (released) return undefined;
					released = true;
					try {
						fs.rmSync(file, { force: true });
						return undefined;
					} catch (error) {
						return `the migration lock ${file} could not be removed (${(error as Error).message}); delete it before the next run`;
					}
				},
			};
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
		}
		let held: unknown;
		try {
			held = JSON.parse(fs.readFileSync(file, 'utf8'));
		} catch {
			throw new MigrationStateError(
				`the migration lock ${file} exists and cannot be read`,
				'If no migration is running, delete the file and run again.'
			);
		}
		const pid = isRecord(held) && typeof held['pid'] === 'number' ? held['pid'] : undefined;
		if (pid === undefined) {
			throw new MigrationStateError(
				`the migration lock ${file} does not name a process`,
				'If no migration is running, delete the file and run again.'
			);
		}
		if (isAlive(pid)) {
			throw new MigrationStateError(
				`another migration is writing this target (process ${pid}, lock ${file})`,
				'Wait for it to finish, then run again. If that process is not a migration any more, delete the lock file.'
			);
		}
		tookOver = `took over the lock of process ${pid}, which is gone (it died during a migration: the journal shows how far it got)`;
		fs.rmSync(file, { force: true });
	}
	throw new MigrationStateError(
		`the migration lock ${file} could not be taken`,
		'Run again; if it persists, delete the file when no migration is running.'
	);
}
