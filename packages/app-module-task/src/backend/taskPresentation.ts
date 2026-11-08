// Presentation helpers of the task detail page: tones, activity feed, ancestor chips, grouped links. Pure functions over
// service results; the rules they display (what is closed, what blocks) come from task-service.
import type { TaskLinks, TaskRecord, TaskSummary } from '@wadeck-app/task-core';
import { headlineOf } from '@wadeck-app/task-service';
import type { ActivityRow, Blocker, ChildrenSummary, DanglingLink } from '@wadeck-app/task-service';

import { shortTitle, shortUtcTime } from './display.js';
import { detailHref, encodedProject } from './hrefs.js';
import type { ProjectIdentity } from './projectRef.js';
import { linkGroupSection, type DslNode } from './dslNodes.js';
import { linkRows } from './rowViews.js';

type ProjectRef = ProjectIdentity & { path: string };

/**
 * The colour family a status is shown in: closed with a positive outcome -> success, closed with a negative one (config
 * `outcome: negative`) -> danger, the starting status -> neutral, anything else -> info.
 */
export type Tone = 'success' | 'danger' | 'neutral' | 'info';

/** The statuses of a project, as the config gives them. */
export interface StatusConfig {
	statuses: string[];
	defaultStatus: string;
	terminalStatuses: string[];
	/** The terminal statuses that end badly (a subset of `terminalStatuses`). */
	negativeStatuses: string[];
}

export function statusTone(config: StatusConfig, status: string): Tone {
	if (config.terminalStatuses.includes(status))
		return config.negativeStatuses.includes(status) ? 'danger' : 'success';
	return status === config.defaultStatus ? 'neutral' : 'info';
}

/** Every status of the config with its tone and flags, in config order. */
export function statusChoices(config: StatusConfig): Array<Record<string, unknown>> {
	return config.statuses.map(status => ({
		value: status,
		label: status,
		tone: statusTone(config, status),
		isDefault: status === config.defaultStatus,
		isTerminal: config.terminalStatuses.includes(status),
	}));
}

/** Task rows (children, ancestors) with the tone of their status and whether they are closed. */
export function withTones<T extends { status: string }>(
	config: StatusConfig,
	rows: T[]
): Array<T & { tone: Tone; statusTone: Tone; isDone: boolean }> {
	return rows.map(row => {
		const tone = statusTone(config, row.status);
		return { ...row, tone, statusTone: tone, isDone: config.terminalStatuses.includes(row.status) };
	});
}

/** The ancestors, root first, as chips: the store lists them from the direct parent up. */
export function ancestorChips(
	project: ProjectRef,
	config: StatusConfig,
	ancestorsNearestFirst: Array<TaskSummary | undefined>
): Array<Record<string, unknown>> {
	// A dangling link higher up the chain resolves to no summary: it has nothing to show.
	const found = ancestorsNearestFirst.filter((task): task is TaskSummary => task !== undefined);
	return [...found].reverse().map(task => ({
		id: task.id,
		title: task.title,
		titleText: shortTitle(task.title),
		// What BreadcrumbTrail reads: the cut title as the label, the full one as the tooltip.
		label: shortTitle(task.title),
		status: task.status,
		tone: statusTone(config, task.status),
		href: detailHref(project, task.id),
	}));
}

/**
 * The feed of a task in the shape of the Timeline component, oldest first: its creation, then one entry per change (status
 * moves and everything of the activity log: type, labels, metadata, parent, links, title and description edits), merged by
 * task-service. A task changed before the log existed shows its status moves only.
 */
export function activityEntries(config: StatusConfig, rows: ActivityRow[]): Array<Record<string, unknown>> {
	// The service lists newest first; the Timeline feed of the detail answer has always been oldest first.
	return [...rows].reverse().map(row => {
		const closing = row.kind === 'status' && config.terminalStatuses.includes(row.to ?? '');
		return {
			id: row.id,
			// The Timeline component knows five kinds; anything else reads as a note and `activityKind` keeps the real one.
			kind: timelineKind(row, closing),
			activityKind: row.kind,
			icon: row.icon,
			...entryTexts(row, closing),
			from: row.kind === 'created' ? null : (row.from ?? null),
			to: row.to ?? null,
			tone: row.tone,
			at: row.at,
			atText: shortUtcTime(row.at),
		};
	});
}

