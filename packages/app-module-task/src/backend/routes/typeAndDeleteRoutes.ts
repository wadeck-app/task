// Routes of the project task types and of the (previewed, confirmed) deletion of tasks.
import { addType, executeDelete, listTypes, planDelete, removeType } from '@wadeck-app/task-service';

import { readAcrossProjects } from '../acrossProjects.js';
import { allTypesBody } from '../allProjectsViews.js';
import { DELETE_USAGE, deleteInput, outcomeBody, planBody } from '../deleteRequest.js';
import { RequestError } from '../errors.js';
import { allProjectsFlag, BLANK_ANSWER, bodyObject, isBlankRequest, requiredString } from '../request.js';
import { typesBody } from '../taskViews.js';
import type { RouteKit } from './routeKit.js';

const TYPE_NAME_USAGE = 'Send a JSON body { "name": string }.';

export function registerTypeRoutes(kit: RouteKit): void {
	const { route, open } = kit;

	route('GET', '/types', req => {
		if (isBlankRequest(req.query)) return BLANK_ANSWER;
		if (allProjectsFlag(req.query, 'the types')) {
			return { status: 200, body: allTypesBody(readAcrossProjects(kit.configDir, ctx => listTypes(ctx))) };
		}
		const ctx = open(req);
		return { status: 200, body: typesBody(ctx.project, listTypes(ctx)) };
	});

	route('POST', '/types', req => {
		const ctx = open(req);
		const body = bodyObject(req.body, TYPE_NAME_USAGE);
		addType(ctx, { name: requiredString(body, 'name', TYPE_NAME_USAGE) });
		// ctx.config is a snapshot: reopen the project to answer the list as saved.
		const saved = open(req);
		return { status: 200, body: typesBody(saved.project, listTypes(saved)) };
	});

	route('DELETE', '/types/:name', req => {
		const ctx = open(req);
		const name = req.params?.['name'] ?? '';
		const configured = listTypes(ctx);
		// removeType is a silent no-op for a type that is not there: a typo must not read as a success.
		if (!configured.includes(name)) {
			throw new RequestError(
				404,
				`type "${name}" is not configured in this project`,
				configured.length === 0
					? 'No type is configured; nothing to remove.'
					: `Configured types: ${configured.join(', ')}.`
			);
		}
		removeType(ctx, { name });
		const saved = open(req);
		return { status: 200, body: typesBody(saved.project, listTypes(saved)) };
	});
}

export function registerDeleteRoutes(kit: RouteKit): void {
	const { route, open } = kit;

	route('POST', '/tasks/delete/plan', req => {
		const ctx = open(req);
		const body = bodyObject(req.body, DELETE_USAGE);
		const plan = planDelete(ctx, deleteInput(body));
		return { status: 200, body: planBody(ctx.project, plan, body) };
	});

	route('POST', '/tasks/delete', req => {
		const ctx = open(req);
		const body = bodyObject(req.body, DELETE_USAGE);
		const plan = planDelete(ctx, deleteInput(body));
		// Deletion is irreversible: only an explicit boolean true goes through; otherwise the preview is the answer.
		if (body['confirm'] !== true) {
			throw new RequestError(
				400,
				'confirm must be true to delete: nothing was deleted',
				'Review "plan", then resend the same body with "confirm": true.',
				{ plan: planBody(ctx.project, plan, body) }
			);
		}
		const { deletedCount } = executeDelete(ctx, plan);
		return { status: 200, body: outcomeBody(ctx.project, plan, deletedCount) };
	});
}
