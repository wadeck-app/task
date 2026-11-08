// What the accordion of the global Tree page reads (`projects` of GET /tree?allProjects=true): one entry per registered
// project, readable or not. `task:ProjectAccordion` filters and folds it in the browser, so its size is bounded here
// (ROW_CAP rows per project) and the full forest stays one click away at `treeHref`.
import type { TaskTreeNode } from '@wadeck-app/task-core';

import { shortTitle } from './display.js';
import { detailHref, pageLink } from './hrefs.js';

/** Rows sent per project: the rest is reached through the "N more" link to the tree page of the project. */
export const ROW_CAP = 60;
/** Unreadable projects named in the one-line summary before "and N more". */
const NAMED_UNREADABLE_MAX = 5;

export interface TreeProjectReadable {
	project: { id: string; name: string; path: string };
	value: {
		forest: TaskTreeNode[];
		terminalStatuses: readonly string[];
		/** The terminal statuses that end badly (rows in the danger tone). */
		negativeStatuses?: readonly string[];
		figures: { open: number; total: number };
	};
}

export interface UnreadableProject {
	id: string;
	name: string;
	path: string;
	error: string;
}

export interface TreeProjectsInput {
	entries: TreeProjectReadable[];
	unreadableProjects: UnreadableProject[];
}

/** Tasks in the forest, and how many of them are closed (a closed task in an open-only forest is a parent kept for context). */
export function countForest(
	nodes: readonly TaskTreeNode[],
	terminal: readonly string[]
): { tasks: number; closed: number } {
	let tasks = 0;
	let closed = 0;
	const visit = (list: readonly TaskTreeNode[]): void => {
		for (const node of list) {
			tasks++;
			if (terminal.includes(node.status)) closed++;
			visit(node.children);
		}
	};
	visit(nodes);
	return { tasks, closed };
}

function collectRows(
	project: { id: string },
	terminal: readonly string[],
	negative: readonly string[],
	nodes: readonly TaskTreeNode[],
	depth: number,
	out: Array<Record<string, unknown>>
): void {
	for (const node of nodes) {
		if (out.length >= ROW_CAP) return;
		out.push({
			id: node.id,
			title: node.title,
			titleText: shortTitle(node.title),
			status: node.status,
			// A closed task reads as done (or danger when it ended badly); an open one stays neutral (the status text says which).
			tone: terminal.includes(node.status) ? (negative.includes(node.status) ? 'danger' : 'success') : 'neutral',
			depth,
			href: detailHref(project, node.id),
		});
		collectRows(project, terminal, negative, node.children, depth + 1, out);
	}
}

function readableEntry({ project, value }: TreeProjectReadable): Record<string, unknown> {
	const { open, total } = value.figures;
	const rows: Array<Record<string, unknown>> = [];
	collectRows(project, value.terminalStatuses, value.negativeStatuses ?? [], value.forest, 0, rows);
	const hiddenCount = countForest(value.forest, value.terminalStatuses).tasks - rows.length;
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
		percent: empty ? 0 : Math.round(((total - open) / total) * 100),
		empty,
		allDone,
		summaryText: empty ? 'No tasks' : allDone ? `All ${total} done` : `${open} open of ${total}`,
		rows,
		hiddenCount,
		moreText:
			hiddenCount === 0
				? null
				: `${hiddenCount} more ${hiddenCount === 1 ? 'task' : 'tasks'}: open the tree of ${project.name}`,
	};
}

/** Every project (unreadable ones with their reason and fix), sorted by name. */
export function buildTreeProjects(input: TreeProjectsInput): Array<Record<string, unknown>> {
	return [
		...input.entries.map(readableEntry),
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
}

/**
 * The page-level line about the projects that could not be read: how many and which (names only). The reason and the fix
 * sit on each project's flagged line of the list; raw paths and YAML errors never lead the page.
 */
export function unreadableSummary(unreadable: readonly UnreadableProject[]): string | null {
	if (unreadable.length === 0) return null;
	const names = unreadable.map(bad => bad.name);
	const listed =
		names.length <= NAMED_UNREADABLE_MAX
			? names.join(', ')
			: `${names.slice(0, NAMED_UNREADABLE_MAX).join(', ')} and ${names.length - NAMED_UNREADABLE_MAX} more`;
	const count = unreadable.length === 1 ? '1 project cannot' : `${unreadable.length} projects cannot`;
	const target = unreadable.length === 1 ? 'it' : 'one';
	return `${count} be read: ${listed}. Open ${target} in the list below for its reason and fix.`;
}
