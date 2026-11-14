// The loss table of a migration: what the target cannot represent, collected while the tasks are mapped, then turned into rows
// (design 1.8: always listed, never silent, blocking unless the person allowed the kind).
import { LOSS_GROUPS, LOSS_IDS_MAX, LOSS_KINDS } from './migrateTypes.js';
import type { LossKind, LossRow } from './migrateTypes.js';

interface Entry {
	count: number;
	ids: string[];
	details: Map<string, number>;
}

/** What the person can do about each kind, and how its row reads. `what` gets the number of tasks concerned and the details. */
const WORDING: Record<LossKind, { what: (items: number, tasks: number, details: string) => string; fix: string }> = {
	status: {
		what: (_items, tasks, details) =>
			`${tasks} task(s) have a status the target project does not define (${details}); they are created in the target's default status`,
		fix: "add the status to the target project's `statuses` (config.yml), or accept the loss",
	},
	'status-outcome': {
		what: (_items, tasks, details) =>
			`${tasks} task(s) are in a status that does not end a task the same way in the target (${details})`,
		fix: 'align the `statuses` of the two projects (terminal, outcome), or accept the loss',
	},
	type: {
		what: (_items, tasks, details) =>
			`${tasks} task(s) have a type the target project does not list (${details}); the type is not set`,
		fix: 'add the type to the target project (task type add <name> -p <target>), or accept the loss',
	},
	labels: {
		what: (items, tasks, details) =>
			`${items} label(s) on ${tasks} task(s) cannot be stored on the target (${details}); they are not set`,
		fix: 'rename the labels in the source, or accept the loss',
	},
	meta: {
		what: (items, tasks) =>
			`${items} metadata entr${items === 1 ? 'y' : 'ies'} on ${tasks} task(s) cannot be stored: the target has no metadata; they are not set`,
		fix: 'declare a meta fill in the target strategy (strategy.options.fills.meta), or accept the loss',
	},
	priority: {
		what: (items, tasks, details) =>
			`${items} priorit${items === 1 ? 'y' : 'ies'} on ${tasks} task(s) cannot be stored on the target (${details}); they are not set`,
		fix: 'add the priority to the target project (priorities in its config.yml), use a target project on the local strategy (the other storage strategies do not carry priorities yet), or accept the loss',
	},
	assignee: {
		what: (items, tasks) =>
			`${items} assignee(s) on ${tasks} task(s) cannot be stored: the target does not carry assignees; they are not set (a claim lease is never migrated)`,
		fix: 'use a target project on the local strategy (the other storage strategies do not carry assignees yet), or accept the loss',
	},
	lease: {
		what: (_items, tasks) =>
			`${tasks} task(s) hold a claim lease on the source: a lease is never migrated, so on the target nothing keeps another worker from claiming them (even with an assignee kept) without --force`,
		fix: 'finish or release the claims on the source first (task release <id>), or accept the loss',
	},
	comments: {
		what: (items, tasks) =>
			`${items} comment(s) on ${tasks} task(s) cannot be stored: the target has no comments; they are not written`,
		fix: 'accept the loss (a target without comments cannot keep them)',
	},
	history: {
		what: (_items, tasks) =>
			`${tasks} task(s) have a status history or an activity log the target cannot take (the port cannot replay them); only the creation and the current status are kept`,
		fix: 'add --history-comment to keep the history as a note comment on each task, or accept the loss',
	},
	'created-at': {
		what: (_items, tasks) =>
			`the target assigns the creation instant: ${tasks} task(s) lose their original one (it becomes the migration time)`,
		fix: 'add --history-comment to keep the original instant in a note comment, or accept the loss',
	},
	marker: {
		what: (_items, tasks) =>
			`the target cannot store the marker "migratedFrom" (it has no metadata): ${tasks} task(s) are recognised by the journal only, so running again after losing the journal would create duplicates`,
		fix: 'declare a meta fill in the target strategy (strategy.options.fills.meta) so the marker can be written, or accept it and keep the journal file',
	},
	'text-length': {
		what: (items, tasks) =>
			`${items} text(s) of ${tasks} task(s) are longer than the target accepts; they are cut and end with a note`,
		fix: 'shorten the texts in the source, or accept the loss',
	},
	'hierarchy:unsupported': {
		what: items => `${items} parent link(s) cannot be stored: the target has no hierarchy; the tasks become roots`,
		fix: 'accept the loss (a target without hierarchy cannot keep parents)',
	},
	'hierarchy:depth': {
		what: (items, _tasks, details) =>
			`${items} task(s) are nested deeper than the target allows (${details}); they are attached to no parent`,
		fix: 'flatten the tree in the source, or accept the loss',
	},
	'hierarchy:children': {
		what: (items, _tasks, details) =>
			`${items} task(s) exceed the number of children the target allows for one parent (${details}); they are attached to no parent`,
		fix: 'spread the children over several parents in the source, or accept the loss',
	},
	'hierarchy:orphan': {
		what: items => `${items} task(s) name a parent that is not in the source; they become roots`,
		fix: 'fix the parent in the source (task remove-parent <id>), or accept the loss',
	},
	'hierarchy:cycle': {
		what: items => `${items} parent link(s) of the source form a cycle; each is dropped to break it`,
		fix: 'fix the parents in the source, or accept the loss',
	},
	'links:blockedBy': {
		what: items => `${items} blockedBy link(s) cannot be stored by the target`,
		fix: 'accept the loss',
	},
	'links:duplicateOf': {
		what: items => `${items} duplicateOf link(s) cannot be stored by the target`,
		fix: 'declare the duplicateOf fill in the target strategy, or accept the loss',
	},
	'links:causedBy': {
		what: items => `${items} causedBy link(s) cannot be stored by the target (no forge has this link type)`,
		fix: 'accept the loss: the links are dropped and listed here, nothing is invented in their place',
	},
	'links:dangling': {
		what: items => `${items} link(s) point to a task that is not in the source; they are not created`,
		fix: 'remove the link in the source (task unlink), or accept the loss',
	},
};

