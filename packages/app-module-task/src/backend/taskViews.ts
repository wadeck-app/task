// View models of the task pages: what the dsl-views bind to (hrefs, options, flags, form data), built from service results.
//
// CONTRACT OF `GET /tasks/:id` (the task page and ALL its design variants bind to these; `$sources.detail.<field>`).
// Presentation only: every rule shown (what is closed, what blocks, the children count) is computed by task-service.
// A list is never tested for emptiness in the DSL (`[]` is truthy): use the boolean next to it.
//
// Pre-existing: task, parent (null when root or dangling), children (rows), links, labelRows, metaRows, statusOptions,
//   typeOptions, hasTypes, noTypes, hasLabels, labelOptions, linkTypeOptions, hrefs, taskHrefs.{detail,history,childrenList},
//   projectParam, forms.*, canDetach, warnings, warningText, project, projectText.
//
// | field                   | type                                   | meaning                                                              | consumer |
// | ----------------------- | -------------------------------------- | -------------------------------------------------------------------- | -------- |
// | projectParam            | string                                 | encoded project id: `params` of the quick actions                    | actions  |
// | createdAt, updatedAt    | ISO string                             | raw dates (RelativeDate)                                             | all      |
// | createdText, updatedText| "2026-10-19 19:37"                     | UTC minute display of the dates                                      | all      |
// | headline                | string                                 | the title as a heading: task-service `headlineOf(title)`, <= 90 chars (an old task whose title is a whole prompt is cut; a new task's title already is a headline) | H1, pickers |
// | body, bodyAddsInfo      | string, boolean                        | the full text (`description`, else the title) and whether it says more than the headline (`bodyAddsInfo`): show the body panel only then | body panel |
// | noBodyInfo              | boolean                                | opposite of `bodyAddsInfo` (the DSL has no negation): the "Add a description" field is shown only then | $if      |
// | checklistRows           | [{id,title,headline,status,tone,terminal,href}] | the children as the rows of task:TaskChecklist | checklist |
// | terminalStatus, reopenStatus | string, string                    | the status a checked sub-task gets (first terminal in config order, '' when the project has none) and the one an unchecked one gets back (the default status) | checklist |
// | deleteImpactText, hasDescendants, deleteCascadeLabel | string, boolean, string | the sentence of the delete dialog ("its 2 children become root tasks, ..."), whether the cascade switch is offered, and its label | delete dialog |
// | forms.delete            | {projectParam,ids,cascade,confirm}     | the body of POST /tasks/delete for this task (the dialog's submit); ids is this task's id | delete dialog |
// | descriptionText, hasDescription | string or null, boolean        | the body when it adds information, else null / false (the old Description panel no longer repeats the title) | Markdown, $if |
// | statusOptions           | [{value,label,tone,terminal}]          | the statuses of the merged config (the one `set-status` validates against), config order | pickers |
// | typeOptions             | [{value,label}]                        | "None" (value '') then the configured types; [] when the project has none (free text) | pickers |
// The detail answer never scans the project's task files: label suggestions come from GET /labels and metadata key
// suggestions from GET /meta-keys, both fetched on demand by the pickers.
// | metaEntries             | [{key,value,keyId}]                    | the metadata with `keyId`, the base64url key of `PUT/DELETE /tasks/:id/meta-keys/:key` (a key may hold "/" or "%") | MetaEditor |
// | deleteImpact            | {childCount,descendantCount,linkCount,blocksCount} | what a deletion touches: direct children (become roots), all descendants (a cascade), links counted both ways (removed), tasks it blocks | delete dialog |
// | pills                   | [{key,label,text,tone,empty}]          | status, type, labels, parent (+ `blocked`, tone danger, only while open blockers exist); text "none" when empty | pill row |
// | pillTexts               | {status,type,labels,parent,blocked?}   | each pill as one text "Label: text" (blocked only while blockers are open): the labelled pills of the bar and flow designs | pill row |
// | statusChoices           | [{value,label,tone,isDefault,isTerminal}] | statuses in config order; tone success (closed), neutral (initial), info (others) | ActionSelect, SegmentedControl |
// | statusTone, isTerminal, isOpen | tone, boolean, boolean          | of the task's current status; isOpen = not terminal (the DSL has no negation) | badges   |
// | typeChoices             | [{value,label}]                        | configured types; [] when the project has none (free text)           | ActionSelect |
// | labelList               | string[]                               | the labels                                                           | LabelChips |
// | labelKeys               | Record<string,string>                  | label -> base64url key, for DELETE /tasks/:id/label-keys/:key         | LabelChips |
// | labelCount, metaCount, linkCount | number                | counts for panel headers (the DSL cannot take a length)             | Panel count |
// | metaList                | [{key,value}]                          | the metadata (same rows as metaRows)                                 | PropertyList |
// | activity, hasActivity, activityCount | [{id,kind,activityKind,icon,title,detail,from,to,tone,at,atText}], boolean, number | oldest first: "created", then one per status change and per recorded change (type, labels, metadata, parent, links, title, description; tasks changed before the log existed show status moves only). `kind` is the Timeline kind (created, status, done = closing, link, note), `activityKind` the real one, `title` a plain sentence, `detail` "From: ..\nTo: .." of a text edit; GET /tasks/:id/activity has the filterable list | Timeline |
// | ancestors, hasAncestors | [{id,title,titleText,status,tone,href}] | root first; empty for a root task or a dangling parent (see warnings) | breadcrumb |
// | parentRow, hasParent    | row or null, boolean                   | the direct parent (last ancestor) as a linkable row                  | sidebars |
// | noParent, noType, hasType, noLabels | boolean          | opposite flags (the DSL has no negation): editors shown only while a property is empty | variants |
// | children (rows)         | + tone, statusTone, isDone             | the existing rows with the tone of their status                      | lists    |
// | childrenSummary         | {total,done,open,value,max,text,hasChildren} | text "2 of 5 done" ('' without children); value/max feed a Progress | progress |
// | hasChildren, hasLinks, hasLabels, hasMeta | boolean              | non-empty flags                                                      | $if      |
// | blockers, blockedText   | [{id,title,status,href}], string or null | OPEN blockers only; "Blocked by N open task(s)" or null             | warnings |
// | taskHrefs.deleteTasks   | href                                   | the delete page of the project                                       | links    |
//
// `GET /tasks/:id/links` adds: hasLinks, noLinks, rows (each + tone, statusTone, isDone), groups [{relation,label,rows}] and groupSections (one Section per group, rendered with ExtensionSlot)
// (relations without a task left out). Quick-action routes (value in the PATH, see taskWriteRoutes.ts): POST
// /tasks/:id/status/:status, /tasks/:id/type/:type, /tasks/:id/labels/:label; a label is removed by key: DELETE /tasks/:id/label-keys/:key
// (labelKeys: label -> base64url key, labelOptions values are keys; a label may hold "/" or "%").
import type { TaskLinks, TaskRecord, TaskSummary, TaskTreeNode } from '@wadeck-app/task-core';
import { ALL_LINK_NAMES, bodyAddsInfo, headlineOf, taskDescription } from '@wadeck-app/task-service';
import type { ActivityRow, BlockerSummary, ChildrenSummary, DanglingLink } from '@wadeck-app/task-service';

