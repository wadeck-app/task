// Priority, assignee and claim of a task: POST /tasks/:id/{priority,assignee,claim,release}. The rules (the valid priorities, the
// claim and its lease, who may release) are task-core's and task-service's; the routes parse the body and deliver the events.
import {
	claimTask,
	clearTaskAssignee,
	clearTaskPriority,
	releaseTask,
	setTaskAssignee,
	setTaskPriority,
} from '@wadeck-app/task-service';
import type { ClaimTaskInput, TaskChangeResult } from '@wadeck-app/task-service';

import { RequestError } from '../errors.js';
import { bodyObject, requiredString } from '../request.js';
import type { RouteAnswer } from '../request.js';
import { undeliveredFields } from '../undelivered.js';
import { taskId } from './routeKit.js';
import type { RouteKit } from './routeKit.js';

const PRIORITY_USAGE =
	'Send a JSON body { "priority": string } (one of the project priorities; an empty string clears it and the project default applies again).';
const ASSIGNEE_USAGE =
	'Send a JSON body { "assignee": string } (free text, 1 to 100 characters, one line; an empty string clears the assignee and the lease).';
const CLAIM_USAGE =
	'Send a JSON body { "assignee": string, "leaseMinutes"?: whole number 1 to 10080, "renew"?: boolean, "force"?: boolean }: renew extends the lease of the holder, force takes a task whose lease is still live.';
const RELEASE_USAGE =
	'Send a JSON body { "assignee"?: string, "force"?: boolean } (or none): with an assignee, a holder other than it needs force.';

/** A string field that may be empty (an empty value clears the field); anything else, absent included, is a 400. */
function stringField(source: Record<string, unknown>, field: string, usage: string): string {
	const value = source[field];
	if (typeof value !== 'string') {
		throw new RequestError(400, `${field} must be a string (it may be empty)`, usage);
	}
	return value;
}

/** An optional boolean of the body (`true` / `false`); anything else is a 400, a text "true" included (no coercion). */
function optionalBoolean(source: Record<string, unknown>, field: string, usage: string): boolean | undefined {
	const value = source[field];
	if (value === undefined) return undefined;
	if (typeof value !== 'boolean') {
		throw new RequestError(400, `${field} must be true or false when given`, usage);
	}
	return value;
}

/** The lease length: a whole number of minutes, as a number or as digits (a select of a form holds text). The range is the service's. */
function optionalMinutes(source: Record<string, unknown>, usage: string): number | undefined {
	const value = source['leaseMinutes'];
	if (value === undefined || value === '') return undefined;
	if (typeof value === 'number') return value;
	if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
	throw new RequestError(400, `leaseMinutes must be a whole number of minutes, got ${JSON.stringify(value)}`, usage);
}

/** `{ assignee? }` of an optional body (release): no body is the same as an empty object. */
function optionalBody(body: unknown, usage: string): Record<string, unknown> {
	return body === undefined || body === null ? {} : bodyObject(body, usage);
}

export function registerFieldRoutes(kit: RouteKit): void {
	const { route, open, deliver } = kit;

	/** The change as every other route answers it: the task (never with a `revision`) and what the queue did not get. */
	const answerChange = async (result: TaskChangeResult): Promise<RouteAnswer> => {
		const undelivered = await deliver(result.events);
		return { status: 200, body: { task: result.task, ...undeliveredFields(undelivered) } };
	};

	route('POST', '/tasks/:id/priority', async req => {
		const ctx = open(req);
		const priority = stringField(bodyObject(req.body, PRIORITY_USAGE), 'priority', PRIORITY_USAGE);
		// An empty value is the "None" choice of the picker: the project default applies again (same as `task unset-priority`).
		return answerChange(
			priority === ''
				? await clearTaskPriority(ctx, { id: taskId(req) })
				: await setTaskPriority(ctx, { id: taskId(req), priority })
		);
	});

	route('POST', '/tasks/:id/assignee', async req => {
		const ctx = open(req);
		const assignee = stringField(bodyObject(req.body, ASSIGNEE_USAGE), 'assignee', ASSIGNEE_USAGE);
		return answerChange(
			assignee === ''
				? await clearTaskAssignee(ctx, { id: taskId(req) })
				: await setTaskAssignee(ctx, { id: taskId(req), assignee })
		);
	});

	route('POST', '/tasks/:id/claim', async req => {
		const ctx = open(req);
		const body = bodyObject(req.body, CLAIM_USAGE);
		const leaseMinutes = optionalMinutes(body, CLAIM_USAGE);
		const renew = optionalBoolean(body, 'renew', CLAIM_USAGE);
		const force = optionalBoolean(body, 'force', CLAIM_USAGE);
		const input: ClaimTaskInput = {
			id: taskId(req),
			assignee: requiredString(body, 'assignee', CLAIM_USAGE),
			...(leaseMinutes === undefined ? {} : { leaseMinutes }),
			...(renew === undefined ? {} : { renew }),
			...(force === undefined ? {} : { force }),
		};
		const result = await claimTask(ctx, input);
		const undelivered = await deliver(result.events);
		// The answer of `task claim --json` without the `revision`: it is a worker's token for its own later writes, and a page has none.
		const { revision: _revision, ...task } = result.task;
		return {
			status: 200,
			body: {
				taskId: task.id,
				outcome: result.outcome,
				assignee: task.assignee,
				claimedAt: task.claimedAt,
				leaseUntil: result.leaseUntil,
				...(result.previousAssignee === undefined ? {} : { previousAssignee: result.previousAssignee }),
				task,
				...undeliveredFields(undelivered),
			},
		};
	});

	route('POST', '/tasks/:id/release', async req => {
		const ctx = open(req);
		const body = optionalBody(req.body, RELEASE_USAGE);
		const assignee = body['assignee'];
		if (assignee !== undefined && typeof assignee !== 'string') {
			throw new RequestError(400, 'assignee must be a string when given', RELEASE_USAGE);
		}
		const force = optionalBoolean(body, 'force', RELEASE_USAGE);
		const result = await releaseTask(ctx, {
			id: taskId(req),
			// An empty name is "no name given", as a form sends it.
			...(assignee === undefined || assignee === '' ? {} : { assignee }),
			...(force === undefined ? {} : { force }),
		});
		const undelivered = await deliver(result.events);
		return {
			status: 200,
			body: {
				taskId: result.task.id,
				previousAssignee: result.previousAssignee,
				task: result.task,
				...undeliveredFields(undelivered),
			},
		};
	});
}
