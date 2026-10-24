// Cross-project reads: what every registered project holds, for the callers that show them together.
import type { TaskSummary } from '@wadeck-app/task-core';

import type { TaskServiceContext } from './context.js';
import { NoReadableProjectsError } from './errors.js';
import type { ProjectFailure } from './errors.js';
import { listTasks } from './listTasks.js';
import type { ListKnownProjectsOptions } from './knownProjects.js';
import { inspectKnownProjects } from './projectsHealth.js';
import { countTasksByStatus } from './taskStats.js';
import type { StatusCount } from './taskStats.js';

/** One registered project and what it holds. */
export interface ProjectOverview {
	/** Id in the shared project registry. */
	id: string;
	/** Registry name. */
	name: string;
	path: string;
	/** The directory exists. */
	exists: boolean;
	/** Tasks in a non-terminal status; null when the project cannot be read. */
	open: number | null;
	/** Every task, closed ones included; null when the project cannot be read. */
	total: number | null;
	/** Tasks per status (see {@link countTasksByStatus}); empty when the project cannot be read. */
	byStatus: StatusCount[];
	/** Why the project cannot be read (broken parent chain, data split between the registry and the old folder, config.yml invalid), with the fix when there is one; null when it can. */
	error: string | null;
}

export interface ProjectsSummary {
	/** Every registered project, in registration order, unreadable ones included. */
	projects: ProjectOverview[];
	/** Projects that could be read: the ones the totals count. */
	readableCount: number;
	open: number;
	total: number;
	/** Statuses summed over the readable projects. */
	byStatus: StatusCount[];
	/** Present only when the shared registry could not be read: why. */
	registryProblem?: string;
}

/** The figures of one project's tasks. */
export function summarizeProject(ctx: TaskServiceContext): { open: number; total: number; byStatus: StatusCount[] } {
	const byStatus = countTasksByStatus(ctx);
	return {
		open: byStatus.filter(entry => !entry.terminal).reduce((sum, entry) => sum + entry.count, 0),
		total: byStatus.reduce((sum, entry) => sum + entry.count, 0),
		byStatus,
	};
}

/**
 * What every registered project holds. Nothing registered is an empty summary (the caller says what to do);
 * a project that cannot be read is listed with its reason and left out of the totals, never silently dropped.
 * Throws {@link NoReadableProjectsError} when projects are registered and none can be read (zeros would read as "no tasks"),
 * A registry that cannot be read is not an error here: it is reported in `registryProblem`.
 */
export function summarizeProjects(options: ListKnownProjectsOptions = {}): ProjectsSummary {
	const projects: ProjectOverview[] = [];
	const merged = new Map<string, StatusCount>();
	let readableCount = 0;
	let open = 0;
	let total = 0;
	const inspected = inspectKnownProjects(options);
	for (const { known, health, context } of inspected.entries) {
		const base = {
			id: known.id,
			name: known.name,
			path: known.path,
			exists: health.exists,
		};
		if (context === null) {
			projects.push({ ...base, open: null, total: null, byStatus: [], error: health.error });
			continue;
		}
		const figures = summarizeProject(context);
		projects.push({ ...base, ...figures, error: null });
		readableCount++;
		open += figures.open;
		total += figures.total;
		for (const entry of figures.byStatus) {
			const sum = merged.get(entry.status) ?? { ...entry, count: 0 };
			sum.count += entry.count;
			merged.set(entry.status, sum);
		}
	}
	throwIfNoneReadable(projects.length, readableCount, failuresOf(projects));
	return {
		projects,
		readableCount,
		open,
		total,
		byStatus: [...merged.values()],
		...(inspected.registryProblem === null ? {} : { registryProblem: inspected.registryProblem }),
	};
}

function failuresOf(projects: readonly ProjectOverview[]): ProjectFailure[] {
	return projects.flatMap(p => (p.error === null ? [] : [{ path: p.path, error: p.error }]));
}

function throwIfNoneReadable(registered: number, readable: number, failures: ProjectFailure[]): void {
	if (registered > 0 && readable === 0) throw new NoReadableProjectsError(failures);
}

/** A task and the project it belongs to. */
export interface ProjectTask extends TaskSummary {
	project: { id: string; name: string; path: string };
}

export interface ListTasksAcrossProjectsInput {
	/** Include tasks in a terminal status (hidden by default). */
	showAll?: boolean;
	/** Default `process.env`: XDG_CONFIG_HOME locates the shared project registry, read at call time. */
	env?: NodeJS.ProcessEnv;
}

export interface TasksAcrossProjects {
	/** Sorted by project name (case-insensitive), then project path, then creation time. */
	tasks: ProjectTask[];
	/** Projects that could be read. */
	readableCount: number;
	/** Projects that could not be read, with why: reported, never dropped. */
	unreadable: Array<{ id: string; name: string; path: string; error: string }>;
	/** Present only when the shared registry could not be read: why. */
	registryProblem?: string;
}

/**
 * The tasks of every registered project, each carrying its project. Nothing registered is an empty answer;
 * projects that cannot be read are reported in `unreadable`. Throws like {@link summarizeProjects} when none can be read.
 */
export function listTasksAcrossProjects(input: ListTasksAcrossProjectsInput = {}): TasksAcrossProjects {
	const inspected = inspectKnownProjects({ env: input.env });
	const tasks: ProjectTask[] = [];
	const unreadable: TasksAcrossProjects['unreadable'] = [];
	const registered = inspected.entries;
	for (const { known, health, context } of registered) {
		if (context === null) {
			unreadable.push({
				id: known.id,
				name: known.name,
				path: known.path,
				error: health.error ?? 'unreadable',
			});
			continue;
		}
		for (const task of listTasks(context, { showAll: input.showAll })) {
			tasks.push({ ...task, project: { id: known.id, name: context.project.name, path: known.path } });
		}
	}
	throwIfNoneReadable(registered.length, registered.length - unreadable.length, unreadable);
	tasks.sort(
		(a, b) =>
			compareText(a.project.name, b.project.name) ||
			compareText(a.project.path, b.project.path) ||
			compareText(a.createdAt, b.createdAt)
	);
	return {
		tasks,
		readableCount: registered.length - unreadable.length,
		unreadable,
		...(inspected.registryProblem === null ? {} : { registryProblem: inspected.registryProblem }),
	};
}

function compareText(a: string, b: string): number {
	const [left, right] = [a.toLowerCase(), b.toLowerCase()];
	return left < right ? -1 : left > right ? 1 : 0;
}
