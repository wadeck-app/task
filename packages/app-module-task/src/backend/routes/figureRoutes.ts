// The live figures of the shell (manifest `count`): cheap GET routes answering `{ count: <whole number> }`.
//
// The shell reads them every `refreshSeconds` and shows nothing when a read fails, so a failure is a plain HTTP failure:
// never `inlineErrors` (it would turn the failure into a 200 without a number) and never a 0 that means "unknown".
// The ETag of the body is added by app-core for every 200 text answer (no `ctx.unchanged`: the data is a set of files in
// the registry, there is no single version to ask for before the work).
import { listTypes, summarizeProject, summarizeProjects } from '@wadeck-app/task-service';

import { RequestError } from '../errors.js';
import { openProject } from '../projects.js';
import type { RouteKit } from './routeKit.js';

/** The route answer of a figure. The tooltip is the manifest `label` after the number (the shell writes "3 open tasks"). */
function figure(count: number): { status: 200; body: { count: number } } {
	return { status: 200, body: { count } };
}

export function registerFigureRoutes(kit: RouteKit): void {
	const { route } = kit;

	// Menu entry "Tasks": open tasks (non terminal status of each project's config) across the registered projects with a
	// path. An unreadable project is left out, like in the widget and on the Projects page (which name it); only when NONE can
	// be read, or the registry itself cannot, the route fails (summarizeProjects throws), since 0 would read as "no tasks".
	route('GET', '/tasks/open/count', async () => {
		const summary = await summarizeProjects();
		if (summary.registryProblem !== undefined && summary.registryProblem !== null) {
			throw new RequestError(
				500,
				summary.registryProblem,
				'Repair or move away the registry file named above (the project CLI owns it), then retry.'
			);
		}
		return figure(summary.open);
	});

	// Tab "Tasks" of the project group: the project is a path segment of the tab page (id, name or alias).
	route('GET', '/tasks/p/:project/open/count', async req => {
		const ctx = openProject(req.params?.['project'] ?? '');
		return figure((await summarizeProject(ctx)).open);
	});

	// Tab "Types" of the project group.
	route('GET', '/types/p/:project/count', req => {
		const ctx = openProject(req.params?.['project'] ?? '');
		return figure(listTypes(ctx).length);
	});
}
