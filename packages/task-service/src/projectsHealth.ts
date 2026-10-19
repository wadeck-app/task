import * as fs from 'node:fs';

import { TaskConfigLoader } from '@wadeck-app/task-core';

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

/** Health of every registered project, in registration order. A corrupt registry throws the registry error. */
export function inspectRegisteredProjects(configDir: string): ProjectHealth[] {
	return listRegisteredProjects(configDir).map(dir => {
		const exists = fs.existsSync(dir);
		if (!exists) {
			return { path: dir, exists, initialized: false, error: `directory ${dir} does not exist` };
		}
		if (!TaskConfigLoader.isInitialized(dir)) {
			return { path: dir, exists, initialized: false, error: `not initialized: run \`task init\` in ${dir}` };
		}
		try {
			openTaskContext({ projectDir: dir });
			return { path: dir, exists, initialized: true, error: null };
		} catch (error) {
			return { path: dir, exists, initialized: true, error: describeError(error).message };
		}
	});
}
