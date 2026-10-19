import * as path from 'node:path';

import type { ModuleContext } from '@wadeck-app/app-core-sdk';
import { LINK_TYPES } from '@wadeck-app/task-core';
import type { TaskLinks, TaskRecord, TaskSummary, TaskTreeNode } from '@wadeck-app/task-core';
import {
	addLabel,
	ALL_LINK_NAMES,
	addType,
	createQueueEventSink,
	createTask,
	DanglingParentError,
	deliverEvents,
	executeDelete,
	getFullTree,
	getTaskConfigDir,
	getTaskHistory,
	getTaskLinks,
	linkTasks,
	listAncestors,
	listChildren,
	listForest,
	listTasks,
	listTypes,
	parseDeleteFilter,
	planDelete,
	removeLabel,
	removeParent,
	removeType,
	setMeta,
	setParent,
	setStatus,
	setType,
	showTask,
	unlinkTasks,
} from '@wadeck-app/task-service';
import type {
	DeletePlan,
	DeleteSelector,
	EventSink,
	PlanDeleteInput,
	TaskEvent,
	TaskServiceContext,
	UndeliveredEvent,
} from '@wadeck-app/task-service';

import { RequestError, toHttpError } from './errors.js';
import { recordServerError } from './serverErrorLog.js';
import { listProjects, openProject, requireRegisteredProjects, sameDir } from './projects.js';

export interface TaskRoutesOptions {
	/** Directory holding projects.json and logs/. Default: {@link getTaskConfigDir}. */
	configDir?: string;
	/** Destination of the events produced by mutating routes. Default: the queue sink, logging under `<configDir>/logs`. */
	eventSink?: EventSink;
	/** Where 5xx failures are reported besides the task log. Default: process.stderr (app-core's own output). */
	writeStderr?: (text: string) => void;
}

interface RouteRequest {
	params?: Record<string, string>;
	query?: Record<string, string | string[] | undefined>;
	body?: unknown;
}

interface RouteAnswer {
	status: number;
	body: unknown;
}

type Reply = { code(status: number): { send(body: unknown): unknown } };

const MODULE_ID = 'task';

/** A query parameter given at most once. */
function queryValue(query: RouteRequest['query'], name: string): string | undefined {
	const value = query?.[name];
	if (Array.isArray(value)) {
		throw new RequestError(400, `${name} must be given once, got ${value.length} values`);
	}
	if (value !== undefined && typeof value !== 'string') {
		throw new RequestError(400, `${name} must be a string`);
	}
	return value;
}

/** A query parameter that may be empty: a cleared filter field sends `?name=`, which means "no filter". */
function optionalQueryValue(query: RouteRequest['query'], name: string): string | undefined {
	const value = queryValue(query, name);
	return value === '' ? undefined : value;
}

/** A boolean query parameter ("true" / "false"; absent or empty is false). */
function booleanFlag(query: RouteRequest['query'], name: string, hint: string): boolean {
	const value = optionalQueryValue(query, name);
	if (value === undefined || value === 'false') return false;
	if (value === 'true') return true;
	throw new RequestError(400, `${name} must be "true" or "false", got "${value}"`, hint);
}

function showAllFlag(query: RouteRequest['query']): boolean {
	return booleanFlag(query, 'showAll', 'Use ?showAll=true to include terminal statuses.');
}

function bodyObject(body: unknown, usage: string): Record<string, unknown> {
	if (body === null || body === undefined || typeof body !== 'object' || Array.isArray(body)) {
		throw new RequestError(400, `expected a JSON object body, got: ${JSON.stringify(body) ?? 'nothing'}`, usage);
	}
	return body as Record<string, unknown>;
}

function requiredString(source: Record<string, unknown>, field: string, usage: string): string {
	const value = source[field];
	if (typeof value !== 'string' || value === '') {
		throw new RequestError(400, `${field} must be a non-empty string`, usage);
	}
	return value;
}

function optionalString(source: Record<string, unknown>, field: string, usage: string): string | undefined {
	const value = source[field];
	if (value === undefined) return undefined;
	if (typeof value !== 'string' || value === '') {
		throw new RequestError(400, `${field} must be a non-empty string when given`, usage);
	}
	return value;
}

