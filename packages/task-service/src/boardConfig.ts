// The `board` key of config.yml: how the Kanban board groups the statuses into columns (decision D18).
//   board:
//     columns:
//       - name: To do
//         statuses: [backlog]
//       - name: Doing
//         statuses: [in-progress, review]
// Scope local (the project's own layer). A status in no column is allowed: the board shows it in an implicit "Unmapped" column.
import { ConfigSchemaError, writeFileAtomic } from '@wadeck-app/project-sdk';
import {
	BOARD_CARD_FIELDS,
	BOARD_CARD_TITLE_LINES,
	BOARD_COLUMN_SORTS,
	BOARD_FINISHED_FOR,
	BOARD_GROUP_STYLES,
	TaskConfigLoader,
} from '@wadeck-app/task-core';
import type {
	BoardCardConfig,
	BoardCardField,
	BoardColumnConfig,
	BoardColumnSort,
	BoardFinishedFor,
	BoardGroupStyle, BoardConfig, TaskResolvedConfig } from '@wadeck-app/task-core';

import { ownConfigFile } from './storage.js';
import type { TaskStorage } from './storage.js';

/** The most characters of a column name. */
export const BOARD_COLUMN_NAME_MAX = 50;

/** A problem in the `board` section: file, dotted key and the fix. A ConfigSchemaError, so every caller already maps it (`invalid`, 400). */
export class BoardConfigError extends ConfigSchemaError {
	constructor(
		file: string,
		path: string,
		problem: string,
		readonly hint: string
	) {
		super(`${file}: ${path}: ${problem}`, { layer: file, key: 'board', path });
		this.name = 'BoardConfigError';
	}
}

const SECTION_HINT =
	'Write board: { columns: [{ name: <text>, statuses: [<status>, ...] }] } in the config.yml named above, or remove the board key for one column per status.';

const isObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

function found(value: unknown): string {
	return Array.isArray(value) ? 'a list' : (JSON.stringify(value) ?? String(value));
}

/**
 * Checks a `board` value and returns its columns. The structure and the uniqueness rules apply to every layer; when `statuses`
 * is given (the own layer, against the statuses of the project) a status that does not exist is an error too.
 */
