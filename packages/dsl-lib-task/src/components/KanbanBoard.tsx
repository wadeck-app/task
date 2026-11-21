import React, { useEffect, useMemo, useRef, useState } from 'react';
import { LayoutTemplate, Settings2 } from 'lucide-react';
import { useAbExperiments, useAbTest, useRegisterAbTests } from '@wadeck-app/dsl-ui';
import { deleteJson, isAbort, postJson, problemText, putJson } from '../apiFetch.js';
import { getApiBase } from '../runtime-config.js';
import { isUnreadableAnswer } from '../actionProblem.js';
import { TONE_PILL } from '../tones.js';
import {
	CONTROL_BORDER,
	FIELD_CLASS,
	CONTROL_H,
	CONTROL_RADIUS,
	FOCUS_RING,
	GAP_CONTROLS,
	ICON_SIZE,
	PILL_RADIUS,
	PILL_TEXT,
} from '../ui/tokens.js';
import { useAction } from '../useAction.js';
import type { ActionFailure, ActionHandler } from '../useAction.js';
import { Notice } from './Notice.js';
import type { BoardView, ZoneProps } from '../kanban/BoardParts.js';
import {
	applyMoves,
	FINISHED_FOR_OPTIONS,
	isBoardEmpty,
	isFinishedFor,
	normalizeColumns,
	statusOfCard,
	withSort,
} from '../kanban/boardModel.js';
import type {
	BoardCardData,
	BoardConfigBody,
	BoardColumnData,
	BoardLayoutData,
	BoardStatusData,
	FinishedChoice,
	LayoutColumn,
	PendingMove,
	SortChoice,
} from '../kanban/boardModel.js';
import {
	MIXED_SORT,
	SORT_VARIANT_OPTIONS,
	SORT_VARIANT_PLACE,
	SortBadge,
	SortChips,
	SortHeaderMenu,
	ToolbarSegmented,
	ToolbarSortSelect,
} from '../kanban/sortControls.js';
import type { SortVariant, ToolbarSortValue } from '../kanban/sortControls.js';
import { ColumnsEditor, FINISHED_HINT } from '../kanban/ColumnsEditor.js';
import { CardLayoutEditor } from '../kanban/CardLayoutEditor.js';
import type { CardBody } from '../kanban/cardLayout.js';
import { layoutOf, useLiveBoard } from '../kanban/useLiveBoard.js';
import { BoardColumns } from '../kanban/BoardColumns.js';

export type { BoardCardData, BoardColumnData } from '../kanban/boardModel.js';

