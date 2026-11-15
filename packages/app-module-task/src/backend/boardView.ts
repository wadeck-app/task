// The Kanban board of one project (GET /tasks/board): the columns of the config, the cards of the list, a version that tells
// whether the board changed. Built from ONE read of the list (the index for the local strategy): no task file is read.
import { createHash } from 'node:crypto';

import { listStatuses, listTasks, unmappedStatuses } from '@wadeck-app/task-service';
import type { StatusInfo } from '@wadeck-app/task-service';
import type { TaskSummary } from '@wadeck-app/task-core';

import { shortTitle } from './display.js';
import { detailHref, tasksPageHref } from './hrefs.js';
import type { OpenedProject } from './projects.js';
import { effectivePriority } from './taskFieldViews.js';
import { statusTone } from './taskPresentation.js';

/** The most cards one column shows; the others are counted in `hiddenCount` and listed on the Tasks page. */
export const BOARD_COLUMN_CAP = 100;

/** The ids named by the warning of statuses the config does not list. */
const WARNING_IDS_MAX = 5;

export interface BoardCard {
	id: string;
	headline: string;
	href: string;
	/** The effective priority (the stored one, else the project default). */
	priority: string;
	/** `medium (default)` when it is the project default. */
	priorityText: string;
	/** Absent when nobody holds the task. */
	assignee?: string;
	/** The status of the task: the card sits in the column that lists it, and a drop area of that status moves it here. */
	status: string;
	/** The tone of the status. */
	tone: string;
	createdAt: string;
}

/** One status a column holds. */
export interface BoardColumnStatus {
	name: string;
	tone: string;
	terminal: boolean;
	outcome?: 'positive' | 'negative';
	/** The tasks in this status, the hidden ones included. */
	count: number;
}

/** The key of the implicit column of the statuses no column lists. */
export const UNMAPPED_COLUMN_KEY = '__unmapped__';
const UNMAPPED_COLUMN_NAME = 'Unmapped';

export interface BoardColumn {
	/** Identifies the column: its name, or UNMAPPED_COLUMN_KEY. */
	key: string;
	name: string;
	/** What the header shows (the name). */
	label: string;
	/** True for the column of the statuses no column lists (not stored in the config). */
	implicit?: true;
	/** The tone of the status of a single-status column; neutral for a group. */
	tone: string;
	/** Every status of the column is terminal. */
	terminal: boolean;
	/** A single-status terminal column only. */
	outcome?: 'positive' | 'negative';
	/** The statuses the column holds, in the order of the column: each one is a drop area. */
	statuses: BoardColumnStatus[];
	/** The tasks in this status, the hidden ones included. */
	count: number;
	hiddenCount: number;
	cards: BoardCard[];
}

/** Every task of the project, closed ones too, as the backend lists them: ONE read, summaries with the STORED priority. */
export async function listBoardTasks(ctx: OpenedProject): Promise<TaskSummary[]> {
	// A backend that has to find out where the priority is kept (github) does it now, so the list that follows carries it
	// (the dispatch reads of task-service do the same); absent on local, remote and gitlab.
	await ctx.store.prepare?.({ priority: true });
	return listTasks(ctx, { showAll: true });
}

/**
 * The order of an open column: the highest priority first (the index in the project's `priorities`, one outside the list last),
 * then the older task, then the id. The rule of the `priority-then-oldest` ordering of task-service (not exported by it), applied
 * here to the summaries because the board also needs to know whether the priority is stored or the default.
 */
function priorityThenOldest(ctx: OpenedProject): (a: TaskSummary, b: TaskSummary) => number {
	const rank = (task: TaskSummary): number => {
		const index = ctx.config.priorities.indexOf(effectivePriority(ctx.config, task));
		return index === -1 ? ctx.config.priorities.length : index;
	};
	return (a, b) => rank(a) - rank(b) || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
}

/**
 * A short stable text that changes if and only if what the board shows changes: the id, status, title, priority and assignee
 * of every task (labels, comments and other details are not on a card) and the statuses of the config. The same text whichever
 * backend or process computes it.
 */
export function boardVersion(ctx: OpenedProject, tasks: readonly TaskSummary[]): string {
	const lines = [...tasks]
		.sort((a, b) => a.id.localeCompare(b.id))
		.map(task =>
			JSON.stringify([task.id, task.status, task.title, effectivePriority(ctx.config, task), task.assignee ?? ''])
		);
	// The columns are part of the board: a status added to or removed from the config changes the version too.
	const columns = JSON.stringify([listStatuses(ctx), ctx.config.board ?? null]);
	return createHash('sha256')
		.update([columns, ...lines].join('\n'))
		.digest('hex')
		.slice(0, 16);
}

function cardOf(ctx: OpenedProject, task: TaskSummary): BoardCard {
	const priority = effectivePriority(ctx.config, task);
	return {
		id: task.id,
		headline: shortTitle(task.title),
		href: detailHref(ctx.project, task.id),
		priority,
		priorityText: task.priority === undefined ? `${priority} (default)` : priority,
		...(task.assignee === undefined ? {} : { assignee: task.assignee }),
		status: task.status,
		tone: statusTone(ctx.config, task.status),
		createdAt: task.createdAt,
	};
}

