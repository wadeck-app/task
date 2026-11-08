import { TaskConflictError } from '../errors.js';
import type { BackendCapabilities, BackendKind } from './capabilities.js';

/**
 * The backend cannot do this operation (design 1.4). Never a silent fallback: `hint` says what to do instead (another
 * operation, a config key that declares a fill, or the stage in which the backend gains it).
 */
export class UnsupportedByBackendError extends Error {
	constructor(
		readonly backendKind: BackendKind,
		readonly operation: string,
		readonly capability: keyof BackendCapabilities,
		readonly hint: string
	) {
		super(`The ${backendKind} backend does not support ${operation} (capability "${capability}")`);
		this.name = 'UnsupportedByBackendError';
		if (hint.trim() === '') {
			throw new Error(
				`UnsupportedByBackendError for ${operation} needs a hint: a refusal without a next step is a bug in the ${backendKind} backend`
			);
		}
	}
}

/**
 * A write carried the revision the caller read, and the task changed since (design 1.6). A TaskConflictError, so
 * everything that already maps conflicts keeps working; `kind` is the field the design adds to TaskConflictError itself.
 */
export class StaleRevisionError extends TaskConflictError {
	readonly kind = 'stale' as const;
	readonly hint = 'Read the task again (task show <id>), check the change is still wanted, and redo it.';

	constructor(
		readonly taskId: string,
		readonly expectedRevision: string,
		readonly actualRevision: string
	) {
		super(
			`Task "${taskId}" changed since it was read (expected revision ${expectedRevision}, now ${actualRevision}); nothing was written`
		);
		this.name = 'StaleRevisionError';
	}
}