export function validateBoard(file: string, value: unknown, statuses?: readonly string[]): BoardConfig {
	const fail = (path: string, problem: string, hint = SECTION_HINT): never => {
		throw new BoardConfigError(file, path, problem, hint);
	};
	if (!isObject(value)) {
		return fail('board', `must be a mapping with a "columns" list, found ${found(value)}.`);
	}
	for (const key of Object.keys(value)) {
		if (key !== 'columns' && key !== 'finishedFor' && key !== 'card') {
			fail(`board.${key}`, 'unknown key (only "columns", "finishedFor" and "card" are allowed).');
		}
	}
	const raw = value['columns'];
	if (!Array.isArray(raw)) {
		return fail('board.columns', `must be a list of columns, found ${found(raw)}.`);
	}
	if (raw.length === 0) {
		return fail(
			'board.columns',
			'must list at least one column.',
			'Add a column, or remove the board key for one column per status.'
		);
	}
	const columns: BoardColumnConfig[] = [];
	const nameAt = new Map<string, number>();
	const statusAt = new Map<string, number>();
	raw.forEach((entry: unknown, index) => {
		const at = `board.columns[${index}]`;
		if (!isObject(entry)) {
			return fail(at, `must be a mapping with a name and statuses, found ${found(entry)}.`);
		}
		for (const key of Object.keys(entry)) {
			if (key !== 'name' && key !== 'statuses' && key !== 'sort' && key !== 'groupStyle') {
				fail(
					`${at}.${key}`,
					'unknown key (a column has "name", "statuses" and optionally "sort" and "groupStyle").'
				);
			}
		}
		const name = entry['name'];
		if (typeof name !== 'string' || name.trim() === '') {
			return fail(`${at}.name`, 'must not be empty. Give the column a name.');
		}
		if (name !== name.trim()) {
			return fail(`${at}.name`, `"${name}" has a space at its start or end; write "${name.trim()}".`);
		}
		if (name.length > BOARD_COLUMN_NAME_MAX) {
			return fail(
				`${at}.name`,
				`"${name}" is longer than ${BOARD_COLUMN_NAME_MAX} characters: at most ${BOARD_COLUMN_NAME_MAX} characters.`
			);
		}
		const same = nameAt.get(name.toLowerCase());
		if (same !== undefined) {
			return fail(
				`${at}.name`,
				`"${name}" is already the name of board.columns[${same}]. Column names must be unique.`,
				'Give each column its own name (case does not count): rename one of them.'
			);
		}
		nameAt.set(name.toLowerCase(), index);
		const listed = entry['statuses'];
		if (!Array.isArray(listed) || listed.length === 0) {
			return fail(
				`${at}.statuses`,
				`column "${name}" has no status. List at least one status or delete the column.`,
				'A column shows the tasks of the statuses it lists: write statuses: [<status>, ...], or remove the column.'
			);
		}
		const names: string[] = [];
		listed.forEach((status: unknown, statusIndex) => {
			const statusAt$ = `${at}.statuses[${statusIndex}]`;
			if (typeof status !== 'string' || status === '') {
				return fail(statusAt$, `must be a status name, found ${found(status)}.`);
			}
			const owner = statusAt.get(status);
			if (owner !== undefined) {
				const ownerName = columns[owner]?.name ?? (owner === index ? name : String(owner));
				return fail(
					statusAt$,
					`"${status}" is already in column "${ownerName}" (board.columns[${owner}]). A status belongs to at most one column.`,
					'Remove the status from one of the two columns.'
				);
			}
			if (statuses !== undefined && !statuses.includes(status)) {
				return fail(
					statusAt$,
					`"${status}" is not a status of this project. Valid statuses: ${statuses.join(', ')}.`,
					'Use a name listed under statuses in config.yml, or add the status there first.'
				);
			}
			statusAt.set(status, index);
			names.push(status);
		});
		const sort = entry['sort'];
		if (sort !== undefined && !BOARD_COLUMN_SORTS.includes(sort as BoardColumnSort)) {
			return fail(
				`${at}.sort`,
				`${found(sort)} is not a sort of column "${name}". Valid sorts: ${BOARD_COLUMN_SORTS.join(', ')}.`,
				'Write sort: priority (or another valid sort), or remove the sort key for the usual order.'
			);
		}
		const groupStyle = entry['groupStyle'];
		if (groupStyle !== undefined && !BOARD_GROUP_STYLES.includes(groupStyle as BoardGroupStyle)) {
			return fail(
				`${at}.groupStyle`,
				`${found(groupStyle)} is not a group style of column "${name}". Valid styles: ${BOARD_GROUP_STYLES.join(', ')}.`,
				'The group style is no longer configurable (only the pill is left): remove the groupStyle key.'
			);
		}
		// A legacy groupStyle (D23) was checked above and is NOT kept: only the pill group style exists now (D24).
		columns.push({
			name,
			statuses: names,
			...(sort === undefined ? {} : { sort: sort as BoardColumnSort }),
		});
	});
	const finishedFor = value['finishedFor'];
	if (finishedFor !== undefined && !BOARD_FINISHED_FOR.includes(finishedFor as BoardFinishedFor)) {
		return fail(
			'board.finishedFor',
			`${found(finishedFor)} is not a window. Valid values: ${BOARD_FINISHED_FOR.join(', ')}.`,
			'Write finishedFor: 7d (or another valid value), or remove the key to show every finished task.'
		);
	}
	const card = value['card'] === undefined ? undefined : validateCard(fail, value['card']);
	return {
		columns,
		...(finishedFor === undefined ? {} : { finishedFor: finishedFor as BoardFinishedFor }),
		...(card === undefined ? {} : { card }),
	};
}

const CARD_HINT =
	'Write card: { titleLines: 2, fields: [{ field: priority, style: pill }, { field: assignee }] } (fields: ' +
	Object.keys(BOARD_CARD_FIELDS).join(', ') +
	'), or remove the card key for the usual card.';

