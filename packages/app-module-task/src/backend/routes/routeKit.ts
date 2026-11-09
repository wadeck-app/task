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
}

type Reply = { code(status: number): { send(body: unknown): unknown } };

/** The task id of the request path (`/tasks/:id/...`). */
export function taskId(req: RouteRequest): string {
	return req.params?.['id'] ?? '';
}

export function createRouteKit(
	ctx: ModuleContext,
	deps: { eventSink: EventSink; logDir: string; writeStderr: (text: string) => void }
): RouteKit {
	const { eventSink, logDir, writeStderr } = deps;
	// Projects (ids) opened by this module whose server raises their queue events: the events a use case returns for them are not
	// delivered here, the server already raised them. Refreshed by every `open`, so a project switched to another strategy follows.
	const raisedByServer = new Set<string>();
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
					const failure = toHttpError(error);
					// Only unexpected failures: a 4xx is the caller's mistake and is already in its answer.
					// 503 is the remote system being unavailable (no token, unreachable, refused): expected and already explained in the
					// answer with its fix, so it is not an unexpected failure to put in the log and on stderr.
					if (failure.status >= 500 && failure.status !== 503) {
						recordServerError(
							logDir,
							{ method, route: subPath, status: failure.status, error },
							writeStderr
						);
					}
					const answer = wantsInlineErrors(req as unknown as RouteRequest) ? toInlineError(failure) : failure;
					return out.code(answer.status).send(answer.body);
				}
			});
		},
		open(req) {
			const opened = openProject(queryValue(req.query, 'project'));
			if (eventsRaisedByServer(opened)) raisedByServer.add(opened.project.id);
			else raisedByServer.delete(opened.project.id);
			return opened;
		},
		deliver: events =>
			deliverForRequest(
				eventSink,
				events.filter(event => !raisedByServer.has(event.payload.taskProjectId ?? ''))
			),
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
