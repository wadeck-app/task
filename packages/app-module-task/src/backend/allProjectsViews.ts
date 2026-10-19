// View models of the all-projects views (dashboard widget, Tasks page without ?project) over the task-service overview.
import type { ProjectOverview, TasksAcrossProjects } from '@wadeck-app/task-service';

import { shortTitle, shortUtcTime } from './display.js';
import { allProjectsTasksHref, detailHref, tasksPageHref } from './hrefs.js';

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

/** The Tasks page without ?project: every project's tasks in one list, rows linking to the task with its project. */
export function allTasksBody(found: TasksAcrossProjects, showAll: boolean): Record<string, unknown> {
	const unreadable = found.unreadable.map(({ path, error }) => ({ path, error }));
	const kind = showAll
		? `${plural(found.tasks.length, 'task')} (closed ones included)`
		: plural(found.tasks.length, 'open task');
	return {
		scope: 'all',
		projectCount: found.readableCount,
		scopeText: `All projects: ${plural(found.readableCount, 'project')}, ${kind}.`,
		showAllToggle: showAll
			? { label: 'Hide closed tasks', href: allProjectsTasksHref(false) }
			: { label: 'Show closed tasks', href: allProjectsTasksHref(true) },
		skipped: unreadable,
		skippedCount: unreadable.length,
		warning: skippedWarning(unreadable, 'listed'),
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
