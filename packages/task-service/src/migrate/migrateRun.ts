// `task migrate` between any two backends, through the async port only (design 1.8). Plan first (reads, loss table, dry run stops there),
// then three passes over the tasks (create + fields, links, comments), then a read-back of everything the run touched. Sequential
// awaits throughout, never Promise.all on writes. The source is only read; a task of the target is only created or completed by this run
// (a field a person set on it is never replaced), and the journal says after every creation which target task a source task became.
import * as path from 'node:path';

import { RateLimitedError } from '@wadeck-app/task-core';
import type { MigratedCreateInput, ResolvedTask, VersionedRecord } from '@wadeck-app/task-core';

import { describeError } from '../describeError.js';
import type { TaskEvent, TaskProjectEnv } from '../events.js';
import { checkAllowLoss } from './lossLedger.js';
import { MIGRATED_FROM_KEY, commentMarker } from './mapTask.js';
import { MigrationRefusedError, MigrationStateError } from './migrateErrors.js';
import {
	PHASES,
	acquireLock,
	inPlaceJournalFileName,
	journalFileName,
	readJournal,
	writeIdMap,
	writeJournal,
} from './migrateJournal.js';
import type { HeldLock, Journal, Phase } from './migrateJournal.js';
import { before, buildPlan, listAll, readRecords } from './migratePlan.js';
import { contentHash, contentParts, differingParts } from './sourceContent.js';
import type { MigrationPlan, PlannedTask } from './migratePlan.js';
import { LOSS_GROUPS, LOSS_KINDS } from './migrateTypes.js';
import type {
	MigrationCounts,
	MigrationEndpoint,
	MigrationFailure,
	MigrationMismatch,
	MigrationOptions,
	MigrationProgress,
	MigrationResult,
	MigrationStatus,
	TargetNotEmpty,
} from './migrateTypes.js';
import { compare } from './migrateVerify.js';
import type { Expectation, Observed } from './migrateVerify.js';

/**
 * In-place migration (one project, its storage changes): what the engine needs besides the two endpoints. The two endpoints carry the
 * SAME project id; the journal is the in-place one; the id map is saved before the switch; the switch comes last.
 */
export interface InPlaceHooks {
	/** What the run migrates to: hash, parts, storage location (stored in the journal; the caller decides what a change of it means). */
	target: { hash: string; parts: Record<string, string>; location: string };
	/** Where the tasks are read from (kind and storage location), stored in the journal: a resume with another source is refused. */
	source: { kind: string; location: string };
	/** Where the persistent id map is written (atomically, after every creation). */
	idMapFile: string;
	/** Do not read the journal on disk (a dry run next to a finished run, or to one of another target). */
	ignoreJournal?: boolean;
	/**
	 * Replaces the config of the project by the draft. Called once, after every task is written and read back with no difference (or the
	 * differences accepted), the source is unchanged since the plan, and the id map and the journal are saved; idempotent (a config
	 * already replaced is left alone). A throw is a failure of step `switch`.
	 */
	switchConfig: (markStarted: (started: boolean) => void) => void | Promise<void>;
	/**
	 * Called once, right before the run's FIRST write (after the plan, the loss check and the lock): where the caller moves the files of
	 * an earlier finished migration out of the way. A dry run, a refused or a blocked run never gets here.
	 */
	beforeWrite?: () => void | Promise<void>;
}

export interface RunMigrationInput {
	source: MigrationEndpoint;
	target: MigrationEndpoint;
	/** The folder of the journal and the lock: the data folder of the target project. */
	journalDir: string;
	options: MigrationOptions;
	/** Set for `task migrate --in-place`: see {@link InPlaceHooks}. */
	inPlace?: InPlaceHooks;
	/** The command that continues a stopped run, printed in the result. */
	resumeCommand: string;
	/** A lock the caller already holds (it took it before its own checks); the caller releases it, the engine never does. Default: take it here and release it. */
	heldLock?: HeldLock;
	onProgress?: (progress: MigrationProgress) => void;
	/** Clock for the journal (ms). Default Date.now. */
	now?: () => number;
	pid?: number;
	/** Whether a process exists (the lock of a dead one is taken over). Default: a signal 0. */
	isAlive?: (pid: number) => boolean;
}

/** At most this often a journal change that cannot cause a duplicate is written; a creation is written at once. */
const JOURNAL_INTERVAL_MS = 250;
const VERIFY_CHUNK = 25;

function side(endpoint: MigrationEndpoint): { id: string; name: string; kind: string } {
	return { id: endpoint.project.id, name: endpoint.project.name, kind: endpoint.backend.kind };
}

function emptyCounts(source: number): MigrationCounts {
	return { source, created: 0, resumed: 0, skipped: 0, failed: 0, remaining: 0 };
}

/** The options as the engine accepts them: unknown `--allow-loss` names are an error that lists the valid ones. */
function checkOptions(options: MigrationOptions): void {
	const { unknown } = checkAllowLoss(options.allowLoss);
	if (unknown.length > 0) {
		throw new MigrationRefusedError(
			`unknown loss kind${unknown.length === 1 ? '' : 's'} for --allow-loss: ${unknown.join(', ')}`,
			`Valid kinds: ${LOSS_KINDS.join(', ')}; groups: ${LOSS_GROUPS.join(', ')} (all = every kind). \`task migrate --dry-run\` prints the kinds that apply.`
		);
	}
}

