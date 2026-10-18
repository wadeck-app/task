import * as path from 'node:path';

import type { ModuleContext } from '@wadeck-app/app-core-sdk';
import type { TaskRecord, TaskSummary } from '@wadeck-app/task-core';
import {
	addLabel,
	createQueueEventSink,
	createTask,
	DanglingParentError,
	deliverEvents,
	getFullTree,
	getTaskConfigDir,
	getTaskHistory,
	getTaskLinks,
	linkTasks,
	listForest,
	listTasks,
	removeLabel,
	setStatus,
	showTask,
	unlinkTasks,
} from '@wadeck-app/task-service';
import type { EventSink, TaskEvent, TaskServiceContext, UndeliveredEvent } from '@wadeck-app/task-service';

import { RequestError, toHttpError } from './errors.js';
import { recordServerError } from './serverErrorLog.js';
import { listProjects, openProject, requireRegisteredProjects } from './projects.js';

export interface TaskRoutesOptions {
	/** Directory holding projects.json and logs/. Default: {@link getTaskConfigDir}. */
	configDir?: string;
	/** Destination of the events produced by mutating routes. Default: the queue sink, logging under `<configDir>/logs`. */
	eventSink?: EventSink;
	/** Where 5xx failures are reported besides the task log. Default: process.stderr (app-core's own output). */
	writeStderr?: (text: string) => void;
}

interface RouteRequest {
	params?: Record<string, string>;
	query?: Record<string, string | string[] | undefined>;
	body?: unknown;
}

interface RouteAnswer {
	status: number;
	body: unknown;
}

type Reply = { code(status: number): { send(body: unknown): unknown } };

const MODULE_ID = 'task';

/** A query parameter given at most once. */
function queryValue(query: RouteRequest['query'], name: string): string | undefined {
	const value = query?.[name];
	if (Array.isArray(value)) {
		throw new RequestError(400, `${name} must be given once, got ${value.length} values`);
	}
	if (value !== undefined && typeof value !== 'string') {
		throw new RequestError(400, `${name} must be a string`);
	}
	return value;
}

function showAllFlag(query: RouteRequest['query']): boolean {
	const value = queryValue(query, 'showAll');
	if (value === undefined || value === 'false') return false;
	if (value === 'true') return true;
	throw new RequestError(
		400,
		`showAll must be "true" or "false", got "${value}"`,
		'Use ?showAll=true to include terminal statuses.'
	);
}

function bodyObject(body: unknown, usage: string): Record<string, unknown> {
	if (body === null || body === undefined || typeof body !== 'object' || Array.isArray(body)) {
		throw new RequestError(400, `expected a JSON object body, got: ${JSON.stringify(body) ?? 'nothing'}`, usage);
	}
	return body as Record<string, unknown>;
}

function requiredString(source: Record<string, unknown>, field: string, usage: string): string {
	const value = source[field];
	if (typeof value !== 'string' || value === '') {
		throw new RequestError(400, `${field} must be a non-empty string`, usage);
	}
	return value;
}

function optionalString(source: Record<string, unknown>, field: string, usage: string): string | undefined {
	const value = source[field];
	if (value === undefined) return undefined;
	if (typeof value !== 'string' || value === '') {
		throw new RequestError(400, `${field} must be a non-empty string when given`, usage);
	}
	return value;
}

const CREATE_USAGE = 'Send a JSON body { "description": string, "parent"?: string (task id or prefix) }.';
const STATUS_USAGE = 'Send a JSON body { "status": string } (one of the project statuses).';
const LABEL_USAGE = 'Send a JSON body { "label": string }.';
const LINK_USAGE =
	'Send { "type": string, "target": string } (type: blockedBy, duplicateOf, causedBy, blocks, duplicates, causes), as a JSON body or, for DELETE, as query parameters.';

/** An event the queue did not receive, as reported in the body of a mutating route. */
interface UndeliveredAnswer {
	event: string;
	taskId: string | undefined;
	reason: string;
	/** Command that replays the event once the cause is fixed. */
	replay: string;
}

function toUndeliveredAnswer(undelivered: UndeliveredEvent): UndeliveredAnswer {
	return {
		event: undelivered.event.name,
		taskId: undelivered.event.payload.taskId,
		reason: undelivered.reason,
		replay: undelivered.replay,
	};
}

function detailHref(project: { path: string }, taskId: string): string {
	return `/modules/${MODULE_ID}/tasks/${taskId}?project=${encodeURIComponent(project.path)}`;
}