const CREATE_USAGE = 'Send a JSON body { "description": string, "parent"?: string (task id or prefix) }.';
const STATUS_USAGE = 'Send a JSON body { "status": string } (one of the project statuses).';
const LABEL_USAGE = 'Send a JSON body { "label": string }.';
const PARENT_USAGE = 'Send a JSON body { "parent": string } (task id or prefix).';
const TYPE_USAGE = 'Send a JSON body { "type": string } (one of the project types, when some are configured).';
const META_USAGE = 'Send a JSON body { "key": string, "value": string }.';
const TYPE_NAME_USAGE = 'Send a JSON body { "name": string }.';
const DELETE_USAGE =
	'Send a JSON body with exactly one selector: { "ids": string[] | "id1,id2" }, { "all": true } or { "filter": "<id|title|status|parentId>=<glob>[,<glob>]" }, plus an optional "cascade": true. POST /tasks/delete also needs "confirm": true.';
const LINK_USAGE =
	'Send { "type": string, "target": string } (type: blockedBy, duplicateOf, causedBy, blocks, duplicates, causes), as a JSON body or, for DELETE, as query parameters.';

/** An event the queue did not receive, as reported in the body of a mutating route. */
interface UndeliveredAnswer {
	event: string;
	taskId: string | undefined;
	reason: string;
	/** Command that replays the event once the cause is fixed. */
	replay: string;
}

function toUndeliveredAnswer(undelivered: UndeliveredEvent): UndeliveredAnswer {
	return {
		event: undelivered.event.name,
		taskId: undelivered.event.payload.taskId,
		reason: undelivered.reason,
		replay: undelivered.replay,
	};
}

/** One display line about the events the queue did not get; null when all were delivered. */
function undeliveredLine(undelivered: readonly UndeliveredAnswer[]): string | null {
	if (undelivered.length === 0) return null;
	const details = undelivered
		.map(entry => `${entry.event} (${entry.reason}), replay with: ${entry.replay}`)
		.join('; ');
	return `The change is saved but ${undelivered.length} queue event(s) were not delivered: ${details}`;
}

function detailHref(project: { path: string }, taskId: string): string {
	return `/modules/${MODULE_ID}/tasks/${taskId}?project=${encodeURIComponent(project.path)}`;
}

/** Hrefs of the module pages, with the project selected (the views link to each other with them). */
function pageHrefs(project: { path: string }): Record<string, string> {
	return {
		tasks: pageLink(project, 'tasks'),
		tree: pageLink(project, 'tree'),
		types: pageLink(project, 'types'),
		newTask: pageLink(project, 'new'),
		deleteTasks: pageLink(project, 'delete'),
		projects: `/modules/${MODULE_ID}/projects`,
	};
}

/**
 * The views build action URLs by text substitution, which does not encode: forms carry the project already encoded
 * (`projectParam`) and the action URL uses `?project={projectParam}`.
 */
function encodedProject(project: { path: string }): string {
	return encodeURIComponent(project.path);
}

/** A link to a module page of the project; `extra` parameters are appended encoded. */
function pageLink(project: { path: string }, name: string, extra: Record<string, string> = {}): string {
	const extraQuery = Object.entries(extra)
		.map(([key, value]) => `&${key}=${encodeURIComponent(value)}`)
		.join('');
	return `/modules/${MODULE_ID}/${name}?project=${encodedProject(project)}${extraQuery}`;
}

/**
 * The query string a view appends to its sources: the encoded project plus the filters of the page URL (the loader
 * cannot append to a URL that already has a "?"). Empty while no project is selected, which makes the view skip the source.
 */
function selectedQuery(projectPath: string | undefined, query: RouteRequest['query']): string {
	if (projectPath === undefined) return '';
	const parts = [`project=${encodeURIComponent(projectPath)}`];
	for (const name of ['showAll', 'parent', 'id']) {
		const value = optionalQueryValue(query, name);
		if (value !== undefined) parts.push(`${name}=${encodeURIComponent(value)}`);
	}
	return parts.join('&');
}

/** The link that flips showAll on a list page while keeping the other filters. */
function showAllToggle(
	project: { path: string },
	page: string,
	showAll: boolean,
	extra: Record<string, string> = {}
): { label: string; href: string } {
	return showAll
		? { label: 'Hide closed tasks', href: pageLink(project, page, extra) }
		: { label: 'Show closed tasks', href: pageLink(project, page, { ...extra, showAll: 'true' }) };
}

