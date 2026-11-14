import type { ModuleContext } from '@wadeck-app/app-core-sdk';
import { eventsRaisedByServer } from '@wadeck-app/task-service';
import type { EventSink, QueueEventSinkOptions, ReadNotice, TaskEvent } from '@wadeck-app/task-service';

import { toHttpError, toInlineError } from '../errors.js';
import { openProject } from '../projects.js';
import type { OpenedProject } from '../projects.js';
import { queryValue } from '../request.js';
import { runInRequestScope } from '../requestScope.js';
import type { RouteAnswer, RouteRequest } from '../request.js';
import { recordServerError } from '../serverErrorLog.js';
import { deliverForRequest } from '../undelivered.js';
import type { UndeliveredAnswer } from '../undelivered.js';

export interface TaskRoutesOptions {
	/** Directory holding logs/. Default: {@link getTaskConfigDir}. */
	configDir?: string;
	/** Destination of the events produced by mutating routes. Default: the queue sink, logging under `<configDir>/logs`. */
	eventSink?: EventSink;
	/** Builds the queue SDK publisher of the default sink (tests inject a fake). Ignored when `eventSink` is given. */
	createPublisher?: QueueEventSinkOptions['createPublisher'];
	/** Where 5xx failures are reported besides the task log. Default: process.stderr (app-core's own output). */
	writeStderr?: (text: string) => void;
}

/** What the route modules share: route registration with error mapping, project selection, event delivery. */
export interface RouteKit {
	/** The module's own persistent folder (ModuleContext.dataDir): state of the views, not of the projects. */
	dataDir: string;
	/** Registers a route; every error thrown by `run` becomes its HTTP answer (see errors.ts). */
	route(method: string, subPath: string, run: (req: RouteRequest) => RouteAnswer | Promise<RouteAnswer>): void;
	/** The service context of the project the request targets (`?project=`). */
	open(req: RouteRequest): OpenedProject;
	/** Delivers the events; those the queue did not get are returned for the body, the change is not failed. */
	deliver(events: readonly TaskEvent[]): Promise<UndeliveredAnswer[]>;
	/**
	 * Registers a Server-Sent Events route. `prepare` runs like a route (request scope, same error answers: a failure is a plain
	 * JSON {error, hint} BEFORE the socket is taken over); once it returned, the socket is hijacked, the event-stream head is
	 * written and `start` runs with the prepared value and the way to write and to learn that the client left.
	 */
	stream<T>(
		subPath: string,
		prepare: (req: RouteRequest) => T | Promise<T>,
		start: (prepared: T, io: StreamIo) => void
	): void;
}

/** What a stream route writes to and listens on. */
export interface StreamIo {
	/** False once the client left or the response ended: nothing must be written then. */
	isOpen(): boolean;
	/** Writes text as is (an SSE block); a no-op when closed. */
	write(text: string): void;
	/** Ends the response (idempotent). */
	end(): void;
	/** Runs `fn` once when the client leaves (or `end` is called). */
	onClose(fn: () => void): void;
}

/** The parts of the raw Node response and request a stream uses (the SDK types them loosely). */
interface RawResponse {
	writeHead(status: number, headers: Record<string, string>): unknown;
	write(text: string): unknown;
	end(): unknown;
	writableEnded: boolean;
	destroyed: boolean;
}
interface StreamReply extends Reply {
	hijack(): unknown;
	raw: RawResponse;
}
interface StreamRequest {
	raw: { on(event: 'close', fn: () => void): unknown };
}

type Reply = { code(status: number): { send(body: unknown): unknown } };

/** The task id of the request path (`/tasks/:id/...`). */
export function taskId(req: RouteRequest): string {
	return req.params?.['id'] ?? '';
}

