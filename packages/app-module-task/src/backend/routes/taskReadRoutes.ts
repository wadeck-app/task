// Read routes of tasks: lists, detail, history, hierarchy, links and trees.
import {
	getFullTree,
	getTaskHistory,
	getTaskLinks,
	listAncestors,
	listChildren,
	listForest,
	listTasks,
	listTasksAcrossProjects,
	listTypes,
	showTask,
	showTaskWithRelations,
} from '@wadeck-app/task-service';

import { readAcrossProjects } from '../acrossProjects.js';
import { allForestBody, allTasksBody } from '../allProjectsViews.js';
import { shortUtcTime } from '../display.js';
import { RequestError } from '../errors.js';
import {
	allProjectsFlag,
	BLANK_ANSWER,
	booleanFlag,
	isBlankRequest,
	optionalQueryValue,
	showAllFlag,
} from '../request.js';
import { withRowLinks, linkRows } from '../rowViews.js';
import { childrenBody, forestBody, taskDetailBody, taskTreeBody, tasksListBody } from '../taskViews.js';
import { taskId } from './routeKit.js';
import type { RouteKit } from './routeKit.js';

export function registerTaskReadRoutes(kit: RouteKit): void {
	const { route, open } = kit;

	route('GET', '/tasks', req => {
		if (isBlankRequest(req.query)) return BLANK_ANSWER;
		const showAll = showAllFlag(req.query);
		if (allProjectsFlag(req.query, 'the tasks')) {
			return { status: 200, body: allTasksBody(listTasksAcrossProjects(kit.configDir, { showAll }), showAll) };
		}
		const ctx = open(req);
		const parent = optionalQueryValue(req.query, 'parent');
		return {
			status: 200,
			body: tasksListBody(ctx.project, {
				showAll,
				parent,
				tasks: listTasks(ctx, { showAll, parent }),
				openTasks: listTasks(ctx, {}),
			}),
		};
	});

	route('GET', '/tasks/:id', req => {
		const ctx = open(req);
		const { detail, warnings } = showTaskWithRelations(ctx, { id: taskId(req) });
		return {
			status: 200,
			body: taskDetailBody(ctx, {
				detail,
				warnings,
				links: getTaskLinks(ctx, { id: taskId(req) }),
				types: listTypes(ctx),
			}),
		};
	});

	route('GET', '/tasks/:id/history', req => {
		const history = getTaskHistory(open(req), { id: taskId(req) });
		const rows = history.history.map(entry => ({ ...entry, time: shortUtcTime(entry.timestamp) }));
		return { status: 200, body: { ...history, rows } };
	});

	route('GET', '/tasks/:id/children', req => {
		const ctx = open(req);
		const recursive = booleanFlag(req.query, 'recursive', 'Use ?recursive=true for the whole subtree.');
		const found = listChildren(ctx, { id: taskId(req), recursive });
		return { status: 200, body: childrenBody(ctx.project, found, recursive) };
	});

	route('GET', '/tasks/:id/ancestors', req => {
		const ctx = open(req);
		const ancestors = listAncestors(ctx, { id: taskId(req) });
		return { status: 200, body: { project: ctx.project, ancestors: withRowLinks(ctx.project, ancestors) } };
	});

	route('GET', '/tasks/:id/links', req => {
		const ctx = open(req);
		const links = getTaskLinks(ctx, { id: taskId(req) });
		// The full id of the resolved task (the request may hold a prefix).
		const resolvedId = showTask(ctx, { id: taskId(req) })['id'];
		return {
			status: 200,
			body: { project: ctx.project, id: resolvedId, links, rows: linkRows(ctx.project, links) },
		};
	});

	route('GET', '/tree', req => {
		if (isBlankRequest(req.query)) return BLANK_ANSWER;
		if (allProjectsFlag(req.query, 'the trees')) {
			// A task id or a parent names one project: it cannot narrow the forest of all of them.
			for (const name of ['id', 'parent']) {
				if (optionalQueryValue(req.query, name) !== undefined) {
					throw new RequestError(
						400,
						`allProjects and ${name} cannot be combined`,
						`A task ${name} belongs to one project: use ?project=<absolute dir>&${name}=<id>.`
					);
				}
			}
			const showAll = showAllFlag(req.query);
			const found = readAcrossProjects(kit.configDir, ctx => listForest(ctx, { showAll }));
			return { status: 200, body: allForestBody(found, showAll) };
		}
		const ctx = open(req);
		const rootOf = optionalQueryValue(req.query, 'id');
		if (rootOf !== undefined) {
			// The single tree containing the task, its node flagged `selected`.
			return { status: 200, body: taskTreeBody(ctx.project, getFullTree(ctx, { id: rootOf })) };
		}
		const showAll = showAllFlag(req.query);
		const parent = optionalQueryValue(req.query, 'parent');
		return {
			status: 200,
			body: forestBody(ctx.project, { showAll, parent, forest: listForest(ctx, { showAll, parent }) }),
		};
	});
}