function withRowLinks(ctx: TaskServiceContext, tasks: TaskSummary[]): unknown[] {
	return tasks.map(task => ({ ...task, projectPath: ctx.project.path, href: detailHref(ctx.project, task.id) }));
}

/** The nested tree with the detail link on every node. */
function withTreeLinks(ctx: TaskServiceContext, nodes: TaskTreeNode[]): unknown[] {
	return nodes.map(node => ({
		...node,
		href: detailHref(ctx.project, node.id),
		children: withTreeLinks(ctx, node.children),
	}));
}

// Indentation of the flat tree view: em spaces survive HTML whitespace collapsing, unlike plain spaces.
const EM_SPACE = String.fromCodePoint(0x2003);
const BRANCH = String.fromCodePoint(0x2514);

interface TreeRow {
	id: string;
	title: string;
	status: string;
	depth: number;
	/** The title, indented by depth: what a flat table shows as the hierarchy. */
	label: string;
	href: string;
	selected?: true;
}

/**
 * Depth-first rows of a tree. A DataTable shows them with a row click to the detail page; the TreeView component
 * cannot navigate from YAML (its selection is a callback), hence the flat view.
 */
function flattenTree(ctx: TaskServiceContext, nodes: TaskTreeNode[], depth = 0): TreeRow[] {
	return nodes.flatMap(node => [
		{
			id: node.id,
			title: node.title,
			status: node.status,
			depth,
			label: depth === 0 ? node.title : `${EM_SPACE.repeat(depth - 1)}${BRANCH} ${node.title}`,
			href: detailHref(ctx.project, node.id),
			...(node.selected ? { selected: true as const } : {}),
		},
		...flattenTree(ctx, node.children, depth + 1),
	]);
}

interface LinkRow {
	relation: string;
	/** "outgoing": stored on this task; "derived": the inverse of a link stored on the other task. */
	direction: 'outgoing' | 'derived';
	id: string;
	title: string;
	status: string;
	href: string;
}

function linkRows(ctx: TaskServiceContext, links: TaskLinks): LinkRow[] {
	const stored: readonly string[] = LINK_TYPES;
	return Object.entries(links).flatMap(([relation, tasks]) =>
		tasks.map(task => ({
			relation,
			direction: stored.includes(relation) ? ('outgoing' as const) : ('derived' as const),
			id: task.id,
			title: task.title,
			status: task.status,
			href: detailHref(ctx.project, task.id),
		}))
	);
}

