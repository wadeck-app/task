// Read-only task commands: list, show, history, links, children, parents, tree.
import {
	createStatusFilter,
	getFullTree,
	getTaskHistory,
	getTaskLinks,
	listAncestors,
	listChildren,
	listForest,
	listTasks,
	showTask,
} from '@wadeck-app/task-service';
import type { TaskHistory } from '@wadeck-app/task-service';

import type { ProjectCommand } from '../cli/env.js';
import { runTaskHistoryFollow, runTaskListFollow } from '../cli/follow.js';
import { errorOutput, failure, jsonResult, runJson } from '../cli/output.js';

const LIST_USAGE = 'Usage: task list [--all] [--parent <id>] [--tree] [--follow|-f]';
const SHOW_USAGE = 'Usage: task show <id> [--with-parent] [--with-children]';

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
	return runJson(jsonMode, () => showTask(ctx, { id: taskId, withParent, withChildren }));
};

export const runHistory: ProjectCommand = async (rest, { jsonMode, ctx }) => {
	const id = rest[0];
	if (!id) {
		return errorOutput(jsonMode, 'missing id', 'Usage: task history <id> [--follow|-f]');
	}
	let task: TaskHistory;
	try {
		task = getTaskHistory(ctx, { id });
	} catch (error) {
		return failure(jsonMode, error);
	}
	if (rest.includes('--follow') || rest.includes('-f')) {
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
	return runJson(jsonMode, () => getTaskLinks(ctx, { id }));
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
