// GET /related/project/:projectId: the task module's contribution to the detail page of a project of the project module.
import { listTasks } from '@wadeck-app/task-service';

import { shortTitle } from '../display.js';
import { detailHref, tasksPageHref } from '../hrefs.js';
import { openProject } from '../projects.js';
import type { RouteKit } from './routeKit.js';

/** The aggregator waits 2 s per module and shows a short list: the rest is behind `moreUrl`. */
export const RELATED_MAX_ITEMS = 10;
/** The label of an item is one line of a card, not a table cell. */
const RELATED_LABEL_MAX = 60;

export function registerRelatedRoutes(kit: RouteKit): void {
	// Read only (no event). The project is the registry id of the page address; the project module sends nothing else, but
	// the same resolution as every route applies (id prefix, name, alias), and its errors: unknown 404 with the registry
	// message, virtual project 409 (the module addresses projects by folder, its pages answer 409 too), unreadable 4xx.
	kit.route('GET', '/related/project/:projectId', req => {
		const ctx = openProject(req.params?.['projectId']);
		const open = listTasks(ctx, {});
		// `updatedAt` is only in the task file, not in the index: one read per open task. Cheap for the usual hundreds of
		// tasks, and the only way to order by last change.
		const items = open
			.map(task => ({ task, updatedAt: ctx.store.findByPrefix(task.id).updatedAt }))
			.sort(
				(a, b) =>
					b.updatedAt.localeCompare(a.updatedAt) ||
					b.task.createdAt.localeCompare(a.task.createdAt) ||
					a.task.id.localeCompare(b.task.id)
			)
			.slice(0, RELATED_MAX_ITEMS)
			.map(({ task }) => ({
				label: shortTitle(task.title, RELATED_LABEL_MAX),
				subtitle: `${task.id} · ${task.status}`,
				url: detailHref(ctx.project, task.id),
			}));
		return {
			status: 200,
			body: {
				title: 'Tasks',
				count: open.length,
				countLabel: 'open',
				items,
				moreUrl: tasksPageHref(ctx.project),
			},
		};
	});
}