export interface KanbanBoardProps {
	/**
	 * The board as the route answers it (`columns` of `GET /tasks/board`): one entry per status in config order, each with
	 * its `cards`. Only the initial state: the board then follows the server by itself. Absent (a contribution to another
	 * module's page, which has none of our sources): the board starts empty, says "Loading board" and fetches `boardPath`.
	 */
	columns?: BoardColumnData[];
	/** The stored layout of the board (`config` of the answer: `{ isDefault, columns: [{ name, statuses, sort? }], card? }`), for the "Configure columns" and "Configure cards" editors, the sort controls and the layout of the cards. Only the first value matters; absent in contribution mode (the fetched answer has it). */
	config?: { isDefault?: boolean; columns?: LayoutColumn[]; finishedFor?: string; card?: unknown };
	/** Every status of the project (`allStatuses` of the answer), for the editor. */
	allStatuses?: BoardStatusData[];
	/** The version of that answer; a `version` event with another value makes the board fetch again. */
	version?: string;
	/**
	 * The project reference, RAW: id, name or alias as the page route has it (`$route.project`). The component encodes it
	 * itself, once, in every url it builds (the page's 8-hex id is URL-safe, so it is unchanged). Without it the board cannot
	 * refresh or move cards.
	 */
	projectParam: string;
	/** Name of the `$actions` entry that changes a status. Called with `idParam`, `projectParam`, `status` in the params and `{ status }` as body. Without it the component moves cards by itself with a request to `movePath`. */
	moveAction?: string;
	/** Route used to move a card when there is no `moveAction`: `POST {apiBase}{movePath}?project=...` with `{status}`; `{id}` is replaced by the encoded card id. */
	movePath?: string;
	/** Name of the param that carries the card id to `moveAction` (default `cardId`: a `{id}` of a body-less action is filled from the page by the shell). */
	idParam?: string;
	/** Route that answers the board, below `apiBase` (default `/tasks/board`). */
	boardPath?: string;
	/** Route that stores the column layout (PUT to save, DELETE to reset), below `apiBase` (default `/board/config`). */
	configPath?: string;
	/** Route that stores the layout of the cards (PUT to save, DELETE to reset), below `apiBase` (default `/board/card`). */
	cardPath?: string;
	/** Route of the event stream (SSE, event `version`), below `apiBase` (default `/board/events`). */
	eventsPath?: string;
	/** Where the module API is mounted; defaults to the one `configureTaskUi` set. */
	apiBase?: string;
	/** The `hiddenNote` of the first answer (tasks in statuses no column lists, which the board does not show); then the board follows the server. */
	hiddenNote?: string | null;
	/** The `finishedNote` of the first answer (finished tasks hidden by `finishedFor`, or shown for want of a date); then the board follows the server. */
	finishedNote?: string | null;
	/** No drag, no "Move to" menu. Left out: the `readOnly` of the board answer, else false. */
	readOnly?: boolean;
	/** Shown when no task exists. Left out: the `emptyText` of the board answer, else "No tasks yet". */
	emptyText?: string;
	/** Seconds between two fetches when the live stream is not available (default 20). */
	pollSeconds?: number;
	/**
	 * The other `{placeholders}` of the move action url.
	 * @resolveDeep
	 */
	params?: Record<string, unknown>;
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

const CONFIGURE_BUTTON_CLASS = `inline-flex ${CONTROL_H} items-center ${GAP_CONTROLS} ${CONTROL_RADIUS} ${CONTROL_BORDER} bg-surface px-3 ${PILL_TEXT} text-content hover:bg-muted-bg ${FOCUS_RING}`;

const DEFAULT_SORT_VARIANT: SortVariant = 'header-menu';
/** A control of the board that saves the board setting. */
type BoardSave = 'sort' | 'finished';
const DEFAULT_POLL_SECONDS = 20;

const LIVE_TEXT = { live: 'Live', reconnecting: 'Reconnecting', polling: 'Polling' } as const;
const LIVE_TONE = { live: 'success', reconnecting: 'warning', polling: 'info' } as const;
const LIVE_HINT = {
	live: 'Cards update by themselves when a task changes',
	reconnecting: 'The live connection is not open; trying again',
	polling: 'No live connection: the board is fetched again every few seconds',
} as const;

/** The layout the page gave with its first columns (unknown keys dropped, like a fetched answer), or null when it gave none. */
function initialLayout(
	config: KanbanBoardProps['config'],
	allStatuses: KanbanBoardProps['allStatuses']
): BoardLayoutData | null {
	return config === undefined ? null : layoutOf({ config, allStatuses });
}

/** The sort the columns of the layout share, or MIXED_SORT when they differ. */
function sharedSort(columns: readonly LayoutColumn[]): ToolbarSortValue {
	const sorts = new Set(columns.map(column => column.sort ?? ''));
	return sorts.size === 1 ? ([...sorts][0] as SortChoice) : MIXED_SORT;
}

/** Moves a card with a request of its own (no page action): resolves the failure, null when it worked. */
async function moveByRequest(
	apiBase: string,
	movePath: string,
	projectParam: string,
	id: string,
	status: string
): Promise<ActionFailure | null> {
	const path = movePath.replace('{id}', encodeURIComponent(id));
	try {
		await postJson(path, { project: projectParam }, { status }, { apiBase });
		return null;
	} catch (error) {
		if (isAbort(error)) {
			return { kind: 'thrown', message: 'The request was cancelled' };
		}
		return { kind: 'answer', message: problemText(error) };
	}
}

/**
 * A kanban board of the tasks of one project: a column per status, cards moved by drag and drop or with a "Move to"
 * menu on every card, kept up to date by itself (an event stream tells when the board changed, a poll takes over when
 * there is none). While a card is dragged, every column is covered by one drop band per status (equal heights, in the
 * column's order); a move shows at once and goes back, with the reason, when the server refuses it. A column can be sorted
 * (status, priority, assignee, oldest, newest); a sort that forms groups opens each group with a rule and a pill.
 * Statuses no column lists are not on the board; one muted line (`hiddenNote`) counts their tasks.
 *
 * IN SCOPE: showing and moving the cards of one project, the sort of each column. OUT OF SCOPE: editing a task (a card
 * links to its page), changing the statuses, placing a card by hand inside a column.
 *
 * @registryCategory composite
 * @registryTags kanban board columns status drag cards
 */
export function KanbanBoard({
	columns,
	config,
	allStatuses,
	version = '',
	projectParam,
	moveAction,
	movePath = '/tasks/{id}/status',
	idParam = 'cardId',
	boardPath = '/tasks/board',
	eventsPath = '/board/events',
	configPath = '/board/config',
	cardPath = '/board/card',
	apiBase,
	hiddenNote,
	finishedNote,
	readOnly,
	emptyText,
	pollSeconds = DEFAULT_POLL_SECONDS,
	params,
	onAction,
	actionPending,
}: KanbanBoardProps): React.ReactElement {
	const initial = useMemo((): { columns: BoardColumnData[] | undefined; problem: string | null } => {
		if (columns === undefined) {
			return { columns: undefined, problem: null };
		}
		try {
			return { columns: normalizeColumns(columns), problem: null };
		} catch (error) {
			return {
				columns: [],
				problem: `KanbanBoard: columns is not valid: ${error instanceof Error ? error.message : String(error)}.`,
			};
		}
		// Only the first value matters: the board follows the server after that.
	}, []);
	const validPoll = typeof pollSeconds === 'number' && Number.isFinite(pollSeconds) && pollSeconds > 0;
	const live = useLiveBoard({
		columns: initial.columns,
		version,
		projectParam: projectParam ?? '',
		boardPath,
		eventsPath,
		apiBase: apiBase ?? getApiBase(),
		pollSeconds: validPoll ? pollSeconds : DEFAULT_POLL_SECONDS,
		layout: initialLayout(config, allStatuses),
		hiddenNote: hiddenNote ?? null,
		finishedNote: finishedNote ?? null,
	});
	const mover = useAction('KanbanBoard', moveAction, onAction, actionPending);

	// The A/B row of the board, in the shell's shared dock. Its choice applies only while that dock is on: without it (no
	// host, or the shell runs without --ab-tests) the board shows the initial option, whatever a past session stored.
	const sortTest = useAbTest<SortVariant>({
		id: 'board-sort-control',
		label: 'Board columns: sort control',
		options: SORT_VARIANT_OPTIONS,
		initial: DEFAULT_SORT_VARIANT,
	});
	useRegisterAbTests([sortTest]);
	const abOn = useAbExperiments()?.enabled === true;

	const [moves, setMoves] = useState<Record<string, PendingMove>>({});
	const [moveNote, setMoveNote] = useState<{ text: string; short: boolean } | null>(null);
	const [overStatus, setOverStatus] = useState<string | null>(null);
	// The card being dragged: state (the drop areas appear while it is set) and a ref (the handlers read it without waiting for a render).
	const [dragState, setDragState] = useState<{ id: string; from: string } | null>(null);
	const [configuring, setConfiguring] = useState(false);
	const [configBusy, setConfigBusy] = useState(false);
	const [configError, setConfigError] = useState<string | null>(null);
	// The editor of the layout of the cards: open, saving, and the last refused save or reset.
	const [cardsOpen, setCardsOpen] = useState(false);
	const [cardBusy, setCardBusy] = useState(false);
	const [cardError, setCardError] = useState<string | null>(null);
	// The last refused save of a sort picked on the board (the editor shows its own error).
	const [sortError, setSortError] = useState<string | null>(null);
	// Which control of the board is saving (its own pending text), null when none is.
	const [boardSave, setBoardSave] = useState<BoardSave | null>(null);

	const movesRef = useRef(moves);
	movesRef.current = moves;
	const inFlight = useRef(new Set<string>());
	const dragging = useRef<{ id: string; from: string } | null>(null);
	const mounted = useRef(true);
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);

