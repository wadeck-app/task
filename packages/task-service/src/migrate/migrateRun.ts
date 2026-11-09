// `task migrate` between any two backends, through the async port only (design 1.8). Plan first (reads, loss table, dry run stops there),
// then three passes over the tasks (create + fields, links, comments), then a read-back of everything the run touched. Sequential
// awaits throughout, never Promise.all on writes. The source is only read; a task of the target is only created or completed by this run
// (a field a person set on it is never replaced), and the journal says after every creation which target task a source task became.
import * as path from 'node:path';

import { RateLimitedError } from '@wadeck-app/task-core';
import type { VersionedRecord } from '@wadeck-app/task-core';

import { describeError } from '../describeError.js';
import type { TaskEvent, TaskProjectEnv } from '../events.js';
import { checkAllowLoss } from './lossLedger.js';
import { MIGRATED_FROM_KEY, commentMarker } from './mapTask.js';
import { MigrationRefusedError } from './migrateErrors.js';
import { PHASES, acquireLock, journalFileName, readJournal, writeJournal } from './migrateJournal.js';
import type { Journal, Phase } from './migrateJournal.js';
import { before, buildPlan, readRecords } from './migratePlan.js';
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
} from './migrateTypes.js';
import { compare } from './migrateVerify.js';
import type { Expectation } from './migrateVerify.js';

export interface RunMigrationInput {
	source: MigrationEndpoint;
	target: MigrationEndpoint;
	/** The folder of the journal and the lock: the data folder of the target project. */
	journalDir: string;
	options: MigrationOptions;
	/** The command that continues a stopped run, printed in the result. */
	resumeCommand: string;
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
	private lastSave = 0;

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

/** Fills what the target task lacks of the planned fields; a field already set (by an earlier run or a person) is left alone. */
async function fillFields(
	run: Run,
	planned: PlannedTask,
	targetId: string,
	current: VersionedRecord
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
	if (mapped.type !== undefined && record.type === undefined) {
		record = await backend.setType(targetId, mapped.type);
		run.emit({
			name: 'onTaskTypeChanged',
			payload: { taskId: targetId, oldType: undefined, newType: mapped.type, ...env },
		});
	}
	for (const label of mapped.labels) {
		if ((record.labels ?? []).includes(label)) continue;
		record = await backend.addLabel(targetId, label);
		run.emit({ name: 'onTaskLabelAdded', payload: { taskId: targetId, label, ...env } });
	}
	for (const [key, value] of Object.entries(mapped.meta)) {
		if (record.meta !== undefined && Object.hasOwn(record.meta, key)) continue;
		record = await backend.setMeta(targetId, key, value);
		run.emit({
			name: 'onTaskMetaChanged',
			payload: { taskId: targetId, key, oldValue: undefined, newValue: value, ...env },
		});
	}
	return record;
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
			record = await backend.create({
				title: mapped.title,
				status: mapped.status,
				...(parentId === undefined ? {} : { parentId }),
				...(mapped.description === undefined ? {} : { description: mapped.description }),
				...(mapped.createdAt === undefined ? {} : { createdAt: mapped.createdAt }),
			});
			// Written at once: from here on a second run knows this task exists.
			run.journal.tasks[sourceId] = { target: record.id, phase: 'created' };
			delete run.journal.pending;
			if (run.targetClock === undefined || record.createdAt > run.targetClock) run.targetClock = record.createdAt;
			run.save(true);
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
					type: record.type,
					labels: record.labels ?? [],
					...run.env,
				},
			});
		} else {
			record = await backend.get(run.targetOf(sourceId));
			action = 'resumed';
		}
		run.touched.add(sourceId);
		run.records.set(sourceId, await fillFields(run, planned, record.id, record));
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

