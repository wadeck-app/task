import * as fs from 'node:fs';
import * as path from 'node:path';

import {
	describeError,
	listKnownProjects,
	listTasks,
	openTaskContext,
	projectsRegistryPath,
	resolveProjectReference,
} from '@wadeck-app/task-service';
import type { KnownProject, TaskServiceContext } from '@wadeck-app/task-service';

import { RequestError } from './errors.js';
import { tasksPageHref } from './hrefs.js';
import { findProjectByRef } from './projectRef.js';

/** The service context of a project the module can address: it has a folder, so its path is known. */
export type OpenedProject = TaskServiceContext & { project: { id?: string; name: string; path: string } };

export interface ProjectListing {
	/** Id in the shared project registry; absent for a project known only by the legacy projects.json. */
	id?: string;
	/** Registry name when registered, else the directory name. */
	name: string;
	path: string;
	/** In the shared project registry. */
	registered: boolean;
	/** For a project that is not registered: what to run to register it (the legacy list goes away in stage 2b); null when registered. */
	registryHint: string | null;
	/** False when the project directory is gone (informational for a registered project: its tasks are in the registry). */
	exists: boolean;
	/** Legacy projects: the directory holds a `.task`. A registered project needs none. */
	initialized: boolean;
	/** Tasks in a non-terminal status; null when the project cannot be read (see `error`). */
	openCount: number | null;
	/** Why the project cannot be read (data split between the registry and the .task, invalid config.yml, missing directory...), with the fix; null when it can. */
	error: string | null;
	/** Link to the tasks page of the project; null when the project cannot be read. */
	href: string | null;
}

/** The line shown next to a project that is not in the shared registry. */
export function registryHintFor(dir: string): string {
	return `Not in the shared project registry: project add "${dir}"`;
}

/** The message of a failure with its hint on one text, as shown next to a project that cannot be read. */
function problemOf(error: unknown): string {
	const { message, hint } = error instanceof RequestError ? error : describeError(error);
	return hint === undefined ? message : `${message}. ${hint}`;
}

/** The checks every use of a known project starts with, then its context. A registered project needs no `.task`: its data is in the registry. */
function openKnown(configDir: string, known: KnownProject): OpenedProject {
	if (known.registered) {
		if (known.problem !== undefined) {
			throw new RequestError(
				409,
				known.problem,
				`Fix the parent chain of project ${known.name} with the project CLI (project set-parent).`
			);
		}
		const opened = openTaskContext({
			storage: known.storage,
			project: { id: known.id, name: known.name, path: known.path },
		});
		return opened as OpenedProject;
	}
	// A project only the legacy list knows (removed in stage 2b).
	if (!fs.existsSync(known.path)) {
		throw new RequestError(
			404,
			`project directory ${known.path} no longer exists`,
			`Task only reads ${projectsRegistryPath(configDir)} now: delete the entry by hand, or register the folder where the project moved with the project CLI (project add "<dir>").`
		);
	}
	if (!fs.existsSync(known.storage.dataDir)) {
		throw new RequestError(
			404,
			`project "${known.name}" is in the legacy list but has no .task directory`,
			`Register ${known.path} with the project CLI (project add "${known.path}"), or delete its entry from ${projectsRegistryPath(configDir)}.`
		);
	}
	return openTaskContext({
		storage: known.storage,
		project: { name: known.name, path: known.path },
	}) as OpenedProject;
}

function listingOf(configDir: string, known: KnownProject): ProjectListing {
	const base = {
		...(known.id === undefined ? {} : { id: known.id }),
		name: known.name,
		path: known.path,
		registered: known.registered,
		registryHint: known.registered ? null : registryHintFor(known.path),
		exists: fs.existsSync(known.path),
		initialized: known.registered || fs.existsSync(known.storage.dataDir),
	};
	try {
		const openCount = listTasks(openKnown(configDir, known), {}).length;
		return { ...base, openCount, error: null, href: tasksPageHref(base) };
	} catch (error) {
		// One unreadable project must not hide the others, nor read as "0 open": it is listed with its reason and fix.
		return { ...base, openCount: null, error: problemOf(error), href: null };
	}
}

/**
 * The projects the module shows: every registered project that has a folder, then the legacy projects.json entries the shared
 * registry does not cover. Read at every call (never cached). `registryProblem` says why the shared registry could not be read:
 * the legacy projects are still listed. A corrupt projects.json throws its error.
 */
export function readProjects(configDir: string): { projects: ProjectListing[]; registryProblem: string | null } {
	const known = listKnownProjects(configDir);
	return {
		projects: known.projects.map(entry => listingOf(configDir, entry)),
		registryProblem: known.registryProblem,
	};
}

export function listProjects(configDir: string): ProjectListing[] {
	return readProjects(configDir).projects;
}

/**
 * Resolves the project a request targets and builds the service context over its store.
 * `requested` is the `?project=` value: the id, name or alias of a project of the shared registry, or (deprecated) the
 * absolute directory of a known project. Without it, the only known project is used; several make the choice ambiguous
 * (400 listing them). A corrupt projects.json or an unreadable shared registry throws its error unchanged (never read as
 * "no project"); an unknown reference is the registry's typed error (404 with suggestions, 409 with candidates); a registered
 * project whose data is still in its `.task` keeps working on it (the notice goes to the task log), a real split of the data is a 409.
 */
export function openProject(configDir: string, requested: string | undefined): OpenedProject {
	// A form whose project select was left on its placeholder sends an empty project: say so, instead of "not found".
	if (requested === '') {
		throw new RequestError(
			400,
			'no project chosen',
			'Choose a project in the form first (or pass ?project=<id|name|alias>; GET /api/modules/task/projects lists the known ones).'
		);
	}
	return openKnown(configDir, pickProject(listKnownProjects(configDir).projects, requested));
}

/** What to do when nothing is registered: shown by every view and answered by every route. */
export const NO_PROJECT_HINT =
	'Register a project with the project CLI (project add <dir>): its tasks then live in the shared registry. A project that still has a .task folder: copy its tasks with `task cli migrate-data -p <name>`.';

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
				'Register it with the project CLI (project add "<dir>"); GET /api/modules/task/projects lists the known ones.'
			);
		}
		// A name, an alias or an id prefix is the shared registry's to resolve (typed errors: not found, ambiguous, unreadable).
		const resolved = resolveProjectReference(requested);
		if (resolved.path === undefined || resolved.id === undefined) {
			throw new RequestError(
				409,
				`project ${resolved.name} (${resolved.id ?? 'no id'}) is a virtual project (no folder): the task app-module addresses projects by folder`,
				`Use the CLI for it: task -p ${resolved.name} list. Give the project a folder with the project CLI (project paths add) to use it here.`
			);
		}
		return {
			id: resolved.id,
			name: resolved.name,
			path: resolved.path,
			registered: true,
			storage: resolved.storage,
		};
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