/** The state of one run: what it created, what it touched, the journal and the events. */
class Run {
	readonly counts: MigrationCounts;
	readonly warnings: string[];
	readonly events: TaskEvent[] = [];
	/** Source tasks created by this run: nothing of them needs reading back before it is written. */
	readonly fresh = new Set<string>();
	/** Source tasks this run wrote to (created or completed): the read-back checks these. */
	readonly touched = new Set<string>();
	/** The last record of a task created by this run (spares a read in the next pass). */
	readonly records = new Map<string, VersionedRecord>();
	/** The source task the run is working on, for the failure report. */
	currentSourceId: string | undefined;
	step = 'create';
	/** The latest creation instant on the target (its own clock): what a lost creation is not older than. */
	targetClock: string | undefined;
	/** True when this run replaced the config (in-place). */
	switchedNow = false;
	private lastSave = 0;
	private lastMapSave = 0;
	/** The id map file is behind the journal (true at the start: the first write repairs a map an earlier crash left behind). */
	private mapDirty = true;
	/** In place: the journal could not be saved after the config was replaced. */
	bookkeepingPending = false;

	/** The journal holds a task the id map file does not: the next {@link saveIdMap} writes it. */
	markMapDirty(): void {
		this.mapDirty = true;
	}

	/**
	 * Reads the notices both sides kept since the last call. The ones that are not `stale` become warnings; the texts of the `stale` ones
	 * (a cached answer served because the system could not be reached) are returned.
	 */
	collectNotices(): string[] {
		const stale: string[] = [];
		for (const [label, endpoint] of [
			['source', this.input.source],
			['target', this.input.target],
		] as const) {
			for (const notice of endpoint.takeNotices?.() ?? []) {
				if (notice.kind === 'stale') {
					stale.push(`${label}: ${notice.text}`);
				} else if (!this.warnings.includes(`${label}: ${notice.text}`)) {
					this.warnings.push(`${label}: ${notice.text}`);
				}
			}
		}
		return stale;
	}

	constructor(
		readonly input: RunMigrationInput,
		readonly plan: MigrationPlan,
		readonly journal: Journal,
		readonly journalFile: string
	) {
		this.counts = emptyCounts(plan.tasks.length);
		this.targetClock = plan.targetClock;
		this.warnings = [...plan.warnings];
	}

	get target(): MigrationEndpoint {
		return this.input.target;
	}

	get env(): TaskProjectEnv {
		const { id, name, path: projectPath } = this.target.project;
		return {
			taskProjectId: id,
			taskProjectName: name,
			...(projectPath === undefined ? {} : { taskProjectPath: projectPath }),
		};
	}

	progress(progress: MigrationProgress): void {
		this.input.onProgress?.(progress);
	}

	/** Writes the journal now, or at most every {@link JOURNAL_INTERVAL_MS} unless `force`. */
	save(force: boolean): void {
		const now = (this.input.now ?? Date.now)();
		if (!force && now - this.lastSave < JOURNAL_INTERVAL_MS) return;
		this.lastSave = now;
		this.journal.updatedAt = new Date(now).toISOString();
		writeJournal(this.journalFile, this.journal);
	}

	/** In-place: the id map as the journal knows it now, written whole and atomically (creation order). */
	saveIdMap(force = false): void {
		const file = this.input.inPlace?.idMapFile;
		if (file === undefined) return;
		const now = (this.input.now ?? Date.now)();
		// The same throttle as the journal; nothing to write when the journal holds nothing new since the last write.
		if (!force && now - this.lastMapSave < JOURNAL_INTERVAL_MS) return;
		if (!this.mapDirty) return;
		writeIdMap(
			file,
			Object.entries(this.journal.tasks).map(([from, entry]) => ({ from, to: entry.target }))
		);
		// Only once the file is there: a write that failed is retried by the next forced save.
		this.lastMapSave = now;
		this.mapDirty = false;
	}

	targetOf(sourceId: string): string {
		const entry = this.journal.tasks[sourceId];
		if (entry === undefined) throw new Error(`internal error: task ${sourceId} has no target yet`);
		return entry.target;
	}

	phaseOf(sourceId: string): Phase | undefined {
		return this.journal.tasks[sourceId]?.phase;
	}

	advance(sourceId: string, phase: Phase): void {
		const entry = this.journal.tasks[sourceId];
		if (entry === undefined) throw new Error(`internal error: task ${sourceId} has no target yet`);
		if (PHASES.indexOf(entry.phase) < PHASES.indexOf(phase)) {
			entry.phase = phase;
			this.save(false);
		}
	}

	emit(event: TaskEvent): void {
		if (this.input.options.emitEvents) this.events.push(event);
	}
}

/**
 * Fills what the target task lacks of the planned fields; a field already set (by an earlier run or a person) is left alone.
 * `carried`: the task was just created by this run with its fields in the creation call (createMigrated): a field found in place was
 * written by this run, so its event is raised as when the field was a write of its own; only what the creation did not carry is written.
 */
