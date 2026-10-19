// Cross-project reads: what every registered project holds, for the callers that show them together.
import * as path from 'node:path';

import type { TaskSummary } from '@wadeck-app/task-core';

import type { TaskServiceContext } from './context.js';
import { NoReadableProjectsError } from './errors.js';
import type { ProjectFailure } from './errors.js';
import { listTasks } from './listTasks.js';
import { inspectProject } from './projectsHealth.js';
import { listRegisteredProjects } from './projectsRegistry.js';
import { countTasksByStatus } from './taskStats.js';
import type { StatusCount } from './taskStats.js';

/** One registered project and what it holds. */
export interface ProjectOverview {
	/** Directory name. */
	name: string;
	path: string;
	/** The directory exists. */
	exists: boolean;
	/** The directory holds a `.task` project. */
	initialized: boolean;
	/** Tasks in a non-terminal status; null when the project cannot be read. */
	open: number | null;
	/** Every task, closed ones included; null when the project cannot be read. */
	total: number | null;
	/** Tasks per status (see {@link countTasksByStatus}); empty when the project cannot be read. */
	byStatus: StatusCount[];
	/** Why the project cannot be read (directory gone, not initialized, config.yml invalid), with the fix when there is one; null when it can. */
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
 * and the registry error when `projects.json` is corrupt.
 */
export function summarizeProjects(configDir: string): ProjectsSummary {
	const projects: ProjectOverview[] = [];
	const merged = new Map<string, StatusCount>();
	let readableCount = 0;
	let open = 0;
	let total = 0;
	for (const dir of listRegisteredProjects(configDir)) {
		const { health, context } = inspectProject(dir);
		const base = {
			name: path.basename(dir),
			path: dir,
			exists: health.exists,
			initialized: health.initialized,
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
	return { projects, readableCount, open, total, byStatus: [...merged.values()] };
}

function failuresOf(projects: readonly ProjectOverview[]): ProjectFailure[] {
	return projects.flatMap(p => (p.error === null ? [] : [{ path: p.path, error: p.error }]));
}

function throwIfNoneReadable(registered: number, readable: number, failures: ProjectFailure[]): void {
	if (registered > 0 && readable === 0) throw new NoReadableProjectsError(failures);
}

/** A task and the project it belongs to. */
export interface ProjectTask extends TaskSummary {
	project: { name: string; path: string };
}

export interface ListTasksAcrossProjectsInput {
	/** Include tasks in a terminal status (hidden by default). */
	showAll?: boolean;
}

export interface TasksAcrossProjects {
	/** Sorted by project name (case-insensitive), then project path, then creation time. */
	tasks: ProjectTask[];
	/** Projects that could be read. */
	readableCount: number;
	/** Projects that could not be read, with why: reported, never dropped. */
	unreadable: Array<{ name: string; path: string; error: string }>;
}

/**
 * The tasks of every registered project, each carrying its project. Nothing registered is an empty answer;
 * projects that cannot be read are reported in `unreadable`. Throws like {@link summarizeProjects} when none can be read.
 */
export function listTasksAcrossProjects(
	configDir: string,
	input: ListTasksAcrossProjectsInput = {}
): TasksAcrossProjects {
	const tasks: ProjectTask[] = [];
	const unreadable: TasksAcrossProjects['unreadable'] = [];
	const registered = listRegisteredProjects(configDir);
	for (const dir of registered) {
		const { health, context } = inspectProject(dir);
		if (context === null) {
			unreadable.push({ name: path.basename(dir), path: dir, error: health.error ?? 'unreadable' });
			continue;
		}
		for (const task of listTasks(context, { showAll: input.showAll })) {
			tasks.push({ ...task, project: context.project });
		}
	}
	throwIfNoneReadable(registered.length, registered.length - unreadable.length, unreadable);
	tasks.sort(
		(a, b) =>
			compareText(a.project.name, b.project.name) ||
			compareText(a.project.path, b.project.path) ||
			compareText(a.createdAt, b.createdAt)
	);
	return { tasks, readableCount: registered.length - unreadable.length, unreadable };
}

function compareText(a: string, b: string): number {
	const [left, right] = [a.toLowerCase(), b.toLowerCase()];
	return left < right ? -1 : left > right ? 1 : 0;
}
