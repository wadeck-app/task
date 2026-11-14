import { Plus, Unlink } from 'lucide-react';
import React, { useRef, useState } from 'react';
import { ProgressSummary } from './ProgressSummary.js';
import { StatusBadge } from './StatusBadge.js';
import type { Tone } from '../tones.js';
import { addProblemText } from '../actionProblem.js';
import { useAction } from '../useAction.js';
import { useRefocus } from '../useRefocus.js';
import {
	CONTROL_H,
	CONTROL_RADIUS,
	CONTROL_SQUARE,
	FIELD_CLASS,
	FOCUS_RING,
	GAP_CONTROLS,
	ICON_SIZE,
} from '../ui/tokens.js';
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
	/**
	 * Name of the `$actions` entry run by the icon button at the end of each row, which breaks the link with the parent.
	 * It gets the id of the row in `idParam` (`DELETE /tasks/{id}/parent`). Without it there is no button.
	 */
	detachAction?: string;
	/** Tooltip and accessible name prefix of the detach button; the id of the row is appended to the name. */
	detachLabel?: string;
	/**
	 * Name of the parameter that carries the id of the row to `detachAction` (default `id`). A page whose own task is `{id}`
	 * uses another name (`childId`): the shell fills a `{id}` of a body-less action from the page, not from the row.
	 */
	detachIdParam?: string;
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
	/** `ring` (default): a circle with the percentage. `bar`: a bar with "done of total". `none`: nothing. */
	progress?: 'ring' | 'bar' | 'none';
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

// @formatter:off
const DETACH_CLASS = `inline-flex ${CONTROL_SQUARE} shrink-0 items-center justify-center ${CONTROL_RADIUS} text-muted hover:bg-muted-bg hover:text-danger ${FOCUS_RING} disabled:cursor-not-allowed disabled:opacity-40`;
const BOX_CLASS = 'h-4 w-4 shrink-0 cursor-pointer accent-primary disabled:cursor-not-allowed';
// @formatter:on

/**
 * The sub-tasks of a task as a checklist: a box per task (checked = terminal status), the id, the headline, the status, an
 * optional button that detaches the task from its parent, a progress summary and a way to add a sub-task (the last row of
 * the list, a plus in the box column).
 *
 * @registryCategory composite
 * @registryTags checklist subtasks children progress steps detach
 */
