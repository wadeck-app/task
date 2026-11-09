// The plan of a migration: read the source, decide for every task what it becomes on the target and what is lost, and find out which
// tasks an earlier run already migrated (the journal first, then the marker the target holds). Reads only: the dry run stops here.
import type { TaskBackend, TaskSummary, VersionedRecord } from '@wadeck-app/task-core';

import { planHierarchy } from './hierarchyPlan.js';
import { LossLedger, isLossAllowed } from './lossLedger.js';
import { MIGRATED_FROM_KEY, mapTask } from './mapTask.js';
import type { MappedTask } from './mapTask.js';
import { MigrationRefusedError } from './migrateErrors.js';
import { PHASES } from './migrateJournal.js';
import type { Journal, Phase } from './migrateJournal.js';
import type {
	LossKind,
	LossRow,
	MigrationEndpoint,
	MigrationEstimate,
	MigrationOptions,
	MigrationProgress,
} from './migrateTypes.js';

/** Tasks read in one `getMany` (a remote backend does one request per task anyway; this bounds what is held while it works). */
const READ_CHUNK = 50;
const PAGE_SIZE = 100;

export type PlannedState =
	/** Nothing on the target yet: the task is created. */
	| 'new'
	/** An earlier run created it and stopped before the end: the rest is done now. */
	| 'resume'
	/** Fully migrated: nothing to do. */
	| 'done';

export interface PlannedTask {
	mapped: MappedTask;
	/** The parent the task keeps (source id). */
	parentSourceId?: string;
	state: PlannedState;
	/** The task on the target, for `resume` and `done`. */
	targetId?: string;
	/** The task was found on the target after a creation whose answer was lost: its parent and status are checked, not only its fields. */
	adopted?: true;
	/** How far an earlier run got, for `resume`. */
	phase?: Phase;
}

export interface MigrationPlan {
	/** Parents before children. */
	tasks: PlannedTask[];
	losses: LossRow[];
	blocking: LossKind[];
	notes: string[];
	warnings: string[];
	estimate: MigrationEstimate;
	/** Journal entries whose target task is gone: those tasks are created again. */
	vanished: string[];
	/** The latest creation instant among the tasks the target holds (its own clock); absent for an empty target. */
	targetClock?: string;
}

export interface PlanInput {
	source: MigrationEndpoint;
	target: MigrationEndpoint;
	options: MigrationOptions;
	journal: Journal | undefined;
	onProgress?: (progress: MigrationProgress) => void;
}

/** Every task summary of a backend, page by page. */
export async function listAll(backend: TaskBackend): Promise<TaskSummary[]> {
	const all: TaskSummary[] = [];
	let cursor: string | undefined;
	do {
		const page = await backend.listPage({ limit: PAGE_SIZE, ...(cursor === undefined ? {} : { cursor }) });
		all.push(...page.items);
		cursor = page.nextCursor;
	} while (cursor !== undefined);
	return all;
}

/** The records of `ids`, in order, read in chunks. */
export async function readRecords(
	backend: TaskBackend,
	ids: readonly string[],
	onChunk?: (done: number) => void
): Promise<VersionedRecord[]> {
	const records: VersionedRecord[] = [];
	for (let start = 0; start < ids.length; start += READ_CHUNK) {
		records.push(...(await backend.getMany(ids.slice(start, start + READ_CHUNK))));
		onChunk?.(records.length);
	}
	return records;
}

const REFERENCE = /#\d+\b|\b[0-9a-f]{8}\b/g;

/** How many times the texts name a task of the source by its id: the ids change, and a text is never rewritten. */
function countReferences(tasks: readonly MappedTask[], sourceIds: ReadonlySet<string>): number {
	let count = 0;
	const scan = (text: string | undefined): void => {
		if (text === undefined) return;
		for (const match of text.matchAll(REFERENCE)) {
			const id = match[0].startsWith('#') ? match[0].slice(1) : match[0];
			if (sourceIds.has(id)) count++;
		}
	};
	for (const task of tasks) {
		scan(task.title);
		scan(task.description);
		for (const comment of task.comments) scan(comment.text);
	}
	return count;
}