/** Checks `board.card`: the shape, the fields (known, once each), their styles, the number of title lines. */
function validateCard(fail: (path: string, problem: string, hint?: string) => never, value: unknown): BoardCardConfig {
	if (!isObject(value)) return fail('board.card', `must be a mapping, found ${found(value)}.`, CARD_HINT);
	for (const key of Object.keys(value)) {
		if (key !== 'titleLines' && key !== 'fields') {
			fail(`board.card.${key}`, 'unknown key (a card has "titleLines" and "fields").', CARD_HINT);
		}
	}
	const card: BoardCardConfig = {};
	const lines = value['titleLines'];
	if (lines !== undefined) {
		if (!BOARD_CARD_TITLE_LINES.includes(lines as 1 | 2 | 3)) {
			fail('board.card.titleLines', `titleLines must be 1, 2 or 3, found ${found(lines)}.`, CARD_HINT);
		}
		card.titleLines = lines as 1 | 2 | 3;
	}
	const fields = value['fields'];
	if (fields !== undefined) {
		if (!Array.isArray(fields)) return fail('board.card.fields', `must be a list, found ${found(fields)}.`, CARD_HINT);
		const seen = new Set<string>();
		card.fields = fields.map((entry: unknown, index) => {
			const at = `board.card.fields[${index}]`;
			if (!isObject(entry)) return fail(at, `must be a mapping with a field, found ${found(entry)}.`, CARD_HINT);
			for (const key of Object.keys(entry)) {
				if (key !== 'field' && key !== 'style') fail(`${at}.${key}`, 'unknown key (a card field has "field" and "style").', CARD_HINT);
			}
			const name = entry['field'];
			if (typeof name !== 'string' || !(name in BOARD_CARD_FIELDS)) {
				return fail(
					`${at}.field`,
					`${found(name)} is not a card field. Valid fields: ${Object.keys(BOARD_CARD_FIELDS).join(', ')}.`,
					CARD_HINT
				);
			}
			if (seen.has(name)) return fail(`${at}.field`, `${found(name)} is already listed. A field is shown once.`, CARD_HINT);
			seen.add(name);
			const style = entry['style'];
			if (style === undefined) return { field: name as BoardCardField };
			const valid: readonly string[] = BOARD_CARD_FIELDS[name as BoardCardField];
			if (valid.length === 0) return fail(`${at}.style`, `${name} has no style: remove the style key.`, CARD_HINT);
			if (typeof style !== 'string' || !valid.includes(style)) {
				return fail(`${at}.style`, `${found(style)} is not a style of ${name}. Valid styles: ${valid.join(', ')}.`, CARD_HINT);
			}
			return { field: name as BoardCardField, style };
		});
	}
	return card;
}

/** Statuses of the project that no column lists (the board shows them in its implicit "Unmapped" column). */
export function unmappedStatuses(config: Pick<TaskResolvedConfig, 'statuses' | 'board'>): string[] {
	const mapped = new Set((config.board?.columns ?? []).flatMap(column => column.statuses));
	return config.statuses.filter(status => !mapped.has(status));
}

interface BoardContext {
	storage: TaskStorage;
	config: Pick<TaskResolvedConfig, 'statuses' | 'board'>;
}

/**
 * Writes the columns to the project's OWN config file (created, with its folder, when missing), atomically, after the same
 * validation a load does: nothing is written for an invalid layout. `ctx.config` is a snapshot: reload to see the change.
 */
export function saveBoardColumns(ctx: BoardContext, columns: unknown, finishedFor?: unknown): BoardConfig {
	const file = ownConfigFile(ctx.storage);
	// The card layout has its own route: saving the columns keeps it.
	const card = ctx.config.board?.card;
	const board = validateBoard(
		file,
		{ columns, ...(finishedFor === undefined ? {} : { finishedFor }), ...(card === undefined ? {} : { card }) },
		ctx.config.statuses
	);
	TaskConfigLoader.updateSection(file, 'board', board, writeFileAtomic, { createDirectory: true });
	return board;
}

/**
 * Writes the card layout of the board (own layer, atomic, validated like a load) and keeps the columns and the window. A project with
 * no `board` key gets the default layout (one column per status) with the card.
 */
export function saveBoardCard(ctx: BoardContext, card: unknown): BoardConfig {
	const file = ownConfigFile(ctx.storage);
	const current = ctx.config.board;
	const columns = current?.columns ?? ctx.config.statuses.map(status => ({ name: status, statuses: [status] }));
	const board = validateBoard(
		file,
		{ columns, ...(current?.finishedFor === undefined ? {} : { finishedFor: current.finishedFor }), card },
		ctx.config.statuses
	);
	TaskConfigLoader.updateSection(file, 'board', board, writeFileAtomic, { createDirectory: true });
	return board;
}

/** Removes the card layout (the usual card again); the columns and the window stay. */
export function clearBoardCard(ctx: BoardContext): void {
	const current = ctx.config.board;
	if (current?.card === undefined) return;
	const { card: _removed, ...rest } = current;
	TaskConfigLoader.updateSection(ownConfigFile(ctx.storage), 'board', rest, writeFileAtomic, { createDirectory: false });
}

/** Removes the `board` key from the own config file (back to one column per status); a file without it is left as it is. */
export function clearBoardColumns(ctx: BoardContext): void {
	TaskConfigLoader.updateSection(ownConfigFile(ctx.storage), 'board', undefined, writeFileAtomic, {
		createDirectory: false,
	});
}
