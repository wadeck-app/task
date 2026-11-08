// Write routes of tasks: create, status, labels, parent, type, meta and links.
import {
	addLabel,
	createTask,
	getTaskActivity,
	linkTasks,
	removeLabel,
	removeParent,
	setMeta,
	setParent,
	setStatus,
	setTaskText,
	setType,
	unlinkTasks,
	unsetMeta,
	unsetType,
} from '@wadeck-app/task-service';
import type { TaskChangeResult } from '@wadeck-app/task-service';

import { RequestError } from '../errors.js';
import { detailHref } from '../hrefs.js';
import { labelFromKey } from '../labelKey.js';
import { rememberLastProject } from '../lastProject.js';
import { metaKeyFromKey } from '../metaKey.js';
import { bodyObject, optionalString, queryValue, requiredString } from '../request.js';
import type { RouteAnswer, RouteRequest } from '../request.js';
import { taskTextFields } from '../taskViews.js';
import { undeliveredFields } from '../undelivered.js';
import { taskId } from './routeKit.js';
import type { RouteKit } from './routeKit.js';

const CREATE_USAGE =
	'Send a JSON body { "title"?: string, "description"?: string, "parent"?: string (task id or prefix) } with at least a title or a description (a long text alone is split into a headline and a description).';
const TEXT_USAGE =
	'Send a JSON body { "title"?: string, "description"?: string } with at least one of them; an empty description clears it.';
const META_VALUE_USAGE =
	'Send a JSON body { "value": string } or give ?value=<text> (an empty value is allowed); the key is in the path.';
const STATUS_USAGE = 'Send a JSON body { "status": string } (one of the project statuses).';
const LABEL_USAGE = 'Send a JSON body { "label": string }.';
const PARENT_USAGE = 'Send a JSON body { "parent": string } (task id or prefix).';
const TYPE_USAGE =
	'Send a JSON body { "type": string } (one of the project types, when some are configured; an empty string clears the type).';
const PATH_LABEL_USAGE = 'Use POST /tasks/<id>/labels/<label> with a non-blank label in the path.';
const PATH_STATUS_USAGE = 'Use POST /tasks/<id>/status/<status> with one of the project statuses in the path.';
const PATH_TYPE_USAGE = 'Use POST /tasks/<id>/type/<type> with a non-blank type in the path.';
const META_USAGE = 'Send a JSON body { "key": string, "value": string }.';
const META_KEY_USAGE =
	'Use /tasks/<id>/meta/<key> with a non-blank key in the path (a key holding "/" or "%": /tasks/<id>/meta-keys/<base64url key>).';
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

/** A text field that may be absent or empty (a form sends an empty description); anything but a string is a 400. */
function optionalText(source: Record<string, unknown>, field: string, usage: string): string | undefined {
	const value = source[field];
	if (value === undefined) return undefined;
	if (typeof value !== 'string') {
		throw new RequestError(400, `${field} must be a string when given`, usage);
	}
	return value;
}

/** The value of `PUT /tasks/:id/meta/:key`: the JSON body, else `?value=` (the installed shell sends no body). May be empty. */
function metaValue(req: RouteRequest): string {
	const hasBody = req.body !== undefined && req.body !== null;
	const value = hasBody ? bodyObject(req.body, META_VALUE_USAGE)['value'] : queryValue(req.query, 'value');
	if (typeof value !== 'string') {
		throw new RequestError(400, 'value must be a string (it may be empty)', META_VALUE_USAGE);
	}
	return value;
}