function estimateWrites(
	tasks: readonly PlannedTask[],
	source: MigrationEndpoint,
	target: MigrationEndpoint,
	reads: { source: number; targetScan: number }
): MigrationEstimate {
	const caps = target.backend.capabilities;
	let writes = 0;
	let verified = 0;
	for (const task of tasks) {
		if (task.state === 'done') continue;
		verified++;
		const { mapped } = task;
		if (task.state === 'new') writes += 1;
		if (caps.meta) writes += 1;
		writes += (mapped.type === undefined ? 0 : 1) + mapped.labels.length + Object.keys(mapped.meta).length;
		writes += mapped.links.length + mapped.comments.length;
	}
	const cost = target.traits.cost;
	const sourceRead = source.traits.cost?.read;
	const targetRead = cost?.read;
	// Reading a task costs requests too: the source, the target tasks scanned for a marker, and the read-back of what is written.
	const requests =
		(cost === undefined ? 0 : writes * cost.requests) +
		(sourceRead === undefined ? 0 : reads.source * sourceRead.requests) +
		(targetRead === undefined ? 0 : (reads.targetScan + verified) * targetRead.requests);
	const seconds =
		(cost === undefined ? 0 : writes * cost.seconds) +
		(sourceRead === undefined ? 0 : reads.source * sourceRead.seconds) +
		(targetRead === undefined ? 0 : (reads.targetScan + verified) * targetRead.seconds);
	return {
		writes,
		requests: Math.round(requests),
		seconds: Math.round(seconds),
		...(cost?.quotaPerHour === undefined ? {} : { quotaPerHour: cost.quotaPerHour }),
	};
}

export async function buildPlan(input: PlanInput): Promise<MigrationPlan> {
	const { source, target, options, journal, onProgress } = input;

	// 1. The source, whole, through the port.
	const summaries = await listAll(source.backend);
	onProgress?.({ stage: 'read', done: 0, total: summaries.length });
	const records = await readRecords(
		source.backend,
		summaries.map(summary => summary.id),
		done => onProgress?.({ stage: 'read', done, total: summaries.length })
	);
	const warnings: string[] = [];
	for (const notice of source.takeNotices?.() ?? []) {
		if (notice.kind === 'stale') {
			throw new MigrationRefusedError(
				`the source project ${source.project.name} was read from a cache (${notice.text}); migrating from it could copy outdated tasks`,
				'Wait until the source can be reached, then run the migration again.'
			);
		}
		warnings.push(`source: ${notice.text}`);
	}

	// 2. What every task becomes, and what is lost.
	const ledger = new LossLedger();
	const sourceIds = new Set(records.map(record => record.id));
	const caps = target.backend.capabilities;
	const hierarchy = planHierarchy(
		records,
		{
			hierarchy: caps.hierarchy,
			...(target.traits.hierarchyDepth === undefined ? {} : { depth: target.traits.hierarchyDepth }),
			...(target.traits.childrenPerParent === undefined ? {} : { children: target.traits.childrenPerParent }),
		},
		ledger
	);
	const byId = new Map(records.map(record => [record.id, record]));
	const mappedById = new Map<string, MappedTask>();
	for (const id of hierarchy.order) {
		mappedById.set(id, mapTask(byId.get(id)!, { source, target, options, ledger, sourceIds }));
	}
	onProgress?.({ stage: 'plan', done: records.length, total: records.length });

	const allowed = (kind: LossKind): boolean => isLossAllowed(kind, options.allowLoss);
	const losses = ledger.rows(allowed);
	const blocking = losses.filter(row => !row.allowed).map(row => row.kind);

	// 3. What an earlier run already did: the journal, then (when the target can hold the marker) the marker itself.
	const targetSummaries = await listAll(target.backend);
	const targetIds = new Set(targetSummaries.map(summary => summary.id));
	const entries = new Map<string, { target: string; phase: Phase }>();
	const vanished: string[] = [];
	for (const [sourceId, entry] of Object.entries(journal?.tasks ?? {})) {
		if (!sourceIds.has(sourceId)) continue; // gone from the source since: nothing to continue
		if (targetIds.has(entry.target)) entries.set(sourceId, entry);
		else vanished.push(sourceId);
	}
	const notes: string[] = [];
	const claimed = new Set([...entries.values()].map(entry => entry.target));
	const unclaimed = targetSummaries.filter(summary => !claimed.has(summary.id));
	const needsScan =
		caps.meta &&
		unclaimed.length > 0 &&
		(journal === undefined || journal.status !== 'completed' || vanished.length > 0);
	const scanned = needsScan ? unclaimed.length : 0;
	if (needsScan) {
		const found = await scanMarkers(target.backend, unclaimed, source.project.id);
		for (const [sourceId, targetId] of found.entries()) {
			if (sourceIds.has(sourceId) && !entries.has(sourceId))
				entries.set(sourceId, { target: targetId, phase: 'created' });
		}
		notes.push(
			`read ${unclaimed.length} task(s) of the target looking for the marker ${MIGRATED_FROM_KEY} of an earlier run: ${found.size} found`
		);
	}
	if (vanished.length > 0) {
		warnings.push(
			`${vanished.length} task(s) of the journal are no longer on the target (${vanished.slice(0, 5).join(', ')}${vanished.length > 5 ? ', ...' : ''}): they are created again; links that other tasks held to them are not restored`
		);
	}

	// A creation the last run started and never recorded: the task may be on the target without the journal knowing. Look for it by
	// title (and by the instant: the source's when the target keeps it, else not before the last task the target had then, on the
	// target's own clock); one match is taken back,
	// none means it never happened, several are not guessed.
	const adopted = new Set<string>();
	const pending = journal?.pending;
	if (pending !== undefined && sourceIds.has(pending.sourceId) && !entries.has(pending.sourceId)) {
		const mapped = mappedById.get(pending.sourceId)!;
		const taken = new Set([...entries.values()].map(entry => entry.target));
		const candidates = targetSummaries.filter(
			summary =>
				!taken.has(summary.id) &&
				summary.title === mapped.title &&
				(target.traits.keepsCreatedAt
					? summary.createdAt === mapped.createdAt
					: pending.after === undefined || summary.createdAt >= pending.after)
		);
		const label = `the earlier run stopped while creating "${mapped.title}" (task ${pending.sourceId})`;
		if (candidates.length === 1) {
			entries.set(pending.sourceId, { target: candidates[0]!.id, phase: 'created' });
			adopted.add(pending.sourceId);
			notes.push(`${label}: found on the target as ${candidates[0]!.id}; it is taken back and completed`);
		} else if (candidates.length === 0) {
			notes.push(`${label}: no such task on the target, it is created again`);
		} else {
			throw new MigrationRefusedError(
				`${label}, and ${candidates.length} tasks of the target could be it: ${candidates.map(candidate => candidate.id).join(', ')}`,
				'Delete the one that is not it on the target (the others stay), or all of them to have it created again, then run again with --resume.'
			);
		}
	}

	const tasks: PlannedTask[] = hierarchy.order.map(sourceId => {
		const mapped = mappedById.get(sourceId)!;
		const parentSourceId = hierarchy.parentOf.get(sourceId);
		const entry = entries.get(sourceId);
		if (entry === undefined)
			return { mapped, ...(parentSourceId === undefined ? {} : { parentSourceId }), state: 'new' };
		return {
			mapped,
			...(parentSourceId === undefined ? {} : { parentSourceId }),
			state: entry.phase === 'done' ? 'done' : 'resume',
			...(adopted.has(sourceId) ? { adopted: true as const } : {}),
			targetId: entry.target,
			phase: entry.phase,
		};
	});

	// 4. Notes that lose nothing.
	const references = countReferences(
		tasks.map(task => task.mapped),
		sourceIds
	);
	if (references > 0) {
		notes.push(
			`${references} reference(s) to task ids appear in titles, descriptions or comments; ids change on the target and texts are never rewritten`
		);
	}
	if (!caps.meta) {
		notes.push(
			'the target holds no metadata, so a second run recognises migrated tasks by the journal only (keep migrate-journal-*.json in the target data folder)'
		);
	}
	const done = tasks.filter(task => task.state === 'done').length;
	const resumed = tasks.filter(task => task.state === 'resume').length;
	if (done + resumed > 0) {
		notes.push(`${done} task(s) are already migrated and skipped${resumed > 0 ? `, ${resumed} are finished` : ''}`);
	}
	if (journal !== undefined && journal.status !== 'completed' && !options.resume) {
		notes.push('an earlier run did not finish: add --resume to continue it');
	}

	const estimate = estimateWrites(tasks, source, target, { source: records.length, targetScan: scanned });
	if (estimate.quotaPerHour !== undefined && estimate.requests > estimate.quotaPerHour * 0.9) {
		warnings.push(
			`the estimate (${estimate.requests} requests) is close to or over the hourly quota (${estimate.quotaPerHour}): the run will probably stop on the rate limit and tell you when to continue (--resume)`
		);
	}
	return {
		tasks,
		losses,
		blocking,
		notes,
		warnings,
		estimate,
		vanished,
		targetClock: latestInstant(targetSummaries),
	};
}

