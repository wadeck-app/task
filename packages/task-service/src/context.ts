import type { TaskResolvedConfig, TaskStore } from '@wadeck-app/task-core';

import type { TaskProjectEnv } from './events.js';

/** Everything an operation needs: the storage, the resolved project config and the project identity. */
export interface TaskServiceContext {
	store: TaskStore;
	config: TaskResolvedConfig;
	/** `id` is the id in the shared project registry; absent for a project found by the legacy rule (a directory holding a `.task`). */
	project: { id?: string; name: string; path: string };
}

/** The `taskProjectId` (registered projects only), `taskProjectName` / `taskProjectPath` fields appended to every event payload. */
export function projectEnv(ctx: TaskServiceContext): TaskProjectEnv {
	return {
		...(ctx.project.id === undefined ? {} : { taskProjectId: ctx.project.id }),
		taskProjectName: ctx.project.name,
		taskProjectPath: ctx.project.path,
	};
}
