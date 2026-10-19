import { TaskConfigLoader } from '@wadeck-app/task-core';

import { ProjectsRegistryError } from './errors.js';
import { registerProject } from './projectsRegistry.js';

/**
 * Registers a project for the task app-module, provided it holds a `.task` (shared by `task init` and
 * `task projects add`). Idempotent: `added` is false when it was already registered. Throws a registry error whose
 * hint is `task init` when the directory is not an initialized project, so nothing broken is ever registered.
 */
export function registerInitializedProject(configDir: string, dir: string): { path: string; added: boolean } {
	if (!TaskConfigLoader.isInitialized(dir)) {
		throw new ProjectsRegistryError(
			`"${dir}" is not an initialized task project (no .task directory)`,
			'Run `task init` there (it registers the project by itself).'
		);
	}
	const { added } = registerProject(configDir, dir);
	return { path: dir, added };
}
