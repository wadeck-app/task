// The subset of the source a migration copies (phase 2): `--only-open`, `--status`, `--ids`, `--limit`. Pure: it decides which NEW
// source tasks join the run; what the journal already knows stays in the run whatever the selection says (an unfinished task is finished,
// a finished one is kept), so a series of partial runs converges on the whole source and never copies a task twice.
import type { VersionedRecord } from '@wadeck-app/task-core';

import { InvalidStatusError } from '../errors.js';
import type { ProjectFacts } from '../plugins/kinds.js';
import { suggest } from '../text.js';
import { MigrationRefusedError } from './migrateErrors.js';
import type { MigrationSelection, SelectionReport } from './migrateTypes.js';

/** The most `--limit` accepts: the same bound as `task list --limit` (a test ties the two). */
export const SELECTION_LIMIT_MAX = 1000;

/** True when the selection can leave a task out (an empty selection is every task, as without one). */
export function isSelectionActive(selection: MigrationSelection | undefined): selection is MigrationSelection {
	return (
		selection !== undefined &&
		(selection.onlyOpen === true ||
			(selection.statuses?.length ?? 0) > 0 ||
			(selection.ids?.length ?? 0) > 0 ||
			selection.limit !== undefined)
	);
}

/** The selection as the engine accepts it, against the statuses of the SOURCE project. Throws what the person must fix. */
export function checkSelection(
	selection: MigrationSelection | undefined,
	sourceStatuses: ProjectFacts['statuses']
): void {
	if (selection === undefined) return;
	if (selection.onlyOpen === true && (selection.statuses?.length ?? 0) > 0) {
		throw new MigrationRefusedError(
			'--only-open and --status contradict each other: --only-open is "every status that does not end a task", --status lists the statuses by name',
			'Give only one of them: --only-open, or --status <name>[,<name>...] (task status list -p <source> shows the statuses).'
		);
	}
	if (
		selection.limit !== undefined &&
		(!Number.isInteger(selection.limit) || selection.limit < 1 || selection.limit > SELECTION_LIMIT_MAX)
	) {
		throw new MigrationRefusedError(
			`limit must be a whole number from 1 to ${SELECTION_LIMIT_MAX}, found ${String(selection.limit)}`,
			'--limit <n> copies at most n tasks per run; run the same command again (with --resume after a stop) for the next ones.'
		);
	}
	const names = sourceStatuses.map(status => status.name);
	for (const status of selection.statuses ?? []) {
		if (!names.includes(status)) {
			const hint = suggest(status, names);
			throw new InvalidStatusError(status, names, hint === undefined ? [] : [hint]);
		}
	}
}

export interface SelectionInput {
	records: readonly VersionedRecord[];
	/** Every source id in plan order (parents before children). */
	order: readonly string[];
	selection: MigrationSelection;
	sourceStatuses: ProjectFacts['statuses'];
	/** What the journal (or a marker on the target) says about a task. */
	stateOf: (sourceId: string) => 'new' | 'resume' | 'done';
}

export interface Selected {
	/** The tasks of the run: what the journal knows, and the new ones the selection keeps. */
	inPlan: Set<string>;
	report: Omit<SelectionReport, 'deferred'>;
}

export function selectTasks(input: SelectionInput): Selected {
	const { selection, records, order, sourceStatuses } = input;
	const known = new Set(records.map(record => record.id));
	const unknown = (selection.ids ?? []).filter(id => !known.has(id));
	if (unknown.length > 0) {
		throw new MigrationRefusedError(
			`unknown task id${unknown.length === 1 ? '' : 's'} for --ids: ${unknown.join(', ')}`,
			`The source holds ${records.length} task(s): ${records
				.slice(0, 10)
				.map(record => record.id)
				.join(', ')}${records.length > 10 ? ', ...' : ''}. Ids are exact (no prefix).`
		);
	}
	const byId = new Map(records.map(record => [record.id, record]));
	const terminal = new Set(sourceStatuses.filter(status => status.terminal).map(status => status.name));
	const wantedStatuses = selection.statuses === undefined ? undefined : new Set(selection.statuses);
	const wantedIds = selection.ids === undefined || selection.ids.length === 0 ? undefined : new Set(selection.ids);

	const inPlan = new Set<string>();
	const candidates: string[] = [];
	let resumed = 0;
	let alreadyMigrated = 0;
	const excludedBy = { status: 0, ids: 0, limit: 0 };
	for (const id of order) {
		const state = input.stateOf(id);
		if (state !== 'new') {
			inPlan.add(id);
			if (state === 'done') alreadyMigrated++;
			else resumed++;
			continue;
		}
		const status = byId.get(id)!.status;
		if (selection.onlyOpen === true && terminal.has(status)) excludedBy.status++;
		else if (wantedStatuses !== undefined && wantedStatuses.size > 0 && !wantedStatuses.has(status))
			excludedBy.status++;
		else if (wantedIds !== undefined && !wantedIds.has(id)) excludedBy.ids++;
		else candidates.push(id);
	}
	// The unfinished tasks of the journal come first in the budget: they are in the run anyway.
	const budget = selection.limit === undefined ? candidates.length : Math.max(0, selection.limit - resumed);
	for (const id of candidates.slice(0, budget)) inPlan.add(id);
	excludedBy.limit = candidates.length - Math.min(budget, candidates.length);
	const selected = resumed + Math.min(budget, candidates.length);
	return {
		inPlan,
		report: {
			total: records.length,
			selected,
			alreadyMigrated,
			excluded: excludedBy.status + excludedBy.ids + excludedBy.limit,
			excludedBy,
		},
	};
}