export class LossLedger {
	private readonly entries = new Map<LossKind, Entry>();

	/** Records `amount` items lost on source task `taskId`; `detail` names what (a status, a label...) and is counted. */
	add(kind: LossKind, taskId: string, detail?: string, amount = 1): void {
		let entry = this.entries.get(kind);
		if (entry === undefined) {
			entry = { count: 0, ids: [], details: new Map() };
			this.entries.set(kind, entry);
		}
		entry.count += amount;
		if (!entry.ids.includes(taskId)) entry.ids.push(taskId);
		if (detail !== undefined) entry.details.set(detail, (entry.details.get(detail) ?? 0) + amount);
	}

	/** The rows, in the order of {@link LOSS_KINDS}; `allowed` says which kinds the person accepted. */
	rows(allowed: (kind: LossKind) => boolean): LossRow[] {
		return LOSS_KINDS.flatMap(kind => {
			const entry = this.entries.get(kind);
			if (entry === undefined) return [];
			const details = [...entry.details]
				.slice(0, 8)
				.map(([name, count]) => (entry.details.size > 1 || count > 1 ? `${name} x${count}` : name))
				.join(', ');
			const more = entry.details.size > 8 ? `, and ${entry.details.size - 8} more` : '';
			return [
				{
					kind,
					count: entry.count,
					taskIds: entry.ids.slice(0, LOSS_IDS_MAX),
					text: WORDING[kind].what(entry.count, entry.ids.length, details + more),
					fix: WORDING[kind].fix,
					allowed: allowed(kind),
				},
			];
		});
	}
}

export interface AllowLossCheck {
	/** The kinds, groups and `all` that were given and exist. */
	accepted: string[];
	/** Names that are neither a kind, nor a group, nor `all`. */
	unknown: string[];
}

/** Splits what `--allow-loss` was given into known and unknown names. */
export function checkAllowLoss(given: readonly string[]): AllowLossCheck {
	const known = new Set<string>([...LOSS_KINDS, ...LOSS_GROUPS]);
	return {
		accepted: given.filter(name => known.has(name)),
		unknown: given.filter(name => !known.has(name)),
	};
}

/** True when `--allow-loss` covers `kind`: by its name, by its group (`links` covers `links:causedBy`) or by `all`. */
export function isLossAllowed(kind: LossKind, allowed: readonly string[]): boolean {
	const group = kind.includes(':') ? kind.slice(0, kind.indexOf(':')) : undefined;
	return allowed.includes('all') || allowed.includes(kind) || (group !== undefined && allowed.includes(group));
}
