import { useCallback, useEffect, useRef, useState } from 'react';
import { getJson, isAbort, problemText } from '../apiFetch.js';
import { isColumnSort, isFinishedFor, isGroupStyle, normalizeColumns } from './boardModel.js';
import type { BoardColumnData, BoardLayoutData, BoardStatusData } from './boardModel.js';

export type LiveState = 'live' | 'reconnecting' | 'polling';

/** Stream errors in a row (no open between them) after which the stream is given up for polling. */
export const MAX_STREAM_ERRORS = 3;

export interface LiveBoardOptions {
	/** The first cards; undefined = none yet, the board is fetched at mount. */
	columns: BoardColumnData[] | undefined;
	version: string;
	/** Empty: the board cannot refresh (the component says so). */
	projectParam: string;
	boardPath: string;
	eventsPath: string;
	/** Where the module API is mounted, already resolved (may be empty). */
	apiBase: string;
	pollSeconds: number;
	/** The layout of the first answer (the page gives it with the first columns); the board then follows the server. */
	layout?: BoardLayoutData | null;
	/** The `hiddenNote` of the first answer (the page gives it with the first columns). */
	hiddenNote?: string | null;
	/** The `finishedNote` of the first answer. */
	finishedNote?: string | null;
}

export interface LiveBoard {
	columns: BoardColumnData[];
	version: string;
	/** The first fetch is running (no initial columns were given). */
	loading: boolean;
	/** An answer was applied (initial columns count). */
	loaded: boolean;
	/** What the last applied answer said besides the cards. */
	meta: BoardMeta;
	/** Counts the answers applied: a change tells the board that the server spoke. */
	generation: number;
	link: LiveState;
	/** Why the last refresh failed, in words; null after a good one. */
	problem: string | null;
	/**
	 * Fetches the board now. Without `force` an answer with the version already shown changes nothing. Resolves false when
	 * the fetch failed (the problem is set), true otherwise.
	 */
	refetch: (force?: boolean) => Promise<boolean>;
	/** While true an answer waits instead of replacing the cards (a card is being dragged). */
	holdRef: { current: boolean };
	/** Ends the hold and applies the answer that waited, if any. */
	release: () => void;
}

/** The version a `version` event carries: the plain text, or a JSON string, or a JSON object with `version`. */
export function versionOfEvent(data: string | undefined): string | undefined {
	if (data === undefined || data === '') {
		return undefined;
	}
	try {
		const parsed: unknown = JSON.parse(data);
		if (typeof parsed === 'string') {
			return parsed;
		}
		if (typeof parsed === 'number') {
			return String(parsed);
		}
		if (typeof parsed === 'object' && parsed !== null) {
			const version = (parsed as { version?: unknown }).version;
			return typeof version === 'string' || typeof version === 'number' ? String(version) : undefined;
		}
	} catch {
		// Not JSON: the text itself is the version.
	}
	return data;
}

/** The fields of a board answer that are not cards. */
export interface BoardMeta {
	/** The answer was `{blank: true}`: nothing to show. */
	blank: boolean;
	warning: string | null;
	tasksHref: string | null;
	emptyText: string | null;
	/** One sentence counting the tasks in statuses no column lists (they are not on the board); null when there are none. */
	hiddenNote: string | null;
	/** One sentence about the finished tasks the `finishedFor` window hides (or shows for want of a date); null when nothing to say. */
	finishedNote: string | null;
	readOnly: boolean | undefined;
	/** The stored layout and the statuses it can place; null when the answer has none (the editor is then not offered). */
	layout: BoardLayoutData | null;
}

const NO_META: BoardMeta = {
	blank: false,
	warning: null,
	tasksHref: null,
	emptyText: null,
	hiddenNote: null,
	finishedNote: null,
	readOnly: undefined,
	layout: null,
};

const text = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);
const flag = (value: unknown): boolean | undefined => (typeof value === 'boolean' ? value : undefined);

const isObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

/** The `config` and `allStatuses` of a board answer, or null when either is missing or malformed. */
export function layoutOf(raw: Record<string, unknown>): BoardLayoutData | null {
	const config = raw['config'];
	const all = raw['allStatuses'];
	if (!isObject(config) || !Array.isArray(config['columns']) || !Array.isArray(all)) {
		return null;
	}
	const columns: BoardLayoutData['columns'] = [];
	for (const column of config['columns']) {
		if (!isObject(column) || typeof column['name'] !== 'string' || !Array.isArray(column['statuses'])) {
			return null;
		}
		const sort = column['sort'];
		const groupStyle = column['groupStyle'];
		columns.push({
			name: column['name'],
			statuses: column['statuses'].filter((x): x is string => typeof x === 'string'),
			...(isColumnSort(sort) ? { sort } : {}),
			...(isGroupStyle(groupStyle) && groupStyle !== 'label' ? { groupStyle } : {}),
		});
	}
	const allStatuses: BoardStatusData[] = [];
	for (const status of all) {
		if (!isObject(status) || typeof status['name'] !== 'string') {
			return null;
		}
		allStatuses.push(status as unknown as BoardStatusData);
	}
	// An unknown window is dropped: the controls then say "No limit", which is what a missing key means.
	const finishedFor = config['finishedFor'];
	return {
		isDefault: config['isDefault'] === true,
		columns,
		allStatuses,
		...(isFinishedFor(finishedFor) ? { finishedFor } : {}),
	};
}

interface Shown {
	columns: BoardColumnData[];
	version: string;
	meta: BoardMeta;
}

/**
 * The cards of a board that follow the server: an EventSource tells when the version changed, the board is fetched again
 * then, and a poll takes over when the stream is not available. One request at a time (a newer one aborts the older).
 */
