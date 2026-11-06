// The compact, capped view of the global forest that the Tree page variants read (`overview` of GET /tree?allProjects=true).
// One entry per registered project, readable or not; the variants are components that filter, sort and fold this data in
// the browser, so its size is bounded here (rowCap rows per project) and the full forest stays at `treeHref`.
import type { TaskTreeNode } from '@wadeck-app/task-core';

import { shortTitle, shortUtcTime } from './display.js';
import { RequestError } from './errors.js';
import { detailHref, pageLink } from './hrefs.js';

/** Rows sent per project when the request does not say. */
export const DEFAULT_ROW_CAP = 60;
/** The largest ?rowCap= accepted: a bigger answer is the page the variants exist to avoid. */
export const MAX_ROW_CAP = 400;
/** Root tasks with children previewed per project. */
export const ROOT_PREVIEW = 5;

export interface OverviewReadable {
	project: { id: string; name: string; path: string };
	value: {
		forest: TaskTreeNode[];
		terminalStatuses: readonly string[];
		figures: { open: number; total: number };
		/** The newest `createdAt` of the project, null without a task. */
		lastAddedAt: string | null;
	};
}

export interface OverviewInput {
	entries: OverviewReadable[];
	unreadableProjects: Array<{ id: string; name: string; path: string; error: string }>;
}

export interface TreeOverview {
	rowCap: number;
	totals: { projects: number; readable: number; unreadable: number; open: number; total: number; done: number };
	projects: Array<Record<string, unknown>>;
}

/** ?rowCap=: absent is the default; anything but an integer in 1..MAX_ROW_CAP is refused, never clamped silently. */
export function parseRowCap(raw: string | undefined): number {
	if (raw === undefined || raw === '') return DEFAULT_ROW_CAP;
	const value = Number(raw);
	if (!Number.isInteger(value) || value < 1 || value > MAX_ROW_CAP) {
		throw new RequestError(
			400,
			`rowCap must be an integer from 1 to ${MAX_ROW_CAP}, got "${raw}"`,
			`Use ?rowCap=${DEFAULT_ROW_CAP} (the default), or open the project tree to see every task.`
		);
	}
	return value;
}

/** The newest `createdAt` among the tasks, null without any. ISO timestamps compare as text. */
export function newestCreatedAt(tasks: ReadonlyArray<{ createdAt: string }>): string | null {
	return tasks.reduce<string | null>(
		(newest, task) => (newest === null || task.createdAt > newest ? task.createdAt : newest),
		null
	);
}

function countNodes(nodes: readonly TaskTreeNode[]): number {
	return nodes.reduce((sum, node) => sum + 1 + countNodes(node.children), 0);
}

function collectRows(
	project: { id: string },
	terminal: readonly string[],
	nodes: readonly TaskTreeNode[],
	limit: number,
	depth: number,
	out: Array<Record<string, unknown>>
): void {
	for (const node of nodes) {
		if (out.length >= limit) return;
		out.push({
			id: node.id,
			title: node.title,
			titleText: shortTitle(node.title),
			status: node.status,
			// A closed task reads as done; an open one stays neutral (the status text says which).
			tone: terminal.includes(node.status) ? 'success' : 'neutral',
			depth,
			href: detailHref(project, node.id),
		});
		collectRows(project, terminal, node.children, limit, depth + 1, out);
	}
}

function subtreeStats(node: TaskTreeNode, terminal: readonly string[]): { done: number; total: number } {
	let done = 0;
	let total = 0;
	const visit = (child: TaskTreeNode): void => {
		total++;
		if (terminal.includes(child.status)) done++;
		child.children.forEach(visit);
	};
	node.children.forEach(visit);
	return { done, total };
}

function readableEntry(entry: OverviewReadable, rowCap: number): Record<string, unknown> {
	const { project, value } = entry;
	const { open, total } = value.figures;
	const done = total - open;
	const rows: Array<Record<string, unknown>> = [];
	collectRows(project, value.terminalStatuses, value.forest, rowCap, 0, rows);
	const rowCount = countNodes(value.forest);
	const hiddenCount = rowCount - rows.length;
	const roots = value.forest
		.filter(node => node.children.length > 0)
		.map(node => ({ node, ...subtreeStats(node, value.terminalStatuses) }))
		.sort((a, b) => b.total - a.total)
		.slice(0, ROOT_PREVIEW)
		.map(({ node, done: childDone, total: childTotal }) => ({
			id: node.id,
			titleText: shortTitle(node.title),
			title: node.title,
			status: node.status,
			href: detailHref(project, node.id),
			done: childDone,
			total: childTotal,
		}));
	const empty = total === 0;
	const allDone = !empty && open === 0;
	return {
		id: project.id,
		name: project.name,
		path: project.path,
		readable: true,
		treeHref: pageLink(project, 'tree'),
		open,
		total,
		done,
		percent: empty ? 0 : Math.round((done / total) * 100),
		empty,
		allDone,
		summaryText: empty ? 'No tasks' : allDone ? `All ${total} done` : `${open} open of ${total}`,
		lastAddedAt: value.lastAddedAt,
		lastAddedText: value.lastAddedAt === null ? '-' : shortUtcTime(value.lastAddedAt),
		rows,
		rowCount,
		hiddenCount,
		moreText:
			hiddenCount === 0
				? null
				: `${hiddenCount} more ${hiddenCount === 1 ? 'task' : 'tasks'}: open the tree of ${project.name}`,
		roots,
	};
}

/** The overview of the global forest: every project (unreadable ones with their reason), sorted by name, with totals. */
export function buildTreeOverview(input: OverviewInput, options: { rowCap: number }): TreeOverview {
	const projects: Array<Record<string, unknown>> = [
		...input.entries.map(entry => readableEntry(entry, options.rowCap)),
		...input.unreadableProjects.map(bad => ({
			id: bad.id,
			name: bad.name,
			path: bad.path,
			readable: false,
			treeHref: pageLink(bad, 'tree'),
			problemText: bad.error,
		})),
	].sort((a, b) => {
		const [left, right] = [String(a['name']).toLowerCase(), String(b['name']).toLowerCase()];
		return left < right ? -1 : left > right ? 1 : 0;
	});
	const readable = input.entries.length;
	const open = input.entries.reduce((sum, entry) => sum + entry.value.figures.open, 0);
	const total = input.entries.reduce((sum, entry) => sum + entry.value.figures.total, 0);
	return {
		rowCap: options.rowCap,
		totals: {
			projects: projects.length,
			readable,
			unreadable: input.unreadableProjects.length,
			open,
			total,
			done: total - open,
		},
		projects,
	};
}