async function fillFields(
	run: Run,
	planned: PlannedTask,
	targetId: string,
	current: VersionedRecord,
	carried = false
): Promise<VersionedRecord> {
	const { mapped } = planned;
	const backend = run.target.backend;
	const env = run.env;
	let record = current;

	// A task found after a lost answer may lack what the creation does after the request (its parent, its final status).
	if (planned.adopted === true) {
		if (planned.parentSourceId !== undefined && record.parentId === undefined) {
			record = await backend.setParent(targetId, run.targetOf(planned.parentSourceId));
		}
		if (record.status !== mapped.status) record = await backend.updateStatus(targetId, mapped.status);
	}
	if (backend.capabilities.meta && record.meta?.[MIGRATED_FROM_KEY] !== mapped.qualifiedId) {
		record = await backend.setMeta(targetId, MIGRATED_FROM_KEY, mapped.qualifiedId);
	}
	if (mapped.type !== undefined && (record.type === undefined || (carried && record.type === mapped.type))) {
		if (record.type === undefined) record = await backend.setType(targetId, mapped.type);
		run.emit({
			name: 'onTaskTypeChanged',
			payload: { taskId: targetId, oldType: undefined, newType: mapped.type, ...env },
		});
	}
	if (
		mapped.priority !== undefined &&
		(record.priority === undefined || (carried && record.priority === mapped.priority))
	) {
		if (record.priority === undefined) record = await backend.setPriority!(targetId, mapped.priority);
		run.emit({
			name: 'onTaskPriorityChanged',
			payload: { taskId: targetId, oldPriority: undefined, newPriority: mapped.priority, ...env },
		});
	}
	if (mapped.assignee !== undefined && record.assignee === undefined) {
		record = await backend.setAssignee!(targetId, mapped.assignee);
		run.emit({
			name: 'onTaskAssigneeChanged',
			payload: { taskId: targetId, oldAssignee: undefined, newAssignee: mapped.assignee, ...env },
		});
	}
	for (const label of mapped.labels) {
		const held = (record.labels ?? []).includes(label);
		if (held && !carried) continue;
		if (!held) record = await backend.addLabel(targetId, label);
		run.emit({ name: 'onTaskLabelAdded', payload: { taskId: targetId, label, ...env } });
	}
	for (const [key, value] of Object.entries(mapped.meta)) {
		const held = record.meta !== undefined && Object.hasOwn(record.meta, key);
		if (held && !(carried && record.meta![key] === value)) continue;
		if (!held) record = await backend.setMeta(targetId, key, value);
		run.emit({
			name: 'onTaskMetaChanged',
			payload: { taskId: targetId, key, oldValue: undefined, newValue: value, ...env },
		});
	}
	return record;
}

/**
 * What a new task's creation carries when the target backend writes fields IN the creation (its traits say `foldsCreate`): the type, the
 * labels, the priority and the metadata with the migration marker. Undefined when the backend does not, or the task has none of them
 * (then a plain create). What the backend leaves out of the creation is found missing in the record and written by fillFields.
 */
function carriedFields(run: Run, planned: PlannedTask): Omit<MigratedCreateInput, 'title' | 'status'> | undefined {
	if (run.target.traits.foldsCreate !== true) return undefined;
	const { mapped } = planned;
	const meta = run.target.backend.capabilities.meta
		? { [MIGRATED_FROM_KEY]: mapped.qualifiedId, ...mapped.meta }
		: mapped.meta;
	const carried = {
		...(mapped.type === undefined ? {} : { type: mapped.type }),
		...(mapped.labels.length === 0 ? {} : { labels: mapped.labels }),
		...(mapped.priority === undefined ? {} : { priority: mapped.priority }),
		...(Object.keys(meta).length === 0 ? {} : { meta }),
	};
	return Object.keys(carried).length === 0 ? undefined : carried;
}

/** Pass 1: parents before children, create (when the target has no task for it yet) and fill the fields. */
async function createPass(run: Run): Promise<void> {
	const { plan } = run;
	const backend = run.target.backend;
	run.step = 'create';
	let position = 0;
	for (const planned of plan.tasks) {
		position++;
		const { mapped } = planned;
		const sourceId = mapped.sourceId;
		run.currentSourceId = sourceId;
		const progress = {
			stage: 'create' as const,
			done: position,
			total: plan.tasks.length,
			sourceId,
			title: mapped.title,
		};
		if (planned.state !== 'new' && !before(run.phaseOf(sourceId), 'fielded')) {
			run.progress({
				...progress,
				targetId: run.targetOf(sourceId),
				action: planned.state === 'done' ? 'skipped' : 'resumed',
			});
			continue;
		}
		let record: VersionedRecord;
		let action: 'created' | 'resumed';
		// The task was created with its fields in the creation call (see carriedFields).
		let folded = false;
		if (planned.state === 'new') {
			const parentId = planned.parentSourceId === undefined ? undefined : run.targetOf(planned.parentSourceId);
			// Written before the request: if the answer is lost, the next run knows what to look for on the target.
			run.journal.pending = {
				sourceId,
				title: mapped.title,
				at: new Date((run.input.now ?? Date.now)()).toISOString(),
				...(run.targetClock === undefined ? {} : { after: run.targetClock }),
			};
			run.save(true);
			const creation = {
				title: mapped.title,
				status: mapped.status,
				...(parentId === undefined ? {} : { parentId }),
				...(mapped.description === undefined ? {} : { description: mapped.description }),
				...(mapped.createdAt === undefined ? {} : { createdAt: mapped.createdAt }),
			};
			const carries = carriedFields(run, planned);
			if (carries === undefined) {
				record = await backend.create(creation);
			} else {
				if (typeof backend.createMigrated !== 'function') {
					throw new Error(
						`internal error: the ${backend.kind} backend declares foldsCreate but has no createMigrated`
					);
				}
				record = await backend.createMigrated({ ...creation, ...carries });
			}
			folded = carries !== undefined;
			// Written at once: from here on a second run knows this task exists.
			run.journal.tasks[sourceId] = {
				target: record.id,
				phase: 'created',
				...(run.input.inPlace === undefined ? {} : contentOf(run.plan, sourceId)),
			};
			delete run.journal.pending;
			if (run.targetClock === undefined || record.createdAt > run.targetClock) run.targetClock = record.createdAt;
			run.save(true);
			run.markMapDirty();
			run.saveIdMap();
			run.fresh.add(sourceId);
			run.counts.created++;
			action = 'created';
			run.emit({
				name: 'onTaskCreated',
				payload: {
					taskId: record.id,
					status: record.status,
					description: record.description ?? record.title,
					parentId: record.parentId,
					// The creation describes the task before its fields, as when each was a write of its own; they follow as events.
					type: folded ? undefined : record.type,
					labels: folded ? [] : (record.labels ?? []),
					...run.env,
				},
			});
		} else {
			record = await backend.get(run.targetOf(sourceId));
			action = 'resumed';
		}
		run.touched.add(sourceId);
		run.records.set(sourceId, await fillFields(run, planned, record.id, record, folded));
		run.advance(sourceId, 'fielded');
		run.progress({ ...progress, targetId: record.id, action });
	}
}