/** The two lines of an entry. The status rows keep the wording the page has always had ("Created", "Moved from..", "Closed (..)"). */
function entryTexts(row: ActivityRow, closing: boolean): { title: string; detail: string } {
	if (row.kind === 'created') return { title: 'Created', detail: `Status ${row.to ?? ''}` };
	if (row.kind === 'status') {
		const moved = `Moved from ${row.from ?? ''} to ${row.to ?? ''}`;
		return closing ? { title: `Closed (${row.to ?? ''})`, detail: moved } : { title: moved, detail: '' };
	}
	// A comment: its text is the detail (a long text is not a title).
	if (row.kind === 'comment') {
		return { title: row.actor === undefined ? 'Comment' : `Comment by ${row.actor}`, detail: row.text };
	}
	return { title: row.text, detail: editDetail(row) };
}

function timelineKind(row: ActivityRow, closing: boolean): 'created' | 'status' | 'done' | 'link' | 'note' {
	if (row.kind === 'created') return 'created';
	if (row.kind === 'status') return closing ? 'done' : 'status';
	return row.kind === 'link-added' || row.kind === 'link-removed' ? 'link' : 'note';
}

/** The second line of a title / description edit: the old and the new text (already cut to a preview). */
function editDetail(row: ActivityRow): string {
	if (row.details === undefined) return '';
	const { oldValue, newValue } = row.details;
	return [
		oldValue === undefined ? undefined : `From: ${oldValue}`,
		newValue === undefined ? undefined : `To: ${newValue}`,
	]
		.filter(line => line !== undefined)
		.join('\n');
}

/** One row of the activity route: the service row plus the day group (UTC) and the minute the view prints. */
export function activityRowView(row: ActivityRow): Record<string, unknown> {
	const day = /^(\d{4}-\d\d-\d\d)T/.exec(row.at)?.[1];
	return { ...row, group: day ?? 'Unknown date', time: shortUtcTime(row.at) };
}

/**
 * The statuses with what a picker needs: value, label, tone, terminal, and `outcome` (`positive` | `negative`, terminal
 * statuses only) (config order; the same config `set-status` validates against). The label is the bare name: the colour
 * says closed / how it ended.
 */
export function statusOptionRows(config: StatusConfig): Array<{
	value: string;
	label: string;
	tone: Tone;
	terminal: boolean;
	outcome?: 'positive' | 'negative';
}> {
	return config.statuses.map(status => {
		const terminal = config.terminalStatuses.includes(status);
		return {
			value: status,
			label: status,
			tone: statusTone(config, status),
			terminal,
			...(terminal
				? { outcome: config.negativeStatuses.includes(status) ? ('negative' as const) : ('positive' as const) }
				: {}),
		};
	});
}

/**
 * The types of a picker: a "None" entry (empty value, clears the type) then the configured types. No configured type means
 * any text is accepted, so there is nothing to pick from: an empty list.
 */
export function typeOptionRows(types: string[]): Array<{ value: string; label: string }> {
	return types.length === 0
		? []
		: [{ value: '', label: 'None' }, ...types.map(type => ({ value: type, label: type }))];
}

/** A property pill of the task header: one per property, "none" when empty; only the blocked pill is conditional. */
export interface PropertyPill {
	key: 'status' | 'type' | 'labels' | 'parent' | 'blocked';
	label: string;
	text: string;
	tone: Tone;
	empty: boolean;
}

const EMPTY_PILL_TEXT = 'none';

