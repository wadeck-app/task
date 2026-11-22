import { ArrowDown, ArrowUp, SlidersHorizontal, Star, X } from 'lucide-react';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
	BUTTON_PRIMARY_CLASS,
	FIELD_CLASS,
	GAP_BLOCKS,
	GAP_CONTROLS,
	ICON_SIZE,
	ICON_BUTTON_CLASS,
	PILL_NEUTRAL_CLASS,
} from '../ui/tokens.js';
import { FacetFilter } from '../tasklist/FacetFilter.js';
import { ProjectFilter } from '../tasklist/ProjectFilter.js';
import {
	COLUMNS,
	TaskListHeader,
	TaskListRowView,
	directionText,
	firstDirection,
} from '../tasklist/TaskListTable.js';
import {
	UPDATED_RANGES,
	UPDATED_RANGE_LABEL,
	activeFilterCount,
	applyFilters,
	facetOptions,
	favoriteProjects,
	hasActiveFilters,
	projectOptions,
	priorityRanking,
	sortRows,
} from '../tasklist/taskListModel.js';
import type { ProjectInfo, SortKey, TaskListRow, UpdatedRange } from '../tasklist/taskListModel.js';
import { useListState } from '../tasklist/useListState.js';
import type { ListScope } from '../tasklist/useListState.js';
import { ChipRow } from './ChipRow.js';
import { Notice } from './Notice.js';

export type { TaskListRow } from '../tasklist/taskListModel.js';

export interface TaskListProps {
	/**
	 * The tasks as `GET /tasks` answers them (`tasks`): `id`, `title`, `titleText`, `status`, `priority` / `priorityText` /
	 * `priorityIsDefault`, `assignee`, `leaseText`, `created` / `createdAt`, `updated` / `updatedAt`, `href`, and in the global list
	 * `projectName` / `projectPath`. Only `id`, `title` and `status` are required: a missing `updatedAt` (old data) sorts last.
	 */
	rows: TaskListRow[];
	/**
	 * The global list only: the projects of the answer (`projects` of `GET /tasks?allProjects=true`: `name`, `favorite`, `priority`,
	 * `count`) in importance order, so a project with no task can be offered. Absent (older server): the projects are read from the rows.
	 * The rows carry `projectFavorite` and `projectPriority`; a row without them is not a favorite and normal.
	 *
	 * @resolveDeep
	 */
	projects?: ProjectInfo[];
	/** `project`: one project (columns Priority and Assignee). `all`: the global list (column and filter Project; no priority nor assignee). */
	scope?: 'project' | 'all';
	/** Shown instead of the list when `rows` is empty (not when the filters hide every row: that has its own message). */
	emptyMessage?: string;
	/**
	 * Where the last view (sort and filters) of this list is remembered for the session: the project id, or `all`. The
	 * address carries the view too (`q`, `sort`, `dir`, `status`, `priority`, `assignee`, `projectIn`, `fav`, `updated`); a parameter
	 * of the page (`showAll`, `parent`, `project`, `reload`) is never touched.
	 */
	storageKey?: string;
	/** The priorities of the project from the lowest to the highest, when the route supplies them. Else: low < medium < high < urgent if those are the names, alphabetical otherwise. */
	priorityOrder?: string[];
	/** The instant "now" for the relative times and the Updated range (ISO 8601). Defaults to the clock. */
	now?: string;
}

const NARROW_ONLY = 'xl:hidden';

/** Favorites shown as chips before "+N more". */
const CHIPS_MAX = 6;

