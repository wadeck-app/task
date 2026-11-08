import {
	ArrowRight,
	ArrowRightLeft,
	GitBranch,
	Link2,
	LockOpen,
	MessageSquare,
	MessageSquareX,
	Pencil,
	Plus,
	Shapes,
	SlidersHorizontal,
	Tag,
	Trash2,
	Unlink,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import React, { useId, useState } from 'react';
import { TONE_DOT, TONE_TEXT, toneOf } from '../tones.js';
import type { Tone } from '../tones.js';
import {
	CONTROL_H,
	CONTROL_RADIUS,
	CONTROL_TEXT,
	FOCUS_RING,
	GAP_BLOCKS,
	GAP_CONTROLS,
	ICON_SIZE,
} from '../ui/tokens.js';

export interface ActivityDetails {
	/** The value before, drawn struck through and muted. */
	old?: string;
	/** The value after. */
	new?: string;
}

export interface ActivityRow {
	/** ISO 8601 instant. The tooltip of the time shows it in UTC. */
	at: string;
	/** What happened (`status`, `type`, `parent`, `link`, `label`, `meta`, `description`, `created`...): picks the icon and the filter. */
	kind: string;
	/** The route's own icon hint; the icon comes from `kind`. */
	icon?: string;
	/** Overrides the colour of the kind. */
	tone?: string;
	/** The sentence (`Status: todo to done`); for a `comment` row, the whole text of the comment. */
	text: string;
	/** Who did it; the author of a comment (absent when none was named). */
	actor?: string;
	/** A preview of the change: a text, or the old and new values. */
	details?: string | ActivityDetails;
	/** The day heading above the row (`Today`, `Yesterday`, `2026-11-06`); consecutive rows with the same group share it. */
	group?: string;
}

export interface ActivityFeedProps {
	/** What happened, newest first (kept in the given order). */
	rows: ActivityRow[];
	/** The filter tabs, in order: `all`, `history`, or a kind. One filter hides the tabs. */
	filters?: string[];
	/** The number to print in each tab; computed from the rows when absent. */
	counts?: Record<string, number>;
	/** Rows shown before "Show more", and added by each click. */
	pageSize?: number;
	/** Shown when there is nothing to list under `all`. */
	emptyText?: string;
	/** The instant "now" for the relative times (ISO 8601). Defaults to the clock. */
	now?: string;
}

/**
 * The HISTORY filter: changes to the properties of the task, i.e. who/what it is linked to and how it is classified.
 * It leaves out the creation, the edits of the title and the description (text, not properties) and any kind this
 * component does not know (those stay under All activity).
 */
export const HISTORY_KINDS: readonly string[] = [
	'status',
	'type',
	'parent',
	'link',
	'unlink',
	'label',
	'meta',
	'unblocked',
];

// @formatter:off
const KIND_ICON: Record<string, LucideIcon> = {
	created: Plus,
	status: ArrowRightLeft,
	type: Shapes,
	parent: GitBranch,
	link: Link2,
	unlink: Unlink,
	label: Tag,
	meta: SlidersHorizontal,
	unblocked: LockOpen,
	title: Pencil,
	description: Pencil,
	text: Pencil,
	comment: MessageSquare,
	'comment-edited': Pencil,
	'comment-removed': MessageSquareX,
	deleted: Trash2,
};

const KIND_TONE: Record<string, Tone> = {
	created: 'info',
	status: 'neutral',
	type: 'neutral',
	parent: 'purple',
	link: 'purple',
	unlink: 'purple',
	label: 'neutral',
	meta: 'neutral',
	unblocked: 'success',
	title: 'neutral',
	description: 'neutral',
	text: 'neutral',
	comment: 'neutral',
	'comment-edited': 'neutral',
	'comment-removed': 'neutral',
	deleted: 'danger',
};

const FILTER_LABEL: Record<string, string> = {
	all: 'All activity',
	history: 'History',
};
// @formatter:on

const COLLAPSE_CHARS = 140;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "5 minutes ago" for a recent instant, the UTC date beyond 30 days, the raw text for something that is not a date. */
export function relativeTime(at: string, nowMs: number): string {
	const time = Date.parse(at);
	if (Number.isNaN(time)) {
		return at;
	}
	const age = nowMs - time;
	if (age < MINUTE) {
		return 'just now';
	}
	const plural = (n: number, unit: string): string => `${n} ${unit}${n === 1 ? '' : 's'} ago`;
	if (age < HOUR) {
		return plural(Math.floor(age / MINUTE), 'minute');
	}
	if (age < DAY) {
		return plural(Math.floor(age / HOUR), 'hour');
	}
	if (age < 30 * DAY) {
		return plural(Math.floor(age / DAY), 'day');
	}
	return new Date(time).toISOString().slice(0, 10);
}

function filterLabel(id: string): string {
	return FILTER_LABEL[id] ?? id.charAt(0).toUpperCase() + id.slice(1);
}

function matches(filter: string, row: ActivityRow): boolean {
	if (filter === 'all') {
		return true;
	}
	if (filter === 'history') {
		return HISTORY_KINDS.includes(row.kind);
	}
	// The comments themselves (not the notes that one was edited or removed, which stay under All activity).
	if (filter === 'comments') {
		return row.kind === 'comment';
	}
	return row.kind === filter;
}

function detailsLength(details: ActivityRow['details']): number {
	if (typeof details === 'string') {
		return details.length + (details.split('\n').length > 3 ? COLLAPSE_CHARS : 0);
	}
	return (details?.old?.length ?? 0) + (details?.new?.length ?? 0);
}

function Details({ details }: { details: NonNullable<ActivityRow['details']> }): React.ReactElement {
	const long = detailsLength(details) > COLLAPSE_CHARS;
	const [open, setOpen] = useState(false);
	const collapsed = long && !open;
	return (
		<div className="mt-1 flex flex-col items-start gap-2">
			<div
				data-testid="activity-details"
				data-collapsed={collapsed ? 'true' : 'false'}
				style={
					collapsed
						? {
								display: '-webkit-box',
								WebkitLineClamp: 2,
								WebkitBoxOrient: 'vertical',
								overflow: 'hidden',
							}
						: undefined
				}
				className="min-w-0 max-w-full whitespace-pre-wrap break-words text-xs text-content"
			>
				{typeof details === 'string' ? (
					details
				) : (
					<>
						{details.old !== undefined ? (
							<span className="text-muted line-through">{details.old}</span>
						) : null}
						{details.old !== undefined && details.new !== undefined ? (
							<ArrowRight size={12} aria-hidden="true" className="mx-1 inline text-muted" />
						) : null}
						{details.new !== undefined ? <span className="font-medium">{details.new}</span> : null}
					</>
				)}
			</div>
			{long ? (
				<button
					type="button"
					aria-expanded={open}
					onClick={() => setOpen(!open)}
					className={`${CONTROL_RADIUS} text-xs font-medium text-muted underline ${FOCUS_RING}`}
				>
					{open ? 'Hide details' : 'Show details'}
				</button>
			) : null}
		</div>
	);
}

function Row({ row, nowMs }: { row: ActivityRow; nowMs: number }): React.ReactElement {
	const Icon = KIND_ICON[row.kind];
	const tone = toneOf(row.tone ?? KIND_TONE[row.kind] ?? 'neutral');
	return (
		<li data-testid="activity-row" data-kind={row.kind} className={`flex ${GAP_CONTROLS} pb-4`}>
			<span className="mt-0.5 flex w-5 shrink-0 justify-center">
				{Icon ? (
					<span data-testid="activity-icon" className={TONE_TEXT[tone]}>
						<Icon size={ICON_SIZE + 2} aria-hidden="true" />
					</span>
				) : (
					<span
						data-testid="activity-dot"
						aria-hidden="true"
						className={`mt-1.5 h-2 w-2 rounded-full ${TONE_DOT[tone === 'neutral' ? 'neutral' : tone]}`}
					/>
				)}
			</span>
			<div className="min-w-0 flex-1">
				{row.kind === 'comment' ? (
					<>
						{row.actor !== undefined && row.actor !== '' ? (
							<span
								data-testid="activity-actor"
								className="block break-words text-sm font-medium text-content"
							>
								{row.actor}
							</span>
						) : null}
						{/* The whole comment: line breaks kept, long words wrapped. */}
						<p
							data-testid="activity-comment-text"
							className="m-0 whitespace-pre-wrap break-words text-sm text-content"
						>
							{row.text}
						</p>
					</>
				) : (
					<p className="m-0 break-words text-sm text-content">{row.text}</p>
				)}
				{row.details !== undefined && row.details !== '' ? <Details details={row.details} /> : null}
				<time
					dateTime={row.at}
					title={Number.isNaN(Date.parse(row.at)) ? row.at : new Date(row.at).toISOString()}
					className="text-xs text-muted"
				>
					{relativeTime(row.at, nowMs)}
				</time>
			</div>
		</li>
	);
}

/**
 * The activity of a task: one feed with a lucide icon per kind, day headings, relative times (the absolute UTC
 * instant in the tooltip), collapsible change previews, filter tabs with counts ("All activity", "History") and
 * "Show more" after 15 rows. Filtering is client side, from `rows[].kind` (see HISTORY_KINDS).
 *
 * IN SCOPE: reading what happened to one task. OUT OF SCOPE: adding a comment, server paging.
 *
 * @registryCategory composite
 * @registryTags activity history feed timeline filter tabs
 */
export function ActivityFeed({
	rows,
	filters = ['all', 'history'],
	counts,
	pageSize = 15,
	emptyText = 'No activity yet',
	now,
}: ActivityFeedProps): React.ReactElement {
	const baseId = useId();
	const list = (Array.isArray(rows) ? rows : []).filter(
		(row): row is ActivityRow => typeof row === 'object' && row !== null && typeof row.text === 'string'
	);
	const tabs = (Array.isArray(filters) && filters.length > 0 ? filters : ['all']).filter(f => typeof f === 'string');
	const [selected, setSelected] = useState(tabs[0] ?? 'all');
	const [shown, setShown] = useState(pageSize);
	const filter = tabs.includes(selected) ? selected : (tabs[0] ?? 'all');
	const parsedNow = now === undefined ? Number.NaN : Date.parse(now);
	const nowMs = Number.isNaN(parsedNow) ? Date.now() : parsedNow;

	const filtered = list.filter(row => matches(filter, row));
	const visible = filtered.slice(0, shown);
	const left = filtered.length - visible.length;
	const groups: { name: string; rows: ActivityRow[] }[] = [];
	for (const row of visible) {
		const name =
			row.group !== undefined && row.group !== ''
				? row.group
				: Number.isNaN(Date.parse(row.at))
					? 'Unknown date'
					: new Date(row.at).toISOString().slice(0, 10);
		const last = groups[groups.length - 1];
		if (last && last.name === name) {
			last.rows.push(row);
		} else {
			groups.push({ name, rows: [row] });
		}
	}

	const choose = (id: string): void => {
		setSelected(id);
		setShown(pageSize);
	};
	const tabId = (id: string): string => `${baseId}-tab-${id}`;
	const showTabs = tabs.length > 1;

	const onTabKey = (event: React.KeyboardEvent, index: number): void => {
		let target = -1;
		if (event.key === 'ArrowRight') {
			target = (index + 1) % tabs.length;
		} else if (event.key === 'ArrowLeft') {
			target = (index - 1 + tabs.length) % tabs.length;
		} else if (event.key === 'Home') {
			target = 0;
		} else if (event.key === 'End') {
			target = tabs.length - 1;
		}
		if (target >= 0) {
			event.preventDefault();
			const id = tabs[target]!;
			choose(id);
			document.getElementById(tabId(id))?.focus();
		}
	};

	return (
		<div data-testid="activity-feed" className={`flex flex-col ${GAP_BLOCKS}`}>
			{showTabs ? (
				<div role="tablist" aria-label="Activity filter" className={`flex flex-wrap ${GAP_CONTROLS}`}>
					{tabs.map((id, index) => {
						const active = id === filter;
						const count = counts?.[id] ?? list.filter(row => matches(id, row)).length;
						return (
							<button
								key={id}
								id={tabId(id)}
								type="button"
								role="tab"
								aria-selected={active}
								aria-controls={`${baseId}-panel`}
								tabIndex={active ? 0 : -1}
								onClick={() => choose(id)}
								onKeyDown={event => onTabKey(event, index)}
								className={`inline-flex ${CONTROL_H} items-center ${GAP_CONTROLS} ${CONTROL_RADIUS} px-3 ${CONTROL_TEXT} font-medium ${FOCUS_RING} ${active ? 'bg-muted-bg text-content' : 'text-muted hover:text-content'}`}
							>
								<span>{filterLabel(id)}</span>
								<span className="rounded-full bg-surface px-2 text-xs text-muted">{count}</span>
							</button>
						);
					})}
				</div>
			) : null}
			<div
				id={`${baseId}-panel`}
				role={showTabs ? 'tabpanel' : undefined}
				aria-labelledby={showTabs ? tabId(filter) : undefined}
				className={`flex flex-col ${GAP_BLOCKS}`}
			>
				{filtered.length === 0 ? (
					<p data-testid="activity-empty" className="text-sm text-muted">
						{filter === 'all' ? emptyText : `No ${filterLabel(filter).toLowerCase()} yet`}
					</p>
				) : (
					groups.map((group, index) => (
						<section key={`${group.name}-${index}`} data-testid="activity-group">
							<h4 className="mb-2 text-xs font-semibold tracking-wide text-muted">{group.name}</h4>
							<ol className="m-0 list-none p-0">
								{group.rows.map((row, i) => (
									<Row key={`${row.at}-${row.kind}-${i}`} row={row} nowMs={nowMs} />
								))}
							</ol>
						</section>
					))
				)}
				{left > 0 ? (
					<button
						type="button"
						onClick={() => setShown(current => current + pageSize)}
						className={`self-start ${CONTROL_H} ${CONTROL_RADIUS} border border-border bg-surface px-3 ${CONTROL_TEXT} font-medium text-content ${FOCUS_RING}`}
					>
						{`Show more (${left} left)`}
					</button>
				) : null}
			</div>
		</div>
	);
}
