import { ArrowDown, ArrowUp, ArrowUpDown, Clock, Flag, FolderOpen, User } from 'lucide-react';
import React from 'react';
import { StatusBadge } from '../components/StatusBadge.js';
import { relativeTime } from '../components/ActivityFeed.js';
import { FOCUS_RING } from '../ui/tokens.js';
import { priorityName, statusTone } from './taskListModel.js';
import type { SortDir, SortKey, TaskListRow } from './taskListModel.js';
import type { ListScope } from './useListState.js';

export interface ColumnDef {
	key: SortKey;
	label: string;
}

// @formatter:off
/** The columns of each scope, left to right (the global list has no single set of priorities, nor holders). */
export const COLUMNS: Record<ListScope, ColumnDef[]> = {
	project: [
		{ key: 'id', label: 'ID' },
		{ key: 'title', label: 'Title' },
		{ key: 'status', label: 'Status' },
		{ key: 'priority', label: 'Priority' },
		{ key: 'assignee', label: 'Assignee' },
		{ key: 'created', label: 'Created (UTC)' },
		{ key: 'updated', label: 'Updated' },
	],
	all: [
		{ key: 'project', label: 'Project' },
		{ key: 'id', label: 'ID' },
		{ key: 'title', label: 'Title' },
		{ key: 'status', label: 'Status' },
		{ key: 'created', label: 'Created (UTC)' },
		{ key: 'updated', label: 'Updated' },
	],
};

/** Literal class strings (the stylesheet scan is static): one grid template per scope, from xl (1280 px: with the side menu, lg leaves no room for the title). */
const GRID: Record<ListScope, string> = {
	project: 'xl:grid-cols-[5.5rem_minmax(0,1fr)_7.5rem_8rem_6rem_8rem_7.5rem]',
	all: 'xl:grid-cols-[8rem_5.5rem_minmax(0,1fr)_7.5rem_8rem_7.5rem]',
};
// @formatter:on

/** The direction a first click on a column gives: text A to Z, dates and priority the newest / highest first. */
export function firstDirection(key: SortKey): SortDir {
	return key === 'created' || key === 'updated' || key === 'priority' ? 'desc' : 'asc';
}

/** How a sort reads, for the line under the toolbar and the direction button. */
export function directionText(key: SortKey, dir: SortDir): string {
	if (key === 'created' || key === 'updated') {
		return dir === 'desc' ? 'most recent first' : 'oldest first';
	}
	if (key === 'priority') {
		return dir === 'desc' ? 'highest first' : 'lowest first';
	}
	return dir === 'asc' ? 'A to Z' : 'Z to A';
}

export interface HeaderProps {
	scope: ListScope;
	sort: SortKey;
	dir: SortDir;
	onSort: (key: SortKey) => void;
}

/** The header row: one button per column (`aria-sort` on the column header), hidden below xl where the Sort by select is. */
export function TaskListHeader({ scope, sort, dir, onSort }: HeaderProps): React.ReactElement {
	return (
		<div
			role="row"
			className={`sticky top-0 z-10 hidden min-w-0 items-center gap-2 rounded-t-lg border-b border-border bg-surface px-3 xl:grid ${GRID[scope]}`}
		>
			{COLUMNS[scope].map(column => {
				const active = sort === column.key;
				const Arrow = !active ? ArrowUpDown : dir === 'asc' ? ArrowUp : ArrowDown;
				return (
					<div
						key={column.key}
						role="columnheader"
						aria-sort={active ? (dir === 'asc' ? 'ascending' : 'descending') : undefined}
						className="min-w-0"
					>
						<button
							type="button"
							onClick={() => onSort(column.key)}
							// Not just "Status": the Status filter button has that name too.
							aria-label={`Sort by ${column.label.replace(' (UTC)', '')}`}
							className={`-ml-1 inline-flex h-8 max-w-full items-center gap-2 rounded-md px-1 text-sm font-medium ${active ? 'text-content' : 'text-muted'} hover:text-content ${FOCUS_RING}`}
						>
							<span className="truncate">{column.label}</span>
							<Arrow size={14} aria-hidden="true" className={`shrink-0 ${active ? '' : 'opacity-50'}`} />
						</button>
					</div>
				);
			})}
		</div>
	);
}

/** Navigates like the row link does, for a text that has to sit above the stretched link to show its tooltip. */
function follow(href: string | undefined): (() => void) | undefined {
	return href === undefined || href === '' ? undefined : () => window.location.assign(href);
}

/** The text of a missing value (an em dash, written as an escape: the repository keeps typographic characters out of sources). */
export const NONE = String.fromCharCode(0x2014);

const CELL = 'min-w-0';
const MOBILE_ICON = 'shrink-0 xl:hidden';

