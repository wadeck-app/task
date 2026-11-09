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
	readonly hint: string =
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
	readonly hint: string =
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

/** The server refused the content of a write (a label name it does not accept, a value out of range...). Nothing was changed. */
export class BackendRejectedError extends Error {
	constructor(
		readonly backendKind: BackendKind,
		readonly operation: string,
		message: string,
		readonly hint: string
	) {
		super(message);
		this.name = 'BackendRejectedError';
		requireHint('BackendRejectedError', hint);
	}
}

export interface PartialWriteInit {
	backendKind: BackendKind;
	operation: string;
	taskId: string;
	/** What reached the remote system, in words, in order. */
	applied: readonly string[];
	/** What did not, in words. */
	notApplied: readonly string[];
	/** How to repair (a command to run again, a page to fix). */
	hint: string;
	cause?: unknown;
}

/**
 * A write made of several remote calls failed halfway (design 1.6): the remote system holds part of it. The backend re-reads before
 * it reports, so `applied` / `notApplied` describe what is really there. Same pattern as PartialDeleteError.
 */
export class PartialWriteError extends Error {
	readonly backendKind: BackendKind;
	readonly operation: string;
	readonly taskId: string;
	readonly applied: readonly string[];
	readonly notApplied: readonly string[];
	readonly hint: string;

	constructor(init: PartialWriteInit) {
		const causeText =
			init.cause instanceof Error ? init.cause.message : init.cause === undefined ? '' : String(init.cause);
		super(
			`${init.operation} on ${init.taskId} is only partly done: applied [${init.applied.join('; ') || 'nothing'}], NOT applied [${init.notApplied.join('; ') || 'nothing'}]${causeText === '' ? '' : ` (${causeText})`}`,
			init.cause === undefined ? undefined : { cause: init.cause }
		);
		this.name = 'PartialWriteError';
		this.backendKind = init.backendKind;
		this.operation = init.operation;
		this.taskId = init.taskId;
		this.applied = init.applied;
		this.notApplied = init.notApplied;
		this.hint = init.hint;
		requireHint('PartialWriteError', init.hint);
	}
}

// ---- the remote strategy (task serve): the typed failures of the HTTP client, each with a next step ----

/** The task server cannot be reached (DNS, refused, reset, a redirect): nothing was read or written. */
export class RemoteUnreachableError extends BackendUnreachableError {
	override readonly hint: string;

	constructor(
		readonly url: string,
		reason: string
	) {
		super('remote', RemoteUnreachableError.hostOf(url), reason);
		this.name = 'RemoteUnreachableError';
		this.hint = `Is "task serve" running on ${this.host}? Check the address (${url}), the port and the firewall of the machine that serves the tasks, then run: task strategy check`;
	}

	static hostOf(url: string): string {
		try {
			return new URL(url).host;
		} catch {
			return url;
		}
	}
}

/** The server did not answer in time. A write that timed out MAY have been applied: the hint says how to find out. */
export class RemoteTimeoutError extends BackendTimeoutError {
	override readonly hint: string;

	constructor(host: string, timeoutMs: number, kind: 'read' | 'write') {
		super('remote', host, timeoutMs);
		this.name = 'RemoteTimeoutError';
		this.hint =
			kind === 'write'
				? 'The change may have been applied: check with task show (or task list) before repeating it. To wait longer, raise timeoutSeconds in strategy.options.transport.options.'
				: 'Retry; on a slow network raise timeoutSeconds in strategy.options.transport.options, or check that the machine that runs task serve is up (task strategy check).';
	}
}

/** The token is missing here, or the server refused it (401, 403). */
export class RemoteUnauthorizedError extends BackendAuthError {
	constructor(reason: 'missing' | 'unauthenticated' | 'forbidden', message: string, hint: string) {
		super('remote', reason, message, hint);
		this.name = 'RemoteUnauthorizedError';
	}
}

/** This task and the server do not speak a common protocol version (HTTP 426, or a range that excludes ours). */
export class RemoteIncompatibleError extends Error {
	readonly hint: string;

	constructor(
		readonly url: string,
		readonly clientProtocol: number,
		readonly serverProtocol: { min: number; max: number } | undefined
	) {
		super(
			serverProtocol === undefined
				? `The task server at ${url} does not speak protocol ${clientProtocol} and does not say which protocols it supports`
				: `The task server at ${url} does not speak protocol ${clientProtocol} (it supports ${serverProtocol.min}..${serverProtocol.max})`
		);
		this.name = 'RemoteIncompatibleError';
		if (serverProtocol === undefined) {
			this.hint =
				'Update task on both machines (the one that runs task serve and this one) to the same version, then run: task strategy check';
		} else {
			this.hint =
				clientProtocol > serverProtocol.max
					? 'Update task on the machine that runs task serve, then run: task strategy check'
					: 'Update task on this machine, then run: task strategy check';
		}
	}
}

/** The server answers, but serves another project than the config expects (strategy.options.project): nothing was read or written. */
export class RemoteProjectMismatchError extends BackendRejectedError {
	constructor(
		readonly url: string,
		readonly expected: string,
		readonly served: { id?: string; name: string }
	) {
		super(
			'remote',
			'connect',
			`The task server at ${url} serves project "${served.name}"${served.id === undefined ? '' : ` (${served.id})`}, not "${expected}" (strategy.options.project)`,
			`Point transport.options.url at the server of "${expected}", or change strategy.options.project to "${served.name}" (or remove it to accept whatever the server serves), then run: task strategy check`
		);
		this.name = 'RemoteProjectMismatchError';
	}
}
