// `task serve`, the server side of the remote strategy (design 3, stage 4): serves ONE project (its LOCAL backend) over the versioned
// HTTP/JSON protocol of task-core/remote. The server is the single writer of that project and the only place its queue events are
// raised (R6, R7). Plain HTTP on purpose in v1 (the transport is a plugin on the client side; TLS and tunnels are deferred): the
// bind address is loopback unless the caller was explicit (the CLI requires --allow-lan, see ServeCommand), and everything below
// assumes a hostile peer on the network: a bearer token checked in constant time, a request size limit, strict validation of every
// input, JSON only, no CORS, no secret in a body or a log, and no request can make the process throw.
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

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
import { TaskServiceError } from '../errors.js';
import { deliverEvents } from '../events.js';
import type { EventSink, TaskEvent } from '../events.js';
import { MIN_TOKEN_LENGTH, createFailureLimiter, createTokenCheck } from './serverAuth.js';
import { runOperation } from './serverOperations.js';
import { validateInput } from './requestValidation.js';
import { createWriteQueue } from './writeQueue.js';

/** The server could not start (address in use, token too short, a project that cannot be served). `hint` is the fix. */
export class TaskServerStartError extends TaskServiceError {}

export interface TaskServerOptions {
	/** The served project: its LOCAL backend, config and identity (`openResolvedProject`). */
	ctx: TaskServiceContext;
	/** The bearer token every request must carry (at least {@link MIN_TOKEN_LENGTH} characters). */
	token: string;
	/** Default `127.0.0.1`. The CLI refuses a non-loopback host without --allow-lan before calling this. */
	host?: string;
	/** Default 0: the system picks a free port (read it from the result). */
	port?: number;
	/** Where the events of the writes are delivered (the queue). Absent: the server raises none. */
	eventSink?: EventSink;
	/** The version of task, answered by `GET /v1/info`. */
	version?: string;
	/** Default 1 MiB. */
	maxBodyBytes?: number;
	/** Wait before answering a failed authentication, in ms. Default 500. */
	failedAuthDelayMs?: number;
	/** Time to receive a whole request, headers and body. Default 30 s. */
	requestTimeoutMs?: number;
	/** Time to finish the requests in flight when closing, before the connections are cut. Default 10 s. */
	shutdownGraceMs?: number;
	/** Server log (never receives the token). `info` lines are one per request. Default: nothing. */
	log?: (level: 'info' | 'warn' | 'error', message: string) => void;
	/** Test seam: how the failed-authentication delay waits. */
	sleep?: (ms: number) => Promise<void>;
}

export interface RunningTaskServer {
	/** `http://host:port` with the port actually bound. */
	url: string;
	host: string;
	port: number;
	/** Authentication failures since the start. */
	failedAuthCount(): number;
	/** Stops accepting, finishes what is in flight (writes included), flushes the events, cuts what is left after the grace. Safe twice. */
	close(): Promise<void>;
}

const DEFAULTS = {
	maxBodyBytes: 1024 * 1024,
	failedAuthDelayMs: 500,
	requestTimeoutMs: 30_000,
	shutdownGraceMs: 10_000,
};

const SERVER_NAME = 'task-serve' as const;

/** Refuses a project this server must not serve: only a project whose own strategy is `local` has data of its own to serve. */
export function assertServable(ctx: TaskServiceContext): void {
	const kind = ctx.store.kind;
	if (kind !== 'local') {
		throw new TaskServerStartError(
			`project "${ctx.project.name}" uses the ${kind} strategy; task serve serves projects whose tasks are stored locally`,
			`Serve the project on the machine that holds the tasks (its strategy is local), or remove the strategy section of this project's config to serve its own files. Chaining a remote or forge project through this machine is not supported.`
		);
	}
}

function hostLabel(host: string): string {
	return host.includes(':') ? `[${host}]` : host;
}