/** Initial data of the forms of the detail page: each carries the encoded project (see {@link encodedProject}). */
function detailForms(ctx: TaskServiceContext, task: TaskRecord): Record<string, Record<string, unknown>> {
	const base = { projectParam: encodedProject(ctx.project) };
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

function typesBody(ctx: TaskServiceContext): Record<string, unknown> {
	const types = listTypes(ctx);
	return {
		project: ctx.project,
		hrefs: pageHrefs(ctx.project),
		types,
		rows: types.map(name => ({ name })),
		// The name goes into the URL of the remove action: encoded.
		removeOptions: types.map(name => ({ value: encodeURIComponent(name), label: name })),
		forms: {
			add: { projectParam: encodedProject(ctx.project), name: '' },
			remove: { projectParam: encodedProject(ctx.project), name: '' },
		},
		// No configured type: any string is accepted for a task type.
		restricted: types.length > 0,
	};
}

/** The selector of a delete request: exactly one of ids / all / filter. */
function deleteInput(body: Record<string, unknown>): PlanDeleteInput {
	// A form sends every field: a blank text is "not given".
	const ids = body['ids'] === '' ? undefined : body['ids'];
	const filter = body['filter'] === '' ? undefined : body['filter'];
	const { all, cascade } = body;
	if (all !== undefined && typeof all !== 'boolean') {
		throw new RequestError(400, 'all must be true or false', DELETE_USAGE);
	}
	if (cascade !== undefined && typeof cascade !== 'boolean') {
		throw new RequestError(400, 'cascade must be true or false', DELETE_USAGE);
	}
	if (filter !== undefined && (typeof filter !== 'string' || filter === '')) {
		throw new RequestError(400, 'filter must be a non-empty "field=glob" string', DELETE_USAGE);
	}
	const given = [ids !== undefined, all === true, filter !== undefined].filter(Boolean).length;
	if (given !== 1) {
		throw new RequestError(
			400,
			given === 0 ? 'no selector given: nothing to delete' : 'give exactly one selector (ids, all or filter)',
			DELETE_USAGE
		);
	}
	let selector: DeleteSelector;
	if (all === true) {
		selector = { kind: 'all' };
	} else if (typeof filter === 'string') {
		selector = parseDeleteFilter(filter);
	} else {
		const list = typeof ids === 'string' ? ids.split(',') : ids;
		if (!Array.isArray(list) || list.some(entry => typeof entry !== 'string')) {
			throw new RequestError(400, 'ids must be an array of strings or a comma-separated string', DELETE_USAGE);
		}
		const cleaned = (list as string[]).filter(entry => entry.length > 0);
		if (cleaned.length === 0) {
			throw new RequestError(400, 'ids is empty: nothing to delete', DELETE_USAGE);
		}
		selector = { kind: 'ids', ids: cleaned };
	}
	return { selector, cascade: cascade === true };
}

/** Sentences about the side effects, shared by the preview ("would") and the outcome ("did") of a delete. */
function deleteNotes(plan: DeletePlan, tense: 'would' | 'did'): string[] {
	const notes: string[] = [];
	if (plan.orphanCount > 0) {
		notes.push(
			tense === 'would'
				? `${plan.orphanCount} child task(s) would become root tasks (their parent is deleted).`
				: `${plan.orphanCount} child task(s) became root tasks (their parent was deleted).`
		);
	}
	if (plan.danglingLinkCount > 0) {
		notes.push(
			tense === 'would'
				? `${plan.danglingLinkCount} link(s) pointing to deleted tasks would be removed.`
				: `${plan.danglingLinkCount} link(s) pointing to deleted tasks were removed.`
		);
	}
	if (plan.notFound.length > 0) {
		notes.push(`Not found: ${plan.notFound.join(', ')}.`);
	}
	return notes;
}

/** The selector actually given in a delete request (blank form fields dropped). */
function givenSelector(request: Record<string, unknown>): Record<string, unknown> {
	const given: Record<string, unknown> = {};
	if (request['all'] === true) given['all'] = true;
	for (const key of ['ids', 'filter']) {
		if (request[key] !== undefined && request[key] !== '') given[key] = request[key];
	}
	return given;
}

/** The answer of a delete preview; `request` is the body it was asked with. */
function planBody(
	ctx: TaskServiceContext,
	plan: DeletePlan,
	request: Record<string, unknown>
): Record<string, unknown> {
	const count = plan.tasks.length;
	const headline = count === 0 ? 'Nothing to delete.' : `Would delete ${count} task(s).`;
	return {
		canConfirm: count > 0,
		// The body that confirms exactly this preview: the confirm form of the page submits it as is.
		confirmRequest:
			count === 0
				? null
				: {
						projectParam: encodedProject(ctx.project),
						...givenSelector(request),
						cascade: request['cascade'] === true,
						confirm: true,
					},
		project: ctx.project,
		count,
		tasks: withRowLinks(ctx, plan.tasks),
		notFound: plan.notFound,
		orphanCount: plan.orphanCount,
		danglingLinkCount: plan.danglingLinkCount,
		summary: [headline, ...deleteNotes(plan, 'would')].join(' '),
	};
}

interface StatusCount {
	status: string;
	count: number;
	terminal: boolean;
}

function countByStatus(ctx: TaskServiceContext): StatusCount[] {
	const counts = new Map<string, StatusCount>(
		ctx.config.statuses.map(status => [
			status,
			{ status, count: 0, terminal: ctx.config.terminalStatuses.includes(status) },
		])
	);
	for (const task of ctx.store.list()) {
		// A status removed from config.yml still has tasks: show it rather than losing them from the total.
		const entry = counts.get(task.status) ?? { status: task.status, count: 0, terminal: false };
		entry.count++;
		counts.set(task.status, entry);
	}
	return [...counts.values()];
}

/** One display line for the projects the all-projects summary could not read; null when there is none. */
function skippedWarning(skipped: readonly { path: string; error: string }[]): string | null {
	if (skipped.length === 0) return null;
	const noun = skipped.length === 1 ? 'project' : 'projects';
	const details = skipped.map(entry => `${entry.path} (${entry.error})`).join('; ');
	return `${skipped.length} ${noun} not counted: ${details}. Run \`task init\` in the project directory or check that it still exists.`;
}

/** Registers the task routes (`/api/modules/task/...`) on the module context. */
export function registerTaskRoutes(ctx: ModuleContext, options: TaskRoutesOptions = {}): void {
	const configDir = options.configDir ?? getTaskConfigDir();
	const writeStderr = options.writeStderr ?? ((text: string) => void process.stderr.write(text));
	const eventSink = options.eventSink ?? createQueueEventSink({ getLogDir: () => path.join(configDir, 'logs') });

	/** Runs the route, turning every thrown error into its HTTP answer (see errors.ts). */
	function route(
		method: string,
		subPath: string,
		run: (req: RouteRequest) => RouteAnswer | Promise<RouteAnswer>
	): void {
		ctx.registerRoute(method, subPath, async (req, reply) => {
			const out = reply as unknown as Reply;
			try {
				const answer = await run(req as unknown as RouteRequest);
				return out.code(answer.status).send(answer.body);
			} catch (error) {
				const failure = toHttpError(error);
				// Only unexpected failures: a 4xx is the caller's mistake and is already in its answer.
				if (failure.status >= 500) {
					recordServerError(
						path.join(configDir, 'logs'),
						{ method, route: subPath, status: failure.status, error },
						writeStderr
					);
				}
				return out.code(failure.status).send(failure.body);
			}
		});
	}

	const open = (req: RouteRequest): TaskServiceContext => openProject(configDir, queryValue(req.query, 'project'));
	const id = (req: RouteRequest): string => req.params?.['id'] ?? '';

	/**
	 * Hands the events to the sink. Events the sink could not deliver do not fail the request (the change is applied):
	 * they are returned for the JSON body. A sink that throws is a 500.
	 */
	async function deliver(events: readonly TaskEvent[]): Promise<UndeliveredAnswer[]> {
		try {
			const outcome = await deliverEvents(eventSink, events);
			return outcome.undelivered.map(toUndeliveredAnswer);
		} catch (error) {
			throw new RequestError(
				500,
				`the change was applied but its queue events were not delivered: ${error instanceof Error ? error.message : String(error)}`,
				'The change is saved; only the events are missing. Check that the queue CLI is installed and on PATH (`queue --version`).'
			);
		}
	}

	route('GET', '/projects', req => {
		const projects = listProjects(configDir);
		const requested = optionalQueryValue(req.query, 'project');
		// The project the page is about: the one asked for (when registered), else the only registered one.
		const selected =
			projects.find(
				entry => requested !== undefined && sameDir(path.resolve(entry.path), path.resolve(requested))
			) ?? (requested === undefined && projects.length === 1 ? projects[0] : undefined);
		const projectParam = selected === undefined ? '' : encodeURIComponent(selected.path);
		const base = { projectParam };
		return {
			status: 200,
			body: {
				projects,
				multiple: projects.length > 1,
				// Several projects and none chosen: the views ask for a choice instead of showing nothing.
				needsSelection: projects.length > 1 && selected === undefined,
				selectedParam: projectParam,
				selectedQuery: selectedQuery(selected === undefined ? undefined : selected.path, req.query),
				projectOptions: projects.map(entry => ({ value: encodeURIComponent(entry.path), label: entry.name })),
				forms: {
					create: { ...base, description: '', parent: '' },
					delete: { ...base, ids: '', filter: '', all: false, cascade: false },
				},
			},
		};
	});

	route('GET', '/summary', req => {
		const requested = queryValue(req.query, 'project');
		const dirs = requested === undefined ? requireRegisteredProjects(configDir) : [requested];
		const merged = new Map<string, StatusCount>();
		const skipped: { path: string; error: string }[] = [];
		let projectCount = 0;
		let open = 0;
		let total = 0;
		for (const dir of dirs) {
			let project: TaskServiceContext;
			try {
				project = openProject(configDir, dir);
			} catch (error) {
				// Naming a project explicitly must fail loudly; in the all-projects view one broken project is reported, not hidden.
				if (requested !== undefined) throw error;
				skipped.push({ path: dir, error: String(toHttpError(error).body['error']) });
				continue;
			}
			projectCount++;
			for (const entry of countByStatus(project)) {
				const sum = merged.get(entry.status) ?? { ...entry, count: 0 };
				sum.count += entry.count;
				merged.set(entry.status, sum);
				total += entry.count;
				if (!entry.terminal) open += entry.count;
			}
		}
		// Zeros from a registry whose every project failed would read as "no tasks": answer the failure instead.
		if (projectCount === 0 && skipped.length > 0) {
			throw new RequestError(
				500,
				`none of the ${skipped.length} registered projects could be read: ${skipped.map(s => `${s.path} (${s.error})`).join('; ')}`,
				'Run `task init` in each project directory to recreate its .task directory, or fix the cause above.',
				{ skipped }
			);
		}
		return {
			status: 200,
			body: {
				scope: requested === undefined ? 'all' : 'project',
				projectCount,
				open,
				total,
				byStatus: [...merged.values()],
				skipped,
				skippedCount: skipped.length,
				warning: skippedWarning(skipped),
			},
		};
	});

	route('GET', '/tasks', req => {
		const project = open(req);
		const showAll = showAllFlag(req.query);
		const parent = optionalQueryValue(req.query, 'parent');
		const tasks = listTasks(project, { showAll, parent });
		const keepParent: Record<string, string> = parent === undefined ? {} : { parent };
		return {
			status: 200,
			body: {
				project: project.project,
				hrefs: pageHrefs(project.project),
				filters: { showAll, parent: parent ?? null },
				showAllToggle: showAllToggle(project.project, 'tasks', showAll, keepParent),
				parentFilterText: parent === undefined ? null : `Only the direct children of ${parent}.`,
				clearParentHref:
					parent === undefined
						? null
						: pageLink(project.project, 'tasks', showAll ? { showAll: 'true' } : {}),
				// Open tasks, to pick a parent from (the create page).
				parentOptions: listTasks(project, {}).map(task => ({
					value: task.id,
					label: `${task.id} ${task.title}`,
				})),
				tasks: withRowLinks(project, tasks),
			},
		};
	});

	route('GET', '/tasks/:id', req => {
		const project = open(req);
		const warnings: string[] = [];
		let detail: Record<string, unknown>;
		try {
			detail = showTask(project, { id: id(req), withParent: true, withChildren: true });
		} catch (error) {
			if (!(error instanceof DanglingParentError)) throw error;
			// A task must stay reachable to be repaired: show it without its parent and say how to fix it.
			warnings.push(`${error.message}. ${error.hint}`);
			detail = { ...showTask(project, { id: id(req), withChildren: true }), parent: null };
		}
		const { parent, children, ...task } = detail;
		const record = task as unknown as TaskRecord;
		return {
			status: 200,
			body: {
				project: project.project,
				task,
				// Rows for the tables of the detail page (a table shows lists of objects).
				labelRows: (record.labels ?? []).map(label => ({ label })),
				metaRows: Object.entries(record.meta ?? {}).map(([key, value]) => ({ key, value })),
				statusOptions: project.config.statuses.map(status => ({ value: status, label: status })),
				typeOptions: listTypes(project).map(type => ({ value: type, label: type })),
				hasTypes: listTypes(project).length > 0,
				noTypes: listTypes(project).length === 0,
				hasLabels: (record.labels ?? []).length > 0,
				labelOptions: (record.labels ?? []).map(label => ({ value: encodeURIComponent(label), label })),
				linkTypeOptions: ALL_LINK_NAMES.map(name => ({ value: name, label: name })),
				hrefs: pageHrefs(project.project),
				taskHrefs: {
					detail: detailHref(project.project, record.id),
					history: `/modules/${MODULE_ID}/tasks/${record.id}/history?project=${encodedProject(project.project)}`,
					childrenList: pageLink(project.project, 'tasks', { parent: record.id, showAll: 'true' }),
				},
				projectParam: encodedProject(project.project),
				forms: detailForms(project, record),
				parent,
				warnings,
				warningText: warnings.length === 0 ? null : warnings.join(' '),
				children: withRowLinks(project, children as TaskSummary[]),
				links: getTaskLinks(project, { id: id(req) }),
			},
		};
	});

	route('GET', '/tasks/:id/history', req => {
		const project = open(req);
		return { status: 200, body: getTaskHistory(project, { id: id(req) }) };
	});

	route('GET', '/tasks/:id/children', req => {
		const project = open(req);
		const recursive = booleanFlag(req.query, 'recursive', 'Use ?recursive=true for the whole subtree.');
		const found = listChildren(project, { id: id(req), recursive });
		// Both shapes are shown as flat rows; direct children are the depth-0 rows of leaf nodes.
		const nodes: TaskTreeNode[] = recursive
			? (found as TaskTreeNode[])
			: (found as TaskSummary[]).map(child => ({ ...child, children: [] }));
		return {
			status: 200,
			body: {
				project: project.project,
				children: recursive ? withTreeLinks(project, nodes) : withRowLinks(project, found as TaskSummary[]),
				rows: flattenTree(project, nodes),
			},
		};
	});

	route('GET', '/tasks/:id/ancestors', req => {
		const project = open(req);
		const ancestors = listAncestors(project, { id: id(req) });
		return { status: 200, body: { project: project.project, ancestors: withRowLinks(project, ancestors) } };
	});

	route('GET', '/tasks/:id/links', req => {
		const project = open(req);
		const links = getTaskLinks(project, { id: id(req) });
		// The full id of the resolved task (the request may hold a prefix).
		const taskId = showTask(project, { id: id(req) })['id'];
		return {
			status: 200,
			body: { project: project.project, id: taskId, links, rows: linkRows(project, links) },
		};
	});

	route('GET', '/tree', req => {
		const project = open(req);
		const taskId = optionalQueryValue(req.query, 'id');
		if (taskId !== undefined) {
			// The single tree containing the task, its node flagged `selected`.
			const root = getFullTree(project, { id: taskId });
			return {
				status: 200,
				body: {
					project: project.project,
					hrefs: pageHrefs(project.project),
					tree: withTreeLinks(project, [root])[0],
					rows: flattenTree(project, [root]),
				},
			};
		}
		const showAll = showAllFlag(req.query);
		const parent = optionalQueryValue(req.query, 'parent');
		const forest = listForest(project, { showAll, parent });
		return {
			status: 200,
			body: {
				project: project.project,
				hrefs: pageHrefs(project.project),
				showAllToggle: showAllToggle(project.project, 'tree', showAll, parent === undefined ? {} : { parent }),
				tree: withTreeLinks(project, forest),
				rows: flattenTree(project, forest),
			},
		};
	});

	route('GET', '/types', req => ({ status: 200, body: typesBody(open(req)) }));

	route('POST', '/types', req => {
		const project = open(req);
		const body = bodyObject(req.body, TYPE_NAME_USAGE);
		addType(project, { name: requiredString(body, 'name', TYPE_NAME_USAGE) });
		// ctx.config is a snapshot: reopen the project to answer the list as saved.
		return { status: 200, body: typesBody(open(req)) };
	});

	route('DELETE', '/types/:name', req => {
		const project = open(req);
		const name = req.params?.['name'] ?? '';
		const configured = listTypes(project);
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
		removeType(project, { name });
		return { status: 200, body: typesBody(open(req)) };
	});

	route('POST', '/tasks', async req => {
		const project = open(req);
		const body = bodyObject(req.body, CREATE_USAGE);
		const input = {
			description: requiredString(body, 'description', CREATE_USAGE),
			// A form sends an empty parent when none is chosen.
			parent: body['parent'] === '' ? undefined : optionalString(body, 'parent', CREATE_USAGE),
		};
		const created = createTask(project, input);
		const undelivered = await deliver(created.events);
		return {
			status: 201,
			body: {
				task: created.task,
				message: `Created task ${created.task.id}: ${created.task.title}`,
				href: detailHref(project.project, created.task.id),
				undelivered,
				undeliveredText: undeliveredLine(undelivered),
			},
		};
	});

	route('POST', '/tasks/delete/plan', req => {
		const project = open(req);
		const body = bodyObject(req.body, DELETE_USAGE);
		const plan = planDelete(project, deleteInput(body));
		return { status: 200, body: planBody(project, plan, body) };
	});

	route('POST', '/tasks/delete', req => {
		const project = open(req);
		const body = bodyObject(req.body, DELETE_USAGE);
		const plan = planDelete(project, deleteInput(body));
		// Deletion is irreversible: only an explicit boolean true goes through; otherwise the preview is the answer.
		if (body['confirm'] !== true) {
			throw new RequestError(
				400,
				'confirm must be true to delete: nothing was deleted',
				'Review "plan", then resend the same body with "confirm": true.',
				{ plan: planBody(project, plan, body) }
			);
		}
		const { deletedCount } = executeDelete(project, plan);
		return {
			status: 200,
			body: {
				project: project.project,
				deletedCount,
				orphanCount: plan.orphanCount,
				danglingLinkCount: plan.danglingLinkCount,
				notFound: plan.notFound,
				summary: [`Deleted ${deletedCount} task(s).`, ...deleteNotes(plan, 'did')].join(' '),
			},
		};
	});

	route('POST', '/tasks/:id/status', async req => {
		const project = open(req);
		const body = bodyObject(req.body, STATUS_USAGE);
		const result = setStatus(project, { id: id(req), status: requiredString(body, 'status', STATUS_USAGE) });
		const undelivered = await deliver(result.events);
		const { events: _events, ...answer } = result;
		return { status: 200, body: { ...answer, undelivered, undeliveredText: undeliveredLine(undelivered) } };
	});

	route('POST', '/tasks/:id/labels', req => {
		const project = open(req);
		const body = bodyObject(req.body, LABEL_USAGE);
		const task: TaskRecord = addLabel(project, { id: id(req), label: requiredString(body, 'label', LABEL_USAGE) });
		return { status: 200, body: { task } };
	});

	route('DELETE', '/tasks/:id/labels/:label', req => {
		const project = open(req);
		const label = req.params?.['label'] ?? '';
		const task: TaskRecord = removeLabel(project, { id: id(req), label });
		return { status: 200, body: { task } };
	});

	route('POST', '/tasks/:id/parent', req => {
		const project = open(req);
		const body = bodyObject(req.body, PARENT_USAGE);
		const task = setParent(project, { id: id(req), parent: requiredString(body, 'parent', PARENT_USAGE) });
		return { status: 200, body: { task } };
	});

	route('DELETE', '/tasks/:id/parent', req => {
		const project = open(req);
		return { status: 200, body: { task: removeParent(project, { id: id(req) }) } };
	});

	route('POST', '/tasks/:id/type', req => {
		const project = open(req);
		const body = bodyObject(req.body, TYPE_USAGE);
		const task = setType(project, { id: id(req), type: requiredString(body, 'type', TYPE_USAGE) });
		return { status: 200, body: { task } };
	});

	route('POST', '/tasks/:id/meta', req => {
		const project = open(req);
		const body = bodyObject(req.body, META_USAGE);
		const key = requiredString(body, 'key', META_USAGE);
		// An empty value is allowed (same as `task set-meta <id> <key> ""`).
		const value = body['value'];
		if (typeof value !== 'string') {
			throw new RequestError(400, 'value must be a string (it may be empty)', META_USAGE);
		}
		return { status: 200, body: { task: setMeta(project, { id: id(req), key, value }) } };
	});

	/** `type` and `target` of a link request: the JSON body, else (DELETE) the query string. */
	function linkInput(req: RouteRequest, allowQuery: boolean): { id: string; type: string; target: string } {
		const hasBody = req.body !== undefined && req.body !== null;
		const source: Record<string, unknown> =
			hasBody || !allowQuery
				? bodyObject(req.body, LINK_USAGE)
				: { type: queryValue(req.query, 'type'), target: queryValue(req.query, 'target') };
		return {
			id: id(req),
			type: requiredString(source, 'type', LINK_USAGE),
			target: requiredString(source, 'target', LINK_USAGE),
		};
	}

	route('POST', '/tasks/:id/links', async req => {
		const project = open(req);
		const result = linkTasks(project, linkInput(req, false));
		const undelivered = await deliver(result.events);
		return {
			status: 200,
			body: { task: result.task, undelivered, undeliveredText: undeliveredLine(undelivered) },
		};
	});

	route('DELETE', '/tasks/:id/links', async req => {
		const project = open(req);
		const result = unlinkTasks(project, linkInput(req, true));
		const undelivered = await deliver(result.events);
		return {
			status: 200,
			body: { task: result.task, undelivered, undeliveredText: undeliveredLine(undelivered) },
		};
	});
}
