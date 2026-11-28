// `task serve`, the server side of the remote strategy (design 3, stage 4): serves ONE project (its LOCAL backend) over the versioned
// HTTP/JSON protocol of task-core/remote. The server is the single writer of that project and the only place its queue events are
// raised (R6, R7). Plain HTTP on purpose in v1 (the transport is a plugin on the client side; TLS and tunnels are deferred): the
// bind address is loopback unless the caller was explicit (the CLI requires --allow-lan, see ServeCommand), and everything below
// assumes a hostile peer on the network: a bearer token checked in constant time, a request size limit, strict validation of every
// input, JSON only, no CORS, no secret in a body or a log, and no request can make the process throw.
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

import { PROTOCOL_HEADER, PROTOCOL_MIN, WireProtocolError, encodeWireError } from '@wadeck-app/task-core';

import type { TaskServiceContext } from '../context.js';
import { TaskServiceError } from '../errors.js';
import type { EventSink } from '../events.js';
import { MIN_TOKEN_LENGTH, createFailureLimiter, createTokenCheck } from './serverAuth.js';
import { createRequestHandler } from './requestHandler.js';
import type { ServiceResponse } from './requestHandler.js';

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
	/**
	 * The clock of this server, the one authority on time: a claim starts now and its lease ends now plus the length the client asked
	 * for (protocol 2; the client sends a duration, never an instant). Default: the system clock.
	 */
	now?: () => Date;
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

/**
 * Refuses a project this server must not serve: one that is itself on the `remote` strategy (a server of a server is a loop waiting to
 * happen and two hops of timeouts). Any other storage (local files, github, gitlab, migrating) is served: the client sees the port.
 */
export function assertServable(ctx: TaskServiceContext): void {
	const kind = ctx.store.kind;
	if (kind === 'remote') {
		throw new TaskServerStartError(
			`project "${ctx.project.name}" uses the remote strategy; task serve does not serve a project whose tasks live behind another server`,
			`Run task serve on the machine that holds the tasks (any storage there: local files, github, gitlab), or point the clients at that machine.`
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
	const now = options.now ?? ((): Date => new Date());
	const tokenCheck = createTokenCheck(token);
	const limiter = createFailureLimiter(options.failedAuthDelayMs ?? DEFAULTS.failedAuthDelayMs);
	// Nothing that reaches a client may hold the token, nor the server's own folder.
	const secrets = [token, ctx.storage.dataDir];
	const inFlight = new Set<Promise<void>>();
	let closing = false;
	// The whole pipeline (routes, validation, the single-writer queue, events) is the one the stdio server shares: requestHandler.ts.
	const handler = createRequestHandler({
		ctx,
		eventSink: sink,
		version: options.version,
		now,
		log,
		redact: secrets,
	});

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

	/** The answer on the wire: the adapter's own headers around the ones the handler gives (the protocol version, Allow). */
	const send = (res: http.ServerResponse, response: ServiceResponse): void => {
		if (res.headersSent) return;
		const text = JSON.stringify(response.body);
		const { [PROTOCOL_HEADER]: protocol, ...extra } = response.headers;
		const close: Record<string, string> =
			response.status === 401 || response.status === 413 || response.status === 415 ? { Connection: 'close' } : {};
		res.writeHead(response.status, {
			'Content-Type': 'application/json; charset=utf-8',
			'Content-Length': Buffer.byteLength(text),
			[PROTOCOL_HEADER]: protocol ?? String(PROTOCOL_MIN),
			'Cache-Control': 'no-store',
			'X-Content-Type-Options': 'nosniff',
			...extra,
			...close,
		});
		res.end(text);
	};

	const lowerHeaders = (req: http.IncomingMessage): Record<string, string | undefined> => {
		const headers: Record<string, string | undefined> = {};
		for (const name of Object.keys(req.headers)) headers[name.toLowerCase()] = headerValue(req.headers[name]);
		return headers;
	};

	const handle = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
		const response = await handler.handle({
			method: req.method ?? 'GET',
			path: req.url ?? '/',
			headers: lowerHeaders(req),
			readBody: () => readBody(req),
			isGone: () => res.destroyed,
			// First of all, before the protocol is even looked at: shutting down, then the token.
			admit: async () => {
				if (closing)
					throw new WireProtocolError('unavailable', 'the server is shutting down', 'Retry in a moment.');
				await authenticate(req);
			},
		});
		if (response.gone === true) return;
		send(res, response);
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
					if (!res.headersSent) send(res, { status: 500, headers: {}, body: encodeWireError(error, { redact: secrets }).body });
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
				const drained = Promise.all([...inFlight]).then(() => handler.idle());
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
				await handler.flushEvents();
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
