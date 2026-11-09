// The typed errors on the wire (protocol v1): the server turns what the backend threw into `{ error: { type, message, hint?, ... } }`
// with an HTTP status, the client turns that back into the SAME error class, so an adapter (CLI, module) behaves exactly as on a local
// project. No stack, no path and no secret ever travels: `encodeWireError` takes the secrets to remove. No Node module is imported.
import {
	BackendRejectedError,
	RemoteIncompatibleError,
	RemoteUnauthorizedError,
	RemoteUnreachableError,
	StaleRevisionError,
	UnsupportedByBackendError,
} from '../backend/backendErrors.js';
import type { BackendCapabilities } from '../backend/capabilities.js';
import { AmbiguousTaskPrefixError, TaskConflictError, TaskNotFoundError } from '../errors.js';
import { CommentNotFoundError, InvalidCommentTextError } from '../taskComments.js';
import { PROTOCOL_VERSION } from './protocol.js';

/** Failures of the protocol itself (not of a task operation): raised by the server, never by a backend. */
export type ProtocolFailureType =
	| 'unauthorized'
	| 'incompatible'
	| 'too-large'
	| 'unsupported-media'
	| 'not-allowed'
	| 'unknown-route'
	| 'invalid-request'
	| 'unavailable';

export type WireErrorType =
	| ProtocolFailureType
	| 'not-found'
	| 'ambiguous'
	| 'stale'
	| 'conflict'
	| 'comment-not-found'
	| 'invalid-comment'
	| 'unsupported'
	| 'rejected'
	| 'internal';

export interface WireErrorBody {
	error: { type: string; message: string; hint?: string; [extra: string]: unknown };
}

const STATUS: Record<WireErrorType, number> = {
	unauthorized: 401,
	incompatible: 426,
	'too-large': 413,
	'unsupported-media': 415,
	'not-allowed': 405,
	'unknown-route': 404,
	'invalid-request': 400,
	unavailable: 503,
	'not-found': 404,
	ambiguous: 409,
	stale: 412,
	conflict: 409,
	'comment-not-found': 404,
	'invalid-comment': 400,
	unsupported: 422,
	rejected: 400,
	internal: 500,
};

/** The server's own refusal of a request (bad token, wrong version, too large, malformed). `extras` travel in the body. */
export class WireProtocolError extends Error {
	constructor(
		readonly type: ProtocolFailureType,
		message: string,
		readonly hint: string,
		readonly extras: Record<string, unknown> = {}
	) {
		super(message);
		this.name = 'WireProtocolError';
	}
}

export interface EncodeOptions {
	/** Secrets (the token) removed from every text of the body, whatever put them there. */
	redact?: readonly string[];
}

function redactDeep(value: unknown, secrets: readonly string[]): unknown {
	if (typeof value === 'string') {
		return secrets.reduce((text, secret) => (secret === '' ? text : text.split(secret).join('***')), value);
	}
	if (Array.isArray(value)) return value.map(item => redactDeep(item, secrets));
	if (typeof value === 'object' && value !== null) {
		return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactDeep(item, secrets)]));
	}
	return value;
}

function classify(error: unknown): { type: WireErrorType; extras: Record<string, unknown>; hint?: string } {
	if (error instanceof WireProtocolError) return { type: error.type, extras: error.extras, hint: error.hint };
	if (error instanceof StaleRevisionError) {
		return {
			type: 'stale',
			hint: error.hint,
			extras: {
				taskId: error.taskId,
				expectedRevision: error.expectedRevision,
				actualRevision: error.actualRevision,
			},
		};
	}
	if (error instanceof TaskNotFoundError) return { type: 'not-found', extras: { taskId: error.taskId } };
	if (error instanceof AmbiguousTaskPrefixError) {
		return { type: 'ambiguous', extras: { prefix: error.prefix, matches: error.matches } };
	}
	if (error instanceof TaskConflictError) return { type: 'conflict', extras: {} };
	if (error instanceof CommentNotFoundError) {
		return {
			type: 'comment-not-found',
			hint: error.hint,
			extras: { taskId: error.taskId, commentId: error.commentId, validIds: error.validIds },
		};
	}
	if (error instanceof InvalidCommentTextError) return { type: 'invalid-comment', hint: error.hint, extras: {} };
	if (error instanceof UnsupportedByBackendError) {
		return {
			type: 'unsupported',
			hint: error.hint,
			extras: { operation: error.operation, capability: error.capability },
		};
	}
	if (error instanceof BackendRejectedError) {
		return { type: 'rejected', hint: error.hint, extras: { operation: error.operation } };
	}
	return { type: 'internal', extras: {} };
}

