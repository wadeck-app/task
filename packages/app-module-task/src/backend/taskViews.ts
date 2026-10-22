// View models of the task pages: what the dsl-views bind to (hrefs, options, flags, form data), built from service results.
import type { TaskLinks, TaskRecord, TaskSummary, TaskTreeNode } from '@wadeck-app/task-core';
import { ALL_LINK_NAMES } from '@wadeck-app/task-service';
import type { TaskServiceContext } from '@wadeck-app/task-service';

import { detailHref, encodedProject, historyHref, pageHrefs, pageLink, projectText, showAllToggle } from './hrefs.js';
import { flattenTree, withRowLinks, withTreeLinks } from './rowViews.js';

type Project = TaskServiceContext['project'];

/** The tasks page: the filtered list plus the links and options around it. */
export function tasksListBody(
	project: Project,
	data: {
		showAll: boolean;
		parent: string | undefined;
		tasks: TaskSummary[];
		/** Open tasks, to pick a parent from (the create page). */
		openTasks: TaskSummary[];
	}
): Record<string, unknown> {
	const { showAll, parent } = data;
	const keepParent: Record<string, string> = parent === undefined ? {} : { parent };
	return {
		project,
		projectText: projectText(project),
		hrefs: pageHrefs(project),
		filters: { showAll, parent: parent ?? null },
		showAllToggle: showAllToggle(project, 'tasks', showAll, keepParent),
		parentFilterText: parent === undefined ? null : `Only the direct children of ${parent}.`,
		clearParentHref: parent === undefined ? null : pageLink(project, 'tasks', showAll ? { showAll: 'true' } : {}),
		parentOptions: data.openTasks.map(task => ({ value: task.id, label: `${task.id} ${task.title}` })),
		tasks: withRowLinks(project, data.tasks),
	};
}

/** Initial data of the forms of the detail page: each carries the encoded project (see {@link encodedProject}). */
function detailForms(project: Project, task: TaskRecord): Record<string, Record<string, unknown>> {
	const base = { projectParam: encodedProject(project) };
	return {
		status: { ...base, status: task.status },
		type: { ...base, type: task.type ?? '' },
		label: { ...base, label: '' },
		meta: { ...base, key: '', value: '' },
		parent: { ...base, parent: '' },
		link: { ...base, type: 'blockedBy', target: '' },
		empty: base,
	};
}

/** The detail page of a task. `detail` is the service's task detail with `parent` and `children`. */
export function taskDetailBody(
	ctx: TaskServiceContext,
	data: { detail: Record<string, unknown>; warnings: string[]; links: TaskLinks; types: string[] }
): Record<string, unknown> {
	const { project } = ctx;
	const { parent, children, ...task } = data.detail;
	const record = task as unknown as TaskRecord;
	const labels = record.labels ?? [];
	return {
		project,
		projectText: projectText(project),
		task,
		// Rows for the tables of the detail page (a table shows lists of objects).
		labelRows: labels.map(label => ({ label })),
		metaRows: Object.entries(record.meta ?? {}).map(([key, value]) => ({ key, value })),
		statusOptions: ctx.config.statuses.map(status => ({ value: status, label: status })),
		typeOptions: data.types.map(type => ({ value: type, label: type })),
		hasTypes: data.types.length > 0,
		noTypes: data.types.length === 0,
		hasLabels: labels.length > 0,
		labelOptions: labels.map(label => ({ value: encodeURIComponent(label), label })),
		linkTypeOptions: ALL_LINK_NAMES.map(name => ({ value: name, label: name })),
		hrefs: pageHrefs(project),
		taskHrefs: {
			detail: detailHref(project, record.id),
			history: historyHref(project, record.id),
			childrenList: pageLink(project, 'tasks', { parent: record.id, showAll: 'true' }),
		},
		projectParam: encodedProject(project),
		forms: detailForms(project, record),
		parent,
		// A dangling parentId resolves to no `parent`, yet the task must stay detachable from the page.
		canDetach: record.parentId !== undefined,
		warnings: data.warnings,
		warningText: data.warnings.length === 0 ? null : data.warnings.join(' '),
		children: withRowLinks(project, children as TaskSummary[]),
		links: data.links,
	};
}

/** The children of a task: nested for a recursive listing, flat rows in both cases. */
export function childrenBody(
	project: Project,
	found: TaskSummary[] | TaskTreeNode[],
	recursive: boolean
): Record<string, unknown> {
	// Both shapes are shown as flat rows; direct children are the depth-0 rows of leaf nodes.
	const nodes: TaskTreeNode[] = recursive
		? (found as TaskTreeNode[])
		: (found as TaskSummary[]).map(child => ({ ...child, children: [] }));
	return {
		project,
		children: recursive ? withTreeLinks(project, nodes) : withRowLinks(project, found as TaskSummary[]),
		rows: flattenTree(project, nodes),
	};
}

/** The tree page for the whole project (a filtered forest). */
export function forestBody(
	project: Project,
	data: { showAll: boolean; parent: string | undefined; forest: TaskTreeNode[] }
): Record<string, unknown> {
	return {
		project,
		projectText: projectText(project),
		hrefs: pageHrefs(project),
		showAllToggle: showAllToggle(
			project,
			'tree',
			data.showAll,
			data.parent === undefined ? {} : { parent: data.parent }
		),
		tree: withTreeLinks(project, data.forest),
		rows: flattenTree(project, data.forest),
	};
}

/** The tree page for the single tree containing one task (its node flagged `selected`). */
export function taskTreeBody(project: Project, root: TaskTreeNode): Record<string, unknown> {
	return {
		project,
		hrefs: pageHrefs(project),
		tree: withTreeLinks(project, [root])[0],
		rows: flattenTree(project, [root]),
	};
}

/** The types page. */
export function typesBody(project: Project, types: string[]): Record<string, unknown> {
	return {
		project,
		projectText: projectText(project),
		hrefs: pageHrefs(project),
		types,
		rows: types.map(name => ({ name })),
		// The name goes into the URL of the remove action: encoded.
		removeOptions: types.map(name => ({ value: encodeURIComponent(name), label: name })),
		forms: {
			add: { projectParam: encodedProject(project), name: '' },
			remove: { projectParam: encodedProject(project), name: '' },
		},
		// No configured type: any string is accepted for a task type.
		restricted: types.length > 0,
	};
}
