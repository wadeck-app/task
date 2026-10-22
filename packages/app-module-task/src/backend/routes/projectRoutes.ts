// GET /projects and GET /summary: which projects the module knows and how many tasks they hold.
import { isSameProjectDir, summarizeProject, summarizeProjects } from '@wadeck-app/task-service';
import type { ProjectOverview, ProjectsSummary } from '@wadeck-app/task-service';

import { projectRows, skippedOf, skippedWarning } from '../allProjectsViews.js';
import {
	allProjectsPageHref,
	allProjectsTasksHref,
	MODULE_ID,
	projectText,
	selectedQuery,
	tasksPageHref,
} from '../hrefs.js';
import { listProjects, NO_PROJECT_HINT, openProject } from '../projects.js';
import type { ProjectListing } from '../projects.js';
import { optionalQueryValue, queryValue } from '../request.js';
import type { RouteRequest } from '../request.js';
import type { RouteKit } from './routeKit.js';

/** The `?showAll` filter, passed on to the global list (the only filter it has). */
function globalQuery(query: RouteRequest['query']): string {
	const showAll = optionalQueryValue(query, 'showAll');
	return showAll === undefined ? 'allProjects=true' : `allProjects=true&showAll=${encodeURIComponent(showAll)}`;
}

/** The figures the widget shows, from the overview of the registered projects (or of the one asked for). */
function summaryBody(scope: 'all' | 'project', summary: ProjectsSummary): Record<string, unknown> {
	const skipped = skippedOf(summary.projects);
	const noProjects = summary.projects.length === 0;
	return {
		scope,
		// Nothing registered: the views show this text (with the exact next step), not an error nor empty figures.
		noProjects,
		noProjectsText: noProjects ? `No project is registered with the task app-module. ${NO_PROJECT_HINT}` : null,
		projectCount: summary.readableCount,
		open: summary.open,
		total: summary.total,
		byStatus: summary.byStatus,
		skipped,
		skippedCount: skipped.length,
		warning: skippedWarning(skipped, 'counted'),
		// The widget is narrow and its badge does not wrap: the detail is in the project table and on the Projects page.
		skippedText:
			skipped.length === 0
				? null
				: `${skipped.length} ${skipped.length === 1 ? 'project' : 'projects'} not counted (see the table).`,
		// What the status table shows: closed statuses are told apart from the open ones counted above.
		rows: summary.byStatus.map(entry => ({
			statusText: entry.terminal ? `${entry.status} (closed)` : entry.status,
			count: entry.count,
		})),
		// One row per registered project: figures and link, or the reason it is not counted.
		projectRows: projectRows(summary.projects),
	};
}

/** Why the selected project cannot be shown, with what to do about it. */
function problemText(project: ProjectListing): string {
	let fix = 'Fix the cause above, then reload.';
	if (!project.exists) {
		fix = `Run \`task projects remove ${project.path}\` to unregister it, or \`task projects add <dir>\` if the project moved.`;
	} else if (!project.initialized) {
		fix = `Run \`task init\` in ${project.path} to recreate it.`;
	}
	const cause = project.error?.endsWith('.') ? project.error : `${project.error}.`;
	return `${cause} ${fix}`;
}