/** Pass 2: the links, now that both ends exist. */
async function linkPass(run: Run): Promise<void> {
	const { plan } = run;
	const backend = run.target.backend;
	run.step = 'links';
	let position = 0;
	for (const planned of plan.tasks) {
		position++;
		const { mapped } = planned;
		const sourceId = mapped.sourceId;
		run.currentSourceId = sourceId;
		if (!before(run.phaseOf(sourceId), 'linked')) continue;
		const targetId = run.targetOf(sourceId);
		let written = 0;
		if (mapped.links.length > 0) {
			let record = run.records.get(sourceId) ?? (await backend.get(targetId));
			for (const link of mapped.links) {
				const to = run.targetOf(link.sourceTarget);
				if ((record.links ?? []).some(held => held.type === link.type && held.target === to)) continue;
				const statusBefore = record.status;
				record = await backend.addLink(targetId, link.type, to);
				written++;
				run.emit({
					name: 'onTaskLinked',
					payload: { taskId: targetId, linkType: link.type, targetId: to, ...run.env },
				});
				// A target may change the status with the link (GitHub closes an issue it marks as a duplicate): put back the planned one.
				if (statusBefore === mapped.status && record.status !== mapped.status) {
					record = await backend.updateStatus(targetId, mapped.status);
				}
			}
			run.records.set(sourceId, record);
			if (written > 0) run.touched.add(sourceId);
		}
		run.advance(sourceId, 'linked');
		if (written > 0) {
			run.progress({
				stage: 'links',
				done: position,
				total: plan.tasks.length,
				sourceId,
				targetId,
				title: mapped.title,
				action: 'linked',
				items: written,
			});
		}
	}
}

/** Pass 3: the comments (and the note), each recognised by the marker in its first line, so a task is never commented twice. */
async function commentPass(run: Run): Promise<void> {
	const { plan } = run;
	const backend = run.target.backend;
	run.step = 'comments';
	let position = 0;
	for (const planned of plan.tasks) {
		position++;
		const { mapped } = planned;
		const sourceId = mapped.sourceId;
		run.currentSourceId = sourceId;
		if (!before(run.phaseOf(sourceId), 'done')) continue;
		const targetId = run.targetOf(sourceId);
		let written = 0;
		if (mapped.comments.length > 0) {
			// A task created by this run has no comment yet; any other may have some (an earlier run stopped halfway).
			const existing = run.fresh.has(sourceId)
				? []
				: ((await backend.get(targetId)).comments ?? []).map(comment => comment.text);
			for (const comment of mapped.comments) {
				const marker = commentMarker(mapped.qualifiedId, comment.key);
				if (existing.some(text => text.includes(marker))) continue;
				const change = await backend.addComment(
					targetId,
					comment.text,
					comment.author === undefined ? {} : { author: comment.author }
				);
				written++;
				run.emit({
					name: 'onTaskCommentAdded',
					payload: {
						taskId: targetId,
						commentId: change.comment.id,
						text: change.comment.text,
						author: change.comment.author,
						...run.env,
					},
				});
			}
			if (written > 0) run.touched.add(sourceId);
		}
		run.advance(sourceId, 'done');
		if (written > 0) {
			run.progress({
				stage: 'comments',
				done: position,
				total: plan.tasks.length,
				sourceId,
				targetId,
				title: mapped.title,
				action: 'commented',
				items: written,
			});
		}
	}
}

/**
 * Reads the tasks of a chunk back from the target. A backend whose fields-only read (`resolve`) is cheaper than the whole record (its
 * cost trait says so: github, where the record is the issue, its timeline, its comments and its blockers) is asked for it for a task
 * with no link and no comment to check, since the check compares nothing else; every other task, and every other backend, is read whole
 * (a remote backend answers a whole chunk in one request).
 */
async function readBack(run: Run, chunk: readonly PlannedTask[]): Promise<Observed[]> {
	const backend = run.target.backend;
	const cost = run.target.traits.cost;
	const cheap = cost?.resolve !== undefined && cost.read !== undefined && cost.resolve.requests < cost.read.requests;
	const needsWhole = (planned: PlannedTask): boolean =>
		!cheap || planned.mapped.links.length > 0 || planned.mapped.comments.length > 0;
	const whole = await readRecords(
		backend,
		chunk.filter(needsWhole).map(planned => run.targetOf(planned.mapped.sourceId))
	);
	let next = 0;
	const answers: Observed[] = [];
	for (const planned of chunk) {
		if (needsWhole(planned)) answers.push(whole[next++]!);
		else answers.push((await backend.resolve(run.targetOf(planned.mapped.sourceId))) as ResolvedTask);
	}
	return answers;
}