function headerValue(value: string | string[] | undefined): string | undefined {
	return Array.isArray(value) ? value[0] : value;
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Starts the server. Resolves once it listens; rejects with a TaskServerStartError that says what to change. */
export async function startTaskServer(options: TaskServerOptions): Promise<RunningTaskServer> {
	const { ctx, token } = options;
	assertServable(ctx);
	if (token.length < MIN_TOKEN_LENGTH) {
		throw new TaskServerStartError(
			`the token is too short (${token.length} characters; at least ${MIN_TOKEN_LENGTH} are required)`,
			"Generate a long random one, for example: node -e \"process.stdout.write(require('crypto').randomBytes(32).toString('hex'))\""
		);
	}
	const host = options.host ?? '127.0.0.1';
	const maxBodyBytes = options.maxBodyBytes ?? DEFAULTS.maxBodyBytes;
	const shutdownGraceMs = options.shutdownGraceMs ?? DEFAULTS.shutdownGraceMs;
	const log = options.log ?? ((): void => undefined);
	const sleep = options.sleep ?? ((ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms)));
	const sink = options.eventSink;
	const tokenCheck = createTokenCheck(token);
	const limiter = createFailureLimiter(options.failedAuthDelayMs ?? DEFAULTS.failedAuthDelayMs);
	const queue = createWriteQueue();
	// Nothing that reaches a client may hold the token, nor the server's own folder.
	const secrets = [token, ctx.storage.dataDir];
	const inFlight = new Set<Promise<void>>();
	let closing = false;
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

	const readBody = async (req: http.IncomingMessage): Promise<unknown> => {
		const declared = Number(headerValue(req.headers['content-length']) ?? '0');
		if (Number.isFinite(declared) && declared > maxBodyBytes) throw tooLarge(declared);
		const chunks: Buffer[] = [];
		let size = 0;
		for await (const chunk of req) {
			const buffer = chunk as Buffer;
			size += buffer.length;
			if (size > maxBodyBytes) throw tooLarge(size);
			chunks.push(buffer);
		}
		if (size === 0) return undefined;
		const contentType = (headerValue(req.headers['content-type']) ?? '').split(';')[0]!.trim().toLowerCase();
		if (contentType !== 'application/json') {
			throw new WireProtocolError(
				'unsupported-media',
				`the body must be application/json, found "${contentType === '' ? 'no Content-Type' : contentType}"`,
				'Send the body as JSON with the header Content-Type: application/json.'
			);
		}
		try {
			return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
		} catch {
			throw new WireProtocolError(
				'invalid-request',
				'the body is not valid JSON',
				'Send a well-formed JSON object.'
			);
		}
	};

	const tooLarge = (size: number): WireProtocolError =>
		new WireProtocolError(
			'too-large',
			`the request body is larger than ${maxBodyBytes} bytes (${size} received)`,
			'Send less data per request.'
		);

	const authenticate = async (req: http.IncomingMessage): Promise<void> => {
		if (tokenCheck.accepts(headerValue(req.headers['authorization']))) return;
		const source = req.socket.remoteAddress ?? 'unknown address';
		const { count, delayMs } = limiter.failed(source);
		log(
			'warn',
			`authentication failed from ${source} (${count} failure${count === 1 ? '' : 's'} from this address)`
		);
		if (delayMs > 0) await sleep(delayMs);
		throw new WireProtocolError(
			'unauthorized',
			'the token is missing or wrong',
			'Send the bearer token task serve was started with (Authorization: Bearer <token>); the client reads it from the variable or file named in strategy.options.transport.options.'
		);
	};

	const checkProtocol = (req: http.IncomingMessage): void => {
		const raw = headerValue(req.headers[PROTOCOL_HEADER.toLowerCase()]);
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
	};

	const expectedRevisionOf = (req: http.IncomingMessage): string | undefined => {
		const raw = headerValue(req.headers['if-match']);
		if (raw === undefined || raw.trim() === '*') return undefined;
		return raw
			.trim()
			.replace(/^W\//, '')
			.replace(/^"(.*)"$/, '$1');
	};

	const eventsSuppressed = (req: http.IncomingMessage): boolean => {
		const raw = headerValue(req.headers[EVENTS_HEADER.toLowerCase()]);
		if (raw === undefined) return false;
		if (raw.trim() === EVENTS_SUPPRESS) return true;
		throw new WireProtocolError(
			'invalid-request',
			`${EVENTS_HEADER}: "${raw}" is not a known value`,
			`The only value is "${EVENTS_SUPPRESS}".`
		);
	};

	const send = (
		res: http.ServerResponse,
		status: number,
		body: unknown,
		extra: Record<string, string> = {}
	): void => {
		if (res.headersSent) return;
		const text = JSON.stringify(body);
		res.writeHead(status, {
			'Content-Type': 'application/json; charset=utf-8',
			'Content-Length': Buffer.byteLength(text),
			[PROTOCOL_HEADER]: String(PROTOCOL_VERSION),
			'Cache-Control': 'no-store',
			'X-Content-Type-Options': 'nosniff',
			...extra,
		});
		res.end(text);
	};

	const handle = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
		const startedAt = Date.now();
		let status = 500;
		let label = `${req.method ?? '?'} ${(req.url ?? '').split('?')[0]}`;
		try {
			if (closing)
				throw new WireProtocolError('unavailable', 'the server is shutting down', 'Retry in a moment.');
			await authenticate(req);
			checkProtocol(req);
			let match: RouteMatch | { methodNotAllowed: string[] } | undefined;
			try {
				match = matchRoute(req.method ?? 'GET', req.url ?? '/');
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
				send(
					res,
					405,
					encodeWireError(
						new WireProtocolError(
							'not-allowed',
							`${label} is not allowed (allowed: ${match.methodNotAllowed.join(', ')})`,
							'Use one of the allowed methods.'
						),
						{ redact: secrets }
					).body,
					{ Allow: match.methodNotAllowed.join(', ') }
				);
				return;
			}
			label = `${match.spec.method} ${match.spec.path}`;
			const body = await readBody(req);
			if (match.op === 'info') {
				status = 200;
				send(res, 200, info());
				return;
			}
			const op = match.op as PortOperation;
			const input = validateInput(op, { params: match.params, query: match.query, body }, ctx.config);
			const env = projectEnv(ctx);
			if (!match.spec.write) {
				const { result } = await runOperation(op, input, { backend: ctx.store, config: ctx.config, env });
				status = 200;
				send(res, 200, result);
				return;
			}
			const expectedRevision = expectedRevisionOf(req);
			const suppressed = eventsSuppressed(req);
			const { result, delivery } = await queue.run(async () => {
				const outcome = await runOperation(op, input, {
					backend: ctx.store,
					config: ctx.config,
					env,
					...(expectedRevision === undefined ? {} : { expectedRevision }),
				});
				// Registered while the write still holds the queue, so the events leave in the order the changes were made.
				return { result: outcome.result, delivery: deliverInOrder(outcome.events, suppressed) };
			});
			status = op === 'create' ? 201 : 200;
			send(res, status, { result, events: await delivery });
		} catch (error) {
			// The peer left before it finished its request: nobody to answer, and not a fault of the server.
			if ((error as NodeJS.ErrnoException).code === 'ECONNRESET' || res.destroyed) {
				status = 499;
				log('warn', `${label}: the client went away before its request was complete`);
				return;
			}
			const { status: code, body } = encodeWireError(error, { redact: secrets });
			status = code;
			if (code === 500) log('error', `${label}: ${body.error.message}`);
			const close: Record<string, string> =
				code === 401 || code === 413 || code === 415 ? { Connection: 'close' } : {};
			send(res, code, body, close);
		} finally {
			log('info', `${label} -> ${status} (${Date.now() - startedAt} ms)`);
		}
	};

	const server = http.createServer(
		{
			requestTimeout: options.requestTimeoutMs ?? DEFAULTS.requestTimeoutMs,
			headersTimeout: 10_000,
			keepAliveTimeout: 5_000,
			maxHeaderSize: 16 * 1024,
		},
		(req, res) => {
			const work = handle(req, res).catch((error: unknown) => {
				// handle() answers its own failures; this is the last line of defence, so that nothing becomes an unhandled rejection.
				log('error', `request handler failed: ${messageOf(error)}`);
				try {
					if (!res.headersSent) send(res, 500, encodeWireError(error, { redact: secrets }).body);
					else res.destroy();
				} catch {
					res.destroy();
				}
			});
			inFlight.add(work);
			void work.finally(() => inFlight.delete(work));
		}
	);
	// A malformed request never reaches a handler: answer it (when the socket allows) and drop the connection.
	server.on('clientError', (error: NodeJS.ErrnoException, socket) => {
		// A peer that leaves (a command ended with its keep-alive socket open) resets the connection: that is how clients go, not a bad request.
		if (error.code === 'ECONNRESET' || error.code === 'EPIPE') {
			socket.destroy();
			return;
		}
		log('warn', `bad request: ${error.message}`);
		if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
		else socket.destroy();
	});

	await new Promise<void>((resolve, reject) => {
		server.once('error', (error: NodeJS.ErrnoException) => {
			reject(startError(error, host, options.port ?? 0));
		});
		server.listen({ host, port: options.port ?? 0 }, () => resolve());
	});
	// After listening, an error of the server socket must not crash the process.
	server.on('error', error => log('error', `server error: ${error.message}`));

	const address = server.address() as AddressInfo;
	let closed: Promise<void> | undefined;
	return {
		url: `http://${hostLabel(host)}:${address.port}`,
		host,
		port: address.port,
		failedAuthCount: () => limiter.total(),
		close() {
			closed ??= (async () => {
				closing = true;
				const stopped = new Promise<void>(resolve => server.close(() => resolve()));
				server.closeIdleConnections();
				const drained = Promise.all([...inFlight]).then(() => queue.idle());
				let timer: ReturnType<typeof setTimeout> | undefined;
				const expired = new Promise<'expired'>(resolve => {
					timer = setTimeout(() => resolve('expired'), shutdownGraceMs);
				});
				const outcome = await Promise.race([drained.then(() => 'drained' as const), expired]);
				if (timer !== undefined) clearTimeout(timer);
				if (outcome === 'expired') {
					log(
						'warn',
						`shutdown: ${inFlight.size} request(s) still running after ${shutdownGraceMs} ms; cutting the connections`
					);
				}
				server.closeAllConnections();
				await stopped;
				await eventTail;
				await sink?.flush?.();
			})();
			return closed;
		},
	};
}

function startError(error: NodeJS.ErrnoException, host: string, port: number): TaskServerStartError {
	switch (error.code) {
		case 'EADDRINUSE':
			return new TaskServerStartError(
				`${hostLabel(host)}:${port} is already in use`,
				`Another program (maybe another task serve) listens there. Choose another port with --port <n> (or --port 0 to let the system pick one).`
			);
		case 'EACCES':
			return new TaskServerStartError(
				`not allowed to listen on ${hostLabel(host)}:${port}`,
				'Ports below 1024 need elevated rights: choose a port above 1024 with --port <n>.'
			);
		case 'EADDRNOTAVAIL':
			return new TaskServerStartError(
				`${host} is not an address of this machine`,
				"Use 127.0.0.1 (this machine only), or the address of one of this machine's network interfaces with --allow-lan."
			);
		default:
			return new TaskServerStartError(
				`cannot listen on ${hostLabel(host)}:${port} (${error.code ?? error.message})`,
				'Check the --host and --port values.'
			);
	}
}
