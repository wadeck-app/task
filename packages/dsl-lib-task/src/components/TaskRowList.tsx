import React from 'react';
import { StatusBadge } from './StatusBadge.js';
import type { Tone } from '../tones.js';

export interface TaskRowData {
	id: string;
	/** The full title; the tooltip when `titleText` is shown. */
	title: string;
	/** The title already cut by the route; shown instead of `title` when set. */
	titleText?: string;
	status: string;
	tone?: Tone;
	/** An app path; without it the row is not a link. */
	href?: string;
	/** A short note on the right, e.g. `blocks 2`. */
	meta?: string;
}

export interface TaskRowListProps {
	/** The tasks, as data. */
	rows: TaskRowData[];
	density?: 'compact' | 'comfortable';
	showId?: boolean;
	showStatus?: boolean;
	/** Shown when there is no row. */
	emptyText?: string;
	/** `list`: divided rows. `table`: bordered rows. `cards`: one bordered card per row. */
	appearance?: 'list' | 'table' | 'cards';
	/** Show only the first rows and `+N more`. 0 = all. */
	maxRows?: number;
}

// @formatter:off
const CONTAINER: Record<NonNullable<TaskRowListProps['appearance']>, string> = {
	list: 'flex flex-col divide-y divide-border',
	table: 'flex flex-col divide-y divide-border rounded-lg border border-border bg-surface',
	cards: 'flex flex-col gap-2',
};
const ROW: Record<NonNullable<TaskRowListProps['appearance']>, string> = {
	list: '',
	table: 'px-3',
	cards: 'rounded-lg border border-border bg-surface px-3',
};
const PADDING: Record<NonNullable<TaskRowListProps['density']>, string> = {
	compact: 'py-1.5',
	comfortable: 'py-2.5',
};
// @formatter:on

/**
 * Tasks as navigable rows: short id, truncated title, status chip, optional note.
 *
 * IN SCOPE: a read-only list that links to the tasks. OUT OF SCOPE: sorting, selection, row actions.
 *
 * @registryCategory composite
 * @registryTags task rows list children links
 */
export function TaskRowList({
	rows,
	density = 'comfortable',
	showId = true,
	showStatus = true,
	emptyText = 'No tasks',
	appearance = 'list',
	maxRows = 0,
}: TaskRowListProps): React.ReactElement {
	const all = Array.isArray(rows) ? rows : [];
	if (all.length === 0) {
		return (
			<p data-testid="task-row-list-empty" className="text-sm text-muted">
				{emptyText}
			</p>
		);
	}
	const visible = maxRows > 0 ? all.slice(0, maxRows) : all;
	const hidden = all.length - visible.length;
	return (
		<div data-testid="task-row-list" data-appearance={appearance}>
			<ul className={`m-0 list-none p-0 ${CONTAINER[appearance]}`}>
				{visible.map((row, index) => {
					const inner = (
						<>
							{showId ? (
								<span className="shrink-0 whitespace-nowrap font-mono text-xs text-muted">
									{row.id}
								</span>
							) : null}
							<span title={row.title} className="min-w-0 flex-1 truncate text-sm text-content">
								{row.titleText ?? row.title}
							</span>
							{row.meta ? <span className="shrink-0 text-xs text-muted">{row.meta}</span> : null}
							{showStatus ? <StatusBadge label={row.status} tone={row.tone} /> : null}
						</>
					);
					const rowClass = `flex items-center gap-3 ${PADDING[density]}`;
					return (
						<li key={`${row.id}-${index}`} data-testid="task-row" className={ROW[appearance]}>
							{row.href ? (
								<a href={row.href} className={`${rowClass} no-underline hover:bg-muted-bg`}>
									{inner}
								</a>
							) : (
								<div className={rowClass}>{inner}</div>
							)}
						</li>
					);
				})}
			</ul>
			{hidden > 0 ? <p className="mt-1 text-xs text-muted">{`+${hidden} more`}</p> : null}
		</div>
	);
}