export function createRouteKit(
	ctx: ModuleContext,
	deps: {
		eventSink: EventSink;
		logDir: string;
		writeStderr: (text: string) => void;
		/** Called as soon as a write of this process delivered its events (the board streams check their version at once). */
		onChange?: () => void;
	}
): RouteKit {
	const { eventSink, logDir, writeStderr, onChange } = deps;
	// Projects (ids) opened by this module whose server raises their queue events: the events a use case returns for them are not
	// delivered here, the server already raised them. Refreshed by every `open`, so a project switched to another strategy follows.
	const raisedByServer = new Set<string>();
	const failWith = (error: unknown, method: string, subPath: string, inline: boolean, out: Reply): unknown => {
		const failure = toHttpError(error);
		// Only unexpected failures: a 4xx is the caller's mistake and is already in its answer.
		// 503 is the remote system being unavailable (no token, unreachable, refused): expected and already explained in the
		// answer with its fix, so it is not an unexpected failure to put in the log and on stderr.
		if (failure.status >= 500 && failure.status !== 503) {
			recordServerError(logDir, { method, route: subPath, status: failure.status, error }, writeStderr);
		}
		const answer = inline ? toInlineError(failure) : failure;
		return out.code(answer.status).send(answer.body);
	};
	return {
		dataDir: ctx.dataDir,
		route(method, subPath, run) {
			ctx.registerRoute(method, subPath, async (req, reply) => {
				const out = reply as unknown as Reply;
				try {
					// The contexts the handler opens are released when the answer is ready (or the handler failed): a project on a
					// remote strategy may hold a connection or a cache.
					const { value: answer, notices } = await runInRequestScope(
						() => run(req as unknown as RouteRequest),
						message => writeStderr(`warning: ${message}\n`)
					);
					return out.code(answer.status).send(withReadNotices(jsonBody(answer.body), notices));
				} catch (error) {
					return failWith(error, method, subPath, wantsInlineErrors(req as unknown as RouteRequest), out);
				}
			});
		},
		stream<T>(
			subPath: string,
			prepare: (req: RouteRequest) => T | Promise<T>,
			start: (prepared: T, io: StreamIo) => void
		): void {
			ctx.registerRoute('GET', subPath, async (req, reply) => {
				const out = reply as unknown as StreamReply;
				let prepared: T;
				try {
					prepared = (
						await runInRequestScope(
							() => prepare(req as unknown as RouteRequest),
							message => writeStderr(`warning: ${message}\n`)
						)
					).value;
				} catch (error) {
					// The socket is still Fastify's: a plain JSON failure (an EventSource cannot read an inline one).
					return failWith(error, 'GET', subPath, false, out);
				}
				// Take the socket over from Fastify and write to it ourselves (app-core's SSE convention).
				out.hijack();
				out.raw.writeHead(200, {
					'Content-Type': 'text/event-stream',
					'Cache-Control': 'no-cache',
					Connection: 'keep-alive',
					// A reverse proxy must not buffer the stream.
					'X-Accel-Buffering': 'no',
				});
				const closers: Array<() => void> = [];
				let ended = false;
				const io: StreamIo = {
					isOpen: () => !ended && !out.raw.writableEnded && !out.raw.destroyed,
					write(text) {
						if (io.isOpen()) out.raw.write(text);
					},
					end() {
						if (ended) return;
						ended = true;
						if (!out.raw.writableEnded && !out.raw.destroyed) out.raw.end();
						for (const fn of closers.splice(0)) fn();
					},
					onClose(fn) {
						if (ended) fn();
						else closers.push(fn);
					},
				};
				(req as unknown as StreamRequest).raw.on('close', io.end);
				start(prepared, io);
				return undefined;
			});
		},
		open(req) {
			const opened = openProject(queryValue(req.query, 'project'));
			if (eventsRaisedByServer(opened)) raisedByServer.add(opened.project.id);
			else raisedByServer.delete(opened.project.id);
			return opened;
		},
		deliver(events) {
			// The change is saved: tell the board streams now, the queue may take its time.
			onChange?.();
			return deliverForRequest(
				eventSink,
				events.filter(event => !raisedByServer.has(event.payload.taskProjectId ?? ''))
			);
		},
	};
}

/**
 * The installed shell reads every answer but a 204 with `response.json()`: an empty body fails the action with "Failed to
 * execute 'json' on 'Response': Unexpected end of JSON input" (no status, no hint). A route that answers without a body (a
 * mistake, not a design) therefore sends `{}`, never an empty response.
 */
function jsonBody(body: unknown): unknown {
	return body === undefined || body === null ? {} : body;
}

/** `?inlineErrors=true`: the caller is a view that cannot read a failed request (see {@link toInlineError}). */
function wantsInlineErrors(req: RouteRequest): boolean {
	return req.query?.['inlineErrors'] === 'true';
}

/**
 * What the reads of the request want the user to know (data served from the cache because the server could not be asked, something
 * left out of a read): added to an object answer as `readNotices` (the texts), nothing when there is none. A view that shows them
 * binds the field; the others ignore it.
 */
function withReadNotices(body: unknown, notices: readonly ReadNotice[]): unknown {
	if (notices.length === 0 || typeof body !== 'object' || body === null || Array.isArray(body)) return body;
	return { ...(body as Record<string, unknown>), readNotices: notices.map(notice => notice.text) };
}
