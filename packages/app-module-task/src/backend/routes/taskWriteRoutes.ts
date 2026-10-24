// Write routes of tasks: create, status, labels, parent, type, meta and links.
import {
	addLabel,
	createTask,
	linkTasks,
	removeLabel,
	removeParent,
	setMeta,
	setParent,
	setStatus,
	setType,
	unlinkTasks,
} from '@wadeck-app/task-service';
import type { TaskChangeResult } from '@wadeck-app/task-service';

import { RequestError } from '../errors.js';
import { detailHref } from '../hrefs.js';
import { rememberLastProject } from '../lastProject.js';
import { bodyObject, optionalString, queryValue, requiredString } from '../request.js';
import type { RouteAnswer, RouteRequest } from '../request.js';
import { undeliveredFields } from '../undelivered.js';
import { taskId } from './routeKit.js';
import type { RouteKit } from './routeKit.js';

const CREATE_USAGE = 'Send a JSON body { "description": string, "parent"?: string (task id or prefix) }.';
const STATUS_USAGE = 'Send a JSON body { "status": string } (one of the project statuses).';
const LABEL_USAGE = 'Send a JSON body { "label": string }.';
const PARENT_USAGE = 'Send a JSON body { "parent": string } (task id or prefix).';
const TYPE_USAGE = 'Send a JSON body { "type": string } (one of the project types, when some are configured).';
const META_USAGE = 'Send a JSON body { "key": string, "value": string }.';
const LINK_USAGE =
	'Send { "type": string, "target": string } (type: blockedBy, duplicateOf, causedBy, blocks, duplicates, causes), as a JSON body or, for DELETE, as query parameters.';

/** `type` and `target` of a link request: the JSON body, else (DELETE) the query string. */
function linkInput(req: RouteRequest, allowQuery: boolean): { id: string; type: string; target: string } {
	const hasBody = req.body !== undefined && req.body !== null;
	const source: Record<string, unknown> =
		hasBody || !allowQuery
			? bodyObject(req.body, LINK_USAGE)
			: { type: queryValue(req.query, 'type'), target: queryValue(req.query, 'target') };
	return {
		id: taskId(req),
		type: requiredString(source, 'type', LINK_USAGE),
		target: requiredString(source, 'target', LINK_USAGE),
	};
}

export function registerTaskWriteRoutes(kit: RouteKit): void {
	const { route, open, deliver } = kit;

	/** Delivers the events of a change; the answer carries the task and what the queue did not get. */
	const answerChange = async (result: TaskChangeResult): Promise<RouteAnswer> => {
		const undelivered = await deliver(result.events);
		return { status: 200, body: { task: result.task, ...undeliveredFields(undelivered) } };
	};

	route('POST', '/tasks', async req => {
		const ctx = open(req);
		const body = bodyObject(req.body, CREATE_USAGE);
		const description = requiredString(body, 'description', CREATE_USAGE);
		// A blank description would make a task with an empty title (the CLI accepts it too; the form should not).
		if (description.trim() === '') {
			throw new RequestError(400, 'description must not be blank', CREATE_USAGE);
		}
		const input = {
			description,
			// A form sends an empty parent when none is chosen.
			parent: body['parent'] === '' ? undefined : optionalString(body, 'parent', CREATE_USAGE),
		};
		const created = createTask(ctx, input);
		// The New task page preselects it next time; the task exists, so a failure to remember it is a warning only.
		const lastProjectWarning = rememberLastProject(kit.dataDir, ctx.project.id);
		const undelivered = await deliver(created.events);
		return {
			status: 201,
			body: {
				task: created.task,
				message: `Created task ${created.task.id}: ${created.task.title}`,
				href: detailHref(ctx.project, created.task.id),
				lastProjectWarning,
				...undeliveredFields(undelivered),
			},
		};
	});

	route('POST', '/tasks/:id/status', async req => {
		const ctx = open(req);
		const body = bodyObject(req.body, STATUS_USAGE);
		const result = setStatus(ctx, { id: taskId(req), status: requiredString(body, 'status', STATUS_USAGE) });
		const undelivered = await deliver(result.events);
		const { events: _events, ...answer } = result;
		return { status: 200, body: { ...answer, ...undeliveredFields(undelivered) } };
	});

	route('POST', '/tasks/:id/labels', req => {
		const ctx = open(req);
		const body = bodyObject(req.body, LABEL_USAGE);
		return answerChange(addLabel(ctx, { id: taskId(req), label: requiredString(body, 'label', LABEL_USAGE) }));
	});

	route('DELETE', '/tasks/:id/labels/:label', req => {
		return answerChange(removeLabel(open(req), { id: taskId(req), label: req.params?.['label'] ?? '' }));
	});

	route('POST', '/tasks/:id/parent', req => {
		const ctx = open(req);
		const body = bodyObject(req.body, PARENT_USAGE);
		return answerChange(setParent(ctx, { id: taskId(req), parent: requiredString(body, 'parent', PARENT_USAGE) }));
	});

	route('DELETE', '/tasks/:id/parent', req => {
		return answerChange(removeParent(open(req), { id: taskId(req) }));
	});

	route('POST', '/tasks/:id/type', req => {
		const ctx = open(req);
		const body = bodyObject(req.body, TYPE_USAGE);
		return answerChange(setType(ctx, { id: taskId(req), type: requiredString(body, 'type', TYPE_USAGE) }));
	});

	route('POST', '/tasks/:id/meta', req => {
		const ctx = open(req);
		const body = bodyObject(req.body, META_USAGE);
		const key = requiredString(body, 'key', META_USAGE);
		// An empty value is allowed (same as `task set-meta <id> <key> ""`).
		const value = body['value'];
		if (typeof value !== 'string') {
			throw new RequestError(400, 'value must be a string (it may be empty)', META_USAGE);
		}
		return answerChange(setMeta(ctx, { id: taskId(req), key, value }));
	});

	route('POST', '/tasks/:id/links', async req => {
		const ctx = open(req);
		const result = linkTasks(ctx, linkInput(req, false));
		const undelivered = await deliver(result.events);
		return { status: 200, body: { task: result.task, ...undeliveredFields(undelivered) } };
	});

	route('DELETE', '/tasks/:id/links', async req => {
		const ctx = open(req);
		const result = unlinkTasks(ctx, linkInput(req, true));
		const undelivered = await deliver(result.events);
		return { status: 200, body: { task: result.task, ...undeliveredFields(undelivered) } };
	});
}
