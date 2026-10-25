import { ArrowRightLeft, CheckCircle2, Link2, MessageSquare, PlusCircle } from 'lucide-react';
import React from 'react';
import { TONE_TEXT, toneOf } from '../tones.js';
import type { Tone } from '../tones.js';

export type TimelineKind = 'created' | 'status' | 'done' | 'link' | 'note';

export interface TimelineEntry {
	id: string;
	kind: TimelineKind;
	title: string;
	detail?: string;
	/** ISO 8601 instant: orders the entries and gives the day header (UTC day). */
	at: string;
	/** The time as the route wants it read, e.g. `2026-10-21 09:30 UTC`. */
	atText: string;
	/** Overrides the colour of the kind. */
	tone?: Tone;
}

export interface TimelineProps {
	/** What happened, in any order. */
	entries: TimelineEntry[];
	/** One header per UTC day above its entries. */
	groupByDay?: boolean;
	order?: 'newest-first' | 'oldest-first';
	/** Shown when there is no entry. */
	emptyText?: string;
	showIcons?: boolean;
}

const ICONS = {
	created: PlusCircle,
	status: ArrowRightLeft,
	done: CheckCircle2,
	link: Link2,
	note: MessageSquare,
} as const;

// @formatter:off
const KIND_TONE: Record<TimelineKind, Tone> = {
	created: 'info',
	status: 'neutral',
	done: 'success',
	link: 'purple',
	note: 'neutral',
};
// @formatter:on

const UNKNOWN_DAY = 'Unknown date';

function dayOf(entry: TimelineEntry): string {
	const time = Date.parse(entry.at);
	return Number.isNaN(time) ? UNKNOWN_DAY : new Date(time).toISOString().slice(0, 10);
}

function EntryRow({ entry, showIcons, last }: { entry: TimelineEntry; showIcons: boolean; last: boolean }) {
	const kind: TimelineKind = entry.kind in ICONS ? entry.kind : 'note';
	const Icon = ICONS[kind];
	const tone = toneOf(entry.tone ?? KIND_TONE[kind]);
	return (
		<li data-testid="timeline-entry" data-id={entry.id} data-kind={kind} className="relative flex gap-3 pb-4">
			{showIcons ? (
				<div className="relative flex w-5 shrink-0 justify-center">
					{last ? null : (
						<span aria-hidden="true" className="absolute left-1/2 top-5 -ml-px h-full w-px bg-border" />
					)}
					<span className={`relative z-10 mt-0.5 rounded-full bg-surface ${TONE_TEXT[tone]}`}>
						<Icon size={16} aria-hidden="true" />
					</span>
				</div>
			) : null}
			<div className="min-w-0 flex-1">
				<p className="text-sm text-content">{entry.title}</p>
				{entry.detail ? <p className="text-xs text-muted">{entry.detail}</p> : null}
				<time dateTime={entry.at} className="text-xs text-muted">
					{entry.atText}
				</time>
			</div>
		</li>
	);
}

function EntryList({ entries, showIcons }: { entries: TimelineEntry[]; showIcons: boolean }) {
	return (
		<ol className="m-0 list-none p-0">
			{entries.map((entry, index) => (
				<EntryRow key={entry.id} entry={entry} showIcons={showIcons} last={index === entries.length - 1} />
			))}
		</ol>
	);
}

/**
 * A vertical feed of events with icons and a connector line, optionally grouped by day.
 *
 * IN SCOPE: showing a list of dated events. OUT OF SCOPE: adding a comment, paging.
 *
 * @registryCategory composite
 * @registryTags timeline activity history feed
 */
export function Timeline({
	entries,
	groupByDay = false,
	order = 'newest-first',
	emptyText = 'No activity',
	showIcons = true,
}: TimelineProps): React.ReactElement {
	if (!Array.isArray(entries) || entries.length === 0) {
		return (
			<p data-testid="timeline-empty" className="text-sm text-muted">
				{emptyText}
			</p>
		);
	}
	const time = (e: TimelineEntry): number => {
		const t = Date.parse(e.at);
		return Number.isNaN(t) ? 0 : t;
	};
	const sorted = [...entries].sort((a, b) => (order === 'newest-first' ? time(b) - time(a) : time(a) - time(b)));

	if (!groupByDay) {
		return (
			<div data-testid="timeline">
				<EntryList entries={sorted} showIcons={showIcons} />
			</div>
		);
	}
	const groups: { day: string; entries: TimelineEntry[] }[] = [];
	for (const entry of sorted) {
		const day = dayOf(entry);
		const last = groups[groups.length - 1];
		if (last && last.day === day) {
			last.entries.push(entry);
		} else {
			groups.push({ day, entries: [entry] });
		}
	}
	return (
		<div data-testid="timeline" className="flex flex-col gap-2">
			{groups.map(group => (
				<section key={group.day} data-testid="timeline-group">
					<h4
						data-testid="timeline-day"
						className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted"
					>
						{group.day}
					</h4>
					<EntryList entries={group.entries} showIcons={showIcons} />
				</section>
			))}
		</div>
	);
}
