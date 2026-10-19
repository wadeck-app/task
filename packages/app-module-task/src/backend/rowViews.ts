// Row shapes of the module pages: tasks and trees decorated with the links the views navigate with.
import { LINK_TYPES } from '@wadeck-app/task-core';
import type { TaskLinks, TaskSummary, TaskTreeNode } from '@wadeck-app/task-core';

import { detailHref } from './hrefs.js';

type ProjectRef = { path: string };

/** Tasks with the project and the link to their detail page. */
export function withRowLinks(project: ProjectRef, tasks: TaskSummary[]): unknown[] {
	return tasks.map(task => ({ ...task, projectPath: project.path, href: detailHref(project, task.id) }));
}

/** The nested tree with the detail link on every node. */
export function withTreeLinks(project: ProjectRef, nodes: TaskTreeNode[]): unknown[] {
	return nodes.map(node => ({
		...node,
		href: detailHref(project, node.id),
		children: withTreeLinks(project, node.children),
	}));
}

// Indentation of the flat tree view: em spaces survive HTML whitespace collapsing, unlike plain spaces.
const EM_SPACE = String.fromCodePoint(0x2003);
const BRANCH = String.fromCodePoint(0x2514);

interface TreeRow {
	id: string;
	title: string;
	status: string;
	depth: number;
	/** The title, indented by depth: what a flat table shows as the hierarchy. */
	label: string;
	href: string;
	selected?: true;
}

/**
 * Depth-first rows of a tree. A DataTable shows them with a row click to the detail page; the TreeView component
 * cannot navigate from YAML (its selection is a callback), hence the flat view.
 */
export function flattenTree(project: ProjectRef, nodes: TaskTreeNode[], depth = 0): TreeRow[] {
	return nodes.flatMap(node => [
		{
			id: node.id,
			title: node.title,
			status: node.status,
			depth,
			label: depth === 0 ? node.title : `${EM_SPACE.repeat(depth - 1)}${BRANCH} ${node.title}`,
			href: detailHref(project, node.id),
			...(node.selected ? { selected: true as const } : {}),
		},
		...flattenTree(project, node.children, depth + 1),
	]);
}

interface LinkRow {
	relation: string;
	/** "outgoing": stored on this task; "derived": the inverse of a link stored on the other task. */
	direction: 'outgoing' | 'derived';
	id: string;
	title: string;
	status: string;
	href: string;
}

/** One row per linked task, flagged stored ("outgoing") or derived (the inverse of a link held by the other task). */
export function linkRows(project: ProjectRef, links: TaskLinks): LinkRow[] {
	const stored: readonly string[] = LINK_TYPES;
	return Object.entries(links).flatMap(([relation, tasks]) =>
		tasks.map(task => ({
			relation,
			direction: stored.includes(relation) ? ('outgoing' as const) : ('derived' as const),
			id: task.id,
			title: task.title,
			status: task.status,
			href: detailHref(project, task.id),
		}))
	);
}
