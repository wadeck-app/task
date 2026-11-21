import type { BoardCardData, BoardColumnData } from './boardModel.js';

// The layout of the cards of the board (`board.card` of config.yml): which fields a card shows, in what order and how.

/**
 * The fields a card can show and, for each, the styles it can be drawn in (the first style is the default; none = no choice).
 * DUPLICATE of `BOARD_CARD_FIELDS` in packages/task-core/src/TaskConfigLoader.ts (the server validates against that one): this
 * package is browser code and never imports task-core, and no test can compare the two across packages. Change both together.
 */
export const CARD_FIELDS = {
	id: [],
	priority: ['pill', 'text', 'dot'],
	assignee: ['text', 'initials'],
	status: ['auto', 'pill', 'dot'],
	created: [],
	statusSince: [],
	parent: [],
} as const satisfies Record<string, readonly string[]>;

export type CardField = keyof typeof CARD_FIELDS;
export const CARD_FIELD_NAMES = Object.keys(CARD_FIELDS) as CardField[];
/** The numbers of title lines a card can take (`BOARD_CARD_TITLE_LINES` of task-core). */
export const TITLE_LINES = [1, 2, 3] as const;
export type TitleLines = (typeof TITLE_LINES)[number];

/** What the editor calls each field. */
export const FIELD_LABELS: Record<CardField, string> = {
	id: 'ID',
	priority: 'Priority',
	assignee: 'Assignee',
	status: 'Status',
	created: 'Created',
	statusSince: 'In status since',
	parent: 'Parent',
};

/** What the editor calls each style, by field. */
export const STYLE_LABELS: Record<string, string> = {
	pill: 'Pill',
	text: 'Text',
	dot: 'Dot',
	initials: 'Initials',
	auto: 'Auto',
};

/** One line of help under a field of the editor (only where the field needs one). */
export const FIELD_HINTS: Partial<Record<CardField, string>> = {
	status: 'Auto shows the status only in a column that holds several statuses.',
	parent: 'Shown only on a task that has a parent.',
	statusSince: 'Shown only when the date is known.',
};

/** One field of a card as drawn: `style` is always resolved ('' for a field with no style). */
export interface CardFieldLayout {
	field: CardField;
	style: string;
}

/** The layout of the cards, resolved: every default is filled in. */
export interface CardLayout {
	titleLines: TitleLines;
	fields: CardFieldLayout[];
}

/** The title lines of today's card. */
export const DEFAULT_TITLE_LINES: TitleLines = 2;

/** The style a field is drawn in when none is given. */
export const defaultStyle = (field: CardField): string => CARD_FIELDS[field][0] ?? '';

const isField = (value: unknown): value is CardField =>
	typeof value === 'string' && Object.prototype.hasOwnProperty.call(CARD_FIELDS, value);

const isTitleLines = (value: unknown): value is TitleLines => TITLE_LINES.some(lines => lines === value);

const isObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

const entry = (field: CardField): CardFieldLayout => ({ field, style: defaultStyle(field) });

/** Today's card: id, title, priority, assignee, status (in a column that groups statuses). */
export const DEFAULT_CARD_LAYOUT: CardLayout = {
	titleLines: DEFAULT_TITLE_LINES,
	fields: (['id', 'priority', 'assignee', 'status'] as const).map(entry),
};

/**
 * Reads `config.card` of a board answer. Absent or not an object: undefined (the usual card). Lenient on purpose, since the server
 * validated it: an entry this client does not know (a newer server), a repeated field and an unknown style are dropped or put back
 * to the default, so the board still draws.
 */
export function parseCardLayout(raw: unknown): CardLayout | undefined {
	if (!isObject(raw)) {
		return undefined;
	}
	const titleLines = isTitleLines(raw['titleLines']) ? raw['titleLines'] : DEFAULT_TITLE_LINES;
	if (!Array.isArray(raw['fields'])) {
		return { titleLines, fields: DEFAULT_CARD_LAYOUT.fields };
	}
	const seen = new Set<CardField>();
	const fields: CardFieldLayout[] = [];
	for (const item of raw['fields']) {
		if (!isObject(item) || !isField(item['field']) || seen.has(item['field'])) {
			continue;
		}
		const field = item['field'];
		seen.add(field);
		const styles: readonly string[] = CARD_FIELDS[field];
		const style = typeof item['style'] === 'string' && styles.includes(item['style']) ? item['style'] : defaultStyle(field);
		fields.push({ field, style });
	}
	return { titleLines, fields };
}