export function useLiveBoard(options: LiveBoardOptions): LiveBoard {
	const [shown, setShown] = useState<Shown>({
		columns: options.columns ?? [],
		version: options.version,
		meta: { ...NO_META, layout: options.layout ?? null, hiddenNote: text(options.hiddenNote), finishedNote: text(options.finishedNote) },
	});
	const [loading, setLoading] = useState(options.columns === undefined && options.projectParam !== '');
	const [loaded, setLoaded] = useState(options.columns !== undefined);
	const [generation, setGeneration] = useState(0);
	const [link, setLink] = useState<LiveState>('reconnecting');
	const [problem, setProblem] = useState<string | null>(null);

	const config = useRef(options);
	config.current = options;
	const versionRef = useRef(options.version);
	const loadedRef = useRef(options.columns !== undefined);
	loadedRef.current = loaded;
	const controller = useRef<AbortController | null>(null);
	// The version a request is already fetching: a repeated event for it starts nothing.
	const fetching = useRef<string | undefined>(undefined);
	const mounted = useRef(true);
	const holdRef = useRef(false);
	const waiting = useRef<Shown | null>(null);

	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
			controller.current?.abort();
		};
	}, []);

	const apply = useCallback((next: Shown): void => {
		versionRef.current = next.version;
		setShown(next);
		setLoaded(true);
		setGeneration(value => value + 1);
	}, []);

	const release = useCallback((): void => {
		holdRef.current = false;
		const next = waiting.current;
		waiting.current = null;
		if (next !== null && mounted.current) {
			apply(next);
		}
	}, [apply]);

	const refetch = useCallback(
		async (force = false): Promise<boolean> => {
			const { boardPath, projectParam, apiBase } = config.current;
			controller.current?.abort();
			const mine = new AbortController();
			controller.current = mine;
			try {
				const answer = await getJson(boardPath, { project: projectParam }, { signal: mine.signal, apiBase });
				if (mine.signal.aborted || !mounted.current) {
					return true;
				}
				const body = (typeof answer === 'object' && answer !== null ? answer : {}) as {
					columns?: unknown;
					version?: unknown;
				};
				const raw = body as Record<string, unknown>;
				const blank = raw['blank'] === true;
				const columns = blank ? [] : normalizeColumns(body.columns);
				const version = typeof body.version === 'string' ? body.version : '';
				const meta: BoardMeta = {
					blank,
					warning: text(raw['warning']),
					tasksHref: text(raw['tasksHref']),
					emptyText: text(raw['emptyText']),
					hiddenNote: text(raw['hiddenNote']),
					finishedNote: text(raw['finishedNote']),
					readOnly: flag(raw['readOnly']),
					layout: layoutOf(raw),
				};
				setProblem(null);
				setLoading(false);
				if (!force && version !== '' && version === versionRef.current) {
					return true;
				}
				if (holdRef.current) {
					waiting.current = { columns, version, meta };
				} else {
					apply({ columns, version, meta });
				}
				return true;
			} catch (error) {
				if (isAbort(error) || !mounted.current) {
					return true;
				}
				const first = !loadedRef.current;
				setLoading(false);
				setProblem(
					first
						? `The board could not be loaded: ${problemText(error)}. Reload the page; if it persists, check that app-core is running and the project can be read (task strategy check).`
						: `The board could not be refreshed: ${problemText(error)}. The cards shown may be out of date; it tries again at the next change.`
				);
				return false;
			} finally {
				if (controller.current === mine) {
					controller.current = null;
					fetching.current = undefined;
				}
			}
		},
		[apply]
	);

	// Contribution mode: nobody gave the first cards, so the board asks for them.
	const needsFirstLoad = options.columns === undefined;
	const firstProject = options.projectParam;
	useEffect(() => {
		if (needsFirstLoad && firstProject !== '') {
			void refetch(true);
		}
		// Once, at mount.
	}, []);

	const { projectParam, eventsPath, apiBase, pollSeconds } = options;
	useEffect(() => {
		if (projectParam === '') {
			return undefined;
		}
		let source: EventSource | undefined;
		let timer: ReturnType<typeof setInterval> | undefined;
		const startPolling = (): void => {
			setLink('polling');
			timer = setInterval(() => void refetch(), pollSeconds * 1000);
		};
		if (typeof globalThis.EventSource === 'undefined') {
			startPolling();
		} else {
			setLink('reconnecting');
			let errors = 0;
			try {
				source = new globalThis.EventSource(
					`${apiBase}${eventsPath}?project=${encodeURIComponent(projectParam)}`
				);
			} catch (error) {
				setProblem(
					`The live connection could not be opened (${error instanceof Error ? error.message : String(error)}); the board polls every ${pollSeconds} s instead.`
				);
				startPolling();
			}
			source?.addEventListener('open', () => {
				errors = 0;
				setLink('live');
			});
			source?.addEventListener('error', () => {
				errors += 1;
				if (errors >= MAX_STREAM_ERRORS) {
					source?.close();
					startPolling();
				} else {
					setLink('reconnecting');
				}
			});
			source?.addEventListener('version', event => {
				const version = versionOfEvent((event as MessageEvent<string>).data);
				if (version === undefined) {
					setProblem(
						'The live connection sent a version the board cannot read. Reload the page; if it persists, update the task module.'
					);
					return;
				}
				if (version === versionRef.current || version === fetching.current) {
					return;
				}
				fetching.current = version;
				void refetch();
			});
		}
		return () => {
			source?.close();
			if (timer !== undefined) {
				clearInterval(timer);
			}
		};
	}, [projectParam, eventsPath, apiBase, pollSeconds, refetch]);

	return {
		columns: shown.columns,
		version: shown.version,
		meta: shown.meta,
		loading,
		loaded,
		generation,
		link,
		problem,
		refetch,
		holdRef,
		release,
	};
}
