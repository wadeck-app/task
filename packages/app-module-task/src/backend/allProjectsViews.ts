// View models of the all-projects views (dashboard widget, Tasks page without ?project) over the task-service overview.
import type { TaskTreeNode } from '@wadeck-app/task-core';
import type { ProjectOverview, TasksAcrossProjects } from '@wadeck-app/task-service';

import { shortTitle, shortUtcTime } from './display.js';
import type { AcrossProjects } from './acrossProjects.js';
import { allProjectsPageHref, allProjectsTasksHref, detailHref, pageLink, tasksPageHref } from './hrefs.js';
import { BRANCH, flattenTree } from './rowViews.js';

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
	return `${plural(skipped.length, 'project')} not ${verb}: ${details}. Run \`task init\` in the project directory or check that it still exists.`;
}

/** The projects an overview could not read, as the `skipped` list of the answers. */
export function skippedOf(projects: readonly ProjectOverview[]): SkippedProject[] {
	return projects.flatMap(p => (p.error === null ? [] : [{ path: p.path, error: p.error }]));
}

/** Three or four words on why a project cannot be read: the narrow widget has no room for the full reason. */
function shortProblem(project: ProjectOverview): string {
	if (!project.exists) return 'missing';
	if (!project.initialized) return 'not initialized';
	return 'invalid config';
}

/** What the project table of the widget shows: figures and link for a readable project, the reason for the others. */
export function projectRows(projects: readonly ProjectOverview[]): Record<string, unknown>[] {
	return projects.map(p => ({
		name: p.name,
		// The widget table has no room for a Problem column: the reason's gist sits next to the name, the full one is in `problem`.
		label: p.error === null ? p.name : `${p.name} (${shortProblem(p)})`,
		path: p.path,
		// A project that cannot be read has no figures: a dash, never a 0 that reads as "empty".
		openText: p.open === null ? '-' : String(p.open),
		totalText: p.total === null ? '-' : String(p.total),
		problem: p.error ?? '',
		href: p.error === null ? tasksPageHref(p.path) : null,
	}));
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
 * The Tree page without ?project: one top-level row per project (opening its own tree), its forest indented under it.
 * A flat table, because the TreeView component cannot navigate from YAML (see rowViews.ts).
 */
export function allForestBody(found: AcrossProjects<TaskTreeNode[]>, showAll: boolean): Record<string, unknown> {
	let taskTotal = 0;
	const rows = found.entries.flatMap(({ project, value }) => {
		const tasks = flattenTree(project, value, 1);
		taskTotal += tasks.length;
		const href = pageLink(project, 'tree');
		const header = {
			id: '',
			title: project.name,
			status: plural(tasks.length, 'task'),
			depth: 0,
			label: project.name,
			isProject: true,
			href,
		};
		// An empty project says so: without this row it would read as a project the page forgot.
		const body =
			tasks.length > 0
				? tasks
				: [
						{
							id: '',
							title: '',
							status: '',
							depth: 1,
							label: `${BRANCH} (no ${showAll ? '' : 'open '}tasks)`,
							href,
						},
					];
		return [header, ...body];
	});
	return {
		scope: 'all',
		projectCount: found.entries.length,
		scopeText: `All projects: ${plural(found.entries.length, 'project')}, ${taskCount(taskTotal, showAll)}.`,
		showAllToggle: showAll
			? { label: 'Hide closed tasks', href: allProjectsPageHref('tree') }
			: { label: 'Show closed tasks', href: allProjectsPageHref('tree', true) },
		...skippedFields(found.unreadable),
		rows,
	};
}

/** The Types page without ?project: one row per type with its project, a row saying so for a project without any. */
export function allTypesBody(found: AcrossProjects<string[]>): Record<string, unknown> {
	const typeTotal = found.entries.reduce((sum, entry) => sum + entry.value.length, 0);
	return {
		scope: 'all',
		projectCount: found.entries.length,
		scopeText: `All projects: ${plural(found.entries.length, 'project')}, ${plural(typeTotal, 'type')} configured. A row opens its project, where types can be removed.`,
		...skippedFields(found.unreadable),
		rows: found.entries.flatMap(({ project, value }) =>
			(value.length > 0 ? value : [NO_TYPE_TEXT]).map(typeText => ({
				projectName: project.name,
				projectPath: project.path,
				typeText,
				href: pageLink(project, 'types'),
			}))
		),
		// Adding names its project in the form: only the ones that can be written to, none preselected.
		projectOptions: found.entries.map(({ project }) => ({
			value: encodeURIComponent(project.path),
			label: project.name,
		})),
		forms: { add: { projectParam: '', name: '' } },
	};
}