/** Pass 4: every task the run wrote to is read again and compared with the plan. */
async function verifyPass(run: Run): Promise<MigrationMismatch[]> {
	const { plan } = run;
	const target = run.target;
	run.step = 'verify';
	run.currentSourceId = undefined;
	// The switch of an in-place migration is the point of no return: every task is read back, not only what this run wrote.
	const checked = plan.tasks.filter(
		planned => run.input.inPlace !== undefined || run.touched.has(planned.mapped.sourceId)
	);
	const mismatches: MigrationMismatch[] = [];
	for (let start = 0; start < checked.length; start += VERIFY_CHUNK) {
		const chunk = checked.slice(start, start + VERIFY_CHUNK);
		const records = await readBack(run, chunk);
		chunk.forEach((planned, index) => {
			const sourceId = planned.mapped.sourceId;
			const expectation: Expectation = {
				mapped: planned.mapped,
				targetId: run.targetOf(sourceId),
				...(planned.parentSourceId === undefined
					? {}
					: { parentTargetId: run.targetOf(planned.parentSourceId) }),
				marker: target.backend.capabilities.meta,
				keepsCreatedAt: target.traits.keepsCreatedAt,
				links: planned.mapped.links.map(link => ({ type: link.type, target: run.targetOf(link.sourceTarget) })),
			};
			mismatches.push(...compare(expectation, records[index]!));
			run.progress({
				stage: 'verify',
				done: start + index + 1,
				total: checked.length,
				sourceId,
				targetId: expectation.targetId,
				action: 'checked',
			});
		});
	}
	return mismatches;
}

function contentOf(plan: MigrationPlan, sourceId: string): { content?: string; parts?: Record<string, string> } {
	const known = plan.sourceContent.get(sourceId);
	return known === undefined ? {} : { content: known.hash, parts: known.parts };
}

interface SourceChanges {
	added: string[];
	failure: MigrationFailure;
	/** What `--accept-differences` records for the changed and removed tasks (never for an added one). */
	accepted: MigrationMismatch[];
}

/**
 * In place: what changed in the source since it was planned or copied, or undefined when nothing did. Every task is read again in full
 * and its content (everything a migration maps) is compared with what the journal remembers of the copy, else with the plan.
 */
async function sourceChanges(run: Run): Promise<SourceChanges | undefined> {
	const planned = run.plan.sourceContent;
	const source = run.input.source.backend;
	const summaries = await listAll(source);
	const records = await readRecords(
		source,
		summaries.map(summary => summary.id)
	);
	const added: string[] = [];
	const changed: Array<{ id: string; parts: string[] }> = [];
	const seen = new Set<string>();
	for (const record of records) {
		seen.add(record.id);
		const was = planned.get(record.id);
		if (was === undefined) {
			added.push(record.id);
			continue;
		}
		const now = contentParts(record);
		const entry = run.journal.tasks[record.id];
		const copied = entry?.content ?? was.hash;
		if (copied === contentHash(now)) continue;
		const copiedParts = entry?.parts ?? was.parts;
		changed.push({ id: record.id, parts: differingParts(copiedParts, now) });
	}
	const removed = [...planned.keys()].filter(id => !seen.has(id));
	if (added.length + changed.length + removed.length === 0) return undefined;
	const ids = (list: readonly string[]): string =>
		`${list.slice(0, 10).join(', ')}${list.length > 10 ? `, and ${list.length - 10} more` : ''}`;
	const changedText = changed
		.slice(0, 10)
		.map(entry => `${entry.id} (${entry.parts.join(', ')})`)
		.join(', ');
	const parts = [
		...(added.length === 0 ? [] : [`added: ${ids(added)}`]),
		...(changed.length === 0
			? []
			: [`changed: ${changedText}${changed.length > 10 ? `, and ${changed.length - 10} more` : ''}`]),
		...(removed.length === 0 ? [] : [`removed: ${ids(removed)}`]),
	];
	return {
		added,
		failure: {
			step: 'source-changed',
			message: `the source changed while the migration ran, so the config was NOT switched (${parts.join('; ')})`,
			hint: 'Nothing was switched. --resume copies the tasks that were added. A task that was already copied is never overwritten, so a CHANGED one keeps the version that was copied (re-migrate it by hand on the target) and a REMOVED one keeps its copy; the next runs stop on them again. To switch anyway, explicitly, add --accept-differences: the target keeps what was copied and the list is recorded in the journal.',
		},
		accepted: [
			...changed.map(entry => ({
				sourceId: entry.id,
				targetId: run.journal.tasks[entry.id]?.target ?? '',
				field: `source-changed: ${entry.parts.join(', ')}`,
				expected: 'the task as the source holds it now',
				actual: 'the task as it was copied',
			})),
			...removed.map(id => ({
				sourceId: id,
				targetId: run.journal.tasks[id]?.target ?? '',
				field: 'source-removed',
				expected: 'no task',
				actual: 'the copy made earlier stays on the target',
			})),
		],
	};
}

function failureOf(error: unknown, sourceId: string | undefined, step: string): MigrationFailure {
	const described = describeError(error);
	return {
		...(sourceId === undefined ? {} : { sourceId }),
		step,
		message: described.message,
		...(described.hint === undefined ? {} : { hint: described.hint }),
	};
}

/**
 * Migrates every task of `source` into `target`. Throws MigrationRefusedError / MigrationStateError when it cannot start (same
 * project, bad options, journal damaged or in the way, lock held); everything else is an answer: a dry run, a blocked plan, a run that
 * completed, stopped on a rate limit or failed (the journal then says how far it got, `resumeCommand` how to continue).
 */
