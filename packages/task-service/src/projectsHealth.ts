import * as fs from 'node:fs';

import type { TaskServiceContext } from './context.js';
import { describeError } from './describeError.js';
import { openTaskContext } from './openContext.js';
import { listKnownProjects } from './knownProjects.js';
import type { KnownProject, ListKnownProjectsOptions } from './knownProjects.js';

/** One known project and whether it can be used. */
export interface ProjectHealth {
	path: string;
	/** The directory exists (informational: the data of a registered project does not live there). */
	exists: boolean;
	/** Why the project cannot be used (broken parent chain, data split between registry and old folder, config invalid), with the fix when there is one; null when it can. */
	error: string | null;
}

/** A project with its health and, when it can be used, the context opened to find out. */
export interface InspectedProject {
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

/** Checks one project (storage, config valid, data not split) and opens it when it can be used. */
export function inspectProject(known: KnownProject): InspectedProject {
	const exists = fs.existsSync(known.path);
	if (known.problem !== undefined) {
		return { known, health: { path: known.path, exists, error: known.problem }, context: null };
	}
	try {
		const context = openTaskContext({
			storage: known.storage,
			project: { id: known.id, name: known.name, path: known.path },
		});
		return { known, health: { path: known.path, exists, error: null }, context };
	} catch (error) {
		return { known, health: { path: known.path, exists, error: describeProblem(error) }, context: null };
	}
}

/** Every known project (see {@link listKnownProjects}) inspected, and why the shared registry could not be read, if it could not. */
export function inspectKnownProjects(options: ListKnownProjectsOptions = {}): {
	entries: InspectedProject[];
	registryProblem: string | null;
} {
	const { projects, registryProblem } = listKnownProjects(options);
	return { entries: projects.map(project => inspectProject(project)), registryProblem };
}

/** Health of every known project, in registry order. */
export function inspectRegisteredProjects(options: ListKnownProjectsOptions = {}): ProjectHealth[] {
	return inspectKnownProjects(options).entries.map(entry => entry.health);
}
