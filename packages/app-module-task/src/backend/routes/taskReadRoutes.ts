// Read routes of tasks: lists, detail, history, hierarchy, links and trees.
import {
	getFullTree,
	getTaskActivity,
	getTaskHistory,
	readTaskLinks,
	listAncestors,
	listChildren,
	listForest,
	listLabels,
	listTasks,
	searchTasks,
	SEARCH_MAX_LIMIT,
	listTasksAcrossProjects,
	listTypes,
	showTask,
	showTaskWithRelations,
	describeBlockers,
	summarizeChildren,
	summarizeProject,
} from '@wadeck-app/task-service';

import { readAcrossProjects } from '../acrossProjects.js';
import { allForestBody, allTasksBody } from '../allProjectsViews.js';
import { shortUtcTime } from '../display.js';
import { RequestError } from '../errors.js';
import { detailHref } from '../hrefs.js';
import { countDescendants, listMetaKeys } from '../projectVocabulary.js';
import {
	allProjectsFlag,
	BLANK_ANSWER,
	booleanFlag,
	boundedIntegerQuery,
	isBlankRequest,
	optionalQueryValue,
	queryValue,
	showAllFlag,
} from '../request.js';
import { withRowLinks } from '../rowViews.js';
import { activityRowView, linkGroupSections, linkGroups, linkRowViews, statusTone } from '../taskPresentation.js';
import { childrenBody, forestBody, taskDetailBody, taskTreeBody, tasksListBody } from '../taskViews.js';
import { taskId } from './routeKit.js';
import type { RouteKit } from './routeKit.js';

/** The filters of GET /tasks/:id/activity: every row, or the status history only. */
const ACTIVITY_FILTERS = ['all', 'comments', 'history'] as const;

/** `{ name: value }`, or nothing when the value is absent (an optional property under exactOptionalPropertyTypes). */
function optionalField(name: string, value: string | undefined): Record<string, string> {
	return value === undefined ? {} : { [name]: value };
}

