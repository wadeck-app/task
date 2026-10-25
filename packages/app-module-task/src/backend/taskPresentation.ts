// Presentation helpers of the task detail page: tones, activity feed, ancestor chips, grouped links. Pure functions over
// service results; the rules they display (what is closed, what blocks) come from task-service.
import type { TaskLinks, TaskRecord, TaskSummary } from '@wadeck-app/task-core';
import type { Blocker, ChildrenSummary } from '@wadeck-app/task-service';

import { shortTitle, shortUtcTime } from './display.js';
import { detailHref } from './hrefs.js';
import type { ProjectIdentity } from './projectRef.js';
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
function relationLabel(relation: string): string {
	return RELATION_LABELS[relation] ?? relation;
}

/** The rows of the links answer: a tone, and the relation as `meta` (TaskRowList shows it on the right). */
export function linkRowViews(
	project: ProjectRef,
	config: StatusConfig,
	links: TaskLinks
): Array<Record<string, unknown>> {
	return withTones(config, linkRows(project, links)).map(row => ({ ...row, meta: relationLabel(row.relation) }));
}

/** The linked tasks grouped by relation (relations without a task left out), each row with the tone of its status. */
export function linkGroups(
	project: ProjectRef,
	config: StatusConfig,
	links: TaskLinks
): Array<Record<string, unknown>> {
	const rows = linkRowViews(project, config, links) as Array<{ relation: string }>;
	const relations = [...new Set(rows.map(row => row.relation))];
	return relations.map(relation => ({
		relation,
		label: relationLabel(relation),
		rows: rows.filter(row => row.relation === relation),
	}));
}
