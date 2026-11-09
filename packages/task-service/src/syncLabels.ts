import { UnsupportedByBackendError } from '@wadeck-app/task-core';
import type { BackendKind, LabelSyncReport } from '@wadeck-app/task-core';

import type { TaskServiceContext } from './context.js';

/** The strategies whose backend keeps labels in a remote system and can create them. */
const LABEL_FORGES: readonly BackendKind[] = ['github', 'gitlab'];

/**
 * Creates, in the remote system of the project, the labels its configuration needs (status labels, type labels...); never deletes
 * or changes one. `dryRun` reports what would be created. Only a strategy that keeps labels remotely has anything to do: the local
 * one keeps them in the task files.
 */
export async function syncLabels(ctx: TaskServiceContext, input: { dryRun?: boolean }): Promise<LabelSyncReport> {
	const backend = ctx.store;
	// The store of a context may be a proxy that answers every name: the kind tells who can do it (the forges that keep labels).
	if (!LABEL_FORGES.includes(backend.kind)) {
		throw new UnsupportedByBackendError(
			backend.kind,
			'syncLabels',
			'labels',
			`The ${backend.kind} strategy has no remote labels to create. "task labels sync" is for a project that keeps its tasks on GitHub or GitLab (strategy type: github or gitlab in its config.yml): it creates the status and type labels the configuration uses.`
		);
	}
	return backend.syncLabels!({ ...(input.dryRun === undefined ? {} : { dryRun: input.dryRun }) });
}