/** One row of the editor: a field, whether the card shows it, and its style. */
export interface DraftItem {
	field: CardField;
	shown: boolean;
	style: string;
}

/** What the editor edits: every field (the shown ones first, in card order, then the hidden ones) and the title lines. */
export interface CardDraft {
	titleLines: TitleLines;
	items: DraftItem[];
}

/** The draft of a stored layout (the usual card when there is none). */
export function draftFromLayout(layout: CardLayout | undefined): CardDraft {
	const base = layout ?? DEFAULT_CARD_LAYOUT;
	const shown: DraftItem[] = base.fields.map(item => ({ field: item.field, shown: true, style: item.style }));
	const hidden: DraftItem[] = CARD_FIELD_NAMES.filter(field => !base.fields.some(item => item.field === field)).map(
		field => ({ field, shown: false, style: defaultStyle(field) })
	);
	return { titleLines: base.titleLines, items: [...shown, ...hidden] };
}

/** The layout a draft stands for (what the preview and the board draw). */
export function layoutOfDraft(draft: CardDraft): CardLayout {
	return {
		titleLines: draft.titleLines,
		fields: draft.items.filter(item => item.shown).map(item => ({ field: item.field, style: item.style })),
	};
}

/** `field` moved one place earlier (-1) or later (1) among the shown fields; at a border nothing changes. */
export function moveField(items: readonly DraftItem[], field: CardField, direction: -1 | 1): DraftItem[] {
	const from = items.findIndex(item => item.field === field);
	const to = from + direction;
	if (from === -1 || !items[from]!.shown || to < 0 || to >= items.length || !items[to]!.shown) {
		return [...items];
	}
	const next = [...items];
	[next[from], next[to]] = [next[to]!, next[from]!];
	return next;
}

/** `field` taken off the card: it leads the hidden fields. */
export function hideField(items: readonly DraftItem[], field: CardField): DraftItem[] {
	const target = items.find(item => item.field === field);
	if (target === undefined || !target.shown) {
		return [...items];
	}
	const rest = items.filter(item => item.field !== field);
	const firstHidden = rest.findIndex(item => !item.shown);
	const at = firstHidden === -1 ? rest.length : firstHidden;
	return [...rest.slice(0, at), { ...target, shown: false }, ...rest.slice(at)];
}

/** `field` put on the card, after the fields it already shows. */
export function showField(items: readonly DraftItem[], field: CardField): DraftItem[] {
	const target = items.find(item => item.field === field);
	if (target === undefined || target.shown) {
		return [...items];
	}
	const rest = items.filter(item => item.field !== field);
	const shownCount = rest.filter(item => item.shown).length;
	return [...rest.slice(0, shownCount), { ...target, shown: true }, ...rest.slice(shownCount)];
}

/** The body of PUT /board/card: the shown fields in order, a style only when it is not the default. */
export interface CardBody {
	titleLines: TitleLines;
	fields: Array<{ field: CardField; style?: string }>;
}

export function draftToBody(draft: CardDraft): CardBody {
	return {
		titleLines: draft.titleLines,
		fields: draft.items
			.filter(item => item.shown)
			.map(item =>
				item.style === '' || item.style === defaultStyle(item.field)
					? { field: item.field }
					: { field: item.field, style: item.style }
			),
	};
}

/** The day (UTC, YYYY-MM-DD) of an ISO date; undefined when there is none or it cannot be read (nothing is drawn then). */
export function shortDate(iso: string | undefined): string | undefined {
	if (iso === undefined || iso === '') {
		return undefined;
	}
	const ms = Date.parse(iso);
	return Number.isNaN(ms) ? undefined : new Date(ms).toISOString().slice(0, 10);
}

