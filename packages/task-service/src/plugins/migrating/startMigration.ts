// `task strategy migrate start`: the plan for ALL the tasks of `current` against `new`, then, unless it is a dry run, the first writes of a
// migration. Works for any pair of strategies: what a task would lose is asked of the per-task copy of `task migrate` (the same loss
// ledger), what `new` needs is read from its capabilities, what a move costs from its traits.
//
// What a real start writes, in this order, and nothing else:
//   1. the routing index, with a row `in-a` for every task of `current` that has none, at once (so an index that is lost later is told
//      apart from a migration that never started: the file exists and lists every task),
//   2. state.json (status `running`, the losses accepted, the totals).
// It starts no worker: the caller launches it. A dry run writes nothing at all.
import { BackendRejectedError } from '@wadeck-app/task-core';
import type { VersionedRecord } from '@wadeck-app/task-core';

import type { TaskCopyInput, TaskCopyLoss } from '../kinds.js';
import { identityCarrierProblem } from './identityBlock.js';
import { MigrationStateStore } from './migrationState.js';
import type { MigrationState } from './migrationState.js';
import type { MigrationToolkit } from './migrationToolkit.js';
import { moveCost, rateWindowsOf } from './moveRate.js';
import type { MoveCost } from './moveRate.js';
import type { IndexRow } from './routingIndex.js';

export interface PlanLoss {
	kind: string;
	/** How many tasks would lose it. */
	tasks: number;
	text: string;
	fix: string;
	/** True when every task concerned has it covered by the accepted kinds. */
	allowed: boolean;
}

export interface StartEstimate {
	requests: number;
	writes: number;
	requestsPerMove: number;
	writesPerMove: number;
	/** How the numbers were found: the cost model of `new`, its cost per write, or one request per move (no cost declared). */
	basis: MoveCost['basis'] | 'mixed' | 'none';
	/** At the pace the budget and the caps of `new` allow; absent when nothing limits the pace. */
	minutes?: number;
	/** The window that sets that pace. */
	limitedBy?: string;
	notes: string[];
}

export interface StartPlan {
	/** Tasks of `current` to move (the ones already moved are not counted). */
	tasks: number;
	alreadyMoved: number;
	losses: PlanLoss[];
	/** The losses nobody accepted: a real start is refused while there are any. */
	blocking: PlanLoss[];
	estimate: StartEstimate;
}

export interface StartResult {
	dryRun: boolean;
	started: boolean;
	/** True when a real start would be refused (a dry run says so instead of failing). */
	blocked: boolean;
	plan: StartPlan;
	/** The state written (absent for a dry run). */
	state?: MigrationState;
}

export interface StartInput {
	/** Loss kinds (or groups, or `all`) the person accepts for the whole migration. Default: none. */
	acceptedLosses?: readonly string[];
	/** Plan and estimate only: nothing is written. */
	dryRun?: boolean;
}

const STATUS_COMMAND = 'task strategy migrate status';

/** Splits "<problem> Fix: <fix>" (the shape `identityCarrierProblem` answers) into a message and a hint. */
function splitFix(text: string): { message: string; hint: string } {
	const at = text.indexOf(' Fix: ');
	if (at === -1)
		return { message: text, hint: 'Change strategy.options.new in the project config; nothing was written.' };
	return { message: text.slice(0, at), hint: `${text.slice(at + ' Fix: '.length)} Nothing was written.` };
}

function hierarchyOf(
	record: VersionedRecord,
	parents: ReadonlyMap<string, string | undefined>,
	children: ReadonlyMap<string, number>
): TaskCopyInput['hierarchy'] {
	if (record.parentId === undefined) return undefined;
	let depth = 1;
	const seen = new Set<string>([record.id]);
	for (
		let parent: string | undefined = record.parentId;
		parent !== undefined && !seen.has(parent);
		parent = parents.get(parent)
	) {
		seen.add(parent);
		depth++;
	}
	return { depth, siblings: children.get(record.parentId) ?? 0 };
}

function describeBlocking(blocking: readonly PlanLoss[]): string {
	return blocking
		.map(loss => `${loss.kind} (${loss.tasks} task${loss.tasks === 1 ? '' : 's'}): ${loss.text}`)
		.join('; ');
}

