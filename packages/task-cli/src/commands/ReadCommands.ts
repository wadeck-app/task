// Read-only task commands: list, show, history, links, children, parents, tree.
import {
	createStatusFilter,
	getFullTree,
	getTaskActivity,
	getTaskHistory,
	listAncestors,
	listChildren,
	listForest,
	listLabels,
	listTasks,
	readTaskLinks,
	SEARCH_MAX_LIMIT,
	searchTasks,
	showTask,
} from '@wadeck-app/task-service';
import type { ActivityRow, TaskHistory, TaskLinksReport } from '@wadeck-app/task-service';

import type { ProjectCommand } from '../cli/env.js';
import { runTaskHistoryFollow, runTaskListFollow } from '../cli/follow.js';
import { errorOutput, failure, jsonResult, runJson, taskLine } from '../cli/output.js';

const LIST_USAGE = 'Usage: task list [--all] [--parent <id>] [--tree] [--follow|-f]';
const SHOW_USAGE = 'Usage: task show <id> [--with-parent] [--with-children]';

/** One stderr line per link to a vanished task, with its fix (stdout stays the JSON answer; the exit code stays 0). */
function warnDangling(report: TaskLinksReport): void {
	for (const warning of report.warnings) process.stderr.write(`Warning: ${warning}\n`);
}

export const runList: ProjectCommand = async (rest, { jsonMode, ctx }) => {
	let showAll = false;
	let follow = false;
	let tree = false;
	let parentArg: string | undefined;
	for (let i = 0; i < rest.length; i++) {
		const arg = rest[i]!;
		if (arg === '--all') {
			showAll = true;
		} else if (arg === '--follow' || arg === '-f') {
			follow = true;
		} else if (arg === '--tree') {
			tree = true;
		} else if (arg === '--parent') {
			parentArg = rest[i + 1];
			if (!parentArg) {
				return errorOutput(jsonMode, '--parent requires a task id', LIST_USAGE);
			}
			i++;
		} else if (arg.startsWith('-')) {
			return errorOutput(jsonMode, `unknown flag: ${arg}`, LIST_USAGE);
		}
	}
	if (follow && (tree || parentArg !== undefined)) {
		const conflicting = tree ? '--tree' : '--parent';
		return errorOutput(
			jsonMode,
			`--follow cannot be combined with ${conflicting}`,
			'--follow streams new/changed tasks as flat JSON lines; run the list again without --follow to see the hierarchy.'
		);
	}
	if (follow) {
		await runTaskListFollow(ctx.store, createStatusFilter(ctx.config, showAll));
		return { exitCode: 0, output: '' };
	}
	const input = { showAll, parent: parentArg };
	return runJson(jsonMode, () => (tree ? listForest(ctx, input) : listTasks(ctx, input)));
};

export const runShow: ProjectCommand = (rest, { jsonMode, ctx }) => {
	let id: string | undefined;
	let withParent = false;
	let withChildren = false;
	for (const arg of rest) {
		if (arg === '--with-parent') {
			withParent = true;
		} else if (arg === '--with-children') {
			withChildren = true;
		} else if (arg.startsWith('--')) {
			return errorOutput(jsonMode, `unknown flag: ${arg}`, 'Valid flags: --with-parent, --with-children');
		} else if (id === undefined) {
			id = arg;
		}
	}
	if (!id) {
		return errorOutput(jsonMode, 'missing id', SHOW_USAGE);
	}
	const taskId = id;
	return runJson(jsonMode, () => {
		const detail = showTask(ctx, { id: taskId, withParent, withChildren });
		// A link to a vanished task is marked in the answer and warned about, never a failure: the task must stay readable.
		const report = readTaskLinks(ctx, { id: taskId });
		warnDangling(report);
		return report.dangling.length > 0 ? { ...detail, dangling: report.dangling } : detail;
	});
};

const HISTORY_USAGE = 'Usage: task history <id> [--follow|-f]  |  task history <id> [--all] [--json]';

/** "2026-11-08 14:17  Type changed from bug to feature": the UTC minute, then the sentence. */
function activityLine(row: ActivityRow): string {
	return `${row.at.slice(0, 16).replace('T', ' ')}  ${row.text}`;
}

