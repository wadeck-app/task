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

function requireHint(errorName: string, hint: string): void {
	if (hint.trim() === '') {
		throw new Error(`${errorName} needs a hint: a failure without a next step is a bug in the backend`);
	}
}

/** The server cannot be reached at all (DNS, refused, reset, TLS): nothing was read or written. */
export class BackendUnreachableError extends Error {
	readonly hint =
		'Check the network connection, a proxy or firewall, and the address in the strategy options (baseUrl).';

	constructor(
		readonly backendKind: BackendKind,
		readonly host: string,
		readonly reason: string
	) {
		super(`Cannot reach ${host} (${reason})`);
		this.name = 'BackendUnreachableError';
	}
}

/** The server did not answer in time. */
export class BackendTimeoutError extends Error {
	readonly hint =
		'Retry; on a slow network raise strategy.options.timeoutSeconds in the project config, or check the status page of the service.';

	constructor(
		readonly backendKind: BackendKind,
		readonly host: string,
		readonly timeoutMs: number
	) {
		super(`${host} did not answer within ${Math.round(timeoutMs / 1000)} s`);
		this.name = 'BackendTimeoutError';
	}
}

/** The token is missing, rejected (401, expired) or lacks a permission (403). The hint names the token variable and the permissions. */
export class BackendAuthError extends Error {
	constructor(
		readonly backendKind: BackendKind,
		readonly reason: 'missing' | 'unauthenticated' | 'forbidden',
		message: string,
		readonly hint: string
	) {
		super(message);
		this.name = 'BackendAuthError';
		requireHint('BackendAuthError', hint);
	}
}

/**
 * The request budget is used up (design 1.9). `scope`: `primary` (the hourly quota, `retryAt` is its reset), `secondary`
 * (abuse protection: wait the time the server asked) or `search` (the separate search quota). `retryAt` is absent when the
 * server gave no instant.
 */
export class RateLimitedError extends Error {
	readonly hint: string;

	constructor(
		readonly backendKind: BackendKind,
		readonly scope: 'primary' | 'secondary' | 'search',
		readonly retryAt: Date | undefined
	) {
		super(`The ${backendKind} ${scope} rate limit is reached`);
		this.name = 'RateLimitedError';
		this.hint =
			retryAt === undefined
				? 'Wait at least a minute and retry; nothing was changed.'
				: `Retry after ${retryAt.toISOString()}; nothing was changed.`;
	}
}

/**
 * Something stored in the remote system does not fit the task model (two status labels, a state no status maps, a managed block
 * that cannot be parsed). Nothing is guessed: `subject` names the item, `hint` the fix to make there.
 */
export class BackendDataError extends Error {
	constructor(
		readonly backendKind: BackendKind,
		readonly subject: string,
		message: string,
		readonly hint: string
	) {
		super(message);
		this.name = 'BackendDataError';
		requireHint('BackendDataError', hint);
	}
}

/** The remote system's own limit stops the operation (hierarchy depth, items per parent, label count...). */
export class BackendLimitError extends Error {
	constructor(
		readonly backendKind: BackendKind,
		readonly limitName: string,
		readonly limit: number,
		readonly hint: string
	) {
		super(`The ${backendKind} limit "${limitName}" (${limit}) is exceeded`);
		this.name = 'BackendLimitError';
		requireHint('BackendLimitError', hint);
	}
}
