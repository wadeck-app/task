// View models of the Projects page: a READ-ONLY list. Projects are added, moved and removed with the project CLI (Decision #20);
// the page shows what task knows, the registered/unregistered marker, and the exact command that registers a legacy project.
import { literal } from './dslNodes.js';
import type { DslNode } from './dslNodes.js';
import type { ProjectListing } from './projects.js';

function plural(count: number): string {
	return `${count} ${count === 1 ? 'project' : 'projects'}`;
}

/** One row of the Projects table: name, directory, open tasks, the registry column (id, or the command that registers it), the problem. */
export function listRows(projects: readonly ProjectListing[]): Record<string, unknown>[] {
	return projects.map(project => ({
		name: project.name,
		path: project.path,
		registered: project.registered,
		// The Registry column: the id of a shared project, or what to run to register the others.
		registryText: project.registered ? `shared registry (${project.id})` : (project.registryHint ?? ''),
		openText: project.openCount === null ? '-' : String(project.openCount),
		// The reason carries its own fix (migration command, config file to repair, project CLI command).
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
 * One text for the pages that list projects (Projects page, dashboard widget): the shared registry that could not be read, and
 * the projects found only through the legacy projects.json, with the command that registers each. Null when there is nothing to say.
 */
export function registryNotice(
	projects: ReadonlyArray<{ path: string; registered: boolean }>,
	registryProblem: string | null
): string | null {
	const parts: string[] = [];
	if (registryProblem !== null) {
		parts.push(
			`The shared project registry could not be read, only the legacy projects are listed: ${registryProblem}`
		);
	}
	const unregistered = projects.filter(project => !project.registered);
	if (unregistered.length > 0) {
		const commands = unregistered.map(project => `project add "${project.path}"`).join('; ');
		parts.push(
			`${plural(unregistered.length)} not in the shared project registry (the legacy list is removed in a later version): ${commands}.`
		);
	}
	return parts.length === 0 ? null : parts.join(' ');
}

/** The banner above the table when some projects cannot be read; null when all can. */
export function attentionText(projects: readonly ProjectListing[]): string | null {
	const broken = projects.filter(project => project.error !== null).length;
	if (broken === 0) return null;
	return `${plural(broken)} cannot be read: the Problem column gives the reason and the command that fixes it.`;
}
