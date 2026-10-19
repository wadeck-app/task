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

import { RequestError } from '../errors.js';
import { detailHref } from '../hrefs.js';
import { bodyObject, optionalString, queryValue, requiredString } from '../request.js';
import type { RouteRequest } from '../request.js';
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

	route('POST', '/tasks', async req => {
		const ctx = open(req);
		const body = bodyObject(req.body, CREATE_USAGE);
		const input = {
			description: requiredString(body, 'description', CREATE_USAGE),
			// A form sends an empty parent when none is chosen.
			parent: body['parent'] === '' ? undefined : optionalString(body, 'parent', CREATE_USAGE),
		};
		const created = createTask(ctx, input);
		const undelivered = await deliver(created.events);
		return {
			status: 201,
			body: {
				task: created.task,
				message: `Created task ${created.task.id}: ${created.task.title}`,
				href: detailHref(ctx.project, created.task.id),
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
		const task = addLabel(ctx, { id: taskId(req), label: requiredString(body, 'label', LABEL_USAGE) });
		return { status: 200, body: { task } };
	});

	route('DELETE', '/tasks/:id/labels/:label', req => {
		const task = removeLabel(open(req), { id: taskId(req), label: req.params?.['label'] ?? '' });
		return { status: 200, body: { task } };
	});

	route('POST', '/tasks/:id/parent', req => {
		const ctx = open(req);
		const body = bodyObject(req.body, PARENT_USAGE);
		const task = setParent(ctx, { id: taskId(req), parent: requiredString(body, 'parent', PARENT_USAGE) });
		return { status: 200, body: { task } };
	});

	route('DELETE', '/tasks/:id/parent', req => {
		return { status: 200, body: { task: removeParent(open(req), { id: taskId(req) }) } };
	});

	route('POST', '/tasks/:id/type', req => {
		const ctx = open(req);
		const body = bodyObject(req.body, TYPE_USAGE);
		const task = setType(ctx, { id: taskId(req), type: requiredString(body, 'type', TYPE_USAGE) });
		return { status: 200, body: { task } };
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
		return { status: 200, body: { task: setMeta(ctx, { id: taskId(req), key, value }) } };
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
