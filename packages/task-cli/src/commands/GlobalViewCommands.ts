// The cross-project views of the CLI: `task list --all-projects` and `task projects summary`. They need no project:
// parsing and output only, over summarizeProjects / listTasksAcrossProjects (the same reads as the app-module's global view).
import { listTasksAcrossProjects, summarizeProjects } from '@wadeck-app/task-service';
import type { ProjectOverview, ProjectsSummary, TasksAcrossProjects } from '@wadeck-app/task-service';

import { errorOutput, failure, jsonResult } from '../cli/output.js';
import type { CommandResult } from '../cli/output.js';

export const LIST_ALL_PROJECTS_USAGE = 'Usage: task list --all-projects [--all] [--json]';
export const SUMMARY_USAGE = 'Usage: task projects summary [--json]';

const NO_PROJECT_TEXT = '(no project registered -- register one with the project CLI: project add <dir>)';

/** Flags of the per-project `task list` that make no sense across projects, with why. */
const INCOMPATIBLE_FLAGS: ReadonlyMap<string, string> = new Map([
	['--follow', 'a live view across projects is not supported'],
	['-f', 'a live view across projects is not supported'],
	['--tree', 'the hierarchy of one project cannot be drawn across projects'],
	['--parent', 'a task id belongs to one project'],
]);

/** What chose a single project for this run: an explicit choice contradicts `--all-projects`, the ambient `PROJECT_DIR` does not. */
export interface ProjectSelection {
	explicit?: { name: '--project' | '--project-dir' | 'TASK_PROJECT' | 'TASK_PROJECT_DIR'; description: string };
	ignoredProjectDir?: string;
}

/**
 * Reads the project sources: the flags (`--project`, `--project-dir`), then TASK_PROJECT, TASK_PROJECT_DIR and the generic
 * PROJECT_DIR; empty values count as unset.
 */
export function describeProjectSelection(
	projectDirFlag: string | undefined,
	projectRefFlag?: string
): ProjectSelection {
	if (projectRefFlag !== undefined) {
		return { explicit: { name: '--project', description: '--project' } };
	}
	if (projectDirFlag !== undefined) {
		return { explicit: { name: '--project-dir', description: '--project-dir' } };
	}
	if (process.env['TASK_PROJECT']) {
		return { explicit: { name: 'TASK_PROJECT', description: 'the TASK_PROJECT environment variable' } };
	}
	if (process.env['TASK_PROJECT_DIR']) {
		return {
			explicit: { name: 'TASK_PROJECT_DIR', description: 'the TASK_PROJECT_DIR environment variable' },
		};
	}
	const generic = process.env['PROJECT_DIR'];
	return generic ? { ignoredProjectDir: generic } : {};
}

/**
 * Text mode only (the JSON answer carries `registered` and `registryProblem`): the shared registry that could not be read, and
 * the projects found only through the legacy projects.json, with the command that registers each. One line each, on stderr.
 */
function registryNotes(unregisteredPaths: readonly string[], registryProblem: string | undefined): void {
	if (registryProblem !== undefined) {
		process.stderr.write(
			`Warning: the shared project registry was not read, only the legacy projects are listed: ${registryProblem}\n`
		);
	}
	const paths = [...new Set(unregisteredPaths)];
	if (paths.length > 0) {
		const commands = paths.map(dir => `project add "${dir}"`).join('; ');
		process.stderr.write(
			`Deprecated: ${paths.length} listed project(s) are not in the shared project registry (the legacy list is removed in a later version): ${commands}\n`
		);
	}
}

function table(header: string[], rows: string[][]): string {
	const widths = header.map((title, column) => Math.max(title.length, ...rows.map(row => row[column]!.length)));
	const line = (cells: string[]): string =>
		cells
			.map((cell, column) => (column === cells.length - 1 ? cell : cell.padEnd(widths[column]!)))
			.join('  ')
			.trimEnd();
	return [line(header), ...rows.map(line)].join('\n');
}

/**
 * `task list --all-projects [--all]` over every registered project. Text: a Project column, unreadable projects on
 * stderr (the others are still listed); `--json`: the service answer as it is (tasks tagged with their project,
 * `readableCount`, `unreadable`). Exit 1 only when projects are registered and none can be read.
 */