export const runHistory: ProjectCommand = async (rest, { jsonMode, ctx }) => {
	const id = rest[0];
	if (!id) {
		return errorOutput(jsonMode, 'missing id', HISTORY_USAGE);
	}
	const following = rest.includes('--follow') || rest.includes('-f');
	if (rest.includes('--all')) {
		if (following) {
			return errorOutput(
				jsonMode,
				'--all cannot be combined with --follow',
				'Follow the status changes with: task history <id> --follow, or print the whole activity once with: task history <id> --all'
			);
		}
		try {
			const { rows } = getTaskActivity(ctx, { id });
			return jsonMode ? jsonResult(rows) : { exitCode: 0, output: rows.map(activityLine).join('\n') };
		} catch (error) {
			return failure(jsonMode, error);
		}
	}
	let task: TaskHistory;
	try {
		task = getTaskHistory(ctx, { id });
	} catch (error) {
		return failure(jsonMode, error);
	}
	if (following) {
		await runTaskHistoryFollow(ctx.store, task.id, task.history);
		return { exitCode: 0, output: '' };
	}
	return jsonResult(task.history);
};

export const runLinks: ProjectCommand = (rest, { jsonMode, ctx }) => {
	const id = rest[0];
	if (!id) {
		return errorOutput(jsonMode, 'missing id', 'Usage: task links <id>');
	}
	return runJson(jsonMode, () => {
		const report = readTaskLinks(ctx, { id });
		warnDangling(report);
		// The six relations as before; `dangling` (relation, targetId, fix) only when a link points to a vanished task.
		return report.dangling.length > 0 ? { ...report.links, dangling: report.dangling } : report.links;
	});
};

export const runChildren: ProjectCommand = (rest, { jsonMode, ctx }) => {
	const id = rest[0];
	if (!id) {
		return errorOutput(jsonMode, 'missing id', 'Usage: task children <id> [--recursive]');
	}
	return runJson(jsonMode, () => listChildren(ctx, { id, recursive: rest.includes('--recursive') }));
};

export const runParents: ProjectCommand = (rest, { jsonMode, ctx }) => {
	const id = rest[0];
	if (!id) {
		return errorOutput(jsonMode, 'missing id', 'Usage: task parents <id>');
	}
	return runJson(jsonMode, () => listAncestors(ctx, { id }));
};

export const runTree: ProjectCommand = (rest, { jsonMode, ctx }) => {
	const id = rest[0];
	if (!id) {
		return errorOutput(jsonMode, 'missing id', 'Usage: task tree <id>');
	}
	return runJson(jsonMode, () => getFullTree(ctx, { id }));
};

const FIND_USAGE = 'Usage: task find <query> [--limit N] [--json]';

/** `task find`: tasks whose id starts with, or whose title contains, the query (best match first; reads the index only). */
export const runFind: ProjectCommand = (rest, { jsonMode, ctx }) => {
	const words: string[] = [];
	let limit: number | undefined;
	for (let i = 0; i < rest.length; i++) {
		const arg = rest[i]!;
		if (arg === '--limit') {
			const value = rest[i + 1];
			if (value === undefined) {
				return errorOutput(jsonMode, '--limit requires a number', FIND_USAGE);
			}
			limit = /^\d+$/.test(value) ? Number(value) : NaN;
			if (!(limit >= 1 && limit <= SEARCH_MAX_LIMIT)) {
				return errorOutput(
					jsonMode,
					`--limit must be an integer from 1 to ${SEARCH_MAX_LIMIT}, got "${value}"`,
					FIND_USAGE
				);
			}
			i++;
		} else if (arg.startsWith('--')) {
			return errorOutput(jsonMode, `unknown flag: ${arg}`, FIND_USAGE);
		} else {
			words.push(arg);
		}
	}
	const query = words.join(' ').trim();
	if (query === '') {
		return errorOutput(jsonMode, 'missing query', FIND_USAGE);
	}
	try {
		const hits = searchTasks(ctx, { q: query, limit });
		if (jsonMode) {
			return jsonResult(hits);
		}
		if (hits.length === 0) {
			process.stderr.write(`No task matches "${query}".\n`);
		}
		return {
			exitCode: 0,
			output: hits.map(hit => taskLine({ id: hit.id, title: hit.headline, status: hit.status })).join('\n'),
		};
	} catch (error) {
		return failure(jsonMode, error);
	}
};

/** `task labels`: the labels in use with the number of tasks carrying each, most used first. */
export const runLabels: ProjectCommand = (rest, { jsonMode, ctx }) => {
	if (rest.length > 0) {
		return errorOutput(jsonMode, `unexpected argument: ${rest[0]}`, 'Usage: task labels [--json]');
	}
	try {
		const labels = listLabels(ctx);
		if (jsonMode) {
			return jsonResult(labels);
		}
		if (labels.length === 0) {
			process.stderr.write('No label in use in this project. Add one with: task add-label <id> <label>\n');
		}
		return { exitCode: 0, output: labels.map(({ label, count }) => `  ${count}  ${label}`).join('\n') };
	} catch (error) {
		return failure(jsonMode, error);
	}
};
