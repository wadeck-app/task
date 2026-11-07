// Parts of ProjectAccordion (the global Tree page).
// Not a registry component: the types of the `projects` list the module's GET /tree?allProjects=true answers, the name filter
// and the small parts of the accordion. Props only: no fetch, no storage except the remembered choice below.
import { AlertTriangle } from 'lucide-react';
import React, { useState } from 'react';
import { StatusBadge } from './components/StatusBadge.js';
import type { Tone } from './tones.js';
import { reportOnce } from './reportOnce.js';

export interface ProjectRowData {
	id: string;
	title: string;
	titleText?: string;
	status: string;
	tone?: Tone;
	/** Nesting level, 0 for a root task. */
	depth: number;
	href?: string;
}

/** One project of the list. An unreadable one has `readable: false`, `problemText` and no figures. */
export interface ProjectData {
	id: string;
	name: string;
	path?: string;
	readable: boolean;
	/** The page with the whole tree of the project. */
	treeHref: string;
	problemText?: string;
	open?: number;
	total?: number;
	done?: number;
	percent?: number;
	empty?: boolean;
	allDone?: boolean;
	summaryText?: string;
	rows?: ProjectRowData[];
	hiddenCount?: number;
	moreText?: string | null;
}

/** The list a component was given, or an empty one (a prop that is not an array is reported once, never thrown on). */
export function projectList(component: string, value: unknown): ProjectData[] {
	if (Array.isArray(value)) return value as ProjectData[];
	if (value !== undefined && value !== null) {
		reportOnce(`[${component}] "projects" must be a list, got ${typeof value}; nothing is shown.`, 'error');
	}
	return [];
}

/** Case-insensitive "contains" on the name; an empty filter keeps everything. */
export function matchesProject(project: ProjectData, filter: string): boolean {
	const text = filter.trim().toLowerCase();
	return text === '' || project.name.toLowerCase().includes(text);
}

/**
 * A string remembered in localStorage under `key`. It is a user feature (no experiment gate): it always reads and writes.
 * A storage that refuses is reported once and the value lives in memory.
 */
export function useRemembered(key: string): [string, (value: string) => void] {
	const [value, setValue] = useState<string>(() => {
		try {
			return localStorage.getItem(key) ?? '';
		} catch (error) {
			reportOnce(`[task] cannot read "${key}": ${String(error)}. The choice is not remembered.`, 'warn');
			return '';
		}
	});
	const set = (next: string): void => {
		setValue(next);
		try {
			localStorage.setItem(key, next);
		} catch (error) {
			reportOnce(`[task] cannot save "${key}": ${String(error)}. The choice is not remembered.`, 'warn');
		}
	};
	return [value, set];
}

/** A thin bar. `decorative` hides it from assistive technology (the text beside it already says the numbers). */
export function ProgressBar({
	percent,
	label,
	decorative = false,
}: {
	percent: number;
	label: string;
	decorative?: boolean;
}): React.ReactElement {
	const safe = Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : 0;
	const semantics = decorative
		? { 'aria-hidden': true as const }
		: { role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': safe, 'aria-label': label };
	return (
		<div {...semantics} className="h-1.5 w-full min-w-12 overflow-hidden rounded-full bg-muted-bg">
			<div className="h-full bg-success" style={{ width: `${safe}%` }} />
		</div>
	);
}

/** Why a project is not readable (reason and fix, as the route words them). */
export function ProjectProblem({ project }: { project: ProjectData }): React.ReactElement {
	return (
		<p
			data-testid="project-problem"
			className="m-0 flex items-start gap-2 break-words px-3 py-2 text-xs text-warning-text"
		>
			<AlertTriangle size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
			<span className="min-w-0 whitespace-pre-wrap">{project.problemText ?? 'This project cannot be read.'}</span>
		</p>
	);
}

/** The count line of a project: "3 open of 4", "No tasks", "All 5 done"; "cannot be read" for a broken project. */
export function projectSummary(project: ProjectData): string {
	return project.readable ? (project.summaryText ?? '') : 'cannot be read';
}

/** The rows of one project, indented by depth, each a link to its task; the "N more" line links to the whole tree. */
export function ProjectTreeRows({ project }: { project: ProjectData }): React.ReactElement {
	if (!project.readable) return <ProjectProblem project={project} />;
	const rows = project.rows ?? [];
	return (
		<div data-testid="project-rows">
			<ul className="m-0 list-none divide-y divide-border p-0">
				{rows.map(row => (
					<li key={row.id} data-depth={row.depth}>
						<a
							href={row.href}
							className="flex items-center gap-3 py-1.5 pr-3 no-underline hover:bg-muted-bg"
							style={{ paddingLeft: `${12 + Math.min(row.depth, 10) * 16}px` }}
						>
							<span className="shrink-0 whitespace-nowrap font-mono text-xs text-muted">{row.id}</span>
							<span title={row.title} className="min-w-0 flex-1 truncate text-sm text-content">
								{row.titleText ?? row.title}
							</span>
							<StatusBadge label={row.status} tone={row.tone} />
						</a>
					</li>
				))}
			</ul>
			{project.moreText ? (
				<a href={project.treeHref} className="block px-3 py-2 text-sm text-primary">
					{project.moreText}
				</a>
			) : null}
		</div>
	);
}

/** What to tell a user with no project at all: the exact next step (the project CLI owns the registry). */
export const NO_PROJECT_TEXT =
	'No project is registered with the task app-module. Register one with: project add <dir>';
