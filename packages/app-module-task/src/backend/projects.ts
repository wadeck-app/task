import * as fs from 'node:fs';
import * as path from 'node:path';

import { TaskConfigLoader } from '@wadeck-app/task-core';
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
import { findProjectByRef } from './projectRef.js';

export interface ProjectListing {
	/** Id in the shared project registry; absent for a project known only by the legacy projects.json. */
	id?: string;
	/** Registry name when registered, else the directory name. */
	name: string;
	path: string;
	/** In the shared project registry. */
	registered: boolean;
	/** For a project that is not registered: what to run to register it (the legacy list goes away in stage 2); null when registered. */
	registryHint: string | null;
	/** False when the registered directory is gone. */
	exists: boolean;
	/** False when the directory is registered but has no `.task` directory any more. */
	initialized: boolean;
	/** Tasks in a non-terminal status; null when the project cannot be read (see `error`). */
	openCount: number | null;
	/** Why the project cannot be read (not initialized, corrupt config.yml...); null when it can. */
	error: string | null;
	/** Link to the tasks page of the project; null when the project cannot be read. */
	href: string | null;
}

/** The line shown next to a project that is not in the shared registry. */
export function registryHintFor(dir: string): string {
	return `Not in the shared project registry: project add "${dir}"`;
}

/** The checks every use of a known project starts with: its directory exists and holds a `.task`. */
function openKnown(known: KnownProject): TaskServiceContext {
	if (!fs.existsSync(known.path)) {
		throw new RequestError(
			404,
			`project directory ${known.path} no longer exists`,
			known.registered
				? `Move it in the shared registry (project paths move) or unregister it (project remove "${known.name}").`
				: `Run \`task projects remove ${known.path}\` to unregister it (\`task projects prune\` drops every missing one).`
		);
	}
	if (!TaskConfigLoader.isInitialized(known.path)) {
		throw new RequestError(
			404,
			`project "${known.name}" is registered but not initialized (no .task directory)`,
			`Run \`task init\` in ${known.path} to recreate it.`
		);
	}
	return openTaskContext({
		projectDir: known.path,
		...(known.registered ? { project: { id: known.id, name: known.name } } : {}),
	});
}

function listingOf(known: KnownProject): ProjectListing {
	const base = {
		...(known.id === undefined ? {} : { id: known.id }),
		name: known.name,
		path: known.path,
		registered: known.registered,
		registryHint: known.registered ? null : registryHintFor(known.path),
		exists: fs.existsSync(known.path),
		initialized: TaskConfigLoader.isInitialized(known.path),
	};
	try {
		const openCount = listTasks(openKnown(known), {}).length;
		return { ...base, openCount, error: null, href: tasksPageHref(base) };
	} catch (error) {
		// One unreadable project must not hide the others, nor read as "0 open": it is listed with its reason.
		return { ...base, openCount: null, error: describeError(error).message, href: null };
	}
}

/**
 * The projects the module shows: the shared registry first, then the legacy projects.json entries it does not cover. Read at
 * every call (never cached). `registryProblem` says why the shared registry could not be read: the legacy projects are still
 * listed. A corrupt projects.json throws its error.
 */
export function readProjects(configDir: string): { projects: ProjectListing[]; registryProblem: string | null } {
	const known = listKnownProjects(configDir);
	return { projects: known.projects.map(listingOf), registryProblem: known.registryProblem };
}

export function listProjects(configDir: string): ProjectListing[] {
	return readProjects(configDir).projects;
}

/**
 * Resolves the project a request targets and builds the service context over its store.
 * `requested` is the `?project=` value: the id, name or alias of a project of the shared registry, or (deprecated) the
 * absolute directory of a known project. Without it, the only known project is used; several make the choice ambiguous
 * (400 listing them). A corrupt projects.json or an unreadable shared registry throws its error unchanged (never read as
 * "no project"); an unknown reference is the registry's typed error (404 with suggestions, 409 with candidates).
 */
export function openProject(configDir: string, requested: string | undefined): TaskServiceContext {
	// A form whose project select was left on its placeholder sends an empty project: say so, instead of "not found".
	if (requested === '') {
		throw new RequestError(
			400,
			'no project chosen',
			'Choose a project in the form first (or pass ?project=<id|name|alias>; GET /api/modules/task/projects lists the known ones).'
		);
	}
	return openKnown(pickProject(listKnownProjects(configDir).projects, requested));
}

/** What to do when nothing is registered: shown by every view and answered by every route. */
export const NO_PROJECT_HINT =
	'Add one on the Projects page (menu Projects), run `task init` in a project directory to create and register it, or `task projects add <dir>` for a project that is already initialized. Projects of the shared registry (`project add <dir>`) appear here once their folder holds a .task.';

/** The same, on the Projects page itself: it has the add form, so it does not send the user to the page they are on. */
export const NO_PROJECT_HINT_ON_PROJECTS_PAGE =
	'Use the form below to add one, run `task init` in a project directory to create and register it, or `task projects add <dir>` for a project that is already initialized. Projects of the shared registry (`project add <dir>`) appear here once their folder holds a .task.';

function requireAny(known: readonly KnownProject[]): void {
	if (known.length === 0) {
		throw new RequestError(404, 'no project is registered with the task app-module', NO_PROJECT_HINT);
	}
}

function pickProject(known: readonly KnownProject[], requested: string | undefined): KnownProject {
	if (requested !== undefined) {
		// An id, the slug of a page address, or an absolute directory (deprecated): no registry read needed.
		const found = findProjectByRef(known, requested);
		if (found !== undefined) return found;
		if (path.isAbsolute(requested)) {
			throw new RequestError(
				404,
				`project "${requested}" is not registered with the task app-module`,
				'Register it with the project CLI (project add "<dir>"), or run `task init` (or `task projects add <dir>`) in that project directory; GET /api/modules/task/projects lists the known ones.'
			);
		}
		// A name, an alias or an id prefix is the shared registry's to resolve (typed errors: not found, ambiguous, virtual, unreadable).
		const resolved = resolveProjectReference(requested);
		return { id: resolved.id, name: resolved.name, path: resolved.path, registered: true };
	}
	requireAny(known);
	if (known.length > 1) {
		throw new RequestError(
			400,
			'several projects are registered: the project query parameter is required',
			`Add ?project=<id|name|alias> (one of: ${known.map(entry => (entry.id === undefined ? entry.path : `${entry.name} (${entry.id})`)).join(', ')}).`,
			{ registeredProjects: known.map(entry => entry.path) }
		);
	}
	return known[0]!;
}
