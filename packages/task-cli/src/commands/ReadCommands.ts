// Task commands that read: list, show, history, links, children, parents, tree, labels (and `labels sync`, the one that creates labels on a forge).
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
	syncLabels,
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
	return runJson(jsonMode, async () => {
		const detail = await showTask(ctx, { id: taskId, withParent, withChildren });
		// A link to a vanished task is marked in the answer and warned about, never a failure: the task must stay readable.
		const report = await readTaskLinks(ctx, { id: taskId });
		warnDangling(report);
		const full = report.dangling.length > 0 ? { ...detail, dangling: report.dangling } : detail;
		// Computed here, not stored: whether the lease of a claim is over depends on the clock of the reader.
		const leaseUntil = typeof full['leaseUntil'] === 'string' ? Date.parse(full['leaseUntil']) : undefined;
		return leaseUntil === undefined || Number.isNaN(leaseUntil)
			? full
			: { ...full, leaseExpired: leaseUntil <= Date.now() };
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
			const { rows } = await getTaskActivity(ctx, { id });
			return jsonMode ? jsonResult(rows) : { exitCode: 0, output: rows.map(activityLine).join('\n') };
		} catch (error) {
			return failure(jsonMode, error);
		}
	}
	let task: TaskHistory;
	try {
		task = await getTaskHistory(ctx, { id });
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
	return runJson(jsonMode, async () => {
		const report = await readTaskLinks(ctx, { id });
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
export const runFind: ProjectCommand = async (rest, { jsonMode, ctx }) => {
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
		const hits = await searchTasks(ctx, { q: query, limit });
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

const LABELS_SYNC_USAGE = 'Usage: task labels sync [--dry-run] [--json]';

/** `task labels sync`: creates the labels the project's strategy needs in the remote system (never deletes one). */
const runLabelsSync: ProjectCommand = async (rest, { jsonMode, ctx }) => {
	const unknown = rest.find(arg => arg !== '--dry-run');
	if (unknown !== undefined) return errorOutput(jsonMode, `unexpected argument: ${unknown}`, LABELS_SYNC_USAGE);
	try {
		const report = await syncLabels(ctx, { dryRun: rest.includes('--dry-run') });
		if (jsonMode) return jsonResult(report);
		const nameWidth = Math.max(0, ...report.wanted.map(label => label.name.length));
		const verb = (name: string): string =>
			report.created.includes(name) ? (report.dryRun ? 'would create' : 'created') : 'exists';
		const lines = [
			...(report.dryRun ? ['Dry run: nothing was created.'] : []),
			...report.wanted.map(
				label => `  ${verb(label.name).padEnd(12)} ${label.name.padEnd(nameWidth)}  ${label.why}`
			),
			report.created.length === 0
				? 'The labels the configuration needs all exist: nothing to create.'
				: `${report.created.length} label${report.created.length === 1 ? '' : 's'} ${report.dryRun ? 'to create' : 'created'}, ${report.existing.length} already there. No label is ever deleted or changed.`,
			...report.notes,
		];
		return { exitCode: 0, output: lines.join('\n') };
	} catch (error) {
		return failure(jsonMode, error);
	}
};

/** `task labels`: the labels in use with the number of tasks carrying each, most used first. `task labels sync`: see above. */
export const runLabels: ProjectCommand = async (rest, env) => {
	const { jsonMode, ctx } = env;
	if (rest[0] === 'sync') return runLabelsSync(rest.slice(1), env);
	if (rest.length > 0) {
		return errorOutput(
			jsonMode,
			`unexpected argument: ${rest[0]}`,
			'Usage: task labels [--json] | task labels sync [--dry-run] [--json]'
		);
	}
	try {
		const labels = await listLabels(ctx);
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
