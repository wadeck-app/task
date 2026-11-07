import { AlertTriangle, ChevronDown, ChevronRight } from 'lucide-react';
import React, { useState } from 'react';
import {
	matchesProject,
	NO_PROJECT_TEXT,
	ProgressBar,
	ProjectTreeRows,
	projectList,
	projectSummary,
	useRemembered,
} from '../projectTree.js';
import type { ProjectData } from '../projectTree.js';

export interface ProjectAccordionProps {
	/** The projects of the Tree route (`projects` of GET /tree?allProjects=true), readable or not, in name order. */
	projects: ProjectData[];
}

const LAST_KEY = 'task.tree.accordion.last';

const BUTTON =
	'rounded-md border border-border bg-surface px-3 py-1.5 text-sm text-content hover:bg-muted-bg focus-visible:ring-2 focus-visible:ring-primary';

/**
 * The projects open at the first render: only the one opened last time, when it is still listed. Nothing else is opened
 * by guess: dozens of projects must start as a compact index, not as the rows of whichever project comes first.
 */
function initialOpen(projects: ProjectData[], last: string): Set<string> {
	return new Set(projects.some(project => project.id === last) ? [last] : []);
}

/** A project with no task: a project has nothing to unfold, so its line is not a button. */
function isEmpty(project: ProjectData): boolean {
	return project.readable && (project.empty === true || (project.rows ?? []).length === 0);
}

/**
 * One collapsible section per project: name, summary and a mini progress bar in the header, the capped task rows inside,
 * a name filter and expand / collapse all. Only open projects render their rows, so dozens of projects stay light.
 * An empty project is one plain line ("No tasks"); a project that cannot be read is a flagged line whose body gives
 * the reason and the fix (never dropped, never a block of raw paths above the list).
 *
 * IN SCOPE: browsing the global forest project by project. OUT OF SCOPE: editing tasks, the full tree of a project
 * (a link leads to its page).
 *
 * @registryCategory composite
 * @registryTags tree projects accordion collapsible
 */
export function ProjectAccordion({ projects }: ProjectAccordionProps): React.ReactElement {
	const list = projectList('ProjectAccordion', projects);
	const [last, remember] = useRemembered(LAST_KEY);
	const [open, setOpen] = useState<Set<string>>(() => initialOpen(list, last));
	const [filter, setFilter] = useState('');
	if (list.length === 0) {
		return (
			<p data-testid="accordion-empty" className="text-sm text-muted">
				{NO_PROJECT_TEXT}
			</p>
		);
	}
	const shown = list.filter(project => matchesProject(project, filter));
	const toggle = (id: string): void => {
		const next = new Set(open);
		if (next.has(id)) {
			next.delete(id);
		} else {
			next.add(id);
			remember(id);
		}
		setOpen(next);
	};
	return (
		<div data-testid="project-accordion" className="flex flex-col gap-3">
			<div className="flex flex-wrap items-center gap-2">
				<input
					type="search"
					aria-label="Filter projects"
					placeholder="Filter projects"
					value={filter}
					onChange={event => setFilter(event.target.value)}
					className="min-w-48 flex-1 rounded-md border border-border bg-surface px-3 py-1.5 text-sm text-content focus-visible:ring-2 focus-visible:ring-primary"
				/>
				<button
					type="button"
					onClick={() => setOpen(new Set(shown.filter(project => !isEmpty(project)).map(p => p.id)))}
					className={BUTTON}
				>
					Expand all
				</button>
				<button type="button" onClick={() => setOpen(new Set())} className={BUTTON}>
					Collapse all
				</button>
			</div>
			<p className="m-0 text-xs text-muted">{`${shown.length} of ${list.length} projects`}</p>
			{shown.length === 0 ? (
				<p data-testid="accordion-no-match" className="text-sm text-muted">
					{`No project matches "${filter}".`}
				</p>
			) : (
				<ul className="m-0 flex list-none flex-col gap-2 p-0">
					{shown.map(project => {
						if (isEmpty(project)) {
							return (
								<li
									key={project.id}
									data-testid="accordion-item"
									data-kind="empty"
									className="flex items-center gap-3 rounded-lg border border-border bg-surface px-3 py-2"
								>
									<span className="w-4 shrink-0" aria-hidden="true" />
									<span
										className="min-w-0 flex-1 truncate text-sm font-medium text-muted"
										title={project.name}
									>
										{project.name}
									</span>
									<span className="shrink-0 whitespace-nowrap text-xs text-muted">
										{projectSummary(project)}
									</span>
								</li>
							);
						}
						const isOpen = open.has(project.id);
						const bodyId = `accordion-body-${project.id}`;
						const flagged = !project.readable;
						return (
							<li
								key={project.id}
								data-testid="accordion-item"
								data-kind={flagged ? 'flagged' : 'normal'}
								className={`rounded-lg border border-border ${flagged ? 'bg-warning-bg' : 'bg-surface'}`}
							>
								<button
									type="button"
									data-testid="accordion-header"
									aria-expanded={isOpen}
									aria-controls={bodyId}
									onClick={() => toggle(project.id)}
									className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left hover:bg-muted-bg focus-visible:ring-2 focus-visible:ring-primary"
								>
									{isOpen ? (
										<ChevronDown size={16} className="shrink-0" aria-hidden="true" />
									) : (
										<ChevronRight size={16} className="shrink-0" aria-hidden="true" />
									)}
									<span
										className="min-w-0 flex-1 truncate text-sm font-medium text-content"
										title={project.name}
									>
										{project.name}
									</span>{' '}
									{flagged ? (
										<AlertTriangle
											size={14}
											className="shrink-0 text-warning-text"
											aria-hidden="true"
										/>
									) : null}
									<span
										className={`shrink-0 whitespace-nowrap text-xs ${flagged ? 'text-warning-text' : 'text-muted'}`}
									>
										{projectSummary(project)}
									</span>
									{project.readable ? (
										<span className="hidden w-24 shrink-0 sm:block">
											<ProgressBar
												decorative
												percent={project.percent ?? 0}
												label={`${project.name} progress`}
											/>
										</span>
									) : null}
								</button>
								{isOpen ? (
									<div id={bodyId} className="border-t border-border">
										<ProjectTreeRows project={project} />
										{project.readable ? (
											<a href={project.treeHref} className="block px-3 py-2 text-sm text-primary">
												{`Open the tree of ${project.name}`}
											</a>
										) : null}
									</div>
								) : null}
							</li>
						);
					})}
				</ul>
			)}
		</div>
	);
}