	const hasProject = (projectParam ?? '') !== '';
	const hasMoveAction = moveAction !== undefined && moveAction !== '';
	const isReadOnly = readOnly ?? live.meta.readOnly ?? false;
	const canMove = !isReadOnly && hasProject && (hasMoveAction ? mover.available : true);
	const shown = useMemo(() => applyMoves(live.columns, moves), [live.columns, moves]);

	// The server spoke: a move that was waiting for it is confirmed, or it was not applied and the card goes back.
	useEffect(() => {
		if (live.generation === 0) {
			return;
		}
		const settled = Object.entries(movesRef.current).filter(([, move]) => move.settled);
		if (settled.length === 0) {
			return;
		}
		const notes: string[] = [];
		for (const [id, move] of settled) {
			const actual = statusOfCard(live.columns, id);
			if (actual !== undefined && actual !== move.to) {
				const label = (status: string): string => status;
				notes.push(
					`Task ${id} was sent to "${label(move.to)}" but the server still shows it in "${label(actual)}", so it was put back. Open the task to check its status, then try again.`
				);
			}
		}
		setMoves(current => {
			const next = { ...current };
			for (const [id] of settled) {
				delete next[id];
			}
			return next;
		});
		if (notes.length > 0) {
			setMoveNote({ text: notes.join(' '), short: false });
		}
	}, [live.generation, live.columns]);

