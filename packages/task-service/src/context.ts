import type { TaskResolvedConfig, TaskStore } from '@wadeck-app/task-core';

import type { TaskProjectEnv } from './events.js';

/** Everything an operation needs: the storage, the resolved project config and the project identity. */
export interface TaskServiceContext {
	store: TaskStore;
	config: TaskResolvedConfig;
	project: { name: string; path: string };
}

/** The `taskProjectName` / `taskProjectPath` fields appended to every event payload. */
export function projectEnv(ctx: TaskServiceContext): TaskProjectEnv {
	return { taskProjectName: ctx.project.name, taskProjectPath: ctx.project.path };
}
