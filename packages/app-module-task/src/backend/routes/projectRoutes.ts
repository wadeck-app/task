// GET /projects and GET /summary: which projects the module knows and how many tasks they hold.
import { countTasksByStatus, describeError, isSameProjectDir } from '@wadeck-app/task-service';
import type { StatusCount, TaskServiceContext } from '@wadeck-app/task-service';

import { RequestError } from '../errors.js';
import { MODULE_ID, selectedQuery, tasksPageHref } from '../hrefs.js';
import { listProjects, NO_PROJECT_HINT, openProject, requireRegisteredProjects } from '../projects.js';
import type { ProjectListing } from '../projects.js';
import { optionalQueryValue, queryValue } from '../request.js';
import type { RouteKit } from './routeKit.js';

function skippedCount(count: number): string {
	return `${count} ${count === 1 ? 'project' : 'projects'}`;
}

/** One display line for the projects the all-projects summary could not read; null when there is none. */
function skippedWarning(skipped: readonly { path: string; error: string }[]): string | null {
	if (skipped.length === 0) return null;
	const noun = skipped.length === 1 ? 'project' : 'projects';
	const details = skipped.map(entry => `${entry.path} (${entry.error})`).join('; ');
	return `${skipped.length} ${noun} not counted: ${details}. Run \`task init\` in the project directory or check that it still exists.`;
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
		// A selected project that cannot be read: the views show why instead of requesting tasks that would fail.
		const readable = selected !== undefined && selected.error === null;
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
				needsSelection: projects.length > 1 && selected === undefined,
				selectedParam: projectParam,
				selectedProblem,
				selectedQuery: selectedQuery(readable ? selected.path : undefined, req.query),
				tasksHref: selected === undefined ? `/modules/${MODULE_ID}/tasks` : tasksPageHref(selected.path),
				projectOptions: projects.map(entry => ({ value: encodeURIComponent(entry.path), label: entry.name })),
				// No project, or a selected one that cannot be read: no form either (its submit could only fail); the views gate their forms on it.
				forms:
					projects.length === 0 || selectedProblem !== null
						? null
						: {
								create: { ...base, description: '', parent: '' },
								delete: { ...base, ids: '', filter: '', all: false, cascade: false },
							},
			},
		};
	});

	kit.route('GET', '/summary', req => {
		const requested = queryValue(req.query, 'project');
		const dirs = requested === undefined ? requireRegisteredProjects(configDir) : [requested];
		const merged = new Map<string, StatusCount>();
		const skipped: { path: string; error: string }[] = [];
		let projectCount = 0;
		let open = 0;
		let total = 0;
		for (const dir of dirs) {
			let project: TaskServiceContext;
			try {
				project = openProject(configDir, dir);
			} catch (error) {
				// Naming a project explicitly must fail loudly; in the all-projects view one broken project is reported, not hidden.
				if (requested !== undefined) throw error;
				skipped.push({ path: dir, error: describeError(error).message });
				continue;
			}
			projectCount++;
			for (const entry of countTasksByStatus(project)) {
				const sum = merged.get(entry.status) ?? { ...entry, count: 0 };
				sum.count += entry.count;
				merged.set(entry.status, sum);
				total += entry.count;
				if (!entry.terminal) open += entry.count;
			}
		}
		// Zeros from a registry whose every project failed would read as "no tasks": answer the failure instead.
		if (projectCount === 0 && skipped.length > 0) {
			throw new RequestError(
				500,
				`none of the ${skipped.length} registered projects could be read: ${skipped.map(s => `${s.path} (${s.error})`).join('; ')}`,
				'Fix the causes above: `task init` in a project directory recreates its .task, `task projects remove <dir>` unregisters a vanished one (`task projects prune` drops every missing one).',
				{ skipped }
			);
		}
		const rows = [...merged.values()].map(entry => ({
			statusText: entry.terminal ? `${entry.status} (closed)` : entry.status,
			count: entry.count,
		}));
		return {
			status: 200,
			body: {
				scope: requested === undefined ? 'all' : 'project',
				projectCount,
				open,
				total,
				byStatus: [...merged.values()],
				skipped,
				skippedCount: skipped.length,
				warning: skippedWarning(skipped),
				// The widget is narrow and its badge does not wrap: the detail is on the Projects page.
				skippedText:
					skipped.length === 0
						? null
						: `${skippedCount(skipped.length)} not counted (see the Projects page).`,
				// What the table shows: closed statuses are told apart from the open ones counted above.
				rows,
			},
		};
	});
}