export async function runMigration(input: RunMigrationInput): Promise<MigrationResult> {
	const { source, target, options } = input;
	if (input.inPlace === undefined && source.project.id === target.project.id) {
		throw new MigrationRefusedError(
			`the source and the target are the same project (${source.project.name})`,
			'Migrate between two registered projects: --from <source project> --to <other project>. Register the second with the project CLI: project add <dir>.'
		);
	}
	checkOptions(options);

	const clock = input.now ?? Date.now;
	const journalFile = path.join(
		input.journalDir,
		input.inPlace === undefined
			? journalFileName(source.project.id, target.project.id)
			: inPlaceJournalFileName(source.project.id)
	);
	const existing =
		input.inPlace?.ignoreJournal === true
			? undefined
			: readJournal(journalFile, { fromId: source.project.id, toId: target.project.id });
	if (!options.dryRun) {
		if (options.resume && existing === undefined) {
			throw new MigrationRefusedError(
				`nothing to resume: there is no journal for ${source.project.name} -> ${target.project.name} (${journalFile})`,
				'Run the migration without --resume.'
			);
		}
		if (!options.resume && existing !== undefined && existing.status !== 'completed') {
			const started = Object.keys(existing.tasks).length;
			const finished = Object.values(existing.tasks).filter(entry => entry.phase === 'done').length;
			throw new MigrationRefusedError(
				`an earlier migration of ${source.project.name} into ${target.project.name} did not finish (${finished} of ${started} started tasks complete${existing.lastError === undefined ? '' : `; it stopped on: ${existing.lastError.message}`})`,
				'Continue it with the same command plus --resume. Nothing is created twice.'
			);
		}
	}

	// Only the caller that took a lock releases it: a lock handed in stays until the caller is done with its contexts and its events.
	const ownLock = !options.dryRun && input.heldLock === undefined;
	const lock = options.dryRun
		? undefined
		: (input.heldLock ??
			acquireLock(
				input.journalDir,
				{
					pid: input.pid ?? process.pid,
					startedAt: new Date(clock()).toISOString(),
					from: source.project.id,
					to: target.project.id,
				},
				input.isAlive
			));
	let releaseWarning: string | undefined;
	try {
		const knownSource = existing?.inPlace?.source;
		if (input.inPlace !== undefined && existing?.inPlace !== undefined && knownSource === undefined) {
			throw new MigrationRefusedError(
				`the journal ${journalFile} of an earlier in-place run does not record the storage the tasks were read from (it predates source recording), so a resume cannot tell that config.yml still points there`,
				`Move ${journalFile} aside (the id map file stays as it is) and run again. The tasks that run copied are then unclaimed on the target: remove them first, or accept them with --allow-non-empty-target.`
			);
		}
		if (
			input.inPlace !== undefined &&
			knownSource !== undefined &&
			(knownSource.kind !== input.inPlace.source.kind || knownSource.location !== input.inPlace.source.location)
		) {
			throw new MigrationRefusedError(
				`this migration started reading the tasks of ${source.project.name} from ${knownSource.location} (${knownSource.kind}), and its config.yml now points to ${input.inPlace.source.location} (${input.inPlace.source.kind}): the tasks it copied are not the ones that source holds`,
				`Put config.yml back as it was when the run started (the storage it read the tasks from), then run the same command with --resume. If that run is abandoned, move ${journalFile} away and run again.`
			);
		}
		const plan = await buildPlan({ source, target, options, journal: existing, onProgress: input.onProgress });
		// In place, the target is the storage the project is about to use: tasks already there that this migration did not create (no journal
		// entry, no marker) would be duplicated by the copy. The list is the one the plan read.
		let targetNotEmpty: TargetNotEmpty | undefined;
		let acceptedForeignIds: string[] | undefined;
		if (input.inPlace !== undefined) {
			const claimed = new Set<string>([
				...Object.values(existing?.tasks ?? {}).map(entry => entry.target),
				...plan.tasks.flatMap(planned => (planned.targetId === undefined ? [] : [planned.targetId])),
			]);
			const acceptedBefore = existing?.inPlace?.acceptedForeignIds ?? [];
			const foreign = plan.targetSummaries.filter(
				summary => !claimed.has(summary.id) && !acceptedBefore.includes(summary.id)
			);
			if (foreign.length > 0) {
				if (options.allowNonEmptyTarget === true) {
					acceptedForeignIds = [...acceptedBefore, ...foreign.map(summary => summary.id)];
				} else {
					targetNotEmpty = {
						count: foreign.length,
						ids: foreign.slice(0, 10).map(summary => summary.id),
						hint: 'They may be the copy of an earlier migration that was rolled back, the old local files still in the data folder after a rollback, or the tasks of an existing repository or project. Copying now would duplicate them. Remove them from the target, or accept the duplicates with --allow-non-empty-target (their ids are recorded in the journal: a task that appears later is a new blocker).',
					};
					if (!options.dryRun) {
						throw new MigrationRefusedError(
							`the target already holds ${foreign.length} task${foreign.length === 1 ? '' : 's'} that this migration did not create and nothing claims (${targetNotEmpty.ids.join(', ')}${foreign.length > 10 ? ', ...' : ''})`,
							targetNotEmpty.hint
						);
					}
				}
			} else if (acceptedBefore.length > 0) {
				acceptedForeignIds = [...acceptedBefore];
			}
		}
		// A target read answered from a cache (the system was unreachable) proves nothing about what it holds: no write on it.
		const planStale: string[] = [];
		if (input.inPlace !== undefined) {
			for (const notice of target.takeNotices?.() ?? []) {
				if (notice.kind === 'stale') planStale.push(`target: ${notice.text}`);
				else plan.warnings.push(`target: ${notice.text}`);
			}
		}
		const blockers: string[] = [
			...plan.blocking,
			...(targetNotEmpty === undefined ? [] : ['targetNotEmpty']),
			...(planStale.length === 0 ? [] : ['stale-read']),
		];
		const base = {
			dryRun: options.dryRun,
			from: side(source),
			to: side(target),
			losses: plan.losses,
			blocking: plan.blocking,
			notes: plan.notes,
			estimate: plan.estimate,
			journal: journalFile,
		};
		const pending = plan.tasks.filter(planned => planned.state !== 'done').length;

		if (options.dryRun || plan.blocking.length > 0 || planStale.length > 0) {
			// Nothing is written: the counts say what a run would do (dry run) or that it did nothing (blocked).
			const counts = emptyCounts(plan.tasks.length);
			counts.skipped = plan.tasks.length - pending;
			if (options.dryRun) {
				counts.created = plan.tasks.filter(planned => planned.state === 'new').length;
				counts.resumed = plan.tasks.filter(planned => planned.state === 'resume').length;
			} else {
				counts.remaining = pending;
			}
			return {
				...base,
				status: options.dryRun ? 'dry-run' : planStale.length > 0 ? 'stopped' : 'blocked',
				counts,
				blocked: blockers.length > 0,
				blockers,
				...(planStale.length > 0 && !options.dryRun
					? {
							failure: {
								step: 'stale-read',
								message: `a read was answered from a cache because the system could not be reached, so the plan cannot be trusted yet (${planStale.join('; ')})`,
								hint: 'Nothing was written. Retry when the system is reachable: run the same command again.',
							},
							resumeCommand: input.resumeCommand,
						}
					: {}),
				...(input.inPlace === undefined
					? {}
					: { inPlace: { switched: false, idMapFile: input.inPlace.idMapFile } }),
				warnings: plan.warnings,
				idMap: plan.tasks.flatMap(planned =>
					planned.targetId === undefined
						? []
						: [{ source: planned.mapped.sourceId, target: planned.targetId }]
				),
				events: [],
				...(targetNotEmpty === undefined ? {} : { targetNotEmpty }),
			};
		}

		await input.inPlace?.beforeWrite?.();
		const journal: Journal = existing ?? {
			version: 1,
			from: { id: source.project.id, name: source.project.name },
			to: { id: target.project.id, name: target.project.name },
			startedAt: new Date(clock()).toISOString(),
			updatedAt: new Date(clock()).toISOString(),
			status: 'running',
			tasks: {},
		};
		for (const sourceId of plan.vanished) delete journal.tasks[sourceId];
		// Tasks found by their marker (no journal entry yet) join the journal: from now on it knows them.
		for (const planned of plan.tasks) {
			if (planned.targetId !== undefined && journal.tasks[planned.mapped.sourceId] === undefined) {
				journal.tasks[planned.mapped.sourceId] = {
					target: planned.targetId,
					phase: planned.phase ?? 'created',
					...(input.inPlace === undefined ? {} : contentOf(plan, planned.mapped.sourceId)),
				};
			}
		}
		journal.status = 'running';
		if (input.inPlace !== undefined) {
			// Once, here: a journal that is reused keeps what it knew of the switch (the caller sends a finished run elsewhere first).
			journal.inPlace = {
				targetHash: input.inPlace.target.hash,
				parts: input.inPlace.target.parts,
				location: input.inPlace.target.location,
				kinds: { from: source.backend.kind, to: target.backend.kind },
				switched: journal.inPlace?.switched ?? false,
				verified: false,
				// Reset: a run that comes back to the full path has not started a switch yet.
				switchStarted: false,
				source: input.inPlace.source,
				...(acceptedForeignIds === undefined ? {} : { acceptedForeignIds }),
			};
		}
		delete journal.lastError;
		// The plan resolved the creation the last run left open (taken back, or never happened).
		delete journal.pending;
		const run = new Run(input, plan, journal, journalFile);
		if (lock?.tookOver !== undefined) run.warnings.push(lock.tookOver);
		run.save(true);
		run.saveIdMap(true);

		let status: MigrationStatus = 'completed';
		let failure: MigrationFailure | undefined;
		let retryAt: string | undefined;
		let verification: MigrationResult['verification'];
		try {
			await createPass(run);
			await linkPass(run);
			await commentPass(run);
			const mismatches = await verifyPass(run);
			verification = { checked: input.inPlace === undefined ? run.touched.size : plan.tasks.length, mismatches };
			const inPlace = input.inPlace;
			const accept = inPlace !== undefined && options.acceptDifferences === true;
			let acceptedSource: MigrationMismatch[] = [];
			if (inPlace !== undefined) {
				run.step = 'switch';
				run.currentSourceId = undefined;
				// The source is read again, whole, before the read-back result is judged: it is the cause when both differ.
				const changes = await sourceChanges(run);
				// A read answered from a cache (the system was unreachable) proves nothing: never switch on it.
				const stale = run.collectNotices();
				if (stale.length > 0) {
					status = 'stopped';
					failure = {
						step: 'stale-read',
						message: `a read was answered from a cache because the system could not be reached, so the copy cannot be trusted yet (${stale.join('; ')})`,
						hint: 'Nothing was switched. Retry when the system is reachable: run the same command with --resume, every task is read back again.',
					};
				} else if (changes !== undefined) {
					if (changes.added.length > 0 || !accept) {
						status = 'stopped';
						failure = changes.failure;
					} else {
						acceptedSource = changes.accepted;
					}
				}
			}
			if (failure === undefined && mismatches.length > 0 && !accept) {
				status = 'failed';
				failure = {
					step: 'verify',
					message: `${mismatches.length} difference(s) between what was written and what the target holds`,
					hint:
						inPlace === undefined
							? 'The migration wrote everything it was asked to; the differences are listed. A forge may normalise a text; check those tasks and fix by hand where it matters.'
							: 'The config of the project was NOT switched. The differences are listed: fix those tasks by hand where it matters, then run again with --resume (every task is read back again before the switch). A difference that can never clear (a forge normalising a text) can be accepted with --accept-differences: the switch then happens, the target keeps the text as the forge holds it, and the differences are recorded in the journal and printed.',
				};
			}
			if (failure === undefined && inPlace !== undefined) {
				// Point of no return: everything is written and read back, the id map and the journal are saved; only now does the
				// project change storage.
				// A task whose source changed is recorded once, by that: its read-back differences are the same fact.
				const changedIds = new Set(acceptedSource.map(item => item.sourceId));
				const accepted = [
					...(accept ? mismatches.filter(item => !changedIds.has(item.sourceId)) : []),
					...acceptedSource,
				];
				journal.inPlace!.verified = true;
				if (accepted.length > 0) journal.inPlace!.acceptedDifferences = accepted;
				try {
					run.saveIdMap(true);
				} catch (error) {
					throw new MigrationStateError(
						`the id map ${inPlace.idMapFile} could not be written (${error instanceof Error ? error.message : String(error)}): the config was NOT switched, because a map that lags behind the journal would lose the old-id to new-id link`,
						'Fix the cause (disk, permissions), then run the same command with --resume: the map is rewritten from the journal and the read-back runs again.'
					);
				}
				run.save(true);
				await inPlace.switchConfig(started => {
					journal.inPlace!.switchStarted = started;
					run.save(true);
				});
				journal.inPlace!.switched = true;
				run.switchedNow = true;
			}
			journal.status = failure !== undefined && inPlace !== undefined ? 'stopped' : 'completed';
			if (journal.status === 'stopped' && failure !== undefined) {
				journal.lastError = { step: failure.step, message: failure.message };
			}
		} catch (error) {
			failure = failureOf(error, run.currentSourceId, run.step);
			if (error instanceof RateLimitedError) {
				status = 'rate-limited';
				retryAt = error.retryAt?.toISOString();
			} else {
				status = 'failed';
				if (run.step !== 'switch') run.counts.failed = 1;
			}
			journal.status = 'stopped';
			journal.lastError = {
				...(failure.sourceId === undefined ? {} : { sourceId: failure.sourceId }),
				step: failure.step,
				message: failure.message,
			};
		}
		try {
			run.save(true);
		} catch (error) {
			if (!run.switchedNow) throw error;
			// The config is already the draft: the answer must say so, and how to finish. The journal on disk still says verified and
			// switchStarted, with every task done: the next --resume completes the bookkeeping.
			run.bookkeepingPending = true;
			run.warnings.push(
				`the configuration was switched but the journal could not be saved: run the same command with --resume to finish the bookkeeping (${error instanceof Error ? error.message : String(error)})`
			);
		}

		try {
			run.saveIdMap(true);
		} catch (error) {
			run.warnings.push(
				`the id map ${input.inPlace?.idMapFile ?? ''} could not be written (${error instanceof Error ? error.message : String(error)}): --resume rewrites it from the journal`
			);
		}

		// Counts, from what the journal ends up holding: a task an earlier run had created and this one finished is "resumed".
		for (const planned of plan.tasks) {
			const finished = journal.tasks[planned.mapped.sourceId]?.phase === 'done';
			if (planned.state === 'done') run.counts.skipped++;
			else if (!finished) run.counts.remaining++;
			else if (planned.state === 'resume') run.counts.resumed++;
		}
		for (const text of run.collectNotices()) run.warnings.push(text);
		if (run.counts.created + run.counts.resumed + run.counts.failed > 0 || run.switchedNow) {
			run.events.push({
				name: 'onTasksMigrated',
				payload: {
					fromProjectId: source.project.id,
					fromProjectName: source.project.name,
					toProjectId: target.project.id,
					toProjectName: target.project.name,
					created: run.counts.created,
					resumed: run.counts.resumed,
					skipped: run.counts.skipped,
					failed: run.counts.failed,
					remaining: run.counts.remaining,
					complete: status === 'completed',
					...run.env,
				},
			});
		}
		if (input.inPlace !== undefined && run.switchedNow) {
			if (run.bookkeepingPending) {
				// The journal could not be saved: the --resume that finishes the bookkeeping raises the event, once.
				const at = run.events.findIndex(event => event.name === 'onTasksMigrated');
				if (at >= 0) run.events.splice(at, 1);
				run.warnings.push(
					'the summary event onTasksMigrated was not raised: the --resume that finishes the bookkeeping raises it'
				);
			} else if (run.events.some(event => event.name === 'onTasksMigrated')) {
				// Recorded when the result that carries the event is returned, so a later --resume does not raise it a second time.
				journal.inPlace!.summaryEventRaised = true;
				try {
					run.save(true);
				} catch (error) {
					run.warnings.push(
						`the summary event onTasksMigrated is raised, but the journal could not record it (${error instanceof Error ? error.message : String(error)}): a --resume that finishes the bookkeeping could raise it again`
					);
				}
			}
		}
		releaseWarning = ownLock ? lock?.release() : undefined;
		if (releaseWarning !== undefined) run.warnings.push(releaseWarning);
		return {
			...base,
			status,
			counts: run.counts,
			warnings: run.warnings,
			idMap: plan.tasks.flatMap(planned => {
				const entry = journal.tasks[planned.mapped.sourceId];
				return entry === undefined ? [] : [{ source: planned.mapped.sourceId, target: entry.target }];
			}),
			events: run.events,
			...(verification === undefined ? {} : { verification }),
			...(retryAt === undefined ? {} : { retryAt }),
			...(input.inPlace === undefined
				? {}
				: {
						inPlace: {
							switched: run.switchedNow,
							idMapFile: input.inPlace.idMapFile,
							...(run.bookkeepingPending ? { bookkeepingPending: true } : {}),
							...(run.switchedNow && journal.inPlace?.acceptedDifferences !== undefined
								? { acceptedDifferences: journal.inPlace.acceptedDifferences }
								: {}),
						},
					}),
			...(failure !== undefined && (failure.step !== 'verify' || input.inPlace !== undefined)
				? { resumeCommand: input.resumeCommand }
				: {}),
			...(failure === undefined ? {} : { failure }),
		};
	} finally {
		// Idempotent: the success path already released it. A lock the caller holds is the caller's to release.
		if (ownLock) lock?.release();
	}
}
