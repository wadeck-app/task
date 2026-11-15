import type { Tone } from '../tones.js';

/** One card of the board (a row of `GET /tasks/board`). */
export interface BoardCardData {
	id: string;
	headline: string;
	/** An app path; without it the headline is not a link. */
	href?: string;
	/** The EFFECTIVE priority (stored, else the project default). */
	priority?: string;
	/** The priority as displayed; falls back to `priority`. */
	priorityText?: string;
	assignee?: string;
	type?: string;
	labels?: string[];
	/** The status of the task: the one a drop area of that status sets. Filled with the first status of the column when absent. */
	status?: string;
	/** The tone of the status. */
	tone?: Tone;
	updatedAt?: string;
}

/** One status a column holds: it is one drop area while a card is dragged. */
export interface BoardStatusData {
	name: string;
	tone?: Tone;
	terminal?: boolean;
	outcome?: 'positive' | 'negative';
	/** Tasks in this status. */
	count?: number;
}

/** One column of the board: a name and the statuses it holds (one in the default layout, several when the project groups them). */
export interface BoardColumnData {
	/** Identifies the column (its name, or the key of the implicit Unmapped column). */
	key: string;
	/** What the header shows. */
	label: string;
	/** The column of the statuses no configured column lists. */
	implicit?: boolean;
	/** The tone of the status of a one-status column; neutral for a group. */
	tone?: Tone;
	/** Every status of the column is closed. */
	terminal?: boolean;
	outcome?: 'positive' | 'negative';
	/** The statuses of the column, in order. */
	statuses: BoardStatusData[];
	/** Tasks in this column. */
	count: number;
	/** Tasks of this column that the answer leaves out (a cap per column). */
	hiddenCount?: number;
	cards: BoardCardData[];
}

/** What the "Configure columns" editor starts from, and the statuses it can place. */
export interface BoardLayoutData {
	isDefault: boolean;
	columns: Array<{ name: string; statuses: string[] }>;
	allStatuses: BoardStatusData[];
}

export const VARIANTS = ['columns', 'swimlanes', 'compact', 'rails', 'tabs'] as const;
export type KanbanVariant = (typeof VARIANTS)[number];

export const VARIANT_LABELS: Record<KanbanVariant, string> = {
	columns: 'Columns',
	swimlanes: 'Swimlanes',
	compact: 'Compact',
	rails: 'Rails',
	tabs: 'Tabs',
};

export function isVariant(value: unknown): value is KanbanVariant {
	return typeof value === 'string' && (VARIANTS as readonly string[]).includes(value);
}