import { shortUtcTime } from './display.js';
import { labelKey } from './labelKey.js';
import { metaKey } from './metaKey.js';
import { detailHref, encodedProject, historyHref, pageHrefs, pageLink, projectText, showAllToggle } from './hrefs.js';
import type { OpenedProject } from './projects.js';
import { flattenTree, withRowLinks, withTreeLinks } from './rowViews.js';
import {
	activityEntries,
	ancestorChips,
	blockedText,
	blockerRows,
	checklistRows,
	checklistStatuses,
	childrenSummaryView,
	deleteCascadeLabel,
	deleteImpactText,
	propertyPills,
	relationLabel,
	statusChoices,
	statusOptionRows,
	statusTone,
	typeOptionRows,
	withTones,
} from './taskPresentation.js';

type Project = OpenedProject['project'];

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
		// The delete dialog posts this as is to POST /tasks/delete: the task is never retyped, `confirm` is set by the dialog's own button.
		delete: { ...base, ids: task.id, cascade: false, confirm: true },
		empty: base,
	};
}

/**
 * The text of a task as the page shows it: the headline (<= 90 chars), the body (the description, else the title; a blank
 * stored description is no description) and whether the body says more than the headline. Shared by the detail answer and
 * the answer of PATCH /tasks/:id, so an edit and a reload read the same.
 */
export function taskTextFields(record: Pick<TaskRecord, 'title' | 'description'>): {
	headline: string;
	body: string;
	bodyAddsInfo: boolean;
} {
	const headline = headlineOf(record.title);
	const stored = taskDescription(record);
	const body = stored.trim() === '' ? record.title : stored;
	return { headline, body, bodyAddsInfo: bodyAddsInfo(headline, body) };
}