export function propertyPills(input: {
	config: StatusConfig;
	record: TaskRecord;
	/** The direct parent as {@link ancestorChips} gives it (id and cut title), if any. */
	parent: { id: string; titleText: string } | null;
	blockerCount: number;
}): PropertyPill[] {
	const { config, record, parent, blockerCount } = input;
	const labels = record.labels ?? [];
	const pills: PropertyPill[] = [
		{ key: 'status', label: 'Status', text: record.status, tone: statusTone(config, record.status), empty: false },
		{ key: 'type', label: 'Type', text: record.type ?? EMPTY_PILL_TEXT, tone: 'neutral', empty: !record.type },
		{
			key: 'labels',
			label: 'Labels',
			text: labels.length === 0 ? EMPTY_PILL_TEXT : labels.join(', '),
			tone: 'neutral',
			empty: labels.length === 0,
		},
		{
			key: 'parent',
			label: 'Parent',
			text: parent === null ? EMPTY_PILL_TEXT : `${parent.id} ${parent.titleText}`,
			tone: 'neutral',
			empty: parent === null,
		},
	];
	if (blockerCount > 0) {
		pills.push({ key: 'blocked', label: 'Blocked by', text: `${blockerCount} open`, tone: 'danger', empty: false });
	}
	return pills;
}

/** "2 of 5 done" and the figures of a progress bar; the counts come from task-service (`summarizeChildren`). */
export function childrenSummaryView(summary: ChildrenSummary): Record<string, unknown> {
	return {
		total: summary.total,
		done: summary.terminal,
		open: summary.open,
		value: summary.terminal,
		max: summary.total,
		text: summary.total === 0 ? '' : `${summary.terminal} of ${summary.total} done`,
		hasChildren: summary.total > 0,
	};
}

export function blockedText(count: number): string | null {
	return count === 0 ? null : `Blocked by ${count} open task(s)`;
}

export function blockerRows(project: ProjectRef, blockers: Blocker[]): Array<Record<string, unknown>> {
	return blockers.map(blocker => ({ ...blocker, href: detailHref(project, blocker.id) }));
}

const RELATION_LABELS: Record<string, string> = {
	blockedBy: 'Blocked by',
	blocks: 'Blocks',
	duplicateOf: 'Duplicate of',
	duplicates: 'Duplicated by',
	causedBy: 'Caused by',
	causes: 'Causes',
};

/** A relation as a reader says it (`blockedBy` -> `Blocked by`). */
export function relationLabel(relation: string): string {
	return RELATION_LABELS[relation] ?? relation;
}

/** What deleting a task touches, as counted by the detail route. */
export interface DeleteImpact {
	childCount: number;
	descendantCount: number;
	linkCount: number;
	blocksCount: number;
}

