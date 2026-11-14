import {
	AmbiguousReferenceError,
	ConfigSchemaError,
	NoProjectInScopeError,
	ProjectError,
	ProjectNotFoundError,
	ProjectOptionError,
	VirtualProjectError,
} from '@wadeck-app/project-sdk';
import {
	AmbiguousTaskPrefixError,
	BackendAuthError,
	BackendDataError,
	BackendLimitError,
	BackendRejectedError,
	BackendTimeoutError,
	BackendUnreachableError,
	CommentNotFoundError,
	InvalidCommentTextError,
	InvalidTaskFieldError,
	PartialWriteError,
	RateLimitedError,
	RemoteIncompatibleError,
	RemoteProjectMismatchError,
	TaskClaimedError,
	TaskConflictError,
	TaskNotClaimedError,
	TaskNotFoundError,
	TaskReleaseRefusedError,
	UnknownPriorityError,
	UnsupportedByBackendError,
	WriteLockTimeoutError,
} from '@wadeck-app/task-core';

import { MigrationRefusedError, MigrationStateError } from './migrate/migrateErrors.js';
import { PluginCreateError } from './plugin-host/index.js';
import { PluginNotImplementedError } from './plugins/kinds.js';
import { RemovedConfigKeyError } from './removedConfigKey.js';
import { StrategyConfigError } from './strategyConfig.js';
import { TaskClosedError } from './taskClosedError.js';
import {
	AmbiguousDeletePrefixError,
	InvalidLinkTypeError,
	InvalidStatusError,
	InvalidDeleteFilterError,
	InvalidTaskTextError,
	InvalidTaskTypeError,
	DanglingLinkError,
	DanglingParentError,
	NoReadableProjectsError,
	TaskServiceError,
} from './errors.js';

/**
 * What went wrong, independent of the caller:
 * - `not-found`: the task does not exist.
 * - `ambiguous`: an id prefix matches several tasks (`details.matches`).
 * - `conflict`: the request is valid but contradicts the current data (cycle, duplicate link, corrupt hierarchy).
 * - `invalid`: the input is rejected (unknown status, link type, task type, delete filter).
 * - `unsupported`: the project's storage cannot do the operation (`details.capability`); the hint says what to do instead.
 * - `rate-limited`: the remote system's request budget is used up (`details.retryAt` when it said when).
 * - `unavailable`: the remote system cannot be used right now: unreachable, no answer in time, token missing or refused.
 * - `internal`: anything else; a caller should treat it as a failure of the tool, not of the input.
 */
export type ErrorKind =
	'not-found' | 'ambiguous' | 'conflict' | 'invalid' | 'unsupported' | 'rate-limited' | 'unavailable' | 'internal';

/** A caller-agnostic description of an error: the CLI maps it to stderr and an exit code, the app-module to an HTTP status. */
export interface ErrorDescription {
	kind: ErrorKind;
	message: string;
	/** Actionable follow-up for the user (valid values, a fix command); absent when the error carries none. */
	hint?: string;
	/** Structured data the error carries (`matches`, `validStatuses`, `suggestions`, `validTypes`). */
	details: Record<string, unknown>;
}

function describe(
	kind: ErrorKind,
	error: Error,
	hint: string | undefined = undefined,
	details: Record<string, unknown> = {}
): ErrorDescription {
	return { kind, message: error.message, ...(hint === undefined ? {} : { hint }), details };
}

/**
 * Classifies every error the task operations can throw (task-core and task-service errors) and extracts the
 * data a caller needs to explain it. The single place that knows which error class means what; adapters only
 * map the {@link ErrorKind} to their own conventions.
 */