/** A value of the request path (already decoded once by the server); blank is refused like an empty body field. */
function pathValue(req: RouteRequest, name: string, usage: string): string {
	const value = req.params?.[name] ?? '';
	if (value.trim() === '') {
		throw new RequestError(400, `${name} must be a non-empty string`, usage);
	}
	return value;
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
		const title = optionalText(body, 'title', CREATE_USAGE);
		const description = optionalText(body, 'description', CREATE_USAGE);
		// Nothing to make a title of (the form must not create a task with an empty title).
		if ((title ?? '').trim() === '' && (description ?? '').trim() === '') {
			throw new RequestError(400, 'a title or a description is required, and neither may be blank', CREATE_USAGE);
		}
		const input = {
			...(title === undefined ? {} : { title }),
			...(description === undefined ? {} : { description }),
			// A form sends an empty parent when none is chosen.
			parent: body['parent'] === '' ? undefined : optionalString(body, 'parent', CREATE_USAGE),
		};
		const created = await createTask(ctx, input);
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

	const answerStatus = async (req: RouteRequest, status: string): Promise<RouteAnswer> => {
		const result = await setStatus(open(req), { id: taskId(req), status });
		const undelivered = await deliver(result.events);
		const { events: _events, ...answer } = result;
		return { status: 200, body: { ...answer, ...undeliveredFields(undelivered) } };
	};

	route('POST', '/tasks/:id/status', req => {
		const body = bodyObject(req.body, STATUS_USAGE);
		return answerStatus(req, requiredString(body, 'status', STATUS_USAGE));
	});

	// Quick actions (the value is in the path: the installed shell's row action sends no body). Same service call and answer.
	route('POST', '/tasks/:id/status/:status', req => {
		return answerStatus(req, pathValue(req, 'status', PATH_STATUS_USAGE));
	});

	route('POST', '/tasks/:id/type/:type', async req => {
		const type = pathValue(req, 'type', PATH_TYPE_USAGE);
		return answerChange(await setType(open(req), { id: taskId(req), type }));
	});

	route('POST', '/tasks/:id/labels/:label', async req => {
		const label = pathValue(req, 'label', PATH_LABEL_USAGE);
		return answerChange(await addLabel(open(req), { id: taskId(req), label }));
	});

	route('POST', '/tasks/:id/labels', async req => {
		const ctx = open(req);
		const body = bodyObject(req.body, LABEL_USAGE);
		return answerChange(
			await addLabel(ctx, { id: taskId(req), label: requiredString(body, 'label', LABEL_USAGE) })
		);
	});

	route('DELETE', '/tasks/:id/labels/:label', async req => {
		return answerChange(await removeLabel(open(req), { id: taskId(req), label: req.params?.['label'] ?? '' }));
	});

	// Same removal, the label given as its base64url key: a label with "/" or "%" cannot travel in the path (see labelKey.ts).
	route('DELETE', '/tasks/:id/label-keys/:key', async req => {
		const label = labelFromKey(req.params?.['key'] ?? '');
		return answerChange(await removeLabel(open(req), { id: taskId(req), label }));
	});

	route('POST', '/tasks/:id/parent', async req => {
		const ctx = open(req);
		const body = bodyObject(req.body, PARENT_USAGE);
		return answerChange(
			await setParent(ctx, { id: taskId(req), parent: requiredString(body, 'parent', PARENT_USAGE) })
		);
	});

	route('DELETE', '/tasks/:id/parent', async req => {
		return answerChange(await removeParent(open(req), { id: taskId(req) }));
	});

	route('POST', '/tasks/:id/type', async req => {
		const ctx = open(req);
		const body = bodyObject(req.body, TYPE_USAGE);
		// The "None" choice of the type picker posts an empty type: it clears the type (same as DELETE /tasks/:id/type).
		if (body['type'] === '') {
			return answerChange(await unsetType(ctx, { id: taskId(req) }));
		}
		return answerChange(await setType(ctx, { id: taskId(req), type: requiredString(body, 'type', TYPE_USAGE) }));
	});

	route('POST', '/tasks/:id/meta', async req => {
		const ctx = open(req);
		const body = bodyObject(req.body, META_USAGE);
		const key = requiredString(body, 'key', META_USAGE);
		// An empty value is allowed (same as `task set-meta <id> <key> ""`).
		const value = body['value'];
		if (typeof value !== 'string') {
			throw new RequestError(400, 'value must be a string (it may be empty)', META_USAGE);
		}
		return answerChange(await setMeta(ctx, { id: taskId(req), key, value }));
	});

	// A metadata key given in the path. Blank is refused like an empty body field; the key-based twin below carries keys
	// holding "/" or "%".
	const putMeta = async (req: RouteRequest, key: string) =>
		answerChange(await setMeta(open(req), { id: taskId(req), key, value: metaValue(req) }));
	const deleteMeta = async (req: RouteRequest, key: string) =>
		answerChange(await unsetMeta(open(req), { id: taskId(req), key }));

	route('PUT', '/tasks/:id/meta/:key', req => putMeta(req, pathValue(req, 'key', META_KEY_USAGE)));
	route('DELETE', '/tasks/:id/meta/:key', req => deleteMeta(req, pathValue(req, 'key', META_KEY_USAGE)));
	route('PUT', '/tasks/:id/meta-keys/:key', req => putMeta(req, metaKeyFromKey(req.params?.['key'] ?? '')));
	route('DELETE', '/tasks/:id/meta-keys/:key', req => deleteMeta(req, metaKeyFromKey(req.params?.['key'] ?? '')));

	// Clears the type ("none" in the type picker).
	route('DELETE', '/tasks/:id/type', async req => answerChange(await unsetType(open(req), { id: taskId(req) })));

	// Edits the headline and/or the description (one onTaskTextChanged per field that changed).
	route('PATCH', '/tasks/:id', async req => {
		const ctx = open(req);
		const body = bodyObject(req.body, TEXT_USAGE);
		const title = optionalText(body, 'title', TEXT_USAGE);
		const description = optionalText(body, 'description', TEXT_USAGE);
		const result = await setTaskText(ctx, {
			id: taskId(req),
			...(title === undefined ? {} : { title }),
			...(description === undefined ? {} : { description }),
		});
		const undelivered = await deliver(result.events);
		return {
			status: 200,
			body: {
				task: result.task,
				// What the page shows after the edit (the same rules as GET /tasks/:id) and the new length of the activity.
				...taskTextFields(result.task),
				activityCount: (await getTaskActivity(ctx, { id: result.task.id })).rows.length,
				...undeliveredFields(undelivered),
			},
		};
	});

	route('POST', '/tasks/:id/links', async req => {
		const ctx = open(req);
		const result = await linkTasks(ctx, linkInput(req, false));
		const undelivered = await deliver(result.events);
		return { status: 200, body: { task: result.task, ...undeliveredFields(undelivered) } };
	});

	route('DELETE', '/tasks/:id/links', async req => {
		const ctx = open(req);
		const result = await unlinkTasks(ctx, linkInput(req, true));
		const undelivered = await deliver(result.events);
		return { status: 200, body: { task: result.task, ...undeliveredFields(undelivered) } };
	});
}