	const move = async (id: string, status: string): Promise<void> => {
		if (!canMove || inFlight.current.has(id)) {
			return;
		}
		const from = statusOfCard(shown, id);
		if (from === undefined || from === status) {
			return;
		}
		const labelOf = (s: string): string => s;
		inFlight.current.add(id);
		setMoveNote(null);
		setMoves(current => ({ ...current, [id]: { to: status, settled: false } }));
		let failure: ActionFailure | null;
		if (hasMoveAction) {
			const ok = await mover.run({ ...(params ?? {}), projectParam, [idParam]: id, status }, { status });
			failure = ok ? null : (mover.lastFailure() ?? { kind: 'answer', message: '' });
		} else {
			failure = await moveByRequest(apiBase ?? getApiBase(), movePath, projectParam, id, status);
		}
		inFlight.current.delete(id);
		if (!mounted.current) {
			return;
		}
		if (failure !== null) {
			setMoves(current => {
				const next = { ...current };
				delete next[id];
				return next;
			});
			// With a page action the page shows the reason itself (one place); the board only marks that the card went back.
			setMoveNote(
				hasMoveAction
					? {
							text: `Move of ${id} to "${labelOf(status)}" failed: the card went back. The page shows the reason.`,
							short: true,
						}
					: { text: moveFailureText(id, labelOf(status), failure), short: false }
			);
			return;
		}
		setMoves(current => ({ ...current, [id]: { to: status, settled: true } }));
		await live.refetch(true);
	};

	const view: BoardView = {
		columns: shown,
		readOnly: !canMove,
		busy: new Set(
			Object.entries(moves)
				.filter(([, m]) => !m.settled)
				.map(([id]) => id)
		),
		overStatus,
		dragging: dragState,
		startDrag: (event, card: BoardCardData, from) => {
			dragging.current = { id: card.id, from };
			setDragState({ id: card.id, from });
			live.holdRef.current = true;
			if (event.dataTransfer) {
				event.dataTransfer.setData('text/plain', card.id);
				event.dataTransfer.effectAllowed = 'move';
			}
		},
		endDrag: () => {
			dragging.current = null;
			setDragState(null);
			setOverStatus(null);
			live.release();
		},
		zone: (status): ZoneProps => ({
			onDragOver: event => {
				const drag = dragging.current;
				if (!drag || drag.from === status || !canMove) {
					return;
				}
				event.preventDefault();
				// A band is the target of its status alone.
				event.stopPropagation();
				if (event.dataTransfer) {
					event.dataTransfer.dropEffect = 'move';
				}
				setOverStatus(status);
			},
			onDragLeave: event => {
				const next = event.relatedTarget;
				if (!(next instanceof Node) || !event.currentTarget.contains(next)) {
					setOverStatus(current => (current === status ? null : current));
				}
			},
			onDrop: event => {
				const drag = dragging.current;
				if (!drag || drag.from === status || !canMove) {
					return;
				}
				event.preventDefault();
				event.stopPropagation();
				// The dragged card is drawn in its new column at once, so its element goes away and may never get `dragend`.
				view.endDrag();
				void move(drag.id, status);
			},
			...(overStatus === status ? ({ 'data-drop-target': 'true' } as const) : {}),
		}),
		move: (id, status) => void move(id, status),
	};