/** Pass 4: every task the run wrote to is read again and compared with the plan. */
async function verifyPass(run: Run): Promise<MigrationMismatch[]> {
	const { plan } = run;
	const target = run.target;
	run.step = 'verify';
	run.currentSourceId = undefined;
	const checked = plan.tasks.filter(planned => run.touched.has(planned.mapped.sourceId));
	const mismatches: MigrationMismatch[] = [];
	for (let start = 0; start < checked.length; start += VERIFY_CHUNK) {
		const chunk = checked.slice(start, start + VERIFY_CHUNK);
		const records = await readRecords(
			target.backend,
			chunk.map(planned => run.targetOf(planned.mapped.sourceId))
		);
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
	if (source.project.id === target.project.id) {
		throw new MigrationRefusedError(
			`the source and the target are the same project (${source.project.name})`,
			'Migrate between two registered projects: --from <source project> --to <other project>. Register the second with the project CLI: project add <dir>.'
		);
	}
	checkOptions(options);

	const clock = input.now ?? Date.now;
	const journalFile = path.join(input.journalDir, journalFileName(source.project.id, target.project.id));
	const existing = readJournal(journalFile, { fromId: source.project.id, toId: target.project.id });
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

	const lock = options.dryRun
		? undefined
		: acquireLock(
				input.journalDir,
				{
					pid: input.pid ?? process.pid,
					startedAt: new Date(clock()).toISOString(),
					from: source.project.id,
					to: target.project.id,
				},
				input.isAlive
			);
	let releaseWarning: string | undefined;
	try {
		const plan = await buildPlan({ source, target, options, journal: existing, onProgress: input.onProgress });
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

		if (options.dryRun || plan.blocking.length > 0) {
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
				status: options.dryRun ? 'dry-run' : 'blocked',
				counts,
				warnings: plan.warnings,
				idMap: plan.tasks.flatMap(planned =>
					planned.targetId === undefined
						? []
						: [{ source: planned.mapped.sourceId, target: planned.targetId }]
				),
				events: [],
			};
		}

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
				};
			}
		}
		journal.status = 'running';
		delete journal.lastError;
		// The plan resolved the creation the last run left open (taken back, or never happened).
		delete journal.pending;
		const run = new Run(input, plan, journal, journalFile);
		if (lock?.tookOver !== undefined) run.warnings.push(lock.tookOver);
		run.save(true);

		let status: MigrationStatus = 'completed';
		let failure: MigrationFailure | undefined;
		let retryAt: string | undefined;
		let verification: MigrationResult['verification'];
		try {
			await createPass(run);
			await linkPass(run);
			await commentPass(run);
			const mismatches = await verifyPass(run);
			verification = { checked: run.touched.size, mismatches };
			if (mismatches.length > 0) {
				status = 'failed';
				failure = {
					step: 'verify',
					message: `${mismatches.length} difference(s) between what was written and what the target holds`,
					hint: 'The migration wrote everything it was asked to; the differences are listed. A forge may normalise a text; check those tasks and fix by hand where it matters.',
				};
			}
			journal.status = 'completed';
		} catch (error) {
			failure = failureOf(error, run.currentSourceId, run.step);
			if (error instanceof RateLimitedError) {
				status = 'rate-limited';
				retryAt = error.retryAt?.toISOString();
			} else {
				status = 'failed';
				run.counts.failed = 1;
			}
			journal.status = 'stopped';
			journal.lastError = {
				...(failure.sourceId === undefined ? {} : { sourceId: failure.sourceId }),
				step: failure.step,
				message: failure.message,
			};
		}
		run.save(true);

		// Counts, from what the journal ends up holding: a task an earlier run had created and this one finished is "resumed".
		for (const planned of plan.tasks) {
			const finished = journal.tasks[planned.mapped.sourceId]?.phase === 'done';
			if (planned.state === 'done') run.counts.skipped++;
			else if (!finished) run.counts.remaining++;
			else if (planned.state === 'resume') run.counts.resumed++;
		}
		for (const notice of target.takeNotices?.() ?? []) run.warnings.push(`target: ${notice.text}`);
		if (run.counts.created + run.counts.resumed + run.counts.failed > 0) {
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
		releaseWarning = lock?.release();
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
			...(failure !== undefined && failure.step !== 'verify' ? { resumeCommand: input.resumeCommand } : {}),
			...(failure === undefined ? {} : { failure }),
		};
	} finally {
		// Idempotent: the success path already released it.
		lock?.release();
	}
}
