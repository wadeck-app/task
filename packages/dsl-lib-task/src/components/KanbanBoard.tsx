import React, { useEffect, useMemo, useRef, useState } from 'react';
import { isAbort, postJson, problemText } from '../apiFetch.js';
import { getApiBase } from '../runtime-config.js';
import { isUnreadableAnswer } from '../actionProblem.js';
import { TONE_PILL } from '../tones.js';
import { PILL_RADIUS } from '../ui/tokens.js';
import { useAction } from '../useAction.js';
import type { ActionFailure, ActionHandler } from '../useAction.js';
import { Notice } from './Notice.js';
import type { BoardView, ZoneProps } from '../kanban/BoardParts.js';
import {
	applyMoves,
	isBoardEmpty,
	isVariant,
	normalizeColumns,
	statusOfCard,
	unknownVariantText,
	VARIANT_LABELS,
	VARIANTS,
} from '../kanban/boardModel.js';
import type { BoardCardData, BoardColumnData, KanbanVariant, PendingMove } from '../kanban/boardModel.js';
import { useLiveBoard } from '../kanban/useLiveBoard.js';
import { ColumnsLayout, CompactLayout, RailsLayout, SwimlanesLayout, TabsLayout } from '../kanban/variants.js';

export type { BoardCardData, BoardColumnData, KanbanVariant } from '../kanban/boardModel.js';

