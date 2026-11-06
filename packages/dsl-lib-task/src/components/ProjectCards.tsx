import React, { useState } from 'react';
import {
	NO_PROJECT_TEXT,
	ProgressBar,
	ProjectProblem,
	projectList,
	projectSummary,
	sortProjects,
} from '../projectTree.js';
import type { ProjectData, ProjectSort } from '../projectTree.js';

export interface ProjectCardsProps {
	/** The projects of the overview (`overview.projects` of the Tree route). */
	projects: ProjectData[];
	/** Order used until a button is pressed: last task added, project name, number of open tasks. */
	sort?: ProjectSort;
}

// @formatter:off
const SORTS: ReadonlyArray<{ value: ProjectSort; label: string }> = [
	{ value: 'activity', label: 'Last added' },
	{ value: 'name', label: 'Name' },
	{ value: 'open', label: 'Open tasks' },
];
// @formatter:on

/**
 * A responsive grid of project cards: name (links to the project tree), progress, open / total, the biggest parent
 * tasks with their child progress, and when a task was last added. An unreadable project is a card with the reason.
 *
 * IN SCOPE: comparing projects at a glance. OUT OF SCOPE: listing every task (the card leads to the project tree).
 *
 * @registryCategory composite
 * @registryTags tree projects cards grid overview
 */
export function ProjectCards({ projects, sort = 'activity' }: ProjectCardsProps): React.ReactElement {
	const list = projectList('ProjectCards', projects);
	// The buttons change the order for as long as `sort` stays what it was; a new `sort` (the experiment's option) wins.
	const [chosen, choose] = useState<{ base: ProjectSort; value: ProjectSort } | null>(null);
	if (list.length === 0) {
		return (
			<p data-testid="cards-empty" className="text-sm text-muted">
				{NO_PROJECT_TEXT}
			</p>
		);
	}
	const active: ProjectSort = chosen !== null && chosen.base === sort ? chosen.value : sort;
	return (
		<div data-testid="project-cards" className="flex flex-col gap-4">
			<div role="group" aria-label="Sort projects" className="flex flex-wrap items-center gap-2">
				<span className="text-sm text-muted">Sort by</span>
				{SORTS.map(option => (
					<button
						key={option.value}
						type="button"
						aria-pressed={active === option.value}
						onClick={() => choose({ base: sort, value: option.value })}
						className={`rounded-md border px-3 py-1 text-sm focus-visible:ring-2 focus-visible:ring-primary ${active === option.value ? 'border-primary bg-primary-light text-primary' : 'border-border bg-surface text-content hover:bg-muted-bg'}`}
					>
						{option.label}
					</button>
				))}
			</div>
			<ul className="m-0 grid list-none grid-cols-1 gap-3 p-0 md:grid-cols-2 xl:grid-cols-3">
				{sortProjects(list, active).map(project => (
					<li
						key={project.id}
						data-testid="project-card"
						data-name={project.name}
						className="flex min-w-0 flex-col gap-2 rounded-lg border border-border bg-surface p-3"
					>
						<div className="flex items-baseline gap-2">
							<a
								href={project.treeHref}
								className="min-w-0 flex-1 truncate text-sm font-semibold text-content"
								title={project.name}
							>
								{project.name}
							</a>
							<span className="shrink-0 whitespace-nowrap text-xs text-muted">
								{projectSummary(project)}
							</span>
						</div>
						{project.readable ? (
							<>
								{project.empty ? null : (
									<ProgressBar
										percent={project.percent ?? 0}
										label={`${project.name}: ${project.percent ?? 0}% done`}
									/>
								)}
								{(project.roots ?? []).length > 0 ? (
									<ul className="m-0 flex list-none flex-col gap-1 p-0">
										{(project.roots ?? []).map(root => (
											<li key={root.id}>
												<a
													href={root.href}
													className="flex items-center gap-2 text-xs no-underline hover:underline"
												>
													<span
														className="min-w-0 flex-1 truncate text-content"
														title={root.title}
													>
														{root.titleText ?? root.title}
													</span>{' '}
													<span className="shrink-0 whitespace-nowrap text-muted">{`${root.done}/${root.total}`}</span>
												</a>
											</li>
										))}
									</ul>
								) : null}
								<p className="mt-auto text-xs text-muted">{`Last task added ${project.lastAddedText ?? '-'}`}</p>
							</>
						) : (
							<ProjectProblem project={project} />
						)}
					</li>
				))}
			</ul>
		</div>
	);
}