/** The HTTP status and the JSON body for a failure. Total: any thrown value gets an answer, never a stack. */
export function encodeWireError(error: unknown, options: EncodeOptions = {}): { status: number; body: WireErrorBody } {
	const { type, extras, hint } = classify(error);
	const message = error instanceof Error ? error.message : String(error);
	const body: WireErrorBody = {
		error: { type, message, ...(hint === undefined ? {} : { hint }), ...extras },
	};
	const clean = redactDeep(body, options.redact ?? []) as WireErrorBody;
	return { status: STATUS[type], body: clean };
}

export interface DecodeContext {
	/** The address the request went to: named by the errors that tell the user where to look. */
	url: string;
	/** The port operation, for the errors that name it. */
	operation: string;
}

function isWireBody(body: unknown): body is WireErrorBody {
	if (typeof body !== 'object' || body === null) return false;
	const error = (body as { error?: unknown }).error;
	if (typeof error !== 'object' || error === null) return false;
	const { type, message } = error as { type?: unknown; message?: unknown };
	return typeof type === 'string' && typeof message === 'string';
}

function strings(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function textOf(value: unknown, fallback = ''): string {
	return typeof value === 'string' ? value : fallback;
}

function rangeOf(value: unknown): { min: number; max: number } | undefined {
	if (typeof value !== 'object' || value === null) return undefined;
	const { min, max } = value as { min?: unknown; max?: unknown };
	return typeof min === 'number' && typeof max === 'number' ? { min, max } : undefined;
}

/** The error an answer with status `status` and parsed body `body` stands for, as the class the local backend would have thrown. */
export function decodeWireError(status: number, body: unknown, context: DecodeContext): Error {
	if (!isWireBody(body)) {
		return new RemoteUnreachableError(
			context.url,
			`answered HTTP ${status} without a task error: another service or a proxy may be answering at this address`
		);
	}
	const { type, message, hint, ...extras } = body.error;
	const hintText = typeof hint === 'string' && hint !== '' ? hint : undefined;
	switch (type) {
		case 'not-found':
			return new TaskNotFoundError(textOf(extras['taskId']));
		case 'ambiguous':
			return new AmbiguousTaskPrefixError(textOf(extras['prefix']), strings(extras['matches']));
		case 'stale':
			return new StaleRevisionError(
				textOf(extras['taskId']),
				textOf(extras['expectedRevision']),
				textOf(extras['actualRevision'])
			);
		case 'conflict':
			return new TaskConflictError(message);
		case 'comment-not-found':
			return new CommentNotFoundError(
				textOf(extras['taskId']),
				textOf(extras['commentId']),
				strings(extras['validIds'])
			);
		case 'invalid-comment':
			return new InvalidCommentTextError(message, hintText ?? 'Check the text of the comment.');
		case 'unsupported':
			return new UnsupportedByBackendError(
				'remote',
				textOf(extras['operation'], context.operation),
				textOf(extras['capability'], 'writes') as keyof BackendCapabilities,
				hintText ?? 'The server does not support this operation.'
			);
		case 'rejected':
		case 'invalid-request':
		case 'too-large':
		case 'unsupported-media':
			return new BackendRejectedError(
				'remote',
				textOf(extras['operation'], context.operation),
				message,
				hintText ?? 'Nothing was changed. Check the value and try again.'
			);
		case 'unauthorized':
			return new RemoteUnauthorizedError(
				'unauthenticated',
				`The task server at ${context.url} refused the token: ${message}`,
				hintText ??
					'Check that the token read here (the variable or file named in strategy.options.transport.options) is the one task serve was started with, then run: task strategy check'
			);
		case 'incompatible':
			return new RemoteIncompatibleError(context.url, PROTOCOL_VERSION, rangeOf(extras['supported']));
		case 'unknown-route':
		case 'not-allowed':
			// The server does not know this request: it speaks another dialect of the protocol.
			return new RemoteIncompatibleError(context.url, PROTOCOL_VERSION, undefined);
		case 'unavailable':
			return new RemoteUnreachableError(context.url, message);
		case 'internal':
		default:
			// An error type of a newer server: its message is still the best thing to show.
			return new Error(message);
	}
}