/** The detail page of a task. `detail` is the service's task detail with `parent` and `children`. */
export function taskDetailBody(
	ctx: OpenedProject,
	data: {
		detail: Record<string, unknown>;
		warnings: string[];
		links: TaskLinks;
		/** Links to a vanished task: counted, and reported in `warnings` by the route. */
		danglingLinks: DanglingLink[];
		types: string[];
		/** Nearest first, as the store lists them (empty for a root task or a dangling parent). */
		ancestors: Array<TaskSummary | undefined>;
		childrenSummary: ChildrenSummary;
		blockers: BlockerSummary;
		/** All tasks below this one (children, grandchildren...). */
		descendantCount: number;
		/** The merged activity of the task, newest first (task-service `getTaskActivity`). */
		activity: ActivityRow[];
	}
): Record<string, unknown> {
	const { project, config } = ctx;
	const { parent, children, ...task } = data.detail;
	const record = task as unknown as TaskRecord;
	const labels = record.labels ?? [];
	const meta = Object.entries(record.meta ?? {}).map(([key, value]) => ({ key, value }));
	const { headline, body, bodyAddsInfo: addsInfo } = taskTextFields(record);
	const description = addsInfo ? body : null;
	const activity = activityEntries(config, data.activity);
	const ancestors = ancestorChips(project, config, data.ancestors);
	const linkCount =
		Object.values(data.links).reduce((sum, tasks) => sum + tasks.length, 0) + data.danglingLinks.length;
	const parentRow =
		ancestors.length === 0 ? null : (ancestors[ancestors.length - 1] as { id: string; titleText: string });
	const pills = propertyPills({ config, record, parent: parentRow, blockerCount: data.blockers.count });
	const childRows = withRowLinks(project, children as TaskSummary[]) as Array<TaskSummary & { href?: string }>;
	const deleteImpact = {
		childCount: (children as unknown[]).length,
		descendantCount: data.descendantCount,
		linkCount,
		blocksCount: data.links.blocks?.length ?? 0,
	};
	return {
		project,
		projectText: projectText(project),
		task,
		headline,
		body,
		bodyAddsInfo: addsInfo,
		noBodyInfo: !addsInfo,
		metaEntries: meta.map(entry => ({ ...entry, keyId: metaKey(entry.key) })),
		deleteImpact,
		deleteImpactText: deleteImpactText(deleteImpact),
		hasDescendants: data.descendantCount > 0,
		deleteCascadeLabel: deleteCascadeLabel(data.descendantCount),
		checklistRows: checklistRows(config, childRows),
		...checklistStatuses(config),
		pills,
		// "Label: text" of each pill, one string per property: a pill of the bar and flow designs reads "Type: none", never anonymous.
		// The parent reads by its title only: the id is in the picker and the pill is a sentence, not a reference.
		pillTexts: Object.fromEntries(
			pills.map(pill => [
				pill.key,
				pill.key === 'parent' && !pill.empty && parentRow !== null
					? `Parent: ${parentRow.titleText}`
					: `${pill.label}: ${pill.text}`,
			])
		),
		createdAt: record.createdAt,
		updatedAt: record.updatedAt,
		createdText: shortUtcTime(record.createdAt),
		updatedText: shortUtcTime(record.updatedAt),
		descriptionText: description,
		hasDescription: description !== null,
		statusChoices: statusChoices(config),
		statusTone: statusTone(config, record.status),
		isTerminal: config.terminalStatuses.includes(record.status),
		isOpen: !config.terminalStatuses.includes(record.status),
		typeChoices: data.types.map(type => ({ value: type, label: type })),
		labelList: labels,
		labelCount: labels.length,
		metaList: meta,
		metaCount: meta.length,
		linkCount,
		hasMeta: meta.length > 0,
		activity,
		hasActivity: activity.length > 0,
		activityCount: activity.length,
		// Comments: the count and a flag (the Comments tab reads them); the thread itself is GET /tasks/:id/comments.
		commentCount: record.comments?.length ?? 0,
		hasComments: (record.comments?.length ?? 0) > 0,
		ancestors,
		hasAncestors: ancestors.length > 0,
		parentRow: ancestors.length === 0 ? null : ancestors[ancestors.length - 1],
		hasParent: ancestors.length > 0,
		noParent: ancestors.length === 0,
		hasType: Boolean(record.type),
		noType: !record.type,
		childrenSummary: childrenSummaryView(data.childrenSummary),
		hasChildren: data.childrenSummary.total > 0,
		hasLinks: linkCount > 0,
		blockers: blockerRows(project, data.blockers.blockers),
		blockedText: blockedText(data.blockers.count),
		// Rows for the tables of the detail page (a table shows lists of objects).
		labelRows: labels.map(label => ({ label })),
		metaRows: meta,
		statusOptions: statusOptionRows(config),
		typeOptions: typeOptionRows(data.types),
		hasTypes: data.types.length > 0,
		noTypes: data.types.length === 0,
		hasLabels: labels.length > 0,
		noLabels: labels.length === 0,
		// The value is the key of the label (DELETE /tasks/:id/label-keys/:key), whatever characters the label holds.
		labelOptions: labels.map(label => ({ value: labelKey(label), label })),
		labelKeys: Object.fromEntries(labels.map(label => [label, labelKey(label)])),
		linkTypeOptions: ALL_LINK_NAMES.map(name => ({ value: name, label: relationLabel(name) })),
		hrefs: pageHrefs(project),
		taskHrefs: {
			detail: detailHref(project, record.id),
			history: historyHref(project, record.id),
			childrenList: pageLink(project, 'tasks', { parent: record.id, showAll: 'true' }),
			deleteTasks: pageHrefs(project)['deleteTasks'],
		},
		projectParam: encodedProject(project),
		forms: detailForms(project, record),
		parent,
		// A dangling parentId resolves to no `parent`, yet the task must stay detachable from the page.
		canDetach: record.parentId !== undefined,
		warnings: data.warnings,
		warningText: data.warnings.length === 0 ? null : data.warnings.join(' '),
		children: withTones(config, childRows),
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
		projectText: projectText(project),
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
