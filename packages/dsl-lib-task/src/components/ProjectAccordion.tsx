import { ChevronDown, ChevronRight } from 'lucide-react';
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
	/** The projects of the overview (`overview.projects` of the Tree route). */
	projects: ProjectData[];
	/** Which projects start open: the one opened last time (else the first), the first, or none. */
	defaultOpen?: 'last' | 'first' | 'none';
	/** Text above the list, e.g. what the figures count. */
	intro?: string;
}

const LAST_KEY = 'task.tree.accordion.last';

function initialOpen(
	projects: ProjectData[],
	mode: NonNullable<ProjectAccordionProps['defaultOpen']>,
	last: string
): Set<string> {
	if (mode === 'none' || projects.length === 0) return new Set();
	const first = projects.find(p => p.readable) ?? projects[0]!;
	const remembered = mode === 'last' ? projects.find(p => p.id === last) : undefined;
	return new Set([(remembered ?? first).id]);
}

/**
 * One collapsible section per project: name, summary and a mini progress bar in the header, the capped task rows inside,
 * a name filter and expand / collapse all. Only open projects render their rows, so dozens of projects stay light.
 *
 * IN SCOPE: browsing the global forest project by project. OUT OF SCOPE: editing tasks, the full tree of a project
 * (a link leads to its page).
 *
 * @registryCategory composite
 * @registryTags tree projects accordion collapsible
 */
export function ProjectAccordion({ projects, defaultOpen = 'last', intro }: ProjectAccordionProps): React.ReactElement {
	const list = projectList('ProjectAccordion', projects);
	const [last, remember] = useRemembered(LAST_KEY);
	const [open, setOpen] = useState<Set<string>>(() => initialOpen(list, defaultOpen, last));
	// A new `defaultOpen` (the experiment's option switched) starts over; the user's clicks keep standing otherwise.
	const [appliedMode, setAppliedMode] = useState(defaultOpen);
	if (appliedMode !== defaultOpen) {
		setAppliedMode(defaultOpen);
		setOpen(initialOpen(list, defaultOpen, last));
	}
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
			{intro ? <p className="text-sm text-muted">{intro}</p> : null}
			<div className="flex flex-wrap items-center gap-2">
				<input
					type="search"
					aria-label="Filter projects"
					placeholder="Filter projects"
					value={filter}
					onChange={event => setFilter(event.target.value)}
					className="min-w-0 flex-1 rounded-md border border-border bg-surface px-3 py-1.5 text-sm text-content focus-visible:ring-2 focus-visible:ring-primary"
				/>
				<button
					type="button"
					onClick={() => setOpen(new Set(shown.map(p => p.id)))}
					className="rounded-md border border-border bg-surface px-3 py-1.5 text-sm text-content hover:bg-muted-bg"
				>
					Expand all
				</button>
				<button
					type="button"
					onClick={() => setOpen(new Set())}
					className="rounded-md border border-border bg-surface px-3 py-1.5 text-sm text-content hover:bg-muted-bg"
				>
					Collapse all
				</button>
			</div>
			<p className="text-xs text-muted">{`${shown.length} of ${list.length} projects`}</p>
			{shown.length === 0 ? (
				<p data-testid="accordion-no-match" className="text-sm text-muted">
					{`No project matches "${filter}".`}
				</p>
			) : (
				<ul className="m-0 flex list-none flex-col gap-2 p-0">
					{shown.map(project => {
						const isOpen = open.has(project.id);
						const bodyId = `accordion-body-${project.id}`;
						return (
							<li
								key={project.id}
								data-testid="accordion-item"
								className="rounded-lg border border-border bg-surface"
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
										<ChevronDown size={16} aria-hidden="true" />
									) : (
										<ChevronRight size={16} aria-hidden="true" />
									)}
									<span
										className="min-w-0 flex-1 truncate text-sm font-medium text-content"
										title={project.name}
									>
										{project.name}
									</span>{' '}
									<span className="shrink-0 whitespace-nowrap text-xs text-muted">
										{projectSummary(project)}
									</span>
									{project.readable && !project.empty ? (
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
