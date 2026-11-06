import React, { useState } from 'react';
import { StatusBadge } from './StatusBadge.js';
import { matchesProject, NO_PROJECT_TEXT, ProjectProblem, projectList, projectSummary } from '../projectTree.js';
import type { ProjectData } from '../projectTree.js';

export interface ProjectFlatTreeProps {
	/** The projects of the overview (`overview.projects` of the Tree route). */
	projects: ProjectData[];
	/** Rows drawn per project; the rest is behind a "N more" link to the project tree. */
	rowsPerProject?: number;
	/** Projects drawn at once; "Show more projects" adds the same number again. */
	projectsPerPage?: number;
}

const ALL_STATUSES = '';

/**
 * ONE list for everything: a sticky header per project, then its first rows (project, id, indented title, status). Filters
 * on the project name and on the status; the size is bounded by `rowsPerProject` and `projectsPerPage`.
 *
 * IN SCOPE: scanning the open work of many projects in one scroll. OUT OF SCOPE: the whole tree of a big project (link).
 *
 * @registryCategory composite
 * @registryTags tree projects flat table grouped filter
 */
export function ProjectFlatTree({
	projects,
	rowsPerProject = 10,
	projectsPerPage = 25,
}: ProjectFlatTreeProps): React.ReactElement {
	const list = projectList('ProjectFlatTree', projects);
	const [filter, setFilter] = useState('');
	const [status, setStatus] = useState(ALL_STATUSES);
	const [limit, setLimit] = useState(projectsPerPage);
	if (list.length === 0) {
		return (
			<p data-testid="flat-empty" className="text-sm text-muted">
				{NO_PROJECT_TEXT}
			</p>
		);
	}
	const statuses = [...new Set(list.flatMap(p => (p.rows ?? []).map(r => r.status)))].sort();
	const filtered = list
		.filter(p => matchesProject(p, filter))
		.filter(p => status === ALL_STATUSES || (p.rows ?? []).some(r => r.status === status));
	const drawn = filtered.slice(0, limit);
	return (
		<div data-testid="project-flat-tree" className="flex flex-col gap-3">
			<div className="flex flex-wrap items-center gap-2">
				<input
					type="search"
					aria-label="Filter by project"
					placeholder="Filter by project"
					value={filter}
					onChange={event => setFilter(event.target.value)}
					className="min-w-0 flex-1 rounded-md border border-border bg-surface px-3 py-1.5 text-sm text-content focus-visible:ring-2 focus-visible:ring-primary"
				/>
				<select
					aria-label="Status"
					value={status}
					onChange={event => setStatus(event.target.value)}
					className="rounded-md border border-border bg-surface px-3 py-1.5 text-sm text-content focus-visible:ring-2 focus-visible:ring-primary"
				>
					<option value={ALL_STATUSES}>All statuses</option>
					{statuses.map(name => (
						<option key={name} value={name}>
							{name}
						</option>
					))}
				</select>
			</div>
			{filtered.length === 0 ? (
				<p data-testid="flat-no-match" className="text-sm text-muted">
					{`No project matches${filter === '' ? '' : ` "${filter}"`}${status === ALL_STATUSES ? '' : ` with a task in status "${status}"`}.`}
				</p>
			) : (
				<div className="rounded-lg border border-border bg-surface">
					{drawn.map(project => (
						<FlatGroup key={project.id} project={project} status={status} rowsPerProject={rowsPerProject} />
					))}
				</div>
			)}
			{filtered.length > drawn.length ? (
				<div className="flex items-center gap-3">
					<p
						data-testid="flat-page-note"
						className="text-sm text-muted"
					>{`${drawn.length} of ${filtered.length} projects shown`}</p>
					<button
						type="button"
						onClick={() => setLimit(limit + projectsPerPage)}
						className="rounded-md border border-border bg-surface px-3 py-1.5 text-sm text-content hover:bg-muted-bg"
					>
						Show more projects
					</button>
				</div>
			) : null}
		</div>
	);
}

function FlatGroup({
	project,
	status,
	rowsPerProject,
}: {
	project: ProjectData;
	status: string;
	rowsPerProject: number;
}): React.ReactElement {
	const matching = (project.rows ?? []).filter(r => status === ALL_STATUSES || r.status === status);
	const shown = matching.slice(0, rowsPerProject);
	const more = matching.length - shown.length + (project.hiddenCount ?? 0);
	return (
		<section>
			<div
				data-testid="flat-group-header"
				className="sticky top-0 z-[1] flex items-center gap-3 border-b border-border bg-muted-bg px-3 py-1.5"
			>
				<a
					href={project.treeHref}
					className="min-w-0 flex-1 truncate text-sm font-semibold text-content"
					title={project.name}
				>
					{project.name}
				</a>
				<span className="shrink-0 whitespace-nowrap text-xs text-muted">{projectSummary(project)}</span>
			</div>
			{!project.readable ? (
				<div className="p-3">
					<ProjectProblem project={project} />
				</div>
			) : (project.rows ?? []).length === 0 ? (
				<p data-testid="flat-empty-group" className="px-3 py-2 text-sm text-muted">
					No tasks
				</p>
			) : (
				<ul className="m-0 list-none divide-y divide-border p-0">
					{shown.map(row => (
						<li key={row.id} data-testid="flat-row" data-project={project.name}>
							<a
								href={row.href}
								className="flex items-center gap-3 px-3 py-1.5 no-underline hover:bg-muted-bg"
							>
								<span className="hidden w-32 shrink-0 truncate text-xs text-muted sm:block">
									{project.name}
								</span>
								<span className="shrink-0 whitespace-nowrap font-mono text-xs text-muted">
									{row.id}
								</span>
								<span
									title={row.title}
									className="min-w-0 flex-1 truncate text-sm text-content"
									style={{ paddingLeft: `${Math.min(row.depth, 10) * 16}px` }}
								>
									{row.titleText ?? row.title}
								</span>
								<StatusBadge label={row.status} tone={row.tone} />
							</a>
						</li>
					))}
				</ul>
			)}
			{project.readable && more > 0 ? (
				<a href={project.treeHref} className="block border-t border-border px-3 py-1.5 text-sm text-primary">
					{`${more} more - open the tree of ${project.name}`}
				</a>
			) : null}
		</section>
	);
}
