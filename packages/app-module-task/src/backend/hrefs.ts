import { apiRef, pageRef } from './projectRef.js';
import type { ProjectIdentity } from './projectRef.js';
import { optionalQueryValue } from './request.js';
import type { RouteRequest } from './request.js';

/** The id app-core knows the module by: the prefix of its pages and routes. Must equal the id in manifest.json. */
export const MODULE_ID = 'task';

/**
 * The views build action URLs by text substitution, which does not encode: forms carry the project already encoded
 * (`projectParam`) and the action URL uses `?project={projectParam}`. That is the API: it takes the registry id, else
 * (a project not in the shared registry) the directory.
 */
export function encodedProject(project: ProjectIdentity): string {
	return encodeURIComponent(apiRef(project));
}

/** The line that names the project on a page (a header with actions shows no subtitle). */
export function projectText(project: { name: string }): string {
	return `Project: ${project.name}`;
}

/** The module pages that exist once per project; the address of each is `/<section>/p/<slug>[/<tail>]`. */
type ProjectPage = 'tasks' | 'tree' | 'types' | 'new' | 'delete';

const PROJECT_PAGE_ADDRESS: Record<ProjectPage, { section: string; tail: string }> = {
	tasks: { section: 'tasks', tail: '' },
	tree: { section: 'tree', tail: '' },
	types: { section: 'types', tail: '' },
	new: { section: 'tasks', tail: '/new' },
	delete: { section: 'tasks', tail: '/delete' },
};

/**
 * The address of a page of one project. The project is a PATH segment, not a query: the shell's breadcrumb links each
 * crumb to the current address up to that page (path parameters substituted, query dropped), so only a path segment
 * survives a click on a crumb. Pages that act on a task are below the Tasks section (`/tasks/p/<slug>/<id>`).
 */
function projectAddress(project: ProjectIdentity, page: ProjectPage, below = ''): string {
	const { section, tail } = PROJECT_PAGE_ADDRESS[page];
	return `/modules/${MODULE_ID}/${section}/p/${pageRef(project)}${below}${tail}`;
}

/** A link to a module page of the project; `extra` parameters are the query of the page, appended encoded. */
export function pageLink(project: ProjectIdentity, name: ProjectPage, extra: Record<string, string> = {}): string {
	const query = Object.entries(extra)
		.map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
		.join('&');
	return `${projectAddress(project, name)}${query === '' ? '' : `?${query}`}`;
}

/** Link to the tasks list page of a project. */
export function tasksPageHref(project: ProjectIdentity | string): string {
	return pageLink(typeof project === 'string' ? { path: project } : project, 'tasks');
}

/** A module page across all projects (no project in the address); `showAll` lists the closed tasks too. */
export function allProjectsPageHref(page: 'tasks' | 'tree' | 'types', showAll = false): string {
	return `/modules/${MODULE_ID}/${page}${showAll ? '?showAll=true' : ''}`;
}

/** The Tasks page across all projects (no project in the address); `showAll` lists the closed tasks too. */
export function allProjectsTasksHref(showAll = false): string {
	return allProjectsPageHref('tasks', showAll);
}

export function detailHref(project: ProjectIdentity, taskId: string): string {
	return projectAddress(project, 'tasks', `/${taskId}`);
}

export function historyHref(project: ProjectIdentity, taskId: string): string {
	return `${detailHref(project, taskId)}/history`;
}

/** Hrefs of the module pages that act on the project (the views link to them), and the project list. */
export function pageHrefs(project: ProjectIdentity): Record<string, string> {
	return {
		newTask: pageLink(project, 'new'),
		deleteTasks: pageLink(project, 'delete'),
		projects: `/modules/${MODULE_ID}/projects`,
	};
}

/**
 * The query string a view appends to its sources: the encoded project reference (`apiRef`: the registry id, else the
 * directory) plus the filters of the page URL (the loader cannot append to a URL that already has a "?"). Empty while no
 * project is selected, which makes the view skip the source.
 */
export function selectedQuery(projectRef: string | undefined, query: RouteRequest['query']): string {
	if (projectRef === undefined) return '';
	const parts = [`project=${encodeURIComponent(projectRef)}`];
	for (const name of ['showAll', 'parent', 'id']) {
		const value = optionalQueryValue(query, name);
		if (value !== undefined) parts.push(`${name}=${encodeURIComponent(value)}`);
	}
	return parts.join('&');
}

/** The link that flips showAll on a list page while keeping the other filters. */
export function showAllToggle(
	project: ProjectIdentity,
	page: ProjectPage,
	showAll: boolean,
	extra: Record<string, string> = {}
): { label: string; href: string } {
	return showAll
		? { label: 'Hide closed tasks', href: pageLink(project, page, extra) }
		: { label: 'Show closed tasks', href: pageLink(project, page, { ...extra, showAll: 'true' }) };
}
