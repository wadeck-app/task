// Presentation helpers of the task detail page: tones, activity feed, ancestor chips, grouped links. Pure functions over
// service results; the rules they display (what is closed, what blocks) come from task-service.
import type { TaskLinks, TaskRecord, TaskSummary } from '@wadeck-app/task-core';
import { headlineOf } from '@wadeck-app/task-service';
import type { Blocker, ChildrenSummary, DanglingLink } from '@wadeck-app/task-service';

import { shortTitle, shortUtcTime } from './display.js';
import { detailHref, encodedProject } from './hrefs.js';
import type { ProjectIdentity } from './projectRef.js';
import { linkGroupSection, type DslNode } from './dslNodes.js';
import { linkRows } from './rowViews.js';

type ProjectRef = ProjectIdentity & { path: string };

/** The colour family a status is shown in: closed -> success, the starting status -> neutral, anything else -> info. */
export type Tone = 'success' | 'neutral' | 'info';

/** The statuses of a project, as the config gives them. */
export interface StatusConfig {
	statuses: string[];
	defaultStatus: string;
	terminalStatuses: string[];
}

export function statusTone(config: StatusConfig, status: string): Tone {
	if (config.terminalStatuses.includes(status)) return 'success';
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
 * The feed of a task, oldest first: its creation, then one entry per status change. The history holds the successive
 * statuses (its first entry is the status at creation), so a change reads `from` the previous one `to` its own.
 */
export function activityEntries(config: StatusConfig, record: TaskRecord): Array<Record<string, unknown>> {
	const history = record.history ?? [];
	const created = {
		id: 'created',
		kind: 'created',
		title: 'Created',
		detail: `Status ${history[0]?.status ?? record.status}`,
		from: null,
		to: history[0]?.status ?? record.status,
		tone: 'neutral',
		at: record.createdAt,
		atText: shortUtcTime(record.createdAt),
	};
	const changes = history.slice(1).map((entry, index) => {
		const from = history[index]!.status;
		const closing = config.terminalStatuses.includes(entry.status);
		return {
			id: `status-${index + 1}`,
			kind: closing ? 'done' : 'status',
			title: closing ? `Closed (${entry.status})` : `Moved from ${from} to ${entry.status}`,
			detail: closing ? `Moved from ${from} to ${entry.status}` : '',
			from,
			to: entry.status,
			tone: statusTone(config, entry.status),
			at: entry.timestamp,
			atText: shortUtcTime(entry.timestamp),
		};
	});
	return [created, ...changes];
}

/** The statuses with what a picker needs: value, label, tone, terminal (config order; the same config `set-status` validates against). */
export function statusOptionRows(
	config: StatusConfig
): Array<{ value: string; label: string; tone: Tone; terminal: boolean }> {
	return config.statuses.map(status => ({
		value: status,
		label: status,
		tone: statusTone(config, status),
		terminal: config.terminalStatuses.includes(status),
	}));
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
	tone: Tone | 'danger';
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

/** The consequences of deleting a task, in one sentence for the confirmation dialog (children become roots, links go). */
export function deleteImpactText(impact: DeleteImpact): string {
	const parts: string[] = [];
	if (impact.childCount > 0) {
		parts.push(
			impact.childCount === 1
				? 'its 1 child becomes a root task'
				: `its ${impact.childCount} children become root tasks`
		);
	}
	if (impact.linkCount > 0) {
		parts.push(`${plural(impact.linkCount, 'link is', 'links are')} removed`);
	}
	if (impact.blocksCount > 0) {
		parts.push(
			`${impact.blocksCount} ${impact.blocksCount === 1 ? 'task it blocks loses' : 'tasks it blocks lose'} a blocker`
		);
	}
	return parts.length === 0
		? 'Deleting this task has no other effect: no children, no links. This cannot be undone.'
		: `Deleting this task: ${parts.join(', ')}. This cannot be undone.`;
}

/** The label of the "also delete the descendants" switch of the delete dialog. */
export function deleteCascadeLabel(descendantCount: number): string {
	return `Also delete its ${plural(descendantCount, 'descendant', 'descendants')}`;
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