function withRowLinks(ctx: TaskServiceContext, tasks: TaskSummary[]): unknown[] {
	return tasks.map(task => ({ ...task, projectPath: ctx.project.path, href: detailHref(ctx.project, task.id) }));
}

interface StatusCount {
	status: string;
	count: number;
	terminal: boolean;
}

function countByStatus(ctx: TaskServiceContext): StatusCount[] {
	const counts = new Map<string, StatusCount>(
		ctx.config.statuses.map(status => [
			status,
			{ status, count: 0, terminal: ctx.config.terminalStatuses.includes(status) },
		])
	);
	for (const task of ctx.store.list()) {
		// A status removed from config.yml still has tasks: show it rather than losing them from the total.
		const entry = counts.get(task.status) ?? { status: task.status, count: 0, terminal: false };
		entry.count++;
		counts.set(task.status, entry);
	}
	return [...counts.values()];
}

/** One display line for the projects the all-projects summary could not read; null when there is none. */
function skippedWarning(skipped: readonly { path: string; error: string }[]): string | null {
	if (skipped.length === 0) return null;
	const noun = skipped.length === 1 ? 'project' : 'projects';
	const details = skipped.map(entry => `${entry.path} (${entry.error})`).join('; ');
	return `${skipped.length} ${noun} not counted: ${details}. Run \`task init\` in the project directory or check that it still exists.`;
}

