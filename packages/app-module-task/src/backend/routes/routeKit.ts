import type { ModuleContext } from '@wadeck-app/app-core-sdk';
import type { EventSink, QueueEventSinkOptions, TaskEvent } from '@wadeck-app/task-service';

import { toHttpError, toInlineError } from '../errors.js';
import { openProject } from '../projects.js';
import type { OpenedProject } from '../projects.js';
import { queryValue } from '../request.js';
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
	return {
		dataDir: ctx.dataDir,
		route(method, subPath, run) {
			ctx.registerRoute(method, subPath, async (req, reply) => {
				const out = reply as unknown as Reply;
				try {
					const answer = await run(req as unknown as RouteRequest);
					return out.code(answer.status).send(answer.body);
				} catch (error) {
					const failure = toHttpError(error);
					// Only unexpected failures: a 4xx is the caller's mistake and is already in its answer.
					if (failure.status >= 500) {
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
			return openProject(queryValue(req.query, 'project'));
		},
		deliver: events => deliverForRequest(eventSink, events),
	};
}

/** `?inlineErrors=true`: the caller is a view that cannot read a failed request (see {@link toInlineError}). */
function wantsInlineErrors(req: RouteRequest): boolean {
	return req.query?.['inlineErrors'] === 'true';
}