	/**
	 * Stores the whole board setting (columns and `finishedFor`, one PUT): from the editor, or from a control of the board with
	 * one changed sort (`sort`) or a changed window of the finished tasks (`finished`).
	 */
	const saveLayout = async (body: BoardConfigBody, from: 'editor' | BoardSave = 'editor'): Promise<void> => {
		setConfigBusy(true);
		setBoardSave(from === 'editor' ? null : from);
		setConfigError(null);
		setSortError(null);
		try {
			await putJson(configPath, { project: projectParam }, body, { apiBase: apiBase ?? getApiBase() });
			await live.refetch(true);
			if (mounted.current) {
				setConfiguring(false);
			}
		} catch (error) {
			if (mounted.current) {
				if (from === 'sort') {
					setSortError(`The sort was not saved: ${problemText(error)}`);
				} else if (from === 'finished') {
					setSortError(`The finished tasks setting was not saved: ${problemText(error)}`);
				} else {
					setConfigError(`The columns were not saved: ${problemText(error)}`);
				}
			}
		} finally {
			if (mounted.current) {
				setConfigBusy(false);
				setBoardSave(null);
			}
		}
	};

	const resetLayout = async (): Promise<void> => {
		setConfigBusy(true);
		setConfigError(null);
		try {
			await deleteJson(configPath, { project: projectParam }, { apiBase: apiBase ?? getApiBase() });
			await live.refetch(true);
			if (mounted.current) {
				setConfiguring(false);
			}
		} catch (error) {
			if (mounted.current) {
				setConfigError(`The columns were not reset: ${problemText(error)}`);
			}
		} finally {
			if (mounted.current) {
				setConfigBusy(false);
			}
		}
	};

	/** Stores the layout of the cards (PUT, the whole board comes back through the refetch) and closes the editor. */
	const saveCard = async (body: CardBody): Promise<void> => {
		setCardBusy(true);
		setCardError(null);
		try {
			await putJson(cardPath, { project: projectParam }, body, { apiBase: apiBase ?? getApiBase() });
			await live.refetch(true);
			if (mounted.current) {
				setCardsOpen(false);
			}
		} catch (error) {
			if (mounted.current) {
				setCardError(`The cards were not saved: ${problemText(error)}`);
			}
		} finally {
			if (mounted.current) {
				setCardBusy(false);
			}
		}
	};

	const resetCard = async (): Promise<void> => {
		setCardBusy(true);
		setCardError(null);
		try {
			await deleteJson(cardPath, { project: projectParam }, { apiBase: apiBase ?? getApiBase() });
			await live.refetch(true);
			if (mounted.current) {
				setCardsOpen(false);
			}
		} catch (error) {
			if (mounted.current) {
				setCardError(`The cards were not reset: ${problemText(error)}`);
			}
		} finally {
			if (mounted.current) {
				setCardBusy(false);
			}
		}
	};

	const notes: React.ReactElement[] = [];
	const addNote = (key: string, label: string | null, tone: 'danger' | 'warning'): void => {
		if (label) {
			notes.push(<Notice key={key} variant={tone} label={label} />);
		}
	};
	addNote('columns', live.generation === 0 ? initial.problem : null, 'danger');
	if (moveNote !== null && moveNote.short) {
		notes.push(
			<p key="move" role="status" data-testid="kanban-move-failed" className="m-0 text-xs text-muted">
				{moveNote.text}
			</p>
		);
	} else if (moveNote !== null) {
		// Stays until the next move starts or the user dismisses it.
		notes.push(
			<div key="move" className="flex items-start gap-2">
				<div className="min-w-0 flex-1">
					<Notice variant="danger" label={moveNote.text} />
				</div>
				<button
					type="button"
					aria-label="Dismiss message"
					onClick={() => setMoveNote(null)}
					className="h-8 shrink-0 cursor-pointer rounded-md border border-border bg-surface px-3 text-sm text-content hover:bg-muted-bg focus-visible:ring-2 focus-visible:ring-primary"
				>
					Dismiss
				</button>
			</div>
		);
	}
	addNote('refresh', live.problem, 'danger');
	addNote('warning', live.meta.warning, 'warning');
	addNote(
		'project',
		hasProject ? null : 'KanbanBoard: projectParam is missing, so the board cannot refresh or move cards.',
		'warning'
	);
	addNote(
		'action',
		hasMoveAction && !isReadOnly && hasProject && !mover.available
			? `KanbanBoard: cards cannot be moved (${mover.unavailableReason ?? 'moveAction is not set'}).`
			: null,
		'warning'
	);
	addNote(
		'poll',
		validPoll
			? null
			: `KanbanBoard: pollSeconds must be a positive number (got ${String(pollSeconds)}); using ${DEFAULT_POLL_SECONDS}.`,
		'warning'
	);
	// An editor of the board (columns or cards) is open: the controls of the board itself are not offered.
	const editing = configuring || cardsOpen;
	addNote('sort', editing ? null : sortError, 'danger');

