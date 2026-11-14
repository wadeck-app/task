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
	tone?: Tone;
	updatedAt?: string;
}

/** One column of the board: a status of the project, in config order. */
export interface BoardColumnData {
	status: string;
	label: string;
	tone?: Tone;
	terminal?: boolean;
	outcome?: 'positive' | 'negative';
	/** Tasks in this status. */
	count: number;
	/** Tasks in this status that the answer leaves out (a cap per column). */
	hiddenCount?: number;
	cards: BoardCardData[];
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
		if (!isObject(column) || typeof column['status'] !== 'string' || column['status'] === '') {
			throw new Error(`columns[${index}] has no "status"`);
		}
		const status = column['status'];
		if (!Array.isArray(column['cards'])) {
			throw new Error(`columns[${index}] (${status}) has no "cards" list`);
		}
		const cards = column['cards'].map((card, cardIndex) => {
			if (!isObject(card) || typeof card['id'] !== 'string' || card['id'] === '') {
				throw new Error(`columns[${index}].cards[${cardIndex}] (${status}) has no "id"`);
			}
			return {
				...card,
				headline: typeof card['headline'] === 'string' ? card['headline'] : card['id'],
			} as BoardCardData;
		});
		return {
			...column,
			status,
			label: typeof column['label'] === 'string' && column['label'] !== '' ? column['label'] : status,
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

/** The board as the user sees it: the server's columns with every pending move applied. */
export function applyMoves(columns: BoardColumnData[], moves: Record<string, PendingMove>): BoardColumnData[] {
	const ids = Object.keys(moves);
	if (ids.length === 0) {
		return columns;
	}
	const known = new Set(columns.map(column => column.status));
	const lifted: Record<string, BoardCardData> = {};
	const without = columns.map(column => {
		const cards = column.cards.filter(card => {
			const move = moves[card.id];
			if (move === undefined || !known.has(move.to) || move.to === column.status) {
				return true;
			}
			lifted[card.id] = card;
			return false;
		});
		const removed = column.cards.length - cards.length;
		return removed === 0 ? column : { ...column, cards, count: column.count - removed };
	});
	return without.map(column => {
		const arriving = ids.filter(id => lifted[id] !== undefined && moves[id]!.to === column.status);
		if (arriving.length === 0) {
			return column;
		}
		return {
			...column,
			cards: [...arriving.map(id => lifted[id]!), ...column.cards],
			count: column.count + arriving.length,
		};
	});
}

/** The status a card is in, or undefined. */
export function statusOfCard(columns: BoardColumnData[], id: string): string | undefined {
	return columns.find(column => column.cards.some(card => card.id === id))?.status;
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