export function runListAllProjects(
	rest: string[],
	jsonMode: boolean,
	configDir: string,
	selection: ProjectSelection = {}
): CommandResult {
	let showAll = false;
	for (const arg of rest) {
		if (arg === '--all-projects') continue;
		if (arg === '--all') {
			showAll = true;
		} else if (INCOMPATIBLE_FLAGS.has(arg)) {
			return errorOutput(
				jsonMode,
				`--all-projects cannot be combined with ${arg}: ${INCOMPATIBLE_FLAGS.get(arg)}`,
				'Run `task list` in one project for that, or drop the flag.'
			);
		} else if (arg.startsWith('-')) {
			return errorOutput(jsonMode, `unknown flag: ${arg}`, LIST_ALL_PROJECTS_USAGE);
		}
	}
	if (selection.explicit !== undefined) {
		const { description, name } = selection.explicit;
		return errorOutput(
			jsonMode,
			`--all-projects cannot be combined with ${description}: one project and all projects contradict`,
			`${name.startsWith('--') ? 'Drop' : 'Unset'} ${name}, or drop --all-projects to list that one project.`
		);
	}
	// Ambient and generic (a parent tool may set it): not a contradiction, but never silent. Stderr in both modes keeps stdout the pure answer.
	if (selection.ignoredProjectDir !== undefined) {
		process.stderr.write(
			`Note: the PROJECT_DIR environment variable (${selection.ignoredProjectDir}) is ignored: --all-projects lists every registered project.\n`
		);
	}
	let answer: TasksAcrossProjects;
	try {
		answer = listTasksAcrossProjects(configDir, { showAll });
	} catch (error) {
		return failure(jsonMode, error);
	}
	if (jsonMode) return jsonResult(answer);

	for (const project of answer.unreadable) {
		process.stderr.write(`Warning: project ${project.path} not listed: ${project.error}\n`);
	}
	registryNotes(
		[
			...answer.tasks.filter(task => task.project.id === undefined).map(task => task.project.path),
			...answer.unreadable.filter(project => !project.registered).map(project => project.path),
		],
		answer.registryProblem
	);
	if (answer.readableCount === 0) {
		return { exitCode: 0, output: NO_PROJECT_TEXT };
	}
	if (answer.tasks.length === 0) {
		return {
			exitCode: 0,
			output: `(no task in the ${answer.readableCount} readable project(s)${showAll ? '' : '; --all also shows the closed ones'})`,
		};
	}
	const rows = answer.tasks.map(task => [task.project.name, task.id, task.status, task.title]);
	return { exitCode: 0, output: table(['PROJECT', 'ID', 'STATUS', 'TITLE'], rows) };
}

function projectLine(project: ProjectOverview): string[] {
	const figures =
		project.error === null ? `${project.open} open / ${project.total} total` : `[unreadable: ${project.error}]`;
	return [project.name, figures, project.path];
}

function summaryText(summary: ProjectsSummary): string {
	if (summary.projects.length === 0) return NO_PROJECT_TEXT;
	const plural = summary.readableCount === 1 ? 'project' : 'projects';
	const unreadable = summary.projects.length - summary.readableCount;
	const lines = [
		`${summary.open} open / ${summary.total} total in ${summary.readableCount} ${plural}${unreadable > 0 ? ` (${unreadable} unreadable, not counted)` : ''}`,
	];
	if (summary.byStatus.length > 0) {
		lines.push(`By status: ${summary.byStatus.map(entry => `${entry.status} ${entry.count}`).join(', ')}`);
	}
	lines.push('', table(['PROJECT', 'TASKS', 'PATH'], summary.projects.map(projectLine)));
	return lines.join('\n');
}

/**
 * `task projects summary`: totals, then one line per registered project (an unreadable one with its reason). Exit 1
 * only when projects are registered and none can be read.
 */
export function runProjectsSummary(rest: string[], jsonMode: boolean, configDir: string): CommandResult {
	if (rest.length > 0) {
		return errorOutput(jsonMode, `unexpected argument: ${rest[0]}`, SUMMARY_USAGE);
	}
	try {
		const summary = summarizeProjects(configDir);
		if (jsonMode) return jsonResult(summary);
		registryNotes(
			summary.projects.filter(project => !project.registered).map(project => project.path),
			summary.registryProblem
		);
		return { exitCode: 0, output: summaryText(summary) };
	} catch (error) {
		return failure(jsonMode, error);
	}
}