export function describeError(error: unknown): ErrorDescription {
	if (error instanceof TaskNotFoundError) return describe('not-found', error);
	if (error instanceof CommentNotFoundError) {
		return describe('not-found', error, error.hint, { commentId: error.commentId, validIds: error.validIds });
	}
	if (error instanceof InvalidCommentTextError) return describe('invalid', error, error.hint);
	// UnknownPriorityError is an InvalidTaskFieldError: its own branch first for the valid list.
	if (error instanceof UnknownPriorityError) {
		return describe('invalid', error, error.hint, { field: 'priority', validPriorities: error.validPriorities });
	}
	if (error instanceof InvalidTaskFieldError) return describe('invalid', error, error.hint, { field: error.field });
	// Another task process holds the project write lock and did not let go in time: nothing was written, retrying is right.
	if (error instanceof WriteLockTimeoutError) {
		return describe('unavailable', error, error.hint, {
			lockPath: error.lockPath,
			...(error.holder === undefined ? {} : { holder: error.holder }),
		});
	}
	if (error instanceof AmbiguousTaskPrefixError || error instanceof AmbiguousDeletePrefixError) {
		return describe('ambiguous', error, undefined, { matches: error.matches });
	}
	if (error instanceof UnsupportedByBackendError) {
		return describe('unsupported', error, error.hint, {
			backend: error.backendKind,
			operation: error.operation,
			capability: error.capability,
		});
	}
	if (error instanceof RateLimitedError) {
		return describe('rate-limited', error, error.hint, {
			scope: error.scope,
			...(error.retryAt === undefined ? {} : { retryAt: error.retryAt.toISOString() }),
		});
	}
	if (
		error instanceof BackendUnreachableError ||
		error instanceof BackendTimeoutError ||
		error instanceof BackendAuthError ||
		error instanceof RemoteIncompatibleError
	) {
		return describe('unavailable', error, error.hint);
	}
	if (error instanceof BackendRejectedError) {
		return describe('invalid', error, error.hint, { backend: error.backendKind, operation: error.operation });
	}
	if (error instanceof PartialWriteError) {
		return describe('internal', error, error.hint, {
			backend: error.backendKind,
			operation: error.operation,
			taskId: error.taskId,
			applied: error.applied,
			notApplied: error.notApplied,
		});
	}
	if (error instanceof BackendDataError) {
		return describe('conflict', error, error.hint, { subject: error.subject });
	}
	if (error instanceof BackendLimitError) {
		return describe('conflict', error, error.hint, { limit: error.limitName, max: error.limit });
	}
	// The claim errors are conflicts that carry their own fix (wait, renew, release, --force).
	if (error instanceof TaskClaimedError) {
		return describe('conflict', error, error.hint, {
			taskId: error.taskId,
			holder: error.holder,
			leaseUntil: error.leaseUntil,
			remainingMs: error.remainingMs,
			ownLease: error.ownLease,
		});
	}
	if (error instanceof TaskClosedError) {
		return describe('conflict', error, error.hint, { taskId: error.taskId, status: error.status });
	}
	if (error instanceof TaskNotClaimedError) return describe('conflict', error, error.hint, { taskId: error.taskId });
	if (error instanceof TaskReleaseRefusedError) {
		return describe('conflict', error, error.hint, {
			taskId: error.taskId,
			holder: error.holder,
			requestedBy: error.requestedBy,
		});
	}
	if (error instanceof TaskConflictError) return describe('conflict', error);
	if (error instanceof DanglingParentError || error instanceof DanglingLinkError)
		return describe('conflict', error, error.hint);
	if (error instanceof InvalidStatusError) {
		return describe('invalid', error, error.hint, {
			validStatuses: error.validStatuses,
			suggestions: error.suggestions,
		});
	}
	if (error instanceof InvalidLinkTypeError) {
		return describe('invalid', error, error.hint, { validTypes: error.validTypes, suggestions: error.suggestions });
	}
	if (
		error instanceof InvalidTaskTypeError ||
		error instanceof InvalidTaskTextError ||
		error instanceof InvalidDeleteFilterError
	) {
		return describe('invalid', error, error.hint);
	}
	if (error instanceof MigrationRefusedError) return describe('invalid', error, error.hint);
	if (error instanceof MigrationStateError) return describe('conflict', error, error.hint);
	if (error instanceof NoReadableProjectsError) {
		return describe('internal', error, error.hint, { skipped: error.failures });
	}
	if (error instanceof TaskServiceError) return describe('internal', error, error.hint);
	if (error instanceof PluginNotImplementedError) return describe('internal', error, error.hint);
	// A plugin that failed to open: the reason is the cause's, so is the fix.
	if (error instanceof PluginCreateError) {
		if (error.cause === undefined) return describe('internal', error);
		const inner = describeError(error.cause);
		// A cause the callers already know how to explain (a missing token, an unreachable server) keeps its own kind and text.
		return inner.kind === 'internal' ? describe('internal', error, inner.hint) : inner;
	}
	if (error instanceof ProjectError) return describeProjectError(error);
	return { kind: 'internal', message: error instanceof Error ? error.message : String(error), details: {} };
}

/** The shared project registry's own errors (resolution of a project reference, unreadable registry): neutral messages, hints built from their data. */
function describeProjectError(error: ProjectError): ErrorDescription {
	if (error instanceof ProjectNotFoundError)
		return describe('not-found', error, undefined, { suggestions: error.suggestions });
	if (error instanceof AmbiguousReferenceError) {
		return describe('ambiguous', error, undefined, { candidates: error.candidates });
	}
	if (error instanceof NoProjectInScopeError) {
		return describe('not-found', error, error.hint, { cwd: error.cwd, registered: error.registered });
	}
	if (error instanceof ConfigSchemaError) {
		return describe(
			'invalid',
			error,
			(error instanceof StrategyConfigError || error instanceof RemovedConfigKeyError ? error.hint : undefined) ??
				'Fix the config.yml named in the message (remove or rename the key), then retry.'
		);
	}
	if (error instanceof ProjectOptionError) {
		return describe(
			'invalid',
			error,
			error.kind === 'missing-value'
				? 'Give the project right after the flag (-p <id|name|alias>, or --project=<ref>); "project list" shows the registered ones.'
				: 'Pass the project once: keep either -p/--project or the other occurrence.',
			{ option: error.option, optionKind: error.kind }
		);
	}
	if (error instanceof VirtualProjectError) {
		return describe(
			'invalid',
			error,
			'A project without path holds configuration only: give a project that has a path, or add one to this project with the project CLI (project paths add).'
		);
	}
	return describe('internal', error, undefined, { code: error.code });
}

/**
 * True for a failure of the remote system behind a project (unreachable, no answer, a token that is missing or refused, a rate limit,
 * data that does not fit the task model, a limit of the system, an operation it refuses). Such a project is unreadable right now; the
 * views that show several projects report it with its reason and carry on with the others, instead of failing as a whole.
 */
export function isRemoteFailure(error: unknown): boolean {
	if (error instanceof PluginCreateError) return error.cause !== undefined && isRemoteFailure(error.cause);
	return (
		error instanceof BackendUnreachableError ||
		error instanceof BackendTimeoutError ||
		error instanceof BackendAuthError ||
		error instanceof RemoteIncompatibleError ||
		error instanceof RemoteProjectMismatchError ||
		error instanceof RateLimitedError ||
		error instanceof BackendDataError ||
		error instanceof BackendLimitError ||
		error instanceof UnsupportedByBackendError
	);
}