export function registerProjectRoutes(kit: RouteKit): void {
	const { configDir } = kit;

	kit.route('GET', '/projects', req => {
		const projects = listProjects(configDir);
		const requested = optionalQueryValue(req.query, 'project');
		// The project the page is about: the one asked for (when registered), else the only registered one.
		const selected =
			projects.find(entry => requested !== undefined && isSameProjectDir(entry.path, requested)) ??
			(requested === undefined && projects.length === 1 ? projects[0] : undefined);
		const projectParam = selected === undefined ? '' : encodeURIComponent(selected.path);
		const base = { projectParam };
		const needsSelection = projects.length > 1 && selected === undefined;
		// A ?project the registry does not know: said on the Tasks page instead of an empty page.
		const unknownProject = requested !== undefined && selected === undefined;
		// A selected project that cannot be read: the views show why instead of requesting tasks that would fail.
		const readable = selected !== undefined && selected.error === null;
		const projectQuery = selectedQuery(readable ? selected.path : undefined, req.query);
		const global = needsSelection && requested === undefined ? globalQuery(req.query) : '';
		// A source asked for nothing keeps the answer of the previous scope in the shell: it asks for this empty answer instead.
		const projectOrBlank = projectQuery === '' ? 'blank=true' : projectQuery;
		const readableProjects = projects.filter(entry => entry.error === null);
		// Several projects, one of them readable: nothing to hesitate over for a creation. Never for a deletion.
		const onlyReadable = projects.length > 1 && readableProjects.length === 1 ? readableProjects[0] : undefined;
		const createProject = selected === undefined ? onlyReadable : selected;
		const backToGlobal = projects.length > 1 && (selected !== undefined || unknownProject);
		const selectedProblem = selected === undefined || selected.error === null ? null : problemText(selected);
		return {
			status: 200,
			body: {
				projects,
				// Nothing registered: the views show this text (with the exact next step) instead of staying blank.
				noProjects: projects.length === 0,
				noProjectsText:
					projects.length === 0
						? `No project is registered with the task app-module. ${NO_PROJECT_HINT}`
						: null,
				multiple: projects.length > 1,
				// Several projects and none chosen: the views ask for a choice instead of showing nothing.
				needsSelection,
				// The Tasks page across all projects: its source query while several projects exist and none is asked for.
				globalQuery: global,
				// What the Tasks, Tree and Types pages ask their one source: the project, else the global scope, else an empty answer.
				// One source for every scope, so the page never keeps the answer of the previous one (also when the project is unknown).
				scopeQuery: projectQuery !== '' ? projectQuery : global !== '' ? global : 'blank=true',
				// What the pages that always work on one project ask (the New task page): the project, else an empty answer.
				projectQuery: projectOrBlank,
				// Back to the global Tasks page from a project (or from an unknown one); a single project has no global view.
				allProjectsHref: backToGlobal ? allProjectsTasksHref() : null,
				// The same, for the page being shown: the matching global page of each module page.
				globalHrefs: backToGlobal
					? {
							tasks: allProjectsTasksHref(),
							tree: allProjectsPageHref('tree'),
							types: allProjectsPageHref('types'),
						}
					: null,
				selectedText: selected === undefined ? null : projectText(selected),
				unknownProjectText: unknownProject
					? `Project "${requested}" is not registered with the task app-module. Pick a registered project from "All projects", or register it with \`task projects add <dir>\`.`
					: null,
				selectedParam: projectParam,
				selectedProblem,
				selectedQuery: projectQuery,
				tasksHref: selected === undefined ? `/modules/${MODULE_ID}/tasks` : tasksPageHref(selected.path),
				// Only the projects that can be read: picking another one could only fail.
				projectOptions: readableProjects.map(entry => ({
					value: encodeURIComponent(entry.path),
					label: entry.name,
				})),
				// No project, or a selected one that cannot be read: no form either (its submit could only fail); the views gate their forms on it.
				forms:
					projects.length === 0 || selectedProblem !== null
						? null
						: {
								create: {
									projectParam:
										createProject === undefined ? '' : encodeURIComponent(createProject.path),
									description: '',
									parent: '',
								},
								delete: { ...base, ids: '', filter: '', all: false, cascade: false },
							},
			},
		};
	});

	kit.route('GET', '/summary', req => {
		const requested = queryValue(req.query, 'project');
		if (requested === undefined) {
			// Every registered project (nothing registered is an empty summary; none readable throws with the reasons).
			return { status: 200, body: summaryBody('all', summarizeProjects(configDir)) };
		}
		// Naming a project explicitly must fail loudly: an unreadable one is an error, not a skipped entry.
		const ctx = openProject(configDir, requested);
		const figures = summarizeProject(ctx);
		const overview: ProjectOverview = {
			name: ctx.project.name,
			path: ctx.project.path,
			exists: true,
			initialized: true,
			...figures,
			error: null,
		};
		return {
			status: 200,
			body: summaryBody('project', {
				projects: [overview],
				readableCount: 1,
				open: figures.open,
				total: figures.total,
				byStatus: figures.byStatus,
			}),
		};
	});
}
