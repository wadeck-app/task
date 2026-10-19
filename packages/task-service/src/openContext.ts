import * as path from 'node:path';

import { TaskConfigLoader, TaskStore } from '@wadeck-app/task-core';

import type { TaskServiceContext } from './context.js';

export interface OpenTaskContextInput {
	/** Absolute directory of an initialized task project (it holds `.task/`). */
	projectDir: string;
	/** Global config directory (global hooks and defaults). Default: the config loader's own default. */
	globalConfigDir?: string;
}

/**
 * Builds the context of an initialized project: its task store, its resolved config and its identity (name = directory name).
 * The caller checks that the project is initialized first (the message for a missing `.task` depends on the caller);
 * an invalid `config.yml` throws the loader's error, never defaults.
 */
export function openTaskContext(input: OpenTaskContextInput): TaskServiceContext {
	const { projectDir } = input;
	return {
		store: new TaskStore(path.join(projectDir, '.task', 'tasks')),
		config: TaskConfigLoader.load({ configDir: input.globalConfigDir, projectDir }),
		project: { name: path.basename(projectDir), path: projectDir },
	};
}