export interface KanbanBoardProps {
	/**
	 * The board as the route answers it (`columns` of `GET /tasks/board`): one entry per status in config order, each with
	 * its `cards`. Only the initial state: the board then follows the server by itself. Absent (a contribution to another
	 * module's page, which has none of our sources): the board starts empty, says "Loading board" and fetches `boardPath`.
	 */
	columns?: BoardColumnData[];
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
	/** Route of the event stream (SSE, event `version`), below `apiBase` (default `/board/events`). */
	eventsPath?: string;
	/** Where the module API is mounted; defaults to the one `configureTaskUi` set. */
	apiBase?: string;
	/** Shows the large floating bar that switches the variant (A/B testing); the choice is kept in localStorage. Left out: the `abSwitcher` of the board answer decides; a value given here wins. */
	variantSwitcher?: boolean;
	/** `columns`, `swimlanes`, `compact`, `rails` or `tabs`. Initial variant (the stored choice wins when the switcher is on). */
	defaultVariant?: KanbanVariant;
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

const LAYOUTS = {
	columns: ColumnsLayout,
	swimlanes: SwimlanesLayout,
	compact: CompactLayout,
	rails: RailsLayout,
	tabs: TabsLayout,
} as const;
const STORAGE_KEY = 'task.kanban.variant';
const DEFAULT_POLL_SECONDS = 20;
const LIVE_TEXT = { live: 'Live', reconnecting: 'Reconnecting', polling: 'Polling' } as const;
const LIVE_TONE = { live: 'success', reconnecting: 'warning', polling: 'info' } as const;
const LIVE_HINT = {
	live: 'Cards update by themselves when a task changes',
	reconnecting: 'The live connection is not open; trying again',
	polling: 'No live connection: the board is fetched again every few seconds',
} as const;

interface StoredVariant {
	variant: string;
	note: string | null;
}

/** The saved choice of the switcher; a stale or unreadable one is reported and the default is used. */
function storedVariant(fallback: string): StoredVariant {
	let stored: string | null;
	try {
		stored = window.localStorage.getItem(STORAGE_KEY);
	} catch (error) {
		return {
			variant: fallback,
			note: `The saved variant could not be read (${error instanceof Error ? error.message : String(error)}); using "${fallback}".`,
		};
	}
	if (stored === null) {
		return { variant: fallback, note: null };
	}
	if (isVariant(stored)) {
		return { variant: stored, note: null };
	}
	return {
		variant: fallback,
		note: `The saved variant "${stored}" is not known (valid: ${VARIANTS.join(', ')}); using "${fallback}".`,
	};
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

function VariantSwitcher({
	active,
	onPick,
}: {
	active: string;
	onPick: (variant: KanbanVariant) => void;
}): React.ReactElement {
	return (
		<div
			role="toolbar"
			aria-label="Kanban variant"
			className="fixed bottom-4 left-1/2 z-[1000] flex w-max max-w-[calc(100vw-1rem)] -translate-x-1/2 flex-wrap justify-center gap-2 rounded-xl border border-border bg-surface p-2 shadow-lg"
		>
			{VARIANTS.map((variant, index) => (
				<button
					key={variant}
					type="button"
					aria-pressed={variant === active}
					onClick={() => onPick(variant)}
					className={`h-10 shrink-0 cursor-pointer rounded-md border px-3 sm:px-4 text-sm font-semibold focus-visible:ring-2 focus-visible:ring-primary ${variant === active ? 'border-primary bg-primary text-white' : 'border-border bg-surface text-content hover:bg-muted-bg'}`}
				>
					{`${index + 1} ${VARIANT_LABELS[variant]}`}
				</button>
			))}
		</div>
	);
}

/**
 * A kanban board of the tasks of one project: a column per status, cards moved by drag and drop or with a "Move to"
 * menu on every card, kept up to date by itself (an event stream tells when the board changed, a poll takes over when
 * there is none). Five layouts (`columns`, `swimlanes`, `compact`, `rails`, `tabs`); a move shows at once and goes back,
 * with the reason, when the server refuses it.
 *
 * IN SCOPE: showing and moving the cards of one project. OUT OF SCOPE: editing a task (a card links to its page),
 * changing the statuses or the order of the cards.
 *
 * @registryCategory composite
 * @registryTags kanban board columns status drag cards swimlanes
 */
export function KanbanBoard({
	columns,
	version = '',
	projectParam,
	moveAction,
	movePath = '/tasks/{id}/status',
	idParam = 'cardId',
	boardPath = '/tasks/board',
	eventsPath = '/board/events',
	apiBase,
	variantSwitcher,
	defaultVariant = 'columns',
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
	});
	const mover = useAction('KanbanBoard', moveAction, onAction, actionPending);

	const switcherOn = variantSwitcher ?? live.meta.abSwitcher === true;
	// Read only when the switcher is on, which a contribution only learns from the first answer.
	const stored = useMemo(() => (switcherOn ? storedVariant(defaultVariant) : null), [switcherOn, defaultVariant]);
	const [picked, setPicked] = useState<KanbanVariant | null>(null);
	const [storageNote, setStorageNote] = useState<string | null>(null);
	const [moves, setMoves] = useState<Record<string, PendingMove>>({});
	const [moveNote, setMoveNote] = useState<{ text: string; short: boolean } | null>(null);
	const [overStatus, setOverStatus] = useState<string | null>(null);

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
				const label = (status: string): string => live.columns.find(c => c.status === status)?.label ?? status;
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
		const labelOf = (s: string): string => shown.find(c => c.status === s)?.label ?? s;
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
		startDrag: (event, card: BoardCardData, from) => {
			dragging.current = { id: card.id, from };
			live.holdRef.current = true;
			if (event.dataTransfer) {
				event.dataTransfer.setData('text/plain', card.id);
				event.dataTransfer.effectAllowed = 'move';
			}
		},
		endDrag: () => {
			dragging.current = null;
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
				// The dragged card is drawn in its new column at once, so its element goes away and may never get `dragend`.
				view.endDrag();
				void move(drag.id, status);
			},
			...(overStatus === status ? ({ 'data-drop-target': 'true' } as const) : {}),
		}),
		move: (id, status) => void move(id, status),
	};

	const pickVariant = (variant: KanbanVariant): void => {
		setPicked(variant);
		try {
			window.localStorage.setItem(STORAGE_KEY, variant);
			setStorageNote(null);
		} catch (error) {
			setStorageNote(
				`The variant could not be saved (${error instanceof Error ? error.message : String(error)}); it is back to "${defaultVariant}" after a reload.`
			);
		}
	};

	if (!isVariant(defaultVariant)) {
		return <Notice variant="danger" label={unknownVariantText(defaultVariant, 'defaultVariant')} />;
	}
	const variant = picked ?? stored?.variant ?? defaultVariant;
	if (!isVariant(variant)) {
		return <Notice variant="danger" label={unknownVariantText(variant, 'variant')} />;
	}

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
	addNote('storage', switcherOn ? (storageNote ?? stored?.note ?? null) : null, 'warning');

	const empty = isBoardEmpty(shown);
	const Layout = LAYOUTS[variant];
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
	} else if (empty) {
		content = <p className="m-0 text-sm text-muted">{emptyMessage}</p>;
	} else {
		content = <Layout view={view} />;
	}

	return (
		<div
			data-testid="kanban-board"
			data-variant={variant}
			className={`flex min-w-0 flex-col gap-4 ${switcherOn ? 'pb-28' : ''}`}
		>
			<div className="flex flex-wrap items-center justify-between gap-2">
				{live.meta.tasksHref !== null ? (
					<a href={live.meta.tasksHref} className="text-sm text-primary hover:underline">
						Open in Tasks
					</a>
				) : (
					<span />
				)}
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
			{notes.length > 0 ? <div className="flex flex-col gap-2">{notes}</div> : null}
			{content}
			{switcherOn ? <VariantSwitcher active={variant} onPick={pickVariant} /> : null}
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
