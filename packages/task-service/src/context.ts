import type { TaskResolvedConfig, TaskStore } from '@wadeck-app/task-core';

import type { TaskProjectEnv } from './events.js';
import type { TaskStorage } from './storage.js';

/** Everything an operation needs: the storage, the resolved project config and the project identity. */
export interface TaskServiceContext {
	store: TaskStore;
	config: TaskResolvedConfig;
	/** Where the data and the config live (the shared registry, or the old folder of an unmigrated project): `type add|remove` writes the own config file from it. */
	storage: TaskStorage;
	/** Lines worth showing once per process (CLI: stderr; module: task log), e.g. the data of a registered project still in its old folder. */
	notices?: string[];
	/**
	 * `id` is the id in the shared project registry (always set by the resolution; tests may leave it out).
	 * `path` is the main path of the project; absent for a virtual project (no folder).
	 */
	project: { id?: string; name: string; path?: string };
}

/**
 * The `taskProjectId` (registered projects only), `taskProjectName` and `taskProjectPath` (absent for a virtual project, whose
 * events cannot be delivered: the queue has no directory to look from) fields appended to every event payload.
 */
export function projectEnv(ctx: TaskServiceContext): TaskProjectEnv {
	return {
		...(ctx.project.id === undefined ? {} : { taskProjectId: ctx.project.id }),
		taskProjectName: ctx.project.name,
		...(ctx.project.path === undefined ? {} : { taskProjectPath: ctx.project.path }),
	};
}
