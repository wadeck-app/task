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

export interface ProjectMasterDetailProps {
	/** The projects of the overview (`overview.projects` of the Tree route). */
	projects: ProjectData[];
	/** Width of the project list on wide screens. */
	listWidth?: 'narrow' | 'normal' | 'wide';
}

// @formatter:off
const LIST_WIDTH: Record<NonNullable<ProjectMasterDetailProps['listWidth']>, string> = {
	narrow: 'lg:w-56',
	normal: 'lg:w-72',
	wide: 'lg:w-96',
};
// @formatter:on

const SELECTED_KEY = 'task.tree.selected';
const URL_PARAM = 'treeProject';

/**
 * A searchable list of projects on the left (name, counts, unreadable flagged; it scrolls) and the tree of the selected
 * project on the right. The selection is kept in `?treeProject=` and in localStorage; the list is a listbox (arrow keys).
 *
 * IN SCOPE: working in one project at a time out of many. OUT OF SCOPE: comparing projects (see ProjectCards).
 *
 * @registryCategory composite
 * @registryTags tree projects master detail list
 */
export function ProjectMasterDetail({ projects, listWidth = 'normal' }: ProjectMasterDetailProps): React.ReactElement {
	const list = projectList('ProjectMasterDetail', projects);
	const [chosen, choose] = useRemembered(SELECTED_KEY, URL_PARAM);
	const [filter, setFilter] = useState('');
	if (list.length === 0) {
		return (
			<p data-testid="master-detail-empty" className="text-sm text-muted">
				{NO_PROJECT_TEXT}
			</p>
		);
	}
	const found = list.find(p => p.id === chosen);
	const selected = found ?? list.find(p => p.readable) ?? list[0]!;
	const shown = list.filter(p => matchesProject(p, filter));
	const move = (event: React.KeyboardEvent<HTMLElement>, from: number): void => {
		const step = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0;
		const target = shown[from + step];
		if (step === 0 || target === undefined) return;
		event.preventDefault();
		choose(target.id);
		const options = event.currentTarget.parentElement?.querySelectorAll<HTMLElement>('[role="option"]');
		options?.[from + step]?.focus();
	};
	const side = (
		<div data-testid="master-detail-list" className="flex flex-col gap-2">
			<input
				type="search"
				aria-label="Search projects"
				placeholder="Search projects"
				value={filter}
				onChange={event => setFilter(event.target.value)}
				className="rounded-md border border-border bg-surface px-3 py-1.5 text-sm text-content focus-visible:ring-2 focus-visible:ring-primary"
			/>
			<p className="text-xs text-muted">{`${shown.length} of ${list.length} projects`}</p>
			<div
				role="listbox"
				aria-label="Projects"
				className="flex max-h-[70vh] flex-col overflow-y-auto rounded-lg border border-border bg-surface"
			>
				{shown.map((project, index) => {
					const active = project.id === selected.id;
					return (
						<div
							key={project.id}
							role="option"
							aria-selected={active}
							tabIndex={active || (shown.every(p => p.id !== selected.id) && index === 0) ? 0 : -1}
							onClick={() => choose(project.id)}
							onKeyDown={event => move(event, index)}
							className={`flex cursor-pointer flex-col gap-1 border-b border-border px-3 py-2 last:border-b-0 focus-visible:ring-2 focus-visible:ring-primary ${active ? 'bg-primary-light' : 'hover:bg-muted-bg'}`}
						>
							<span className="flex items-center gap-2">
								<span
									className="min-w-0 flex-1 truncate text-sm font-medium text-content"
									title={project.name}
								>
									{project.name}
								</span>{' '}
								<span
									className={`shrink-0 whitespace-nowrap text-xs ${project.readable ? 'text-muted' : 'text-warning-text'}`}
								>
									{projectSummary(project)}
								</span>
							</span>
							{project.readable && !project.empty ? (
								<ProgressBar
									decorative
									percent={project.percent ?? 0}
									label={`${project.name} progress`}
								/>
							) : null}
						</div>
					);
				})}
			</div>
		</div>
	);
	const main = (
		<div data-testid="master-detail-detail" className="flex flex-col gap-3">
			{chosen !== '' && found === undefined ? (
				<p
					data-testid="master-detail-missing"
					className="rounded-md bg-warning-bg px-3 py-2 text-sm text-warning-text"
				>
					{`The project "${chosen}" is not registered (any more): showing ${selected.name} instead.`}
				</p>
			) : null}
			<div className="flex flex-wrap items-center gap-3">
				<h2 className="m-0 min-w-0 flex-1 truncate text-lg font-semibold text-content">{selected.name}</h2>
				{selected.readable ? (
					<a href={selected.treeHref} className="shrink-0 text-sm text-primary">
						{`Open the whole tree of ${selected.name}`}
					</a>
				) : null}
			</div>
			{selected.readable ? (
				<p className="text-sm text-muted">{`${projectSummary(selected)} - last task added ${selected.lastAddedText ?? '-'}`}</p>
			) : null}
			<div className="rounded-lg border border-border bg-surface">
				<ProjectTreeRows project={selected} />
			</div>
		</div>
	);
	// The list comes first in the DOM (and stacked above the tree on a narrow screen): SplitLayout would put it last.
	return (
		<div data-testid="master-detail" className="flex flex-col gap-6 lg:flex-row">
			<div className={`min-w-0 w-full shrink-0 ${LIST_WIDTH[listWidth]}`}>{side}</div>
			<div className="min-w-0 flex-1">{main}</div>
		</div>
	);
}