/** Maps source id -> target id for the target tasks that carry a `migratedFrom` marker of this source project. */
async function scanMarkers(
	backend: TaskBackend,
	summaries: readonly TaskSummary[],
	sourceProjectId: string
): Promise<Map<string, string>> {
	const found = new Map<string, string>();
	const prefix = `${sourceProjectId}/`;
	const records = await readRecords(
		backend,
		summaries.map(summary => summary.id)
	);
	for (const record of records) {
		const marker = record.meta?.[MIGRATED_FROM_KEY];
		if (marker === undefined || !marker.startsWith(prefix)) continue;
		const sourceId = marker.slice(prefix.length);
		if (!found.has(sourceId)) found.set(sourceId, record.id);
	}
	return found;
}

/** True when the phase reached is before `phase` (or nothing was done). */
export function before(reached: Phase | undefined, phase: Phase): boolean {
	return reached === undefined || PHASES.indexOf(reached) < PHASES.indexOf(phase);
}

/** The latest creation instant of the summaries (ISO instants sort as text), or undefined for none. */
function latestInstant(summaries: readonly TaskSummary[]): string | undefined {
	return summaries.reduce<string | undefined>(
		(latest, summary) => (latest === undefined || summary.createdAt > latest ? summary.createdAt : latest),
		undefined
	);
}