/** A closed column shows the latest first (a long history would otherwise show the oldest hundred); id breaks ties. */
function newestFirst(a: TaskSummary, b: TaskSummary): number {
	return b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id);
}

function unknownStatusWarning(unknown: readonly TaskSummary[]): string | null {
	if (unknown.length === 0) return null;
	const named = unknown
		.slice(0, WARNING_IDS_MAX)
		.map(task => `${task.id} (${task.status})`)
		.join(', ');
	const more = unknown.length > WARNING_IDS_MAX ? ` and ${unknown.length - WARNING_IDS_MAX} more` : '';
	return `${unknown.length} task${unknown.length === 1 ? ' is' : 's are'} in a status that config.yml does not list, so ${unknown.length === 1 ? 'it is' : 'they are'} not on the board: ${named}${more}. Add the status to the project config.yml, or move the task with: task set-status <id> <status>.`;
}

/** What a column is made of before the tasks are put in it. */
interface ColumnSpec {
	key: string;
	name: string;
	statuses: string[];
	implicit?: true;
}

/** The columns of the board: the `board` key of the config (one column per status without it), plus Unmapped when a status is in none. */
function columnSpecs(ctx: OpenedProject, statuses: readonly StatusInfo[]): ColumnSpec[] {
	const board = ctx.config.board;
	if (board === undefined) {
		return statuses.map(status => ({ key: status.name, name: status.name, statuses: [status.name] }));
	}
	const specs: ColumnSpec[] = board.columns.map(column => ({
		key: column.name,
		name: column.name,
		statuses: column.statuses,
	}));
	const unmapped = unmappedStatuses(ctx.config);
	if (unmapped.length > 0) {
		specs.push({ key: UNMAPPED_COLUMN_KEY, name: UNMAPPED_COLUMN_NAME, statuses: unmapped, implicit: true });
	}
	return specs;
}

function buildColumn(
	ctx: OpenedProject,
	spec: ColumnSpec,
	statuses: readonly StatusInfo[],
	tasks: readonly TaskSummary[]
): BoardColumn {
	const infos = spec.statuses
		.map(name => statuses.find(status => status.name === name))
		.filter((info): info is StatusInfo => info !== undefined);
	const byPriority = priorityThenOldest(ctx);
	// The statuses in the order of the column, then each status as before: a closed one newest first, an open one by priority then age.
	const ordered = infos.flatMap(info =>
		tasks.filter(task => task.status === info.name).sort(info.terminal ? newestFirst : byPriority)
	);
	const single = infos.length === 1 ? infos[0] : undefined;
	return {
		key: spec.key,
		name: spec.name,
		label: spec.name,
		...(spec.implicit === true ? { implicit: true as const } : {}),
		tone: single === undefined ? 'neutral' : statusTone(ctx.config, single.name),
		terminal: infos.length > 0 && infos.every(info => info.terminal),
		...(single?.outcome === undefined ? {} : { outcome: single.outcome }),
		statuses: infos.map(info => ({
			name: info.name,
			tone: statusTone(ctx.config, info.name),
			terminal: info.terminal,
			...(info.outcome === undefined ? {} : { outcome: info.outcome }),
			count: tasks.filter(task => task.status === info.name).length,
		})),
		count: ordered.length,
		hiddenCount: Math.max(ordered.length - BOARD_COLUMN_CAP, 0),
		cards: ordered.slice(0, BOARD_COLUMN_CAP).map(task => cardOf(ctx, task)),
	};
}

/** The answer of GET /tasks/board (and of PUT / DELETE /board/config, which answer the board they leave). */
export function boardBody(
	ctx: OpenedProject,
	tasks: readonly TaskSummary[],
	options: { abSwitcher: boolean; projectParam: string }
): Record<string, unknown> {
	const statuses = listStatuses(ctx);
	const known = new Set(statuses.map(status => status.name));
	const columns = columnSpecs(ctx, statuses).map(spec => buildColumn(ctx, spec, statuses, tasks));
	const configured = ctx.config.board;
	return {
		columns,
		// What the "Configure columns" editor starts from: the stored layout, or one column per status.
		config: {
			isDefault: configured === undefined,
			columns: (
				configured?.columns ?? statuses.map(status => ({ name: status.name, statuses: [status.name] }))
			).map(column => ({ name: column.name, statuses: [...column.statuses] })),
		},
		// Every status of the project: the editor offers them.
		allStatuses: statuses.map(status => ({
			name: status.name,
			tone: statusTone(ctx.config, status.name),
			terminal: status.terminal,
			...(status.outcome === undefined ? {} : { outcome: status.outcome }),
		})),
		version: boardVersion(ctx, tasks),
		hasCards: tasks.length > 0,
		emptyText:
			tasks.length === 0 ? 'No task yet. Create the first one with the New task button of the Tasks page.' : null,
		warning: unknownStatusWarning(tasks.filter(task => !known.has(task.status))),
		tasksHref: tasksPageHref(ctx.project),
		projectParam: options.projectParam,
		abSwitcher: options.abSwitcher,
	};
}

/** True when the module process runs with TASK_KANBAN_AB=1 (the dev server): the page then shows the variant switcher. */
export function abSwitcherEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return env['TASK_KANBAN_AB'] === '1';
}
