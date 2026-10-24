import * as fs from 'node:fs';
import * as path from 'node:path';

import { TaskConfigLoader } from '@wadeck-app/task-core';

import type { TaskServiceContext } from './context.js';
import { describeError } from './describeError.js';
import { openTaskContext } from './openContext.js';
import { listKnownProjects } from './knownProjects.js';
import type { KnownProject, ListKnownProjectsOptions } from './knownProjects.js';

/** One registered project and whether it can be used. */
export interface ProjectHealth {
	path: string;
	/** The directory exists. */
	exists: boolean;
	/** The directory holds a `.task` project. */
	initialized: boolean;
	/** Why the project cannot be used (directory gone, not initialized, config.yml invalid), with the fix when there is one; null when it can. */
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

/** Checks one project (exists, initialized, config.yml valid) and opens it when it can be used. A bare directory is an unregistered project. */
export function inspectProject(project: KnownProject | string): InspectedProject {
	const known: KnownProject =
		typeof project === 'string' ? { name: path.basename(project), path: project, registered: false } : project;
	const dir = known.path;
	const exists = fs.existsSync(dir);
	if (!exists) {
		return {
			known,
			health: { path: dir, exists, initialized: false, error: `directory ${dir} does not exist` },
			context: null,
		};
	}
	if (!TaskConfigLoader.isInitialized(dir)) {
		return {
			known,
			health: { path: dir, exists, initialized: false, error: `not initialized: run \`task init\` in ${dir}` },
			context: null,
		};
	}
	try {
		const context = openTaskContext({
			projectDir: dir,
			...(known.registered ? { project: { id: known.id, name: known.name } } : {}),
		});
		return { known, health: { path: dir, exists, initialized: true, error: null }, context };
	} catch (error) {
		return {
			known,
			health: { path: dir, exists, initialized: true, error: describeError(error).message },
			context: null,
		};
	}
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