/** One card of the preview. */
export interface PreviewCard {
	card: BoardCardData;
	/** The card is made up, not one of the board. */
	sample: boolean;
	/** Its column holds several statuses (what the `auto` style of the status looks at). */
	showStatus: boolean;
}

/** Three made-up cards, each with something to show for every field. */
const SAMPLES: readonly BoardCardData[] = [
	{
		id: 'SAMPLE-1',
		headline: 'Sample: a long title that goes on for a while, to show how many lines the title may take on a card',
		status: 'in progress',
		tone: 'info',
		priority: 'high',
		priorityText: 'High',
		assignee: 'Ada Lovelace',
		createdAt: '2026-11-01T09:00:00.000Z',
		statusSince: '2026-11-10T09:00:00.000Z',
		parentId: 'SAMPLE-0',
	},
	{
		id: 'SAMPLE-2',
		headline: 'Sample: short title',
		status: 'to do',
		tone: 'neutral',
		priority: 'medium',
		priorityText: 'Medium',
		assignee: 'Grace Hopper',
		createdAt: '2026-11-05T09:00:00.000Z',
		statusSince: '2026-11-05T09:00:00.000Z',
	},
	{
		id: 'SAMPLE-3',
		headline: 'Sample: a review that waits for someone',
		status: 'review',
		tone: 'warning',
		priority: 'urgent',
		priorityText: 'Urgent',
		assignee: 'Alan Turing',
		createdAt: '2026-10-20T09:00:00.000Z',
		statusSince: '2026-11-12T09:00:00.000Z',
		parentId: 'SAMPLE-0',
	},
];

/** How many facts of `card` differ from what the picked cards already show: the more, the better the next pick. */
function novelty(card: BoardCardData, picked: readonly BoardCardData[]): number {
	const has = (read: (c: BoardCardData) => unknown): boolean => picked.some(other => read(other) !== undefined);
	const differs = (read: (c: BoardCardData) => unknown): boolean =>
		read(card) !== undefined && !picked.some(other => read(other) === read(card));
	let score = 0;
	if (card.parentId !== undefined && !has(c => c.parentId)) score += 3;
	if (card.assignee !== undefined && !has(c => c.assignee)) score += 2;
	if (differs(c => c.assignee)) score += 1;
	if (differs(c => c.priority)) score += 1;
	if (differs(c => c.status)) score += 1;
	if (differs(c => c.parentId)) score += 1;
	return score;
}

/** How many optional facts a card has: a tie goes to the richer card. */
const richness = (card: BoardCardData): number =>
	[card.priority, card.assignee, card.parentId, card.createdAt, card.statusSince].filter(value => value !== undefined).length;

/**
 * Three DIFFERENT cards for the preview of the editor, chosen among the real cards of the board so the user sees their own data:
 * the one with the longest title first, then each time the card that differs most from those already picked (a parent, an assignee,
 * another priority, another status). Fewer than three real cards: the rest are labelled samples. Deterministic, never changes a
 * real card.
 */
export function pickPreviewCards(columns: readonly BoardColumnData[], count = 3): PreviewCard[] {
	const pool = columns.flatMap(column =>
		column.cards.map(card => ({ card, showStatus: column.statuses.length > 1 }))
	);
	const picked: PreviewCard[] = [];
	const remaining = [...pool];
	while (picked.length < count && remaining.length > 0) {
		const chosen = picked.map(entry => entry.card);
		let best = 0;
		let bestScore = -1;
		remaining.forEach((candidate, index) => {
			const score =
				chosen.length === 0
					? candidate.card.headline.length
					: novelty(candidate.card, chosen) * 1000 + richness(candidate.card);
			if (score > bestScore) {
				best = index;
				bestScore = score;
			}
		});
		const [taken] = remaining.splice(best, 1);
		picked.push({ ...taken!, sample: false });
	}
	for (const sample of SAMPLES) {
		if (picked.length >= count) {
			break;
		}
		picked.push({ card: sample, sample: true, showStatus: false });
	}
	return picked;
}
