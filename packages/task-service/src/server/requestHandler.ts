// The transport-neutral core of `task serve`: one request in, one answer out, through the whole pipeline (protocol negotiation, route
// match, body validation, the operation, the single-writer queue, the events of the write, the error codec). The HTTP server
// (taskServer.ts) and the one-shot stdio server (stdioServer.ts) are thin adapters over it, so the two cannot drift.
//
// NO authentication here, on purpose. Who may ask is the adapter's business: the HTTP adapter checks the bearer token before anything
// else (`admit`), the stdio adapter has no token because its caller is the program that started the process (`machine run`
// authenticates the peer and an admin allow-listed this very command): the trust boundary is outside the process.
import {
	EVENTS_HEADER,
	EVENTS_SUPPRESS,
	PROTOCOL_HEADER,
	PROTOCOL_MAX,
	PROTOCOL_MIN,
	PROTOCOL_VERSION,
	ProtocolPathError,
	WireProtocolError,
	encodeWireError,
	matchRoute,
} from '@wadeck-app/task-core';
import type { EventsOutcome, PortOperation, RouteMatch, ServerInfo } from '@wadeck-app/task-core';

import type { TaskServiceContext } from '../context.js';
import { projectEnv } from '../context.js';
import { deliverEvents } from '../events.js';
import type { EventSink, TaskEvent } from '../events.js';
import { validateInput } from './requestValidation.js';
import { runOperation } from './serverOperations.js';
import { createWriteQueue } from './writeQueue.js';

const SERVER_NAME = 'task-serve' as const;

export interface ServiceRequest {
	method: string;
	/** The path and the query as sent: `/v1/tasks?status=open`. */
	path: string;
	/** Header names in lower case. */
	headers: Record<string, string | undefined>;
	/**
	 * The decoded body, asked for only once the route is known and accepted (so a body problem never hides a routing one). Resolves
	 * `undefined` when there is none; a problem throws a WireProtocolError (too large, not JSON...).
	 */
	readBody(): Promise<unknown>;
	/** True when the peer left before the answer: nothing is sent. Default: never. */
	isGone?(): boolean;
	/**
	 * The adapter's own admission check, run FIRST: it throws a WireProtocolError to refuse (the HTTP adapter answers 503 while it
	 * closes and checks the token). Absent: everything is admitted (stdio).
	 */
	admit?(): Promise<void>;
}

export interface ServiceResponse {
	status: number;
	/** `X-Task-Protocol` always, and `Allow` for a 405. The adapter adds what is its own (content type, length, cache). */
	headers: Record<string, string>;
	body: unknown;
	/** The peer left: send nothing. */
	gone?: true;
}

export interface RequestHandlerOptions {
	ctx: TaskServiceContext;
	eventSink?: EventSink | undefined;
	version?: string | undefined;
	now?: () => Date;
	log?: (level: 'info' | 'warn' | 'error', message: string) => void;
	/** Texts that must never reach a client (the token, the server's data folder). */
	redact: string[];
}