export function TaskChecklist({
	rows,
	doneAction,
	reopenAction,
	terminalStatus,
	reopenStatus,
	addAction,
	detachAction,
	detachLabel = 'Detach from parent',
	detachIdParam = 'id',
	parentId,
	idParam = 'id',
	statusParam = 'status',
	titleKey = 'description',
	parentKey = 'parent',
	params,
	placeholder = 'Add sub-task',
	progress = 'ring',
	emptyText,
	onAction,
	actionPending,
}: TaskChecklistProps): React.ReactElement {
	const done = useAction('TaskChecklist', doneAction, onAction, actionPending);
	const reopen = useAction('TaskChecklist', reopenAction, onAction, actionPending);
	const adder = useAction('TaskChecklist', addAction, onAction, actionPending);
	const detacher = useAction('TaskChecklist', detachAction, onAction, actionPending);
	const list = Array.isArray(rows) ? rows : [];
	const [changing, setChanging] = useState<string[]>([]);
	const [draft, setDraft] = useState('');
	// A row runs one request at a time: a second click on it while it runs is ignored.
	const changingRef = useRef(new Set<string>());
	const adding = useRef(false);
	// Why the last add failed, in words; the text stays in the field.
	const [problem, setProblem] = useState<string | null>(null);
	const root = useRef<HTMLDivElement>(null);
	// The field takes the focus back after a successful add (also when it is drawn again: the first sub-task of an empty list).
	const { fieldRef, refocus } = useRefocus<HTMLInputElement>(root);

	const guarded = async (row: ChecklistRow, work: () => Promise<unknown>): Promise<void> => {
		if (changingRef.current.has(row.id)) {
			return;
		}
		changingRef.current.add(row.id);
		setChanging([...changingRef.current]);
		try {
			await work();
		} finally {
			changingRef.current.delete(row.id);
			setChanging([...changingRef.current]);
		}
	};

	const toggle = (row: ChecklistRow): Promise<void> =>
		guarded(row, () => {
			const checking = !row.terminal;
			const runner = checking ? done : reopen;
			const status = checking ? terminalStatus : reopenStatus;
			const hasStatus = status !== undefined && status !== '';
			const call = { ...(params ?? {}), [idParam]: row.id, ...(hasStatus ? { [statusParam]: status } : {}) };
			return runner.run(call, hasStatus ? { [statusParam]: status } : undefined);
		});

	const detach = (row: ChecklistRow): Promise<void> =>
		guarded(row, () => detacher.run({ ...(params ?? {}), [detachIdParam]: row.id }));

	const add = async (): Promise<void> => {
		if (adding.current) {
			return;
		}
		const text = draft.trim();
		if (text === '') {
			return;
		}
		adding.current = true;
		setProblem(null);
		try {
			const body: Record<string, unknown> = { [titleKey]: text };
			if (parentId !== undefined && parentId !== '') {
				body[parentKey] = parentId;
			}
			if (await adder.run(params ?? {}, body)) {
				setDraft('');
				refocus();
			} else {
				setProblem(addProblemText('The sub-task', adder.lastFailure()));
			}
		} finally {
			adding.current = false;
		}
	};

	const doneCount = list.filter(r => r.terminal).length;
	const showAdd = addAction !== undefined && addAction !== '';
	const showDetach = detachAction !== undefined && detachAction !== '';

	const addField = (extraClass: string): React.ReactElement => (
		<input
			ref={fieldRef}
			type="text"
			aria-label="Add sub-task"
			placeholder={placeholder}
			value={draft}
			readOnly={adder.busy}
			aria-busy={adder.busy || undefined}
			title={adder.unavailableReason}
			onChange={event => {
				setDraft(event.target.value);
				setProblem(null);
			}}
			onKeyDown={event => {
				if (event.key === 'Enter') {
					event.preventDefault();
					void add();
				}
			}}
			className={`${FIELD_CLASS} ${extraClass}`}
		/>
	);

	const idCell = (row: ChecklistRow): React.ReactElement =>
		row.href ? (
			<a href={row.href} className="shrink-0 font-mono text-xs text-muted hover:text-content hover:underline">
				{row.id}
			</a>
		) : (
			<span className="shrink-0 font-mono text-xs text-muted">{row.id}</span>
		);

	const box = (row: ChecklistRow): React.ReactElement => {
		const runner = row.terminal ? reopen : done;
		const headline = row.headline ?? row.title;
		return (
			<input
				type="checkbox"
				aria-label={`${row.id} ${headline}`}
				checked={row.terminal}
				disabled={!runner.available || changing.includes(row.id)}
				title={runner.unavailableReason}
				onChange={() => void toggle(row)}
				className={BOX_CLASS}
			/>
		);
	};

	const headlineCell = (row: ChecklistRow): React.ReactElement => {
		const headline = row.headline ?? row.title;
		return (
			<span
				className={`min-w-0 flex-1 truncate ${row.terminal ? 'text-muted line-through' : 'text-content'}`}
				title={headline}
			>
				{headline}
			</span>
		);
	};

	const detachButton = (row: ChecklistRow): React.ReactElement | null =>
		showDetach ? (
			<button
				type="button"
				data-testid="checklist-detach"
				aria-label={`${detachLabel} ${row.id}`}
				title={detacher.unavailableReason ?? detachLabel}
				disabled={!detacher.available || changing.includes(row.id)}
				onClick={() => void detach(row)}
				className={DETACH_CLASS}
			>
				<Unlink size={ICON_SIZE} aria-hidden="true" />
			</button>
		) : null;

	const statusCell = (row: ChecklistRow): React.ReactElement => (
		<StatusBadge label={row.statusText ?? row.status} tone={row.tone} />
	);

	return (
		<div ref={root} data-testid="task-checklist" className="flex flex-col gap-2">
			{list.length > 0 ? (
				progress === 'none' ? null : (
					<ProgressSummary
						done={doneCount}
						total={list.length}
						appearance={progress === 'bar' ? 'bar' : 'ring'}
					/>
				)
			) : emptyText ? (
				<p className="text-sm text-muted">{emptyText}</p>
			) : null}
			{list.length > 0 ? (
				<ul className="m-0 flex list-none flex-col divide-y divide-border p-0">
					{list.map(row => (
						<li key={row.id} data-testid="checklist-row" className="py-1">
							<div className={`flex ${CONTROL_H} items-center ${GAP_CONTROLS} text-sm`}>
								{box(row)}
								{idCell(row)}
								{headlineCell(row)}
								{statusCell(row)}
								{detachButton(row)}
							</div>
						</li>
					))}
					{showAdd ? (
						<li data-testid="checklist-add-row" className="py-1">
							<div className={`flex ${CONTROL_H} items-center ${GAP_CONTROLS} text-sm`}>
								<Plus size={ICON_SIZE} aria-hidden="true" className="w-4 shrink-0 text-muted" />
								{addField('min-w-0 flex-1')}
							</div>
						</li>
					) : null}
				</ul>
			) : null}
			{showAdd && list.length === 0 ? (
				<div
					data-testid="checklist-add-row"
					className={`flex ${CONTROL_H} items-center ${GAP_CONTROLS} text-sm`}
				>
					<Plus size={ICON_SIZE} aria-hidden="true" className="w-4 shrink-0 text-muted" />
					{addField('min-w-0 flex-1')}
				</div>
			) : null}
			{problem ? (
				<p role="alert" className="text-xs text-warning-text">
					{problem}
				</p>
			) : null}
		</div>
	);
}
