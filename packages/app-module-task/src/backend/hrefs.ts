import { optionalQueryValue } from './request.js';
import type { RouteRequest } from './request.js';

/** The id app-core knows the module by: the prefix of its pages and routes. Must equal the id in manifest.json. */
export const MODULE_ID = 'task';

/**
 * The views build action URLs by text substitution, which does not encode: forms carry the project already encoded
 * (`projectParam`) and the action URL uses `?project={projectParam}`.
 */
export function encodedProject(project: { path: string }): string {
	return encodeURIComponent(project.path);
}

/** The line that names the project on a page (a header with actions shows no subtitle). */
export function projectText(project: { name: string }): string {
	return `Project: ${project.name}`;
}

/** A link to a module page of the project; `extra` parameters are appended encoded. */
export function pageLink(project: { path: string }, name: string, extra: Record<string, string> = {}): string {
	const extraQuery = Object.entries(extra)
		.map(([key, value]) => `&${key}=${encodeURIComponent(value)}`)
		.join('');
	return `/modules/${MODULE_ID}/${name}?project=${encodedProject(project)}${extraQuery}`;
}

/** Link to the tasks list page of a project (the module's nav page, project selected by the query). */
export function tasksPageHref(projectPath: string): string {
	return `/modules/${MODULE_ID}/tasks?project=${encodeURIComponent(projectPath)}`;
}

export function detailHref(project: { path: string }, taskId: string): string {
	return `/modules/${MODULE_ID}/tasks/${taskId}?project=${encodedProject(project)}`;
}

export function historyHref(project: { path: string }, taskId: string): string {
	return `/modules/${MODULE_ID}/tasks/${taskId}/history?project=${encodedProject(project)}`;
}

/** Hrefs of the module pages, with the project selected (the views link to each other with them). */
export function pageHrefs(project: { path: string }): Record<string, string> {
	return {
		tasks: pageLink(project, 'tasks'),
		tree: pageLink(project, 'tree'),
		types: pageLink(project, 'types'),
		newTask: pageLink(project, 'new'),
		deleteTasks: pageLink(project, 'delete'),
		projects: `/modules/${MODULE_ID}/projects`,
	};
}

/**
 * The query string a view appends to its sources: the encoded project plus the filters of the page URL (the loader
 * cannot append to a URL that already has a "?"). Empty while no project is selected, which makes the view skip the source.
 */
export function selectedQuery(projectPath: string | undefined, query: RouteRequest['query']): string {
	if (projectPath === undefined) return '';
	const parts = [`project=${encodeURIComponent(projectPath)}`];
	for (const name of ['showAll', 'parent', 'id']) {
		const value = optionalQueryValue(query, name);
		if (value !== undefined) parts.push(`${name}=${encodeURIComponent(value)}`);
	}
	return parts.join('&');
}

/** The link that flips showAll on a list page while keeping the other filters. */
export function showAllToggle(
	project: { path: string },
	page: string,
	showAll: boolean,
	extra: Record<string, string> = {}
): { label: string; href: string } {
	return showAll
		? { label: 'Hide closed tasks', href: pageLink(project, page, extra) }
		: { label: 'Show closed tasks', href: pageLink(project, page, { ...extra, showAll: 'true' }) };
}