/** The message for a variant name that does not exist: names the valid ones. */
export function unknownVariantText(value: unknown, where: string): string {
	return `KanbanBoard: ${where} "${String(value)}" is not a known variant. Valid variants: ${VARIANTS.join(', ')}.`;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Checks the `columns` of a board answer and returns them typed. Throws an Error that says which column or card is wrong:
 * a board silently drawn from a broken answer would look like "no tasks".
 */
export function normalizeColumns(raw: unknown): BoardColumnData[] {
	if (!Array.isArray(raw)) {
		throw new Error('the board answer has no "columns" list');
	}
	return raw.map((column, index) => {
		if (!isObject(column) || typeof column['key'] !== 'string' || column['key'] === '') {
			throw new Error(`columns[${index}] has no "key"`);
		}
		const key = column['key'];
		if (!Array.isArray(column['statuses']) || column['statuses'].length === 0) {
			throw new Error(`columns[${index}] (${key}) has no "statuses" list`);
		}
		const statuses = column['statuses'].map((status, statusIndex) => {
			if (!isObject(status) || typeof status['name'] !== 'string' || status['name'] === '') {
				throw new Error(`columns[${index}].statuses[${statusIndex}] (${key}) has no "name"`);
			}
			return { ...status, name: status['name'] } as BoardStatusData;
		});
		if (!Array.isArray(column['cards'])) {
			throw new Error(`columns[${index}] (${key}) has no "cards" list`);
		}
		const cards = column['cards'].map((card, cardIndex) => {
			if (!isObject(card) || typeof card['id'] !== 'string' || card['id'] === '') {
				throw new Error(`columns[${index}].cards[${cardIndex}] (${key}) has no "id"`);
			}
			return {
				...card,
				headline: typeof card['headline'] === 'string' ? card['headline'] : card['id'],
				status:
					typeof card['status'] === 'string' && card['status'] !== '' ? card['status'] : statuses[0]!.name,
			} as BoardCardData;
		});
		return {
			...column,
			key,
			label: typeof column['label'] === 'string' && column['label'] !== '' ? column['label'] : key,
			statuses,
			count: typeof column['count'] === 'number' ? column['count'] : cards.length,
			hiddenCount: typeof column['hiddenCount'] === 'number' ? column['hiddenCount'] : 0,
			cards,
		} as BoardColumnData;
	});
}

/** A move shown before the server confirms it. */
export interface PendingMove {
	to: string;
	/** The action answered: waiting for the refetch to confirm. */
	settled: boolean;
}

/** The column that holds `status`, or undefined. */
export function columnOfStatus(columns: BoardColumnData[], status: string): BoardColumnData | undefined {
	return columns.find(column => column.statuses.some(entry => entry.name === status));
}

/** The board as the user sees it: the server's columns with every pending move applied (the card joins the column of its new status). */
export function applyMoves(columns: BoardColumnData[], moves: Record<string, PendingMove>): BoardColumnData[] {
	const ids = Object.keys(moves);
	if (ids.length === 0) {
		return columns;
	}
	const lifted: Record<string, BoardCardData> = {};
	const without = columns.map(column => {
		const cards = column.cards.filter(card => {
			const move = moves[card.id];
			if (move === undefined || card.status === move.to || columnOfStatus(columns, move.to) === undefined) {
				return true;
			}
			lifted[card.id] = card;
			return false;
		});
		const removed = column.cards.length - cards.length;
		return removed === 0 ? column : { ...column, cards, count: column.count - removed };
	});
	return without.map(column => {
		const arriving = ids.filter(
			id => lifted[id] !== undefined && column.statuses.some(entry => entry.name === moves[id]!.to)
		);
		if (arriving.length === 0) {
			return column;
		}
		// The moved card is shown with its new status (and the tone of that status) in the column that lists it.
		const entries = arriving.map(id => {
			const target = column.statuses.find(entry => entry.name === moves[id]!.to)!;
			return { ...lifted[id]!, status: target.name, ...(target.tone === undefined ? {} : { tone: target.tone }) };
		});
		return { ...column, cards: [...entries, ...column.cards], count: column.count + arriving.length };
	});
}

/** The status a card is in, or undefined. */
export function statusOfCard(columns: BoardColumnData[], id: string): string | undefined {
	for (const column of columns) {
		const card = column.cards.find(entry => entry.id === id);
		if (card !== undefined) {
			return card.status ?? column.statuses[0]?.name;
		}
	}
	return undefined;
}

/** Every status of the board, in column order. */
export function statusesOf(columns: BoardColumnData[]): BoardStatusData[] {
	return columns.flatMap(column => column.statuses);
}

/** Priority names in the usual order; others follow in order of appearance; no priority comes last. */
const KNOWN_PRIORITY_ORDER = ['urgent', 'high', 'medium', 'low'];
export const NO_PRIORITY = 'none';

export interface Lane {
	key: string;
	label: string;
}

/** The priority rows of the swimlanes: only priorities some card has. */
export function lanesOf(columns: BoardColumnData[]): Lane[] {
	const seen = new Map<string, string>();
	let withoutPriority = false;
	for (const column of columns) {
		for (const card of column.cards) {
			if (card.priority === undefined || card.priority === '') {
				withoutPriority = true;
			} else if (!seen.has(card.priority)) {
				seen.set(card.priority, card.priorityText ?? card.priority);
			}
		}
	}
	const keys = [...seen.keys()];
	const rank = (key: string): number => {
		const index = KNOWN_PRIORITY_ORDER.indexOf(key.toLowerCase());
		return index === -1 ? KNOWN_PRIORITY_ORDER.length : index;
	};
	// Stable: equal ranks keep their order of appearance.
	const ordered = keys
		.map((key, order) => ({ key, order }))
		.sort((a, b) => rank(a.key) - rank(b.key) || a.order - b.order)
		.map(entry => ({ key: entry.key, label: seen.get(entry.key)! }));
	return withoutPriority ? [...ordered, { key: NO_PRIORITY, label: 'No priority' }] : ordered;
}

export function laneKeyOf(card: BoardCardData): string {
	return card.priority === undefined || card.priority === '' ? NO_PRIORITY : card.priority;
}

/** Whether nothing is on the board (and nothing is hidden by a cap). */
export function isBoardEmpty(columns: BoardColumnData[]): boolean {
	return columns.every(column => column.cards.length === 0 && (column.hiddenCount ?? 0) === 0 && column.count === 0);
}