export interface RequestHandler {
	handle(request: ServiceRequest): Promise<ServiceResponse>;
	/** Resolves when every write accepted so far has finished. Never rejects. */
	idle(): Promise<void>;
	/** Waits for the events in flight and flushes the sink: call before the process ends. */
	flushEvents(): Promise<void>;
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function createRequestHandler(options: RequestHandlerOptions): RequestHandler {
	const { ctx } = options;
	const sink = options.eventSink;
	const now = options.now ?? ((): Date => new Date());
	const log = options.log ?? ((): void => undefined);
	const queue = createWriteQueue();
	let eventTail: Promise<void> = Promise.resolve();

	const info = (): ServerInfo => ({
		protocol: { version: PROTOCOL_VERSION, min: PROTOCOL_MIN, max: PROTOCOL_MAX },
		server: { name: SERVER_NAME, version: options.version ?? 'unknown' },
		project: { ...(ctx.project.id === undefined ? {} : { id: ctx.project.id }), name: ctx.project.name },
		capabilities: ctx.store.capabilities,
		statuses: [...ctx.config.statuses],
		terminalStatuses: [...ctx.config.terminalStatuses],
		types: [...ctx.config.types],
		events: { enabled: sink !== undefined },
	});

	/** Hands the events to the sink in the order the writes completed; the answer waits for the outcome, the write queue does not. */
	const deliverInOrder = (events: readonly TaskEvent[], suppressed: boolean): Promise<EventsOutcome> => {
		const enabled = sink !== undefined;
		if (sink === undefined || suppressed || events.length === 0) {
			return Promise.resolve({ enabled, delivered: 0, undelivered: [] });
		}
		const run = eventTail.then(() => deliverEvents(sink, events));
		eventTail = run.then(
			() => undefined,
			() => undefined
		);
		return run.then(
			outcome => ({
				enabled,
				delivered: outcome.delivered,
				undelivered: outcome.undelivered.map(item => ({
					event: item.event.name,
					reason: item.reason,
					status: item.status,
				})),
			}),
			(error: unknown) => {
				// A sink is meant to report, not throw: if it does, the change is saved and the events are in an unknown state.
				log('error', `event delivery failed: ${messageOf(error)}`);
				return {
					enabled,
					delivered: 0,
					undelivered: events.map(event => ({
						event: event.name,
						reason: `the event sink failed: ${messageOf(error)}`,
						status: 'unknown' as const,
					})),
				};
			}
		);
	};

	const checkProtocol = (request: ServiceRequest): number => {
		const raw = request.headers[PROTOCOL_HEADER.toLowerCase()];
		const version = raw === undefined ? NaN : Number(raw);
		if (!Number.isInteger(version) || version < PROTOCOL_MIN || version > PROTOCOL_MAX) {
			throw new WireProtocolError(
				'incompatible',
				raw === undefined
					? `the header ${PROTOCOL_HEADER} is required (this server speaks protocol ${PROTOCOL_MIN}..${PROTOCOL_MAX})`
					: `protocol ${raw} is not supported (this server speaks ${PROTOCOL_MIN}..${PROTOCOL_MAX})`,
				'Update task on the older of the two machines to the same version, then run: task strategy check',
				{ supported: { min: PROTOCOL_MIN, max: PROTOCOL_MAX } }
			);
		}
		return version;
	};

	const expectedRevisionOf = (request: ServiceRequest): string | undefined => {
		const raw = request.headers['if-match'];
		if (raw === undefined || raw.trim() === '*') return undefined;
		return raw
			.trim()
			.replace(/^W\//, '')
			.replace(/^"(.*)"$/, '$1');
	};

	const eventsSuppressed = (request: ServiceRequest): boolean => {
		const raw = request.headers[EVENTS_HEADER.toLowerCase()];
		if (raw === undefined) return false;
		if (raw.trim() === EVENTS_SUPPRESS) return true;
		throw new WireProtocolError(
			'invalid-request',
			`${EVENTS_HEADER}: "${raw}" is not a known value`,
			`The only value is "${EVENTS_SUPPRESS}".`
		);
	};

	const handle = async (request: ServiceRequest): Promise<ServiceResponse> => {
		const startedAt = Date.now();
		let status = 500;
		// The protocol version the request named (the answer repeats it): a v1 client reads its own version back.
		let negotiated = PROTOCOL_MIN;
		let label = `${request.method} ${request.path.split('?')[0]}`;
		const answer = (code: number, body: unknown, extra: Record<string, string> = {}): ServiceResponse => ({
			status: code,
			headers: { [PROTOCOL_HEADER]: String(negotiated), ...extra },
			body,
		});
		try {
			if (request.admit !== undefined) await request.admit();
			const version = checkProtocol(request);
			negotiated = version;
			let match: RouteMatch | { methodNotAllowed: string[] } | undefined;
			try {
				match = matchRoute(request.method, request.path);
			} catch (error) {
				if (error instanceof ProtocolPathError) {
					throw new WireProtocolError(
						'invalid-request',
						error.message,
						'Percent-encode the parts of the path.'
					);
				}
				throw error;
			}
			if (match === undefined) {
				throw new WireProtocolError(
					'unknown-route',
					`no such route: ${label}`,
					'Check the version of task on both machines.'
				);
			}
			if ('methodNotAllowed' in match) {
				status = 405;
				return answer(
					405,
					encodeWireError(
						new WireProtocolError(
							'not-allowed',
							`${label} is not allowed (allowed: ${match.methodNotAllowed.join(', ')})`,
							'Use one of the allowed methods.'
						),
						{ redact: options.redact }
					).body,
					{ Allow: match.methodNotAllowed.join(', ') }
				);
			}
			label = `${match.spec.method} ${match.spec.path}`;
			// A route a later protocol added is only served to a request that names that version: a peer that sends the older one has
			// no code for it, and a request made by hand must say which dialect it speaks.
			if (version < match.spec.since) {
				throw new WireProtocolError(
					'incompatible',
					`${label} needs protocol ${match.spec.since}, the request names protocol ${version}`,
					`Send ${PROTOCOL_HEADER}: ${match.spec.since} for this route (this server speaks ${PROTOCOL_MIN}..${PROTOCOL_MAX}).`,
					{ supported: { min: PROTOCOL_MIN, max: PROTOCOL_MAX } }
				);
			}
			const body = await request.readBody();
			if (match.op === 'info') {
				status = 200;
				return answer(200, info());
			}
			const op = match.op as PortOperation;
			const input = validateInput(op, { params: match.params, query: match.query, body }, ctx.config);
			const env = projectEnv(ctx);
			if (!match.spec.write) {
				const { result } = await runOperation(op, input, { backend: ctx.store, config: ctx.config, env, now });
				status = 200;
				return answer(200, result);
			}
			const expectedRevision = expectedRevisionOf(request);
			const suppressed = eventsSuppressed(request);
			const { result, delivery } = await queue.run(async () => {
				const outcome = await runOperation(op, input, {
					backend: ctx.store,
					config: ctx.config,
					env,
					now,
					...(expectedRevision === undefined ? {} : { expectedRevision }),
				});
				// Registered while the write still holds the queue, so the events leave in the order the changes were made.
				return { result: outcome.result, delivery: deliverInOrder(outcome.events, suppressed) };
			});
			status = op === 'create' ? 201 : 200;
			return answer(status, { result, events: await delivery });
		} catch (error) {
			// The peer left before it finished its request: nobody to answer, and not a fault of the server.
			if ((error as NodeJS.ErrnoException).code === 'ECONNRESET' || request.isGone?.() === true) {
				status = 499;
				log('warn', `${label}: the client went away before its request was complete`);
				return { status: 499, headers: {}, body: undefined, gone: true };
			}
			const { status: code, body } = encodeWireError(error, { redact: options.redact });
			status = code;
			if (code === 500) log('error', `${label}: ${body.error.message}`);
			return answer(code, body);
		} finally {
			log('info', `${label} -> ${status} (${Date.now() - startedAt} ms)`);
		}
	};

	return {
		handle,
		idle: () => queue.idle(),
		flushEvents: async () => {
			await eventTail;
			await sink?.flush?.();
		},
	};
}