const plural = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`;

/**
 * What both delete buttons share, in one sentence for the confirmation dialog (links go, blocked tasks lose a blocker). What
 * happens to the children is not here: it differs per button and is stated on them (see {@link deleteButtonLabels}).
 */
export function deleteImpactText(impact: DeleteImpact): string {
	const parts: string[] = [];
	if (impact.linkCount > 0) {
		parts.push(`${plural(impact.linkCount, 'link is', 'links are')} removed`);
	}
	if (impact.blocksCount > 0) {
		parts.push(
			`${impact.blocksCount} ${impact.blocksCount === 1 ? 'task it blocks loses' : 'tasks it blocks lose'} a blocker`
		);
	}
	if (parts.length === 0) {
		return impact.childCount > 0
			? 'Deleting this task cannot be undone.'
			: 'Deleting this task has no other effect: no children, no links. This cannot be undone.';
	}
	return `Deleting this task: ${parts.join(', ')}. This cannot be undone.`;
}

/**
 * The two buttons of the delete dialog, each saying its own outcome (a view reads no form state, so a switch could not change a
 * sentence): `deleteLabel` keeps the children (they become roots), `deleteCascadeLabel` takes the whole subtree.
 */
export function deleteButtonLabels(impact: DeleteImpact): { deleteLabel: string; deleteCascadeLabel: string } {
	const deleteLabel =
		impact.childCount === 0
			? 'Delete task'
			: impact.childCount === 1
				? 'Delete task, its 1 child becomes a root task'
				: `Delete task, its ${impact.childCount} children become root tasks`;
	return {
		deleteLabel,
		deleteCascadeLabel: `Delete task and its ${plural(impact.descendantCount, 'descendant', 'descendants')}`,
	};
}

/** The status a checked sub-task gets (the first terminal status in config order) and the one an unchecked one gets back. */
export function checklistStatuses(config: StatusConfig): { terminalStatus: string; reopenStatus: string } {
	return {
		terminalStatus: config.statuses.find(status => config.terminalStatuses.includes(status)) ?? '',
		reopenStatus: config.defaultStatus,
	};
}

/** The children as the rows of task:TaskChecklist (headline for the line, the whole title as a tooltip is up to the view). */
export function checklistRows(
	config: StatusConfig,
	children: Array<TaskSummary & { href?: string }>
): Array<Record<string, unknown>> {
	return children.map(child => ({
		id: child.id,
		title: child.title,
		headline: headlineOf(child.title),
		status: child.status,
		tone: statusTone(config, child.status),
		terminal: config.terminalStatuses.includes(child.status),
		href: child.href,
	}));
}

/** The task the links belong to, and the links of it that point to a vanished task (see `readTaskLinks`). */
export interface LinkHolder {
	/** Full id of the task whose links are shown. */
	taskId: string;
	dangling: DanglingLink[];
}

/**
 * The rows of the links answer: a tone, and the relation as `meta` (TaskRowList shows it on the right). Each row holds
 * `removeParams`, the `{placeholders}` of the `removeLinkRow` action (the type is the relation as the row shows it, an
 * inverse name included: `unlink` accepts both). A link to a vanished task is a row too, with no `href` and the id the
 * fix needs: it stays visible and removable from the page.
 */
export function linkRowViews(
	project: ProjectRef,
	config: StatusConfig,
	links: TaskLinks,
	holder: LinkHolder
): Array<Record<string, unknown>> {
	const params = (type: string, target: string): Record<string, unknown> => ({
		id: holder.taskId,
		projectParam: encodedProject(project),
		type,
		target,
	});
	const found = withTones(config, linkRows(project, links)).map(row => ({
		...row,
		meta: relationLabel(row.relation),
		removeParams: params(row.relation, row.id),
	}));
	const missing = holder.dangling.map(link => ({
		relation: link.relation,
		direction: 'outgoing',
		id: link.targetId,
		title: `missing task ${link.targetId}`,
		titleText: `missing task ${link.targetId}`,
		status: 'missing',
		tone: 'danger',
		missing: true,
		fix: link.fix,
		meta: relationLabel(link.relation),
		removeParams: params(link.relation, link.targetId),
	}));
	// Keep the relation order of the links answer: a missing task joins the rows of its own relation.
	const order = Object.keys(RELATION_LABELS);
	return [...found, ...missing].sort((a, b) => order.indexOf(a.relation) - order.indexOf(b.relation));
}

/** The linked tasks grouped by relation (relations without a task left out), each row with the tone of its status. */
export function linkGroups(
	project: ProjectRef,
	config: StatusConfig,
	links: TaskLinks,
	holder: LinkHolder
): Array<Record<string, unknown>> {
	const rows = linkRowViews(project, config, links, holder) as Array<{ relation: string }>;
	const relations = [...new Set(rows.map(row => row.relation))];
	return relations.map(relation => ({
		relation,
		label: relationLabel(relation),
		rows: rows.filter(row => row.relation === relation),
	}));
}

/**
 * The page nodes of the groups, in the order of {@link linkGroups}: one Section per group inside ONE stack. The view
 * renders the list with an ExtensionSlot, which lays its items with no gap (a Panel around it gave headings glued to the
 * table above, seen in nine variants), so the spacing comes from the stack. No group: no node.
 */
export function linkGroupSections(groups: Array<Record<string, unknown>>): DslNode[] {
	if (groups.length === 0) return [];
	return [
		{
			$type: 'VerticalStack',
			gap: 'gap-4',
			items: groups.map(group =>
				linkGroupSection({
					label: group['label'] as string,
					rows: group['rows'] as Array<Record<string, unknown>>,
				})
			),
		},
	];
}