/** The favorite projects as toggle chips next to the Project filter; the ones past the sixth are in the Project list. */
function FavoriteChips({
	favorites,
	selected,
	onToggle,
	onMore,
}: {
	favorites: string[];
	selected: string[];
	onToggle: (name: string) => void;
	onMore: () => void;
}): React.ReactElement {
	const shown = favorites.slice(0, CHIPS_MAX);
	const hidden = favorites.length - shown.length;
	return (
		<div role="group" aria-label="Favorite projects" className="min-w-0">
			<ChipRow
				items={
					<>
						{shown.map(name => {
							const on = selected.includes(name);
							return (
								<button
									key={name}
									type="button"
									aria-pressed={on}
									onClick={() => onToggle(name)}
									className={`${PILL_NEUTRAL_CLASS} max-w-[12rem] ${on ? 'border-primary bg-primary-light' : ''}`}
								>
									<Star size={ICON_SIZE} fill="currentColor" aria-hidden="true" className="shrink-0 text-warning-text" />
									<span className="truncate">{name}</span>
								</button>
							);
						})}
						{hidden > 0 ? (
							<button type="button" onClick={onMore} className={PILL_NEUTRAL_CLASS}>
								{`+${hidden} more`}
							</button>
						) : null}
					</>
				}
			/>
		</div>
	);
}

function SortBar({
	scope,
	sort,
	dir,
	onSort,
	onDirection,
}: {
	scope: ListScope;
	sort: SortKey;
	dir: 'asc' | 'desc';
	onSort: (key: SortKey) => void;
	onDirection: () => void;
}): React.ReactElement {
	const Arrow = dir === 'asc' ? ArrowUp : ArrowDown;
	return (
		<div data-testid="tasklist-sortbar" className={`flex items-center ${GAP_CONTROLS} ${NARROW_ONLY}`}>
			<label htmlFor="tasklist-sort" className="text-sm text-muted">
				Sort by
			</label>
			<select
				id="tasklist-sort"
				value={sort}
				onChange={event => onSort(event.target.value as SortKey)}
				className={`${FIELD_CLASS} min-w-0`}
			>
				{COLUMNS[scope].map(column => (
					<option key={column.key} value={column.key}>
						{column.label.replace(' (UTC)', '')}
					</option>
				))}
			</select>
			<button
				type="button"
				onClick={onDirection}
				aria-label={`Direction: ${dir === 'asc' ? 'ascending' : 'descending'}`}
				title={directionText(sort, dir)}
				className={ICON_BUTTON_CLASS}
			>
				<Arrow size={ICON_SIZE} aria-hidden="true" />
			</button>
		</div>
	);
}

