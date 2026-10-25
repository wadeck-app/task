// View models of the all-projects views (dashboard widget, Tasks page without ?project) over the task-service overview.
import type { TaskTreeNode } from '@wadeck-app/task-core';
import type { ProjectOverview, TasksAcrossProjects } from '@wadeck-app/task-service';

import { shortTitle, shortUtcTime } from './display.js';
import type { AcrossProjects } from './acrossProjects.js';
import {
	allProjectsPageHref,
	allProjectsTasksHref,
	detailHref,
	encodedProject,
	pageLink,
	tasksPageHref,
} from './hrefs.js';
import { projectTasksSection } from './dslNodes.js';
import { flattenTree } from './rowViews.js';

const NO_TYPE_TEXT = '(none configured: any text is accepted)';

function plural(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/** A project an all-projects view could not read. */
export interface SkippedProject {
	path: string;
	error: string;
}

/** One display line for the projects an all-projects view left out; null when there is none. */
export function skippedWarning(skipped: readonly SkippedProject[], verb: 'counted' | 'listed'): string | null {
	if (skipped.length === 0) return null;
	const details = skipped.map(entry => `${entry.path} (${entry.error})`).join('; ');
	return `${plural(skipped.length, 'project')} not ${verb}: ${details}. Each reason names its fix.`;
}

/** The projects an overview could not read, as the `skipped` list of the answers. */
export function skippedOf(projects: readonly ProjectOverview[]): SkippedProject[] {
	return projects.flatMap(p => (p.error === null ? [] : [{ path: p.path, error: p.error }]));
}

/** Three or four words on why a project cannot be read: the narrow widget has no room for the full reason. */
function shortProblem(project: ProjectOverview): string {
	if (!project.exists) return 'missing';
	return 'invalid config';
}

/**
 * Characters of the project column of the widget. The shell caps a truncated cell at 320px (not at its tile), so a long name
 * would push the figure columns out of a 3-cell tile (about 300px of table): the route cuts the text itself.
 */
export const WIDGET_LABEL_MAX = 24;

/** The text cut to `max` characters, ending with an ellipsis when it was longer. */
function clamp(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

/** What the project table of the widget shows: figures and link for a readable project, the reason for the others. */
export function projectRows(projects: readonly ProjectOverview[]): Record<string, unknown>[] {
	return projects.map(p => {
		// The gist of an unreadable project stays visible: the name gives way, never the reason.
		const suffix = p.error === null ? '' : ` (${shortProblem(p)})`;
		return {
			name: p.name,
			// The widget table has no room for a Problem column: the reason's gist sits next to the (cut) name, the full one is in `problem`.
			label: `${clamp(p.name, WIDGET_LABEL_MAX - suffix.length)}${suffix}`,
			// Tooltip of the cell: the whole name, and for an unreadable project the whole reason with its fix.
			labelTitle: p.error === null ? p.name : `${p.name}: ${p.error}`,
			path: p.path,
			// A project that cannot be read has no figures: a dash, never a 0 that reads as "empty".
			openText: p.open === null ? '-' : String(p.open),
			totalText: p.total === null ? '-' : String(p.total),
			problem: p.error ?? '',
			href: p.error === null ? tasksPageHref(p) : null,
		};
	});
}

/** "3 open tasks", or "3 tasks (closed ones included)" when the closed ones are listed. */
function taskCount(count: number, showAll: boolean): string {
	return showAll ? `${plural(count, 'task')} (closed ones included)` : plural(count, 'open task');
}

/** The fields every all-projects answer carries about the projects it could not read. */
function skippedFields(skipped: readonly SkippedProject[]): Record<string, unknown> {
	return { skipped, skippedCount: skipped.length, warning: skippedWarning(skipped, 'listed') };
}

/** The Tasks page without ?project: every project's tasks in one list, rows linking to the task with its project. */
export function allTasksBody(found: TasksAcrossProjects, showAll: boolean): Record<string, unknown> {
	const unreadable = found.unreadable.map(({ path, error }) => ({ path, error }));
	return {
		scope: 'all',
		projectCount: found.readableCount,
		scopeText: `All projects: ${plural(found.readableCount, 'project')}, ${taskCount(found.tasks.length, showAll)}.`,
		showAllToggle: showAll
			? { label: 'Hide closed tasks', href: allProjectsTasksHref(false) }
			: { label: 'Show closed tasks', href: allProjectsTasksHref(true) },
		...skippedFields(unreadable),
		tasks: found.tasks.map(task => ({
			...task,
			projectName: task.project.name,
			projectPath: task.project.path,
			titleText: shortTitle(task.title),
			created: shortUtcTime(task.createdAt),
			href: detailHref(task.project, task.id),
		})),
	};
}

/**
 * The Tree page without ?project: one section per project (its name and count, a link to its own tree, its forest as
 * a table). The DataTable has no row styling nor grouping, so a project header row could not be told from a task row:
 * the sections are DSL nodes built here and rendered as is by the view (see dslNodes.ts).
 */
export function allForestBody(
	found: AcrossProjects<{ forest: TaskTreeNode[]; terminalStatuses: readonly string[] }>,
	showAll: boolean
): Record<string, unknown> {
	let taskTotal = 0;
	let closedKept = 0;
	const groups = found.entries.map(({ project, value }) => {
		const rows = flattenTree(project, value.forest);
		taskTotal += rows.length;
		// Without showAll, a closed task in the forest is a parent kept above an open one: it is not an open task.
		if (!showAll) closedKept += rows.filter(row => value.terminalStatuses.includes(row.status)).length;
		return projectTasksSection({
			title: `${project.name} (${plural(rows.length, 'task')})`,
			linkLabel: `Open the tree of ${project.name}`,
			linkTo: pageLink(project, 'tree'),
			rows,
			// An empty project says so: without it the section would read as a project the page forgot.
			emptyMessage: showAll ? 'No tasks' : 'No open tasks',
		});
	});
	return {
		scope: 'all',
		projectCount: found.entries.length,
		scopeText: `All projects: ${plural(found.entries.length, 'project')}, ${taskCount(taskTotal - closedKept, showAll)}${closedKept === 0 ? '' : `, plus ${plural(closedKept, 'closed parent')} kept for context`}.`,
		showAllToggle: showAll
			? { label: 'Hide closed tasks', href: allProjectsPageHref('tree') }
			: { label: 'Show closed tasks', href: allProjectsPageHref('tree', true) },
		...skippedFields(found.unreadable),
		groups,
	};
}

/** The Types page without ?project: one row per type with its project, a row saying so for a project without any. */
export function allTypesBody(found: AcrossProjects<string[]>): Record<string, unknown> {
	const typeTotal = found.entries.reduce((sum, entry) => sum + entry.value.length, 0);
	return {
		scope: 'all',
		projectCount: found.entries.length,
		scopeText: `All projects: ${plural(found.entries.length, 'project')}, ${plural(typeTotal, 'type')} configured. Remove on a row deletes that type from its project.`,
		...skippedFields(found.unreadable),
		// A removable row carries what the remove action needs: the shell fills {name} and {projectParam} of the action URL
		// from the row, and the confirm text says what the next click does. The "none configured" row removes nothing.
		rows: found.entries.flatMap(({ project, value }) =>
			(value.length > 0 ? value : [NO_TYPE_TEXT]).map(typeText => {
				const canRemove = value.length > 0;
				return {
					projectName: project.name,
					projectPath: project.path,
					typeText,
					projectParam: encodedProject(project),
					name: canRemove ? encodeURIComponent(typeText) : '',
					canRemove,
					confirmText: canRemove ? `Remove the type "${typeText}" from the project ${project.name}?` : '',
					confirmLabel: canRemove ? `Remove "${typeText}" from ${project.name}` : '',
				};
			})
		),
		// Adding names its project in the form: only the ones that can be written to, none preselected.
		projectOptions: found.entries.map(({ project }) => ({
			value: encodedProject(project),
			label: project.name,
		})),
		forms: { add: { projectParam: '', name: '' } },
	};
}