export function registerTaskReadRoutes(kit: RouteKit): void {
	const { route, open } = kit;

	route('GET', '/tasks', req => {
		if (isBlankRequest(req.query)) return BLANK_ANSWER;
		const showAll = showAllFlag(req.query);
		if (allProjectsFlag(req.query, 'the tasks')) {
			return { status: 200, body: allTasksBody(listTasksAcrossProjects({ showAll }), showAll) };
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

	// A picker's search (parent, links): the index only, never a task file. Registered before `/tasks/:id`, which would take
	// "search" for an id. `limit` above the maximum is refused (a picker never needs more; no silent clamping).
	route('GET', '/tasks/search', req => {
		const ctx = open(req);
		const limit = boundedIntegerQuery(req.query, 'limit', SEARCH_MAX_LIMIT);
		const exclude = (queryValue(req.query, 'exclude') ?? '')
			.split(',')
			.map(id => id.trim())
			.filter(id => id !== '');
		const hits = searchTasks(ctx, {
			q: queryValue(req.query, 'q') ?? '',
			...(limit === undefined ? {} : { limit }),
			exclude,
			...optionalField('excludeDescendantsOf', optionalQueryValue(req.query, 'excludeDescendantsOf')),
		});
		return {
			status: 200,
			body: hits.map(hit => ({
				id: hit.id,
				headline: hit.headline,
				status: hit.status,
				statusText: hit.status,
				tone: statusTone(ctx.config, hit.status),
				href: detailHref(ctx.project, hit.id),
			})),
		};
	});

	// The labels in use in the project with their count (the suggestions of a label picker).
	route('GET', '/labels', req => ({ status: 200, body: listLabels(open(req)) }));

	// The metadata keys in use in the project (the suggestions of the key field), read when the field is opened.
	route('GET', '/meta-keys', req => ({ status: 200, body: listMetaKeys(open(req)) }));

	route('GET', '/tasks/:id', req => {
		if (isBlankRequest(req.query)) return BLANK_ANSWER;
		const ctx = open(req);
		const { detail, warnings } = showTaskWithRelations(ctx, { id: taskId(req) });
		// The full id of the resolved task (the request may hold a prefix).
		const id = detail['id'] as string;
		// A link to a vanished task is a warning with its fix, not a failure: the task must stay reachable to be repaired.
		const linkReport = readTaskLinks(ctx, { id });
		return {
			status: 200,
			body: taskDetailBody(ctx, {
				detail,
				warnings: [...warnings, ...linkReport.warnings],
				links: linkReport.links,
				danglingLinks: linkReport.dangling,
				types: listTypes(ctx),
				// A dangling parent has no chain to show (its warning says so): the store would list a hole.
				ancestors:
					detail['parent'] === null && detail['parentId'] !== undefined ? [] : listAncestors(ctx, { id }),
				childrenSummary: summarizeChildren(ctx, { id }),
				blockers: describeBlockers(ctx, { id }),
				descendantCount: countDescendants(ctx, id),
				activity: getTaskActivity(ctx, { id }).rows,
			}),
		};
	});

	route('GET', '/tasks/:id/history', req => {
		if (isBlankRequest(req.query)) return BLANK_ANSWER;
		const history = getTaskHistory(open(req), { id: taskId(req) });
		const rows = history.history.map(entry => ({ ...entry, time: shortUtcTime(entry.timestamp) }));
		return { status: 200, body: { ...history, rows } };
	});

	// The whole activity of a task, newest first: status moves and every recorded change. `?filter=history` keeps the status
	// rows (what /history lists); the counts are those of the whole feed. A read: it emits no event.
	route('GET', '/tasks/:id/activity', req => {
		if (isBlankRequest(req.query)) return BLANK_ANSWER;
		const filter = optionalQueryValue(req.query, 'filter') ?? 'all';
		if (!(ACTIVITY_FILTERS as readonly string[]).includes(filter)) {
			throw new RequestError(
				400,
				`filter must be one of: ${ACTIVITY_FILTERS.join(', ')} (got "${filter}")`,
				`Use ?filter=all for every change, ?filter=comments for the comments only or ?filter=history for the status changes only.`
			);
		}
		const { id, rows } = getTaskActivity(open(req), { id: taskId(req) });
		const kept = filter === 'all' ? rows : rows.filter(row => row.source === filter);
		return {
			status: 200,
			body: {
				id,
				filters: ACTIVITY_FILTERS,
				filter,
				counts: {
					all: rows.length,
					comments: rows.filter(row => row.source === 'comments').length,
					history: rows.filter(row => row.source === 'history').length,
				},
				rows: kept.map(activityRowView),
			},
		};
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
		if (isBlankRequest(req.query)) return BLANK_ANSWER;
		const ctx = open(req);
		const { links, dangling, warnings } = readTaskLinks(ctx, { id: taskId(req) });
		// The full id of the resolved task (the request may hold a prefix).
		const resolvedId = showTask(ctx, { id: taskId(req) })['id'] as string;
		const holder = { taskId: resolvedId, dangling };
		// A dangling link counts: the group shows it (missing, removable), so the page must not say "No links".
		const hasLinks = dangling.length > 0 || Object.values(links).some(tasks => tasks.length > 0);
		const groups = linkGroups(ctx.project, ctx.config, links, holder);
		return {
			status: 200,
			body: {
				project: ctx.project,
				id: resolvedId,
				links,
				dangling,
				warnings,
				hasLinks,
				noLinks: !hasLinks,
				rows: linkRowViews(ctx.project, ctx.config, links, holder),
				groups,
				// What the page renders: one Section per group (a view cannot loop; see dslNodes.ts).
				groupSections: linkGroupSections(groups),
			},
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
						`A task ${name} belongs to one project: use ?project=<id|name|alias>&${name}=<task id>.`
					);
				}
			}
			const showAll = showAllFlag(req.query);
			const found = readAcrossProjects(ctx => ({
				forest: listForest(ctx, { showAll }),
				terminalStatuses: ctx.config.terminalStatuses,
				negativeStatuses: ctx.config.negativeStatuses,
				figures: summarizeProject(ctx),
			}));
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
