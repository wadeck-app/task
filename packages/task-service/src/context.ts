import type { TaskBackend, TaskResolvedConfig } from '@wadeck-app/task-core';

import type { TaskProjectEnv } from './events.js';
import type { ReadNotice } from './plugins/kinds.js';
import type { ResolvedStrategy } from './strategyResolve.js';
import type { TaskStorage } from './storage.js';

/** Everything an operation needs: the storage, the resolved project config and the project identity. */
export interface TaskServiceContext {
	/**
	 * The task backend of the project (the async port). The field keeps its historical name `store`: callers read
	 * `ctx.store`, and renaming it would touch every use case and test for nothing.
	 */
	store: TaskBackend;
	config: TaskResolvedConfig;
	/** Where the data and the config live (the shared registry): `type add|remove` writes the own config file from it. */
	storage: TaskStorage;
	/**
	 * `id` is the id in the shared project registry (always set by the resolution; tests may leave it out).
	 * `path` is the main path of the project; absent for a virtual project (no folder).
	 */
	project: { id?: string; name: string; path?: string };
	/**
	 * The strategy the project's config selects (plugin, options, fills, fidelity). Set by `openTaskContext`; a hand-built
	 * context (tests) may leave it out.
	 */
	strategy?: ResolvedStrategy;
	/**
	 * Releases what the backend holds (a connection, a cache); creates nothing. Callers that open a context for a command or a
	 * request call it once at the end; safe to call twice. Absent on a hand-built context.
	 */
	dispose?: () => Promise<void>;
	/**
	 * What the reads since the last call want the user to know (cache served after a failure, something left out): the CLI prints
	 * them as warnings, the module adds them to its answers. Forgets them; empty for the local store and on a hand-built context.
	 */
	takeNotices?: () => ReadNotice[];
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