/** Whether the focus is somewhere the user types, where "/" must stay a character. */
function isTyping(target: EventTarget | null): boolean {
	if (!(target instanceof HTMLElement)) {
		return false;
	}
	return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

/**
 * The tasks of the Tasks page as a sortable, filterable list: a table from xl, cards below. Default order: last update,
 * most recent first. Sort by any column (header buttons, or "Sort by" below xl); filter by text, status, priority, assignee,
 * project and update range, all combined; the view lives in the address (`history.replaceState`) and in sessionStorage.
 * The whole row is a link to the task.
 *
 * IN SCOPE: reading and narrowing the loaded rows, client-side. OUT OF SCOPE: changing a task (the task page does), paging,
 * fetching more rows (the page's source does; `?showAll=true` is the page's own link).
 *
 * @registryCategory composite
 * @registryTags task tasks list table sort filter search
 */
export function TaskList({
	rows,
	scope = 'project',
	emptyMessage = 'No tasks.',
	storageKey = scope === 'all' ? 'all' : 'project',
	priorityOrder,
	projects,
	now,
}: TaskListProps): React.ReactElement {
	const { state, warnings, update, reset } = useListState(scope, storageKey);
	const [nowMs] = useState(() => {
		const given = now === undefined ? Number.NaN : Date.parse(now);
		return Number.isNaN(given) ? Date.now() : given;
	});
	const [filtersOpen, setFiltersOpen] = useState(false);
	const [projectOpen, setProjectOpen] = useState(false);
	const search = useRef<HTMLInputElement>(null);
	const list: TaskListRow[] = Array.isArray(rows) ? rows : [];

	useEffect(() => {
		const onKey = (event: KeyboardEvent): void => {
			if (event.key === '/' && !event.ctrlKey && !event.metaKey && !event.altKey && !isTyping(event.target)) {
				event.preventDefault();
				search.current?.focus();
			}
		};
		document.addEventListener('keydown', onKey);
		return () => document.removeEventListener('keydown', onKey);
	}, []);

	const ranking = useMemo(() => priorityRanking(list, priorityOrder), [list, priorityOrder]);
	const shown = useMemo(
		() => sortRows(applyFilters(list, state, nowMs), state, { priorityOrder }),
		[list, state, nowMs, priorityOrder]
	);
	// Facets count every loaded row, so a count says what a value would show on its own.
	const statusOptions = useMemo(() => facetOptions(list, 'status', state.status), [list, state.status]);
	const priorityOptions = useMemo(() => facetOptions(list, 'priority', state.priority), [list, state.priority]);
	const assigneeOptions = useMemo(() => facetOptions(list, 'assignee', state.assignee), [list, state.assignee]);
	const projectChoices = useMemo(
		() => projectOptions(list, Array.isArray(projects) ? projects : undefined, state.project),
		[list, projects, state.project]
	);
	const favorites = useMemo(() => favoriteProjects(projectChoices), [projectChoices]);

	if (list.length === 0) {
		return (
			<p data-testid="tasklist-empty" className="m-0 rounded-lg border border-border bg-surface px-3 py-4 text-sm text-muted">
				{emptyMessage}
			</p>
		);
	}

	const onSort = (key: SortKey): void =>
		update(state.sort === key ? { dir: state.dir === 'asc' ? 'desc' : 'asc' } : { sort: key, dir: firstDirection(key) });
	const column = COLUMNS[scope].find(item => item.key === state.sort);
	const filterCount = activeFilterCount(state);
	const active = hasActiveFilters(state);
	// Shown while a favorite exists, or while the address asks for it (it must be possible to turn it off).
	const showFavoritesToggle = scope === 'all' && (favorites.length > 0 || state.favoritesOnly);
	const toggleProject = (name: string): void =>
		update({
			project: state.project.includes(name) ? state.project.filter(item => item !== name) : [...state.project, name],
		});
	const clear = (
		<button type="button" onClick={reset} className={PILL_NEUTRAL_CLASS}>
			<X size={ICON_SIZE} aria-hidden="true" />
			Clear filters
		</button>
	);

	return (
		<div data-testid="tasklist" className={`flex min-w-0 flex-col ${GAP_BLOCKS}`}>
			{warnings.map(text => (
				<Notice key={text} label={text} variant="warning" />
			))}
			<div className={`flex min-w-0 flex-wrap items-center ${GAP_CONTROLS}`}>
				<input
					ref={search}
					type="search"
					aria-label="Search tasks"
					aria-keyshortcuts="/"
					// Short: it shares a line with the Filters button below xl. What is searched is in the title of the field.
					placeholder="Search tasks  ( / )"
					title={scope === 'all' ? 'Searches the id, the title and the project' : 'Searches the id, the title and the assignee'}
					value={state.q}
					onChange={event => update({ q: event.target.value })}
					onKeyDown={event => {
						if (event.key === 'Escape' && state.q !== '') {
							event.preventDefault();
							update({ q: '' });
						}
					}}
					className={`${FIELD_CLASS} min-w-0 flex-1 xl:max-w-sm`}
				/>
				{showFavoritesToggle ? (
					<button
						type="button"
						aria-pressed={state.favoritesOnly}
						onClick={() => update({ favoritesOnly: !state.favoritesOnly })}
						className={`${PILL_NEUTRAL_CLASS} ${state.favoritesOnly ? 'border-primary bg-primary-light' : ''}`}
					>
						<Star size={ICON_SIZE} fill={state.favoritesOnly ? 'currentColor' : 'none'} aria-hidden="true" />
						Favorites only
					</button>
				) : null}
				<button
					type="button"
					aria-expanded={filtersOpen}
					onClick={() => setFiltersOpen(open => !open)}
					className={`${PILL_NEUTRAL_CLASS} ${NARROW_ONLY}`}
				>
					<SlidersHorizontal size={ICON_SIZE} aria-hidden="true" />
					{filterCount > 0 ? `Filters (${filterCount})` : 'Filters'}
				</button>
				<SortBar
					scope={scope}
					sort={state.sort}
					dir={state.dir}
					onSort={key => update({ sort: key, dir: firstDirection(key) })}
					onDirection={() => update({ dir: state.dir === 'asc' ? 'desc' : 'asc' })}
				/>
				{active ? clear : null}
			</div>
			<div
				data-testid="tasklist-filters"
				className={`${filtersOpen ? 'flex' : 'hidden xl:flex'} min-w-0 flex-wrap items-center ${GAP_CONTROLS}`}
			>
				<FacetFilter label="Status" options={statusOptions} selected={state.status} onChange={status => update({ status })} />
				{scope === 'project' ? (
					<>
						<FacetFilter label="Priority" options={priorityOptions} selected={state.priority} onChange={priority => update({ priority })} />
						<FacetFilter label="Assignee" options={assigneeOptions} selected={state.assignee} onChange={assignee => update({ assignee })} />
					</>
				) : (
					<>
						<ProjectFilter
							options={projectChoices}
							selected={state.project}
							onChange={project => update({ project })}
							open={projectOpen}
							onOpenChange={setProjectOpen}
						/>
						{favorites.length > 0 ? (
							<FavoriteChips
								favorites={favorites.map(option => option.value)}
								selected={state.project}
								onToggle={toggleProject}
								onMore={() => setProjectOpen(true)}
							/>
						) : null}
					</>
				)}
				<select
					aria-label="Updated"
					value={state.updated}
					onChange={event => update({ updated: event.target.value as UpdatedRange })}
					className={`${FIELD_CLASS} ${state.updated === 'any' ? '' : 'border-primary bg-primary-light'} min-w-0`}
				>
					{UPDATED_RANGES.map(range => (
						<option key={range} value={range}>
							{`Updated: ${UPDATED_RANGE_LABEL[range].toLowerCase()}`}
						</option>
					))}
				</select>
			</div>
			<div className={`flex min-w-0 flex-wrap items-center justify-between ${GAP_CONTROLS} text-sm text-muted`}>
				<p data-testid="tasklist-count" aria-live="polite" className="m-0">
					{`${shown.length} of ${list.length} tasks`}
				</p>
				<p data-testid="tasklist-sortstate" className="m-0">
					{`Sorted by ${column?.label.replace(' (UTC)', '') ?? state.sort}, ${directionText(state.sort, state.dir)}`}
				</p>
			</div>
			{state.sort === 'priority' && ranking.kind === 'alphabetical' ? (
				<p data-testid="tasklist-priority-note" className="m-0 text-xs text-muted">
					Priority sorts alphabetically here: the names of this project are not low, medium, high and urgent, and the page does not give their order.
				</p>
			) : null}
			{shown.length === 0 ? (
				<div
					data-testid="tasklist-no-match"
					className={`flex flex-col items-start ${GAP_CONTROLS} rounded-lg border border-border bg-surface px-3 py-4`}
				>
					<p className="m-0 text-sm text-content">No task matches the filters.</p>
					<button type="button" onClick={reset} className={BUTTON_PRIMARY_CLASS}>
						Clear filters
					</button>
				</div>
			) : (
				<div
					role="table"
					aria-label="Tasks"
					className="min-w-0 rounded-lg border border-border bg-surface xl:max-h-[75vh] xl:overflow-y-auto"
				>
					<TaskListHeader scope={scope} sort={state.sort} dir={state.dir} onSort={onSort} />
					{shown.map(row => (
						<TaskListRowView key={`${row.projectPath ?? ''}/${row.id}`} row={row} scope={scope} nowMs={nowMs} />
					))}
				</div>
			)}
		</div>
	);
}
