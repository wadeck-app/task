import * as fs from 'node:fs';

import { TaskConfigLoader } from '@wadeck-app/task-core';

import type { TaskServiceContext } from './context.js';
import { describeError } from './describeError.js';
import { openTaskContext } from './openContext.js';
import { listRegisteredProjects } from './projectsRegistry.js';

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

/** A project directory with its health and, when it can be used, the context opened to find out. */
export interface InspectedProject {
	health: ProjectHealth;
	/** Null exactly when `health.error` is set. */
	context: TaskServiceContext | null;
}

/** Checks one project directory (exists, initialized, config.yml valid) and opens it when it can be used. */
export function inspectProject(dir: string): InspectedProject {
	const exists = fs.existsSync(dir);
	if (!exists) {
		return {
			health: { path: dir, exists, initialized: false, error: `directory ${dir} does not exist` },
			context: null,
		};
	}
	if (!TaskConfigLoader.isInitialized(dir)) {
		return {
			health: { path: dir, exists, initialized: false, error: `not initialized: run \`task init\` in ${dir}` },
			context: null,
		};
	}
	try {
		const context = openTaskContext({ projectDir: dir });
		return { health: { path: dir, exists, initialized: true, error: null }, context };
	} catch (error) {
		return {
			health: { path: dir, exists, initialized: true, error: describeError(error).message },
			context: null,
		};
	}
}

/** Health of every registered project, in registration order. A corrupt registry throws the registry error. */
export function inspectRegisteredProjects(configDir: string): ProjectHealth[] {
	return listRegisteredProjects(configDir).map(dir => inspectProject(dir).health);
}