export async function startMigration(toolkit: MigrationToolkit, input: StartInput = {}): Promise<StartResult> {
	const dryRun = input.dryRun === true;
	const accepted = [...new Set(input.acceptedLosses ?? [])];
	const store = new MigrationStateStore({ dir: toolkit.dir, files: toolkit.files, now: toolkit.now });

	const existing = store.readState();
	if (existing !== undefined) {
		throw new BackendRejectedError(
			'migrating',
			'start',
			`a migration was already started in this project on ${existing.startedAt} (status ${existing.status})`,
			`See where it stands with: ${STATUS_COMMAND}. A paused or stopped one continues with: task strategy migrate resume. Nothing was written.`
		);
	}

	const carrier = identityCarrierProblem(toolkit.nextCapabilities, 'strategy.options.new');
	if (carrier !== undefined) {
		const { message, hint } = splitFix(carrier);
		throw new BackendRejectedError('migrating', 'start', message, hint);
	}

	const summaries = await toolkit.current.list();
	const snapshot = toolkit.index.snapshot();
	const parents = new Map(summaries.map(summary => [summary.id, summary.parentId] as const));
	const children = new Map<string, number>();
	for (const summary of summaries) {
		if (summary.parentId !== undefined) children.set(summary.parentId, (children.get(summary.parentId) ?? 0) + 1);
	}
	const sourceIds = new Set(summaries.map(summary => summary.id));

	let alreadyMoved = 0;
	let tasks = 0;
	const byKind = new Map<string, { loss: TaskCopyLoss; tasks: number; allAllowed: boolean }>();
	const costs: MoveCost[] = [];
	const missing: string[] = [];
	for (const summary of summaries) {
		const row = snapshot.byPublicId(summary.id);
		if (row?.state === 'deleted') continue;
		if (row === undefined) missing.push(summary.id);
		if (row?.state === 'in-b') {
			alreadyMoved++;
			continue;
		}
		tasks++;
		const record = await toolkit.current.get(summary.id);
		const hierarchy = hierarchyOf(record, parents, children);
		const assessed = toolkit.copier.assess({
			record,
			sourceIds,
			// Nothing has a copy yet at the start: a relation is written when its other end has one (never a loss of its own).
			targetIdOf: sourceId => snapshot.byPublicId(sourceId)?.b,
			acceptedLosses: accepted,
			...(hierarchy === undefined ? {} : { hierarchy }),
		});
		for (const loss of assessed.losses) {
			const seen = byKind.get(loss.kind);
			if (seen === undefined) byKind.set(loss.kind, { loss, tasks: 1, allAllowed: loss.allowed });
			else {
				seen.tasks++;
				seen.allAllowed &&= loss.allowed;
			}
		}
		costs.push(moveCost(record, toolkit.nextTraits));
	}

	const losses: PlanLoss[] = [...byKind.values()].map(({ loss, tasks: count, allAllowed }) => ({
		kind: loss.kind,
		tasks: count,
		text: loss.text,
		fix: loss.fix,
		allowed: allAllowed,
	}));
	const blocking = losses.filter(loss => !loss.allowed);
	const plan: StartPlan = {
		tasks,
		alreadyMoved,
		losses,
		blocking,
		estimate: estimateOf(toolkit, costs),
	};

	if (dryRun) return { dryRun: true, started: false, blocked: blocking.length > 0, plan };

	if (blocking.length > 0) {
		throw new BackendRejectedError(
			'migrating',
			'start',
			`moving the tasks would lose: ${describeBlocking(blocking)}. Nothing was written.`,
			`Accept what you can live with: task strategy migrate start --allow-loss ${blocking.map(loss => loss.kind).join(',')} (or --allow-loss all). See the whole plan first with --dry-run. How to avoid each: ${blocking.map(loss => `${loss.kind}: ${loss.fix}`).join('; ')}`
		);
	}

	const since = new Date(toolkit.now()).toISOString();
	const added: IndexRow[] = missing.map(id => ({ publicId: id, a: id, state: 'in-a', since, version: 1 }));
	toolkit.index.mutate(rows => [...rows, ...added]);

	const state: MigrationState = {
		format: 1,
		startedAt: since,
		acceptedLosses: accepted,
		status: 'running',
		statusSince: since,
		totals: {
			tasks: tasks + alreadyMoved,
			requestsPerMove: plan.estimate.requestsPerMove,
			writesPerMove: plan.estimate.writesPerMove,
		},
		plan: { losses: Object.fromEntries(losses.map(loss => [loss.kind, loss.tasks])) },
		pace: rateWindowsOf(toolkit.budget, toolkit.nextTraits),
		counters: { moved: 0, skippedClaimed: 0, deferred: 0, failures: 0, ratePauses: 0 },
		parked: [],
		lastErrors: [],
	};
	store.writeState(state);
	toolkit.journal.info(
		'info',
		`migration started: ${tasks} task(s) to move, losses accepted: ${accepted.join(', ') || 'none'}`,
		{
			step: 'start',
			outcome: 'started',
		}
	);
	return { dryRun: false, started: true, blocked: false, plan, state };
}

function estimateOf(toolkit: MigrationToolkit, costs: readonly MoveCost[]): StartEstimate {
	const requests = costs.reduce((sum, cost) => sum + cost.requests, 0);
	const writes = costs.reduce((sum, cost) => sum + cost.writes, 0);
	const bases = [...new Set(costs.map(cost => cost.basis))];
	const basis = bases.length === 0 ? 'none' : bases.length === 1 ? bases[0]! : 'mixed';
	const notes: string[] = [];
	if (basis === 'unit') {
		notes.push(
			'the strategy in "new" declares no cost: each move is counted as one request, so the budget bounds the number of moves a minute'
		);
	}
	if (basis === 'per-write') {
		notes.push(
			'requests are counted from the cost per write of "new" and the fields of each task; the real count depends on labels that exist and on retries'
		);
	}
	if (basis === 'model') notes.push('requests are counted by the cost model of "new"');

	let minutes: number | undefined;
	let limitedBy: string | undefined;
	for (const window of rateWindowsOf(toolkit.budget, toolkit.nextTraits)) {
		const total = window.unit === 'requests' ? requests : writes;
		const needed = (total / window.limit) * (window.windowMs / 60_000);
		if (minutes === undefined || needed > minutes) {
			minutes = needed;
			limitedBy = window.name;
		}
	}
	const count = costs.length;
	return {
		requests,
		writes,
		requestsPerMove: count === 0 ? 0 : Math.round((requests / count) * 100) / 100,
		writesPerMove: count === 0 ? 0 : Math.round((writes / count) * 100) / 100,
		basis,
		...(minutes === undefined ? {} : { minutes, limitedBy }),
		notes,
	} as StartEstimate;
}