export interface RowProps {
	row: TaskListRow;
	scope: ListScope;
	nowMs: number;
}

/** One task: a card below xl (id and status, title, meta line), a grid row from xl (1280 px: with the side menu, lg leaves no room for the title). The title link covers the whole row. */
export function TaskListRowView({ row, scope, nowMs }: RowProps): React.ReactElement {
	const text = row.titleText ?? row.title;
	const tooltip = row.title !== '' ? row.title : text;
	const open = follow(row.href);
	const priority = priorityName(row);
	const priorityMuted = row.priorityIsDefault === true || (row.priorityText ?? '').endsWith('(default)');
	// The route sends '' when a task was never updated (old data): same as absent.
	const updatedAt = row.updatedAt === undefined || row.updatedAt === '' ? undefined : row.updatedAt;
	// The route's short UTC text; the ISO instant cut to the minute when only that is there.
	const updatedExact = row.updated
		? row.updated
		: updatedAt === undefined
			? undefined
			: updatedAt.slice(0, 16).replace('T', ' ');
	return (
		<div
			role="row"
			data-testid="tasklist-row"
			data-id={row.id}
			className={`relative grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-center gap-2 border-b border-border px-3 py-2 last:border-b-0 hover:bg-muted-bg xl:py-1.5 ${GRID[scope]}`}
		>
			<div
				role="cell"
				className={`${CELL} font-mono text-xs text-muted max-xl:col-start-1 max-xl:row-start-1 xl:text-sm xl:text-content`}
			>
				{row.id}
			</div>
			<div role="cell" className={`${CELL} max-xl:col-span-2 max-xl:row-start-2 xl:col-auto`}>
				{row.href !== undefined && row.href !== '' ? (
					<a
						href={row.href}
						title={tooltip}
						className="block min-w-0 break-words text-sm font-medium text-content no-underline after:absolute after:inset-0 after:rounded-md focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-inset focus-visible:after:ring-primary max-xl:line-clamp-2 xl:truncate"
					>
						{text}
					</a>
				) : (
					<span title={tooltip} className="block min-w-0 break-words text-sm font-medium text-content max-xl:line-clamp-2 xl:truncate">
						{text}
					</span>
				)}
			</div>
			<div role="cell" className={`${CELL} max-xl:col-start-2 max-xl:row-start-1`}>
				<StatusBadge label={row.status} tone={statusTone(row)} />
			</div>
			<div role="presentation" className="flex min-w-0 flex-wrap items-center gap-2 text-xs text-muted max-xl:col-span-2 max-xl:row-start-3 xl:contents xl:text-sm">
				{scope === 'all' ? (
					<div role="cell" className={`${CELL} flex items-center gap-2 xl:order-first xl:text-content`}>
						<FolderOpen size={12} aria-hidden="true" className={MOBILE_ICON} />
						<span className="truncate" title={row.projectPath === undefined ? row.projectName : `${row.projectName ?? ''} (${row.projectPath})`}>
							{row.projectName ?? ''}
						</span>
					</div>
				) : null}
				{scope === 'project' ? (
					<>
						<div role="cell" className={`${CELL} flex items-center gap-2 ${priority === '' ? 'max-xl:hidden' : ''}`}>
							<Flag size={12} aria-hidden="true" className={MOBILE_ICON} />
							<span className={`truncate ${priorityMuted ? 'text-muted' : 'text-content'}`}>
								{priority === '' ? NONE : (row.priorityText ?? priority)}
							</span>
						</div>
						<div role="cell" className={`${CELL} flex items-center gap-2 ${row.assignee ? '' : 'max-xl:hidden'}`}>
							<User size={12} aria-hidden="true" className={MOBILE_ICON} />
							{row.assignee ? (
								<span
									title={row.leaseText || undefined}
									onClick={open}
									className="relative z-[1] min-w-0 cursor-pointer truncate text-content"
								>
									{row.assignee}
								</span>
							) : (
								<span className="text-muted">{NONE}</span>
							)}
						</div>
					</>
				) : null}
				<div role="cell" className={`${CELL} truncate max-xl:hidden`} title={row.createdAt}>
					{row.created ?? NONE}
				</div>
				<div role="cell" className={`${CELL} flex items-center gap-2`}>
					<Clock size={12} aria-hidden="true" className={MOBILE_ICON} />
					<span
						data-testid="tasklist-updated"
						onClick={open}
						title={updatedExact === undefined ? 'No update date recorded' : `Updated ${updatedExact} UTC`}
						className="relative z-[1] min-w-0 cursor-pointer truncate"
					>
						{updatedAt === undefined ? NONE : relativeTime(updatedAt, nowMs)}
					</span>
				</div>
			</div>
		</div>
	);
}
