import * as fs from 'node:fs';
import * as path from 'node:path';

import type { TaskServiceContext } from './context.js';
import { describeError } from './describeError.js';
import { openTaskContext } from './openContext.js';
import { listKnownProjects } from './knownProjects.js';
import type { KnownProject, ListKnownProjectsOptions } from './knownProjects.js';
import { legacyStorage } from './storage.js';

/** One known project and whether it can be used. */
export interface ProjectHealth {
	path: string;
	/** The directory exists (informational for a registered project: its data does not live there). */
	exists: boolean;
	/** Legacy projects: the directory holds a `.task`. A registered project needs no initialisation: always true. */
	initialized: boolean;
	/** Why the project cannot be used (directory gone, no `.task`, data split between registry and `.task`, config invalid), with the fix when there is one; null when it can. */
	error: string | null;
}

/** A project with its health and, when it can be used, the context opened to find out. */
export interface InspectedProject {
	/** Who it is: registry id and name for a registered project, else the directory name. */
	known: KnownProject;
	health: ProjectHealth;
	/** Null exactly when `health.error` is set. */
	context: TaskServiceContext | null;
}

/** The message of an error with its hint, on one text: what a list shows next to an unreadable project. */
function describeProblem(error: unknown): string {
	const { message, hint } = describeError(error);
	return hint === undefined ? message : `${message}. ${hint}`;
}

function openChecked(known: KnownProject, exists: boolean): InspectedProject {
	const health = { path: known.path, exists, initialized: true };
	try {
		const context = openTaskContext({
			storage: known.storage,
			project: { ...(known.registered ? { id: known.id } : {}), name: known.name, path: known.path },
		});
		return { known, health: { ...health, error: null }, context };
	} catch (error) {
		return { known, health: { ...health, error: describeProblem(error) }, context: null };
	}
}

/** Checks one project (storage, config valid, data migrated) and opens it when it can be used. A bare directory is an unregistered project. */
export function inspectProject(project: KnownProject | string): InspectedProject {
	const known: KnownProject =
		typeof project === 'string'
			? { name: path.basename(project), path: project, registered: false, storage: legacyStorage(project) }
			: project;
	const dir = known.path;
	const exists = fs.existsSync(dir);
	if (known.registered) {
		if (known.problem !== undefined) {
			return { known, health: { path: dir, exists, initialized: true, error: known.problem }, context: null };
		}
		return openChecked(known, exists);
	}
	if (!exists) {
		return {
			known,
			health: { path: dir, exists, initialized: false, error: `directory ${dir} does not exist` },
			context: null,
		};
	}
	if (!fs.existsSync(known.storage.dataDir)) {
		return {
			known,
			health: {
				path: dir,
				exists,
				initialized: false,
				error: `not initialized: no .task in ${dir}; register the folder with: project add "${dir}"`,
			},
			context: null,
		};
	}
	return openChecked(known, exists);
}

/** Every known project (see {@link listKnownProjects}) inspected, and why the shared registry could not be read, if it could not. */
export function inspectKnownProjects(
	configDir: string,
	options: ListKnownProjectsOptions = {}
): { entries: InspectedProject[]; registryProblem: string | null } {
	const { projects, registryProblem } = listKnownProjects(configDir, options);
	return { entries: projects.map(project => inspectProject(project)), registryProblem };
}

/** Health of every known project: the registered ones first, then the legacy ones. A corrupt projects.json throws its error. */
export function inspectRegisteredProjects(configDir: string, options: ListKnownProjectsOptions = {}): ProjectHealth[] {
	return inspectKnownProjects(configDir, options).entries.map(entry => entry.health);
}
