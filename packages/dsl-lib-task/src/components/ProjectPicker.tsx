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

export interface ProjectPickerProps {
	/** The projects of the overview (`overview.projects` of the Tree route). */
	projects: ProjectData[];
	/** What shows when nothing was chosen yet: the overview of all projects, or the first readable project. */
	start?: 'overview' | 'first';
}

const PICKED_KEY = 'task.tree.picked';
const URL_PARAM = 'treePicked';
const ALL = 'all';

/**
 * A searchable project combobox above ONE tree. "All projects" shows compact summary rows (name, progress, counts); choosing
 * a project, from the box or from a row, shows its capped tree. The choice is in `?treePicked=` (deep link) and in localStorage.
 *
 * IN SCOPE: jumping to a project among dozens by typing. OUT OF SCOPE: comparing projects side by side (ProjectCards).
 *
 * @registryCategory composite
 * @registryTags tree projects picker combobox overview
 */
export function ProjectPicker({ projects, start = 'overview' }: ProjectPickerProps): React.ReactElement {
	const list = projectList('ProjectPicker', projects);
	const [picked, pick] = useRemembered(PICKED_KEY, URL_PARAM);
	const [text, setText] = useState('');
	const [listOpen, setListOpen] = useState(false);
	const [cursor, setCursor] = useState(0);
	if (list.length === 0) {
		return (
			<p data-testid="picker-empty" className="text-sm text-muted">
				{NO_PROJECT_TEXT}
			</p>
		);
	}
	const found = list.find(p => p.id === picked);
	const unknown = picked !== '' && picked !== ALL && found === undefined;
	const firstReadable = list.find(p => p.readable) ?? list[0]!;
	const selected: ProjectData | undefined = found ?? (picked === '' && start === 'first' ? firstReadable : undefined);
	const options = list.filter(p => matchesProject(p, text));
	const choose = (id: string): void => {
		pick(id);
		setText('');
		setListOpen(false);
		setCursor(0);
	};
	const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
		if (event.key === 'ArrowDown') {
			event.preventDefault();
			setListOpen(true);
			setCursor(Math.min(cursor + 1, options.length - 1));
		} else if (event.key === 'ArrowUp') {
			event.preventDefault();
			setCursor(Math.max(cursor - 1, 0));
		} else if (event.key === 'Enter' && listOpen && options[cursor]) {
			event.preventDefault();
			choose(options[cursor]!.id);
		} else if (event.key === 'Escape') {
			setListOpen(false);
		}
	};
	return (
		<div data-testid="project-picker" className="flex flex-col gap-3">
			<div className="relative flex flex-wrap items-center gap-2">
				<input
					role="combobox"
					aria-label="Project"
					aria-expanded={listOpen}
					aria-controls="picker-options"
					aria-autocomplete="list"
					placeholder={`Find a project (${list.length})`}
					value={text}
					onFocus={() => setListOpen(true)}
					onBlur={() => setListOpen(false)}
					onChange={event => {
						setText(event.target.value);
						setListOpen(true);
						setCursor(0);
					}}
					onKeyDown={onKeyDown}
					className="min-w-0 flex-1 rounded-md border border-border bg-surface px-3 py-1.5 text-sm text-content focus-visible:ring-2 focus-visible:ring-primary"
				/>
				<button
					type="button"
					aria-pressed={selected === undefined}
					onClick={() => choose(ALL)}
					className="rounded-md border border-border bg-surface px-3 py-1.5 text-sm text-content hover:bg-muted-bg"
				>
					All projects
				</button>
				{listOpen ? (
					// mousedown must not blur the input, or the list would close before the click lands.
					<div
						id="picker-options"
						role="listbox"
						aria-label="Matching projects"
						onMouseDown={event => event.preventDefault()}
						className="absolute left-0 top-full z-10 mt-1 max-h-72 w-full max-w-md overflow-y-auto rounded-lg border border-border bg-surface shadow-lg"
					>
						{options.length === 0 ? (
							<p data-testid="picker-no-match" className="px-3 py-2 text-sm text-muted">
								{`No project matches "${text}".`}
							</p>
						) : (
							options.map((project, index) => (
								<div
									key={project.id}
									role="option"
									aria-selected={index === cursor}
									onClick={() => choose(project.id)}
									className={`flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm ${index === cursor ? 'bg-primary-light' : 'hover:bg-muted-bg'}`}
								>
									<span className="min-w-0 flex-1 truncate text-content">{project.name}</span>
									<span className="shrink-0 text-xs text-muted">{projectSummary(project)}</span>
								</div>
							))
						)}
					</div>
				) : null}
			</div>
			{unknown ? (
				<p
					data-testid="picker-missing"
					className="rounded-md bg-warning-bg px-3 py-2 text-sm text-warning-text"
				>
					{`The project "${picked}" is not registered (any more): showing all projects.`}
				</p>
			) : null}
			{selected === undefined ? (
				<div data-testid="picker-overview" className="rounded-lg border border-border bg-surface">
					<ul className="m-0 list-none divide-y divide-border p-0">
						{list.map(project => (
							<li key={project.id} data-testid="picker-overview-row">
								<button
									type="button"
									onClick={() => choose(project.id)}
									className="flex w-full items-center gap-3 px-3 py-1.5 text-left hover:bg-muted-bg focus-visible:ring-2 focus-visible:ring-primary"
								>
									<span className="min-w-0 flex-1 truncate text-sm text-content" title={project.name}>
										{project.name}
									</span>{' '}
									{project.readable && !project.empty ? (
										<span className="hidden w-28 shrink-0 sm:block">
											<ProgressBar
												decorative
												percent={project.percent ?? 0}
												label={`${project.name} progress`}
											/>
										</span>
									) : null}
									<span
										className={`shrink-0 whitespace-nowrap text-xs ${project.readable ? 'text-muted' : 'text-warning-text'}`}
									>
										{projectSummary(project)}
									</span>
								</button>
							</li>
						))}
					</ul>
				</div>
			) : (
				<div data-testid="picker-detail" className="flex flex-col gap-3">
					<div className="flex flex-wrap items-center gap-3">
						<h2 className="m-0 min-w-0 flex-1 truncate text-lg font-semibold text-content">
							{selected.name}
						</h2>
						{selected.readable ? (
							<a href={selected.treeHref} className="shrink-0 text-sm text-primary">
								{`Open the whole tree of ${selected.name}`}
							</a>
						) : null}
					</div>
					{selected.readable ? <p className="text-sm text-muted">{projectSummary(selected)}</p> : null}
					<div className="rounded-lg border border-border bg-surface">
						<ProjectTreeRows project={selected} />
					</div>
				</div>
			)}
		</div>
	);
}