	// The layout is the project's config: offered where the cards can be moved, once the answer carried it.
	const canConfigure = !isReadOnly && hasProject && live.loaded && live.meta.layout !== null;

	// The sort control: the dock picks it while it is on, else the initial option.
	const sortVariant: SortVariant = abOn ? sortTest.value : DEFAULT_SORT_VARIANT;
	const layoutColumns = live.meta.layout?.columns ?? [];
	const finishedFor = live.meta.layout?.finishedFor;
	// Any save started from the board disables every board control until it ends.
	const sortBusy = configBusy && !configuring;
	const pickSort = (names: string[] | null, choice: SortChoice): void => {
		if (!canConfigure || configBusy) {
			return;
		}
		// The window of the finished tasks travels with the columns: a PUT without it would remove it.
		void saveLayout(
			{ columns: withSort(layoutColumns, names, choice), ...(finishedFor === undefined ? {} : { finishedFor }) },
			'sort'
		);
	};
	const pickFinished = (choice: FinishedChoice): void => {
		if (!canConfigure || configBusy) {
			return;
		}
		void saveLayout({ columns: layoutColumns, ...(choice === 'none' ? {} : { finishedFor: choice }) }, 'finished');
	};
	const finishedControl =
		canConfigure && !editing ? (
			<label className={`inline-flex items-center ${GAP_CONTROLS} ${PILL_TEXT} text-content`}>
				<span className="text-xs text-muted">Finished</span>
				<select
					aria-label="Finished tasks shown for"
					title={FINISHED_HINT}
					value={finishedFor ?? 'none'}
					disabled={sortBusy}
					aria-busy={boardSave === 'finished' || undefined}
					onChange={event => {
						const value = event.target.value;
						pickFinished(isFinishedFor(value) ? value : 'none');
					}}
					className={`${FIELD_CLASS} cursor-pointer text-xs`}
				>
					{FINISHED_FOR_OPTIONS.map(option => (
						<option key={option.value} value={option.value}>
							{option.label}
						</option>
					))}
				</select>
			</label>
		) : null;
	// Only a column of the stored layout has a sort to change.
	const sortable = (column: BoardColumnData): boolean =>
		canConfigure && layoutColumns.some(entry => entry.name === column.key);
	const place = SORT_VARIANT_PLACE[sortVariant];
	if (sortVariant === 'header-menu') {
		view.headerControl = column =>
			sortable(column) ? (
				<SortHeaderMenu
					columnLabel={column.label}
					current={column.sort}
					busy={sortBusy}
					onPick={choice => pickSort([column.key], choice)}
				/>
			) : null;
	} else if (sortVariant === 'chips') {
		view.belowHeader = column =>
			sortable(column) ? (
				<SortChips
					columnLabel={column.label}
					current={column.sort}
					busy={sortBusy}
					onPick={choice => pickSort([column.key], choice)}
				/>
			) : null;
	} else if (sortVariant === 'editor-only') {
		view.headerControl = column => <SortBadge sort={column.sort} />;
	}
	const toolbarSort =
		place === 'toolbar' && canConfigure && !editing && layoutColumns.length > 0 ? (
			sortVariant === 'toolbar-select' ? (
				<ToolbarSortSelect
					value={sharedSort(layoutColumns)}
					busy={sortBusy}
					onPick={choice => pickSort(null, choice)}
				/>
			) : (
				<ToolbarSegmented
					value={sharedSort(layoutColumns)}
					busy={sortBusy}
					onPick={choice => pickSort(null, choice)}
				/>
			)
		) : null;
	// The saved layout of the cards: every card of the board is drawn with it (absent = the usual card).
	view.cardLayout = live.meta.layout?.card;
	const empty = isBoardEmpty(shown);
	const emptyMessage = emptyText ?? live.meta.emptyText ?? 'No tasks yet';
	let content: React.ReactElement | null;
	if (live.loading) {
		content = (
			<p role="status" className="m-0 text-sm text-muted">
				Loading board
			</p>
		);
	} else if (live.meta.blank || !live.loaded) {
		// Nothing to show (a blank answer), or the first load failed: the notice above says why.
		content = null;
	} else if (configuring && live.meta.layout !== null) {
		content = (
			<ColumnsEditor
				layout={live.meta.layout}
				busy={configBusy}
				error={configError}
				onSave={body => void saveLayout(body, 'editor')}
				onReset={() => void resetLayout()}
				onCancel={() => {
					setConfiguring(false);
					setConfigError(null);
				}}
			/>
		);
	} else if (cardsOpen && live.meta.layout !== null) {
		content = (
			<CardLayoutEditor
				layout={live.meta.layout.card}
				columns={live.columns}
				busy={cardBusy}
				error={cardError}
				onSave={body => void saveCard(body)}
				onReset={() => void resetCard()}
				onCancel={() => {
					setCardsOpen(false);
					setCardError(null);
				}}
			/>
		);
	} else if (empty) {
		content = <p className="m-0 text-sm text-muted">{emptyMessage}</p>;
	} else {
		content = <BoardColumns view={view} />;
	}

