import * as fs from 'node:fs';

import {
	describeError,
	listKnownProjects,
	listTasks,
	openTaskContext,
	resolveProjectReference,
} from '@wadeck-app/task-service';
import type { KnownProject, TaskServiceContext } from '@wadeck-app/task-service';

import { RequestError } from './errors.js';
import { tasksPageHref } from './hrefs.js';

/** The service context of a project the module can address: a registered project with a folder, so its path is known. */
export type OpenedProject = TaskServiceContext & { project: { id: string; name: string; path: string } };

export interface ProjectListing {
	/** Id in the shared project registry. */
	id: string;
	/** Registry name. */
	name: string;
	path: string;
	/** False when the project folder is gone (informational: the tasks of a registered project are in the registry). */
	exists: boolean;
	/** Tasks in a non-terminal status; null when the project cannot be read (see `error`). */
	openCount: number | null;
	/** Why the project cannot be read (invalid config.yml, broken parent chain...), with the fix; null when it can. */
	error: string | null;
	/** Link to the tasks page of the project; null when the project cannot be read. */
	href: string | null;
}

/** The message of a failure with its hint on one text, as shown next to a project that cannot be read. */
function problemOf(error: unknown): string {
	const { message, hint } = error instanceof RequestError ? error : describeError(error);
	return hint === undefined ? message : `${message}. ${hint}`;
}

/** The checks every use of a known project starts with, then its context. */
function openKnown(known: KnownProject): OpenedProject {
	if (known.problem !== undefined) {
		throw new RequestError(
			409,
			known.problem,
			`Fix the parent chain of project ${known.name} with the project CLI (project set-parent).`
		);
	}
	return openTaskContext({
		storage: known.storage,
		project: { id: known.id, name: known.name, path: known.path },
	}) as OpenedProject;
}

function listingOf(known: KnownProject): ProjectListing {
	const base = {
		id: known.id,
		name: known.name,
		path: known.path,
		exists: fs.existsSync(known.path),
	};
	try {
		const openCount = listTasks(openKnown(known), {}).length;
		return { ...base, openCount, error: null, href: tasksPageHref(base) };
	} catch (error) {
		// One unreadable project must not hide the others, nor read as "0 open": it is listed with its reason and fix.
		return { ...base, openCount: null, error: problemOf(error), href: null };
	}
}

/**
 * The projects the module shows: every project of the shared registry that has a folder. Read at every call (never cached).
 * `registryProblem` says why the shared registry could not be read (then no project is listed).
 */
export function readProjects(): { projects: ProjectListing[]; registryProblem: string | null } {
	const known = listKnownProjects();
	return {
		projects: known.projects.map(entry => listingOf(entry)),
		registryProblem: known.registryProblem,
	};
}

export function listProjects(): ProjectListing[] {
	return readProjects().projects;
}

/**
 * Resolves the project a request targets and builds the service context over its store.
 * `requested` is the `?project=` value: the id, an id prefix (>= 4), the name or an alias of a project of the shared registry,
 * nothing else (a folder or a slug is an unknown reference, a 404). Without it, the only known project is used; several make the
 * choice ambiguous (400 listing them). An unreadable shared registry throws its error unchanged (never read as "no project");
 * an unknown reference is a 404 (suggestions of the registry), an ambiguous one a 409 with candidates.
 */
export function openProject(requested: string | undefined): OpenedProject {
	// A form whose project select was left on its placeholder sends an empty project: say so, instead of "not found".
	if (requested === '') {
		throw new RequestError(
			400,
			'no project chosen',
			'Choose a project in the form first (or pass ?project=<id|name|alias>; GET /api/modules/task/projects lists the known ones).'
		);
	}
	const listed = listKnownProjects();
	// No project because the registry could not be read is not "nothing registered": say what is wrong with the file.
	if (requested === undefined && listed.projects.length === 0 && listed.registryProblem !== null) {
		throw new RequestError(
			500,
			listed.registryProblem,
			'Repair or move away the registry file named above (the project CLI owns it), then retry.'
		);
	}
	return openKnown(pickProject(listed.projects, requested));
}

/** What to do when nothing is registered: shown by every view and answered by every route. */
export const NO_PROJECT_HINT =
	'Register a project with the project CLI (project add <dir>): its tasks then live in the shared registry.';

function requireAny(known: readonly KnownProject[]): void {
	if (known.length === 0) {
		throw new RequestError(404, 'no project is registered with the task app-module', NO_PROJECT_HINT);
	}
}

/** The 404 hint of a reference that names no project: what the module accepts, and where the known ones are listed. */
const KNOWN_PROJECTS_HINT =
	'Use the id, name or alias of a registered project (GET /api/modules/task/projects lists them).';

function pickProject(known: readonly KnownProject[], requested: string | undefined): KnownProject {
	if (requested !== undefined) {
		// An id, a name, an alias or an id prefix is the shared registry's to resolve (typed errors: not found, ambiguous, unreadable).
		let resolved;
		try {
			resolved = resolveProjectReference(requested);
		} catch (error) {
			const described = describeError(error);
			// Only the registry's "no project matches" carries suggestions: it keeps them, and gains the hint it lacks.
			if (described.kind === 'not-found' && 'suggestions' in described.details) {
				throw new RequestError(404, described.message, KNOWN_PROJECTS_HINT, described.details);
			}
			throw error;
		}
		if (resolved.path === undefined) {
			throw new RequestError(
				409,
				`project ${resolved.name} (${resolved.id}) is a virtual project (no folder): the task app-module addresses projects by folder`,
				`Use the CLI for it: task -p ${resolved.name} list. Give the project a folder with the project CLI (project paths add) to use it here.`
			);
		}
		return {
			id: resolved.id,
			name: resolved.name,
			path: resolved.path,
			storage: resolved.storage,
		};
	}
	requireAny(known);
	if (known.length > 1) {
		throw new RequestError(
			400,
			'several projects are registered: the project query parameter is required',
			`Add ?project=<id|name|alias> (one of: ${known.map(entry => `${entry.name} (${entry.id})`).join(', ')}).`,
			{ registeredProjects: known.map(entry => entry.path) }
		);
	}
	return known[0]!;
}
