import {
	AmbiguousReferenceError,
	ConfigSchemaError,
	NoProjectInScopeError,
	ProjectError,
	ProjectNotFoundError,
	VirtualProjectError,
} from '@wadeck-app/project-sdk';
import { AmbiguousTaskPrefixError, TaskConflictError, TaskNotFoundError } from '@wadeck-app/task-core';

import {
	AmbiguousDeletePrefixError,
	DataMigrationError,
	InvalidLinkTypeError,
	ProjectDataSplitError,
	UnmigratedDataError,
	InvalidStatusError,
	InvalidDeleteFilterError,
	InvalidTaskTypeError,
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
 * - `internal`: anything else; a caller should treat it as a failure of the tool, not of the input.
 */
export type ErrorKind = 'not-found' | 'ambiguous' | 'conflict' | 'invalid' | 'internal';

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
	if (error instanceof AmbiguousTaskPrefixError || error instanceof AmbiguousDeletePrefixError) {
		return describe('ambiguous', error, undefined, { matches: error.matches });
	}
	if (error instanceof TaskConflictError) return describe('conflict', error);
	if (error instanceof DanglingParentError) return describe('conflict', error, error.hint);
	if (error instanceof InvalidStatusError) {
		return describe('invalid', error, error.hint, {
			validStatuses: error.validStatuses,
			suggestions: error.suggestions,
		});
	}
	if (error instanceof InvalidLinkTypeError) {
		return describe('invalid', error, error.hint, { validTypes: error.validTypes, suggestions: error.suggestions });
	}
	if (error instanceof InvalidTaskTypeError || error instanceof InvalidDeleteFilterError) {
		return describe('invalid', error, error.hint);
	}
	if (error instanceof NoReadableProjectsError) {
		return describe('internal', error, error.hint, { skipped: error.failures });
	}
	if (error instanceof ProjectDataSplitError || error instanceof UnmigratedDataError) {
		return describe('conflict', error, error.hint, {
			project: error.projectName,
			oldDir: error.oldDir,
			dataDir: error.dataDir,
		});
	}
	if (error instanceof DataMigrationError) return describe('invalid', error, error.hint);
	if (error instanceof TaskServiceError) return describe('internal', error, error.hint);
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
			'Fix the config.yml named in the message (remove or rename the key), then retry.'
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