	return (
		<div data-testid="kanban-board" data-sort-variant={sortVariant} className="flex min-w-0 flex-col gap-4">
			<div className="flex flex-wrap items-center justify-between gap-2">
				{live.meta.tasksHref !== null ? (
					<a href={live.meta.tasksHref} data-testid="kanban-open-tasks" className={CONFIGURE_BUTTON_CLASS}>
						Open in Tasks
					</a>
				) : (
					<span />
				)}
				<div className="flex flex-wrap items-center gap-2">
					{toolbarSort}
					{finishedControl}
					{sortBusy && boardSave === 'sort' ? (
						<span role="status" data-testid="kanban-sort-pending" className="text-xs text-muted">
							Saving the sort
						</span>
					) : null}
					{sortBusy && boardSave === 'finished' ? (
						<span role="status" data-testid="kanban-finished-pending" className="text-xs text-muted">
							Saving the finished tasks setting
						</span>
					) : null}
					{canConfigure && !editing ? (
						<button
							type="button"
							data-testid="kanban-configure-cards"
							onClick={() => {
								setCardError(null);
								setCardsOpen(true);
							}}
							className={CONFIGURE_BUTTON_CLASS}
						>
							<LayoutTemplate size={ICON_SIZE} aria-hidden="true" />
							Configure cards
						</button>
					) : null}
					{canConfigure && !editing ? (
						<button
							type="button"
							data-testid="kanban-configure"
							onClick={() => {
								setConfigError(null);
								setConfiguring(true);
							}}
							className={CONFIGURE_BUTTON_CLASS}
						>
							<Settings2 size={ICON_SIZE} aria-hidden="true" />
							Configure columns
						</button>
					) : null}
					{hasProject ? (
						<span
							data-testid="kanban-live"
							title={LIVE_HINT[live.link]}
							className={`inline-flex items-center ${PILL_RADIUS} px-2 text-xs font-medium ${TONE_PILL[LIVE_TONE[live.link]]}`}
						>
							{LIVE_TEXT[live.link]}
						</span>
					) : null}
				</div>
			</div>
			{live.meta.hiddenNote !== null && !live.meta.blank ? (
				<p role="status" data-testid="kanban-hidden-note" className="m-0 text-xs text-muted">
					{live.meta.hiddenNote}
				</p>
			) : null}
			{live.meta.finishedNote !== null && !live.meta.blank ? (
				<p role="status" data-testid="kanban-finished-note" className="m-0 text-xs text-muted">
					{live.meta.finishedNote}
				</p>
			) : null}
			{notes.length > 0 ? <div className="flex flex-col gap-2">{notes}</div> : null}
			{content}
		</div>
	);
}

function moveFailureText(
	id: string,
	label: string,
	failure: ReturnType<ReturnType<typeof useAction>['lastFailure']>
): string {
	if (isUnreadableAnswer(failure)) {
		return `Task ${id} was not moved to "${label}". The server did not answer with JSON: the task backend or app-core is probably restarting or unreachable. It is back in its column; try again in a few seconds.`;
	}
	if (failure !== null && failure.message !== '') {
		return `Task ${id} was not moved to "${label}": ${failure.message}. It is back in its column.`;
	}
	return `Task ${id} was not moved to "${label}". The server gave no reason: check that the task module is running and open the task to see its state. It is back in its column.`;
}
