import { isDev, useAbExperiments } from '@wadeck-app/dsl-ui';
import { ChevronDown, ChevronUp } from 'lucide-react';
import React, { createContext, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { reportOnce } from '../reportOnce.js';
import { useStoredChoice } from '../useStoredChoice.js';

export interface VariantSpec {
	/** Name of the choice in the bar. */
	label: string;
	/** What this variant changes compared with the reference one (tooltip and hint line). */
	hint: string;
	/** The DSL node rendered while this variant is chosen. */
	view: unknown;
}

export interface VariantSwitcherProps {
	/** Short stable id: names the storage key and the URL parameter (`ab.<id>`). Letters, digits, `_` and `-`. */
	id: string;
	/** Name of the test, shown on the left of its row. */
	label: string;
	/** The reference variant, used until someone chooses and whenever experiments are off. */
	initial: string;
	/** @mapSlot view */
	variants: Record<string, VariantSpec>;
	renderNode: (node: unknown, ctx: Record<string, unknown>) => React.ReactNode;
}

interface Choice {
	id: string;
	label: string;
	title: string;
}

interface Row {
	id: string;
	label: string;
	choices: Choice[];
	value: string;
	depth: number;
	onSelect: (id: string) => void;
}

interface Store {
	subscribe: (listener: () => void) => () => void;
	getSnapshot: () => readonly Row[];
	set: (owner: symbol, row: Row) => void;
	remove: (owner: symbol) => void;
}

function createStore(): Store {
	const rows = new Map<symbol, Row>();
	const listeners = new Set<() => void>();
	let snapshot: readonly Row[] = [];
	const publish = (): void => {
		// Deeper rows (the options of a variant) first: they are drawn above the row of the variant itself.
		snapshot = [...rows.values()].sort((a, b) => b.depth - a.depth);
		listeners.forEach(listener => listener());
	};
	return {
		subscribe: listener => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		getSnapshot: () => snapshot,
		set: (owner, row) => {
			rows.set(owner, row);
			publish();
		},
		remove: owner => {
			if (rows.delete(owner)) {
				publish();
			}
		},
	};
}

interface Host {
	enabled: boolean;
	depth: number;
	store: Store;
}

const HostContext = createContext<Host | null>(null);

// Ids in use by mounted, enabled tests. Two DIFFERENT tests under one id would share a storage key and fight over it.
const claimed = new Map<string, { signature: string; count: number }>();

function claim(id: string, signature: string): boolean {
	const existing = claimed.get(id);
	if (existing && existing.signature !== signature) {
		return false;
	}
	claimed.set(id, { signature, count: (existing?.count ?? 0) + 1 });
	return true;
}

function release(id: string): void {
	const existing = claimed.get(id);
	if (!existing) {
		return;
	}
	if (existing.count <= 1) {
		claimed.delete(id);
	} else {
		existing.count -= 1;
	}
}

const ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const COLLAPSE_KEY = 'ab.collapsed';
const COLLAPSE_OPTIONS = ['open', 'collapsed'] as const;

// What is wrong with the declaration, or null.
function configError({ id, label, initial, variants }: Omit<VariantSwitcherProps, 'renderNode'>): string | null {
	if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
		return `"id" must be a non-empty string of letters, digits, "_" or "-", got ${JSON.stringify(id)}`;
	}
	if (typeof label !== 'string' || label === '') {
		return '"label" must be a non-empty string';
	}
	if (!variants || typeof variants !== 'object' || Array.isArray(variants) || Object.keys(variants).length === 0) {
		return '"variants" must be a map with at least one variant';
	}
	if (!Object.keys(variants).includes(initial)) {
		return `"initial" is ${JSON.stringify(initial)} but the variants are: ${Object.keys(variants).join(', ')}`;
	}
	for (const [key, variant] of Object.entries(variants)) {
		const v = variant as Partial<VariantSpec> | null;
		if (
			!v ||
			typeof v !== 'object' ||
			typeof v.label !== 'string' ||
			typeof v.hint !== 'string' ||
			v.view === undefined
		) {
			return `variant "${key}" needs a "label", a "hint" and a "view"`;
		}
	}
	return null;
}

const ALERT_CLASS = 'rounded border border-danger bg-danger-bg p-2 text-sm text-danger-text';
const BAR_POSITION = 'fixed bottom-6 left-1/2 z-[9999] -translate-x-1/2';

// Room kept at the end of the page for the fixed bar: the bar's own height plus its distance to the window edge and a margin.
const SPACER_MIN = 56;
const SPACER_EXTRA = 40;

