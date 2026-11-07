import React, { useRef, useState } from 'react';
import { ProgressSummary } from './ProgressSummary.js';
import { StatusBadge } from './StatusBadge.js';
import type { Tone } from '../tones.js';
import { useAction } from '../useAction.js';
import type { ActionHandler } from '../useAction.js';

export interface ChecklistRow {
	id: string;
	/** The one-line headline; falls back to `title`. */
	headline?: string;
	title: string;
	status: string;
	/** The status as displayed; falls back to `status`. */
	statusText?: string;
	tone?: Tone;
	/** The task is in a terminal status: its box is checked. */
	terminal: boolean;
	/** An app path; without it the id is not a link. */
	href?: string;
}

export interface TaskChecklistProps {
	/** The sub-tasks, as data. */
	rows: ChecklistRow[];
	/** Name of the `$actions` entry run when a box is checked. Without it the boxes are disabled. */
	doneAction?: string;
	/** Name of the `$actions` entry run when a box is unchecked. Without it only checking is possible. */
	reopenAction?: string;
	/** The status a checked task gets. */
	terminalStatus?: string;
	/** The status an unchecked task gets. Left out of the call when empty (the action decides). */
	reopenStatus?: string;
	/** Name of the `$actions` entry that creates a sub-task (the add row). Without it there is no add row. */
	addAction?: string;
	/** The task the sub-tasks belong to; sent as the parent of a created sub-task. */
	parentId?: string;
	/** Name of the parameter that carries the id of the clicked row. */
	idParam?: string;
	/** Name of the parameter (and body key) that carries the new status. */
	statusParam?: string;
	/** Body key of the title of a new sub-task. */
	titleKey?: string;
	/** Body key of the parent of a new sub-task. */
	parentKey?: string;
	/**
	 * The other `{placeholders}` of the action urls (`id`, `projectParam`...).
	 * @resolveDeep
	 */
	params?: Record<string, unknown>;
	placeholder?: string;
	/** Shown when there is no row. */
	emptyText?: string;
	/**
	 * Runs an action of the page's `$actions`. Defaults to the page's `ctx.onAction`.
	 * @ctxDefault
	 */
	onAction?: ActionHandler;
	/**
	 * Actions currently running, by name. Defaults to the page's `$ctx.$actionPending`.
	 * @ctxDefault $actionPending
	 */
	actionPending?: Record<string, boolean>;
}

/**
 * The sub-tasks of a task as a checklist: a box per task (checked = terminal status), the id, the headline, the
 * status, a progress ring and an inline row to add a sub-task.
 *
 * @registryCategory composite
 * @registryTags checklist subtasks children progress steps
 */
export function TaskChecklist({
	rows,
	doneAction,
	reopenAction,
	terminalStatus,
	reopenStatus,
	addAction,
	parentId,
	idParam = 'id',
	statusParam = 'status',
	titleKey = 'description',
	parentKey = 'parent',
	params,
	placeholder = 'Add sub-task',
	emptyText,
	onAction,
	actionPending,
}: TaskChecklistProps): React.ReactElement {
	const done = useAction('TaskChecklist', doneAction, onAction, actionPending);
	const reopen = useAction('TaskChecklist', reopenAction, onAction, actionPending);
	const adder = useAction('TaskChecklist', addAction, onAction, actionPending);
	const list = Array.isArray(rows) ? rows : [];
	const [changing, setChanging] = useState<string[]>([]);
	const [draft, setDraft] = useState('');
	// A row runs one request at a time: a second click on it while it runs is ignored.
	const changingRef = useRef(new Set<string>());
	const adding = useRef(false);

	const toggle = async (row: ChecklistRow): Promise<void> => {
		if (changingRef.current.has(row.id)) {
			return;
		}
		const checking = !row.terminal;
		const runner = checking ? done : reopen;
		const status = checking ? terminalStatus : reopenStatus;
		const hasStatus = status !== undefined && status !== '';
		changingRef.current.add(row.id);
		setChanging([...changingRef.current]);
		try {
			const call = { ...(params ?? {}), [idParam]: row.id, ...(hasStatus ? { [statusParam]: status } : {}) };
			await runner.run(call, hasStatus ? { [statusParam]: status } : undefined);
		} finally {
			changingRef.current.delete(row.id);
			setChanging([...changingRef.current]);
		}
	};

	const add = async (): Promise<void> => {
		if (adding.current) {
			return;
		}
		const text = draft.trim();
		if (text === '') {
			return;
		}
		adding.current = true;
		try {
			const body: Record<string, unknown> = { [titleKey]: text };
			if (parentId !== undefined && parentId !== '') {
				body[parentKey] = parentId;
			}
			if (await adder.run(params ?? {}, body)) {
				setDraft('');
			}
		} finally {
			adding.current = false;
		}
	};

	const doneCount = list.filter(r => r.terminal).length;
	const showAdd = addAction !== undefined && addAction !== '';

	return (
		<div data-testid="task-checklist" className="flex flex-col gap-2">
			{list.length > 0 ? (
				<ProgressSummary done={doneCount} total={list.length} appearance="ring" />
			) : emptyText ? (
				<p className="text-sm text-muted">{emptyText}</p>
			) : null}
			{list.length > 0 ? (
				<ul className="flex flex-col divide-y divide-border">
					{list.map(row => {
						const runner = row.terminal ? reopen : done;
						const headline = row.headline ?? row.title;
						const rowBusy = changing.includes(row.id);
						return (
							<li
								key={row.id}
								data-testid="checklist-row"
								className="flex items-center gap-2 py-1.5 text-sm"
							>
								<input
									type="checkbox"
									aria-label={`${row.id} ${headline}`}
									checked={row.terminal}
									disabled={!runner.available || rowBusy}
									title={runner.unavailableReason}
									onChange={() => void toggle(row)}
									className="h-4 w-4 shrink-0 cursor-pointer accent-primary disabled:cursor-not-allowed"
								/>
								{row.href ? (
									<a
										href={row.href}
										className="shrink-0 font-mono text-xs text-muted hover:text-content hover:underline"
									>
										{row.id}
									</a>
								) : (
									<span className="shrink-0 font-mono text-xs text-muted">{row.id}</span>
								)}
								<span
									className={`min-w-0 flex-1 truncate ${row.terminal ? 'text-muted line-through' : 'text-content'}`}
									title={headline}
								>
									{headline}
								</span>
								<StatusBadge label={row.statusText ?? row.status} tone={row.tone} />
							</li>
						);
					})}
				</ul>
			) : null}
			{showAdd ? (
				<input
					type="text"
					aria-label="Add sub-task"
					placeholder={placeholder}
					value={draft}
					readOnly={adder.busy}
					aria-busy={adder.busy || undefined}
					title={adder.unavailableReason}
					onChange={event => setDraft(event.target.value)}
					onKeyDown={event => {
						if (event.key === 'Enter') {
							event.preventDefault();
							void add();
						}
					}}
					className="rounded border border-border bg-surface px-2 py-1 text-sm text-content outline-none placeholder:text-muted focus:ring-1 focus:ring-primary read-only:opacity-70"
				/>
			) : null}
		</div>
	);
}
