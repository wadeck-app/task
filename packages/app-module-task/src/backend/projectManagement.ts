// View models of the Projects page: a READ-ONLY list of the projects of the shared registry. Projects are added, moved and removed
// with the project CLI (Decision #20); the page shows what task knows: id, name, main folder, open tasks, the problem with its fix.
import { literal } from './dslNodes.js';
import type { DslNode } from './dslNodes.js';
import type { ProjectListing } from './projects.js';

function plural(count: number): string {
	return `${count} ${count === 1 ? 'project' : 'projects'}`;
}

/** One row of the Projects table: registry id, name, main folder, open tasks, the problem. */
export function listRows(projects: readonly ProjectListing[]): Record<string, unknown>[] {
	return projects.map(project => ({
		id: project.id,
		name: project.name,
		path: project.path,
		openText: project.openCount === null ? '-' : String(project.openCount),
		// The reason carries its own fix (config file to repair, project CLI command).
		problemText: project.error ?? '',
	}));
}

/** Links to the tasks of the readable projects: a table cannot navigate on a row click here. */
export function openLinks(projects: readonly ProjectListing[]): DslNode[] {
	return projects.flatMap(project =>
		project.href === null
			? []
			: [{ $type: 'ButtonLink', label: literal(project.name), to: project.href, size: 'sm' } satisfies DslNode]
	);
}

/**
 * The text shown by the pages that list projects (Projects page, dashboard widget) when the shared registry could not be read:
 * no project is listed then, and this says why. Null when it could be read (or does not exist yet: the first-use state).
 */
export function registryProblemText(registryProblem: string | null): string | null {
	return registryProblem === null ? null : `The shared project registry could not be read: ${registryProblem}`;
}

/** The banner above the table when some projects cannot be read; null when all can. */
export function attentionText(projects: readonly ProjectListing[]): string | null {
	const broken = projects.filter(project => project.error !== null).length;
	if (broken === 0) return null;
	return `${plural(broken)} cannot be read: the Problem column gives the reason and the command that fixes it.`;
}