/** Registers the task routes (`/api/modules/task/...`) on the module context. */
export function registerTaskRoutes(ctx: ModuleContext, options: TaskRoutesOptions = {}): void {
	const configDir = options.configDir ?? getTaskConfigDir();
	const writeStderr = options.writeStderr ?? ((text: string) => void process.stderr.write(text));
	const eventSink = options.eventSink ?? createQueueEventSink({ getLogDir: () => path.join(configDir, 'logs') });

	/** Runs the route, turning every thrown error into its HTTP answer (see errors.ts). */
	function route(
		method: string,
		subPath: string,
		run: (req: RouteRequest) => RouteAnswer | Promise<RouteAnswer>
	): void {
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
						path.join(configDir, 'logs'),
						{ method, route: subPath, status: failure.status, error },
						writeStderr
					);
				}
				return out.code(failure.status).send(failure.body);
			}
		});
	}

	const open = (req: RouteRequest): TaskServiceContext => openProject(configDir, queryValue(req.query, 'project'));
	const id = (req: RouteRequest): string => req.params?.['id'] ?? '';

	/**
	 * Hands the events to the sink. Events the sink could not deliver do not fail the request (the change is applied):
	 * they are returned for the JSON body. A sink that throws is a 500.
	 */
	async function deliver(events: readonly TaskEvent[]): Promise<UndeliveredAnswer[]> {
		try {
			const outcome = await deliverEvents(eventSink, events);
			return outcome.undelivered.map(toUndeliveredAnswer);
		} catch (error) {
			throw new RequestError(
				500,
				`the change was applied but its queue events were not delivered: ${error instanceof Error ? error.message : String(error)}`,
				'The change is saved; only the events are missing. Check that the queue CLI is installed and on PATH (`queue --version`).'
			);
		}
	}

	route('GET', '/projects', () => ({ status: 200, body: { projects: listProjects(configDir) } }));

	route('GET', '/summary', req => {
		const requested = queryValue(req.query, 'project');
		const dirs = requested === undefined ? requireRegisteredProjects(configDir) : [requested];
		const merged = new Map<string, StatusCount>();
		const skipped: { path: string; error: string }[] = [];
		let projectCount = 0;
		let open = 0;
		let total = 0;
		for (const dir of dirs) {
			let project: TaskServiceContext;
			try {
				project = openProject(configDir, dir);
			} catch (error) {
				// Naming a project explicitly must fail loudly; in the all-projects view one broken project is reported, not hidden.
				if (requested !== undefined) throw error;
				skipped.push({ path: dir, error: String(toHttpError(error).body['error']) });
				continue;
			}
			projectCount++;
			for (const entry of countByStatus(project)) {
				const sum = merged.get(entry.status) ?? { ...entry, count: 0 };
				sum.count += entry.count;
				merged.set(entry.status, sum);
				total += entry.count;
				if (!entry.terminal) open += entry.count;
			}
		}
		// Zeros from a registry whose every project failed would read as "no tasks": answer the failure instead.
		if (projectCount === 0 && skipped.length > 0) {
			throw new RequestError(
				500,
				`none of the ${skipped.length} registered projects could be read: ${skipped.map(s => `${s.path} (${s.error})`).join('; ')}`,
				'Run `task init` in each project directory to recreate its .task directory, or fix the cause above.',
				{ skipped }
			);
		}
		return {
			status: 200,
			body: {
				scope: requested === undefined ? 'all' : 'project',
				projectCount,
				open,
				total,
				byStatus: [...merged.values()],
				skipped,
				skippedCount: skipped.length,
				warning: skippedWarning(skipped),
			},
		};
	});

	route('GET', '/tasks', req => {
		const project = open(req);
		const tasks = listTasks(project, { showAll: showAllFlag(req.query), parent: queryValue(req.query, 'parent') });
		return { status: 200, body: { project: project.project, tasks: withRowLinks(project, tasks) } };
	});

	route('GET', '/tasks/:id', req => {
		const project = open(req);
		const warnings: string[] = [];
		let detail: Record<string, unknown>;
		try {
			detail = showTask(project, { id: id(req), withParent: true, withChildren: true });
		} catch (error) {
			if (!(error instanceof DanglingParentError)) throw error;
			// A task must stay reachable to be repaired: show it without its parent and say how to fix it.
			warnings.push(`${error.message}. ${error.hint}`);
			detail = { ...showTask(project, { id: id(req), withChildren: true }), parent: null };
		}
		const { parent, children, ...task } = detail;
		return {
			status: 200,
			body: {
				project: project.project,
				task,
				parent,
				warnings,
				warningText: warnings.length === 0 ? null : warnings.join(' '),
				children: withRowLinks(project, children as TaskSummary[]),
				links: getTaskLinks(project, { id: id(req) }),
			},
		};
	});

	route('GET', '/tasks/:id/history', req => {
		const project = open(req);
		return { status: 200, body: getTaskHistory(project, { id: id(req) }) };
	});

	route('GET', '/tree', req => {
		const project = open(req);
		const taskId = queryValue(req.query, 'id');
		const tree =
			taskId === undefined
				? listForest(project, { showAll: showAllFlag(req.query), parent: queryValue(req.query, 'parent') })
				: getFullTree(project, { id: taskId });
		return { status: 200, body: { project: project.project, tree } };
	});

	route('POST', '/tasks', async req => {
		const project = open(req);
		const body = bodyObject(req.body, CREATE_USAGE);
		const input = {
			description: requiredString(body, 'description', CREATE_USAGE),
			parent: optionalString(body, 'parent', CREATE_USAGE),
		};
		const created = createTask(project, input);
		const undelivered = await deliver(created.events);
		return { status: 201, body: { task: created.task, undelivered } };
	});

	route('POST', '/tasks/:id/status', async req => {
		const project = open(req);
		const body = bodyObject(req.body, STATUS_USAGE);
		const result = setStatus(project, { id: id(req), status: requiredString(body, 'status', STATUS_USAGE) });
		const undelivered = await deliver(result.events);
		const { events: _events, ...answer } = result;
		return { status: 200, body: { ...answer, undelivered } };
	});

	route('POST', '/tasks/:id/labels', req => {
		const project = open(req);
		const body = bodyObject(req.body, LABEL_USAGE);
		const task: TaskRecord = addLabel(project, { id: id(req), label: requiredString(body, 'label', LABEL_USAGE) });
		return { status: 200, body: { task } };
	});

	route('DELETE', '/tasks/:id/labels/:label', req => {
		const project = open(req);
		const label = req.params?.['label'] ?? '';
		const task: TaskRecord = removeLabel(project, { id: id(req), label });
		return { status: 200, body: { task } };
	});

	/** `type` and `target` of a link request: the JSON body, else (DELETE) the query string. */
	function linkInput(req: RouteRequest, allowQuery: boolean): { id: string; type: string; target: string } {
		const hasBody = req.body !== undefined && req.body !== null;
		const source: Record<string, unknown> =
			hasBody || !allowQuery
				? bodyObject(req.body, LINK_USAGE)
				: { type: queryValue(req.query, 'type'), target: queryValue(req.query, 'target') };
		return {
			id: id(req),
			type: requiredString(source, 'type', LINK_USAGE),
			target: requiredString(source, 'target', LINK_USAGE),
		};
	}

	route('POST', '/tasks/:id/links', async req => {
		const project = open(req);
		const result = linkTasks(project, linkInput(req, false));
		const undelivered = await deliver(result.events);
		return { status: 200, body: { task: result.task, undelivered } };
	});

	route('DELETE', '/tasks/:id/links', async req => {
		const project = open(req);
		const result = unlinkTasks(project, linkInput(req, true));
		const undelivered = await deliver(result.events);
		return { status: 200, body: { task: result.task, undelivered } };
	});
}