function Bar({
	store,
	onHeight,
}: {
	store: Store;
	onHeight: (height: number | null) => void;
}): React.ReactElement | null {
	const rows = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
	const barRef = useRef<HTMLElement | null>(null);
	const [state, setState] = useStoredChoice<(typeof COLLAPSE_OPTIONS)[number]>(
		COLLAPSE_KEY,
		COLLAPSE_OPTIONS,
		'open',
		'dock state',
		undefined,
		true
	);
	const [hint, setHint] = useState<string | null>(null);
	const hasRows = rows.length > 0;
	// Tells the page how much room the bar takes (it is fixed, so it hides the end of the page otherwise).
	useEffect(() => {
		if (!hasRows) {
			onHeight(null);
			return undefined;
		}
		const element = barRef.current;
		onHeight(element?.offsetHeight ?? 0);
		if (!element || typeof ResizeObserver === 'undefined') {
			return undefined;
		}
		const observer = new ResizeObserver(() => onHeight(element.offsetHeight));
		observer.observe(element);
		return () => observer.disconnect();
	}, [hasRows, state, hint, rows.length, onHeight]);
	if (rows.length === 0 || typeof document === 'undefined') {
		return null;
	}
	if (state === 'collapsed') {
		return createPortal(
			<button
				ref={element => {
					barRef.current = element;
				}}
				type="button"
				aria-label={`Show A/B (${rows.length})`}
				title="Show the A/B tests. Every choice stays applied while the bar is folded."
				onClick={() => setState('open')}
				className={`${BAR_POSITION} flex cursor-pointer items-center gap-2 rounded-full border border-border bg-surface px-4 py-2 text-sm font-semibold text-muted shadow-2xl hover:text-content`}
			>
				<span>A/B ({rows.length})</span>
				<ChevronUp size={16} aria-hidden="true" />
			</button>,
			document.body
		);
	}
	return createPortal(
		<div
			ref={element => {
				barRef.current = element;
			}}
			data-testid="variant-switcher"
			onKeyDown={event => {
				if (event.key === 'Escape' && !event.defaultPrevented) {
					event.stopPropagation();
					setState('collapsed');
				}
			}}
			className={`${BAR_POSITION} flex max-h-[80vh] w-max max-w-[calc(100vw-1rem)] flex-col gap-2 overflow-y-auto rounded-2xl border border-border bg-surface p-3 shadow-2xl`}
		>
			<button
				type="button"
				aria-label="Fold the A/B tests"
				title="Fold the bar into a small pill (Escape does the same). Every choice stays applied."
				onClick={() => setState('collapsed')}
				className="absolute right-2 top-1 flex cursor-pointer items-center rounded-full p-1 text-muted hover:text-content"
			>
				<ChevronDown size={16} aria-hidden="true" />
			</button>
			{rows.map(row => (
				<div key={row.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 pr-6">
					<span className="min-w-[6rem] text-xs font-semibold uppercase tracking-wide text-muted">
						{row.label}
					</span>
					<div role="radiogroup" aria-label={row.label} className="flex flex-wrap gap-1.5">
						{row.choices.map(choice => (
							<label
								key={choice.id}
								title={choice.title}
								onMouseOver={() => setHint(choice.title)}
								onMouseOut={() => setHint(null)}
								onFocus={() => setHint(choice.title)}
								onBlur={() => setHint(null)}
								className={`cursor-pointer select-none rounded-lg border px-4 py-2 text-sm font-medium transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-primary ${
									choice.id === row.value
										? 'border-primary bg-primary text-white'
										: 'border-border bg-surface text-content hover:bg-muted-bg'
								}`}
							>
								<input
									type="radio"
									className="sr-only"
									name={`ab-${row.id}`}
									value={choice.id}
									checked={choice.id === row.value}
									onChange={() => row.onSelect(choice.id)}
								/>
								{choice.label}
							</label>
						))}
					</div>
				</div>
			))}
			{hint ? (
				<p data-testid="variant-hint" className="border-t border-border pt-2 text-sm text-muted">
					{hint}
				</p>
			) : null}
		</div>,
		document.body
	);
}

function Core({
	host,
	id,
	label,
	initial,
	variants,
	renderNode,
}: VariantSwitcherProps & { host: Host }): React.ReactElement {
	const error = configError({ id, label, initial, variants });
	const live = host.enabled && error === null;
	const ids = useMemo(() => (error ? [] : Object.keys(variants)), [error, variants]);
	const key = `ab.${id}`;
	const [value, choose] = useStoredChoice<string>(
		key,
		ids,
		initial,
		`${String(label)} variant`.toLowerCase(),
		key,
		live
	);
	const [conflict, setConflict] = useState(false);

	const chooseRef = useRef(choose);
	chooseRef.current = choose;
	const owner = useRef(Symbol(`VariantSwitcher:${id}`)).current;
	const choices: Choice[] = ids.map(variantId => ({
		id: variantId,
		label: variants[variantId]!.label,
		title: variants[variantId]!.hint,
	}));
	const choicesKey = JSON.stringify(choices);
	const signature = JSON.stringify([label, initial, choicesKey]);

	useEffect(() => {
		if (error !== null) {
			reportOnce(`[ab] VariantSwitcher "${String(id)}": ${error}`);
		}
	}, [error, id]);

	useEffect(() => {
		if (!live) {
			return undefined;
		}
		if (!claim(id, signature)) {
			reportOnce(
				`[ab] Two different VariantSwitcher tests use the id "${id}": the second is not shown. Give each test its own id; only an identical declaration may be repeated.`
			);
			setConflict(true);
			return undefined;
		}
		setConflict(false);
		return () => release(id);
	}, [live, id, signature]);

	useEffect(() => {
		if (!live || conflict) {
			host.store.remove(owner);
			return undefined;
		}
		host.store.set(owner, {
			id,
			label,
			choices: JSON.parse(choicesKey) as Choice[],
			value,
			depth: host.depth,
			onSelect: variantId => chooseRef.current(variantId),
		});
		return () => host.store.remove(owner);
	}, [live, conflict, host, id, label, choicesKey, value, owner]);

	const nested = useMemo<Host>(() => ({ ...host, depth: host.depth + 1 }), [host]);

	if (error !== null) {
		return (
			<div role="alert" className={ALERT_CLASS}>
				<strong>VariantSwitcher {JSON.stringify(id)}:</strong> {error}
			</div>
		);
	}
	if (conflict) {
		return (
			<div role="alert" className={ALERT_CLASS}>
				<strong>VariantSwitcher {JSON.stringify(id)}:</strong> another, different test already uses the same id.
			</div>
		);
	}
	// While experiments are off, useStoredChoice returns `initial` without touching the storage or the URL.
	return (
		<HostContext.Provider value={nested}>
			<React.Fragment key={value}>{renderNode(variants[value]!.view, {})}</React.Fragment>
		</HostContext.Provider>
	);
}

function Root(props: VariantSwitcherProps & { enabled: boolean }): React.ReactElement {
	const { enabled, ...rest } = props;
	const store = useRef<Store | null>(null);
	if (store.current === null) {
		store.current = createStore();
	}
	const host = useMemo<Host>(() => ({ enabled, depth: 0, store: store.current! }), [enabled]);
	const [barHeight, setBarHeight] = useState<number | null>(null);
	return (
		<>
			<Core {...rest} host={host} />
			{enabled && barHeight !== null ? (
				<div
					data-testid="variant-switcher-spacer"
					aria-hidden="true"
					style={{ height: `${Math.max(SPACER_MIN, barHeight + SPACER_EXTRA)}px` }}
				/>
			) : null}
			{enabled ? <Bar store={host.store} onHeight={setBarHeight} /> : null}
		</>
	);
}

/**
 * The A/B switcher of a view: renders the CHOSEN variant's view and shows a LARGE bar (fixed, bottom centre) to
 * change it. Declared like dsl-ui's `AbTest` (same props, same storage key `ab.<id>`, same `?ab.<id>=` override,
 * same `ab.collapsed` fold state), so a swap between the two is mechanical.
 *
 * ```yaml
 * $type: task:VariantSwitcher
 * id: task-design
 * label: Task page
 * initial: current
 * variants:
 *   current: { label: Current, hint: The page as shipped., view: { ... } }
 *   github-a: { label: GitHub A, hint: ..., view: { $type: task:VariantSwitcher, id: github-a-side, ... } }
 * ```
 *
 * - Options of a variant are NESTED switchers (other ids) inside its view: their row joins the same bar, above the
 *   variants row, while that variant is shown.
 * - Enabled where the shell's `<AbExperiments>` host says so (its `enabled`, which defaults to development builds);
 *   without a host, `isDev()`. Disabled: renders the `initial` view only, never reads the storage nor the URL, draws
 *   no bar. A production build therefore shows the reference view to everyone.
 * - Why not AbTest: dsl-ui's dock (`rounded-[1.75rem] p-1.5`, `text-xs` rows, fixed bottom centre) is not
 *   configurable by a module and is too small to compare many variants. This bar has 14 px choices, a hint line and
 *   wraps on narrow screens. When dsl-ui offers a size option, delete this component.
 * - A bad declaration (unknown `initial`, bad id, a second different test with the same id) renders an alert, never a
 *   guessed variant.
 *
 * @registryCategory disposition
 * @registryTags layout ab experiment variants
 */
export function VariantSwitcher(props: VariantSwitcherProps): React.ReactElement {
	const parent = useContext(HostContext);
	const abHost = useAbExperiments();
	if (parent) {
		return <Core {...props} host={parent} />;
	}
	return <Root {...props} enabled={abHost ? abHost.enabled : isDev()} />;
}
