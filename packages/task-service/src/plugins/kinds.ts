// The plugin kinds of task and their typed instances (design 3A.3): the one place where the generic host seam (../plugin-host)
// meets task types. Built-in plugins import this file, the seam and task-core types only (architecture rule PLUGINS_IMPORT_SEAM_ONLY).
import { UnsupportedByBackendError } from '@wadeck-app/task-core';
import type { BackendCapabilities, BackendKind, BackendTraits, TaskBackend } from '@wadeck-app/task-core';

import type { Plugin, PluginInstance, PluginRegistry } from '../plugin-host/index.js';

/** One finding of `task strategy check`: the layout of the block is fixed by the command, the plugin only supplies lines. */
export interface CheckLine {
	/** Short label of the fact checked (`data`, `token`, `reachable`...). */
	name: string;
	status: 'ok' | 'warn' | 'error';
	text: string;
	/** What to do, for a `warn` or an `error`. */
	fix?: string;
}

/**
 * Something a read did that the user should know and that is not a failure: data served from the cache because the server could
 * not be asked (`stale`), something of the remote system that has no task equivalent and was left out (`ignored`), or a write done
 * through a declared fill that is only approximate (`emulated`: a human edit on the remote system may overwrite it), or queue events a
 * task server saved the change for but could not hand to its queue (`events`).
 */
export interface ReadNotice {
	kind: 'stale' | 'ignored' | 'emulated' | 'events';
	/** One sentence, ready to print after `warning: `. */
	text: string;
	/** `stale`: when the data served was read from the server. */
	cachedAt?: string;
}

/** What a strategy plugin builds: the backend of a project plus what `strategy show|check` needs to talk about it. */
export interface StrategyInstance extends PluginInstance {
	backend: TaskBackend;
	/** Lines about the instance for `strategy show` (where the data lives, which server...). */
	describe(): string[];
	/** Probes the backend (reachable, writable, counts...). Never throws for an expected problem: it reports it as an `error` line. */
	check(): Promise<CheckLine[]>;
	/** The notices of the reads since the last call, oldest first (the instance forgets them). Absent: this strategy has none. */
	takeNotices?(): ReadNotice[];
}

/** The fills (design 2A) as declared in the project config: capability -> technique, with its own fidelity when it has one. */
export type DeclaredFills = Record<string, { use: string; fidelity: 'strict' | 'degrade' }>;

/** One status of the project's merged config, as a strategy that maps them onto a remote system needs it. */
export interface ProjectStatus {
	name: string;
	terminal: boolean;
	/** The status of a new task. */
	default: boolean;
	/** How a terminal status ended; absent on a non-terminal one. */
	outcome: 'positive' | 'negative' | undefined;
}

/** What the project's config says that a strategy has to agree with: checked at load, before any request. */
export interface ProjectFacts {
	statuses: ProjectStatus[];
	/** The valid task types; empty = any. */
	types: string[];
	/** The valid priorities, highest first. Absent (a hand-built fact list): any priority is accepted. */
	priorities?: string[];
}

export interface StrategyContext {
	/** The project's own config file: where the strategy is written, named in error messages. */
	source: string;
	/** The statuses (config order) and types of the project. */
	statuses: ProjectStatus[];
	types: string[];
	/** The priorities of the project, highest first (the merged config). A local backend refuses any other priority; absent = any text. */
	priorities?: readonly string[];
	project: { id?: string; name: string; path?: string };
	/** The folder of the task files and the data folder of the project (local backends only; others ignore them). */
	tasksDir: string;
	dataDir: string;
	/** Atomic writer of the task files. */
	writeFile: (file: string, content: string) => void;
	env: NodeJS.ProcessEnv;
	fidelity: 'strict' | 'degrade';
	fills: DeclaredFills;
	/** Appends a line to the task log (`task cli logs`). Never throws. Request lines are logged only when `TASK_DEBUG=1`. */
	log: (level: 'info' | 'warn' | 'error', message: string) => void;
	/**
	 * Every read must come from the system itself, never from a cache the plugin keeps (a migration copies what the source holds NOW).
	 * Absent: the plugin's own cache policy applies.
	 */
	freshReads?: boolean;
	/**
	 * Opens the transport the project's `strategy.options.transport` slot selects (a remote strategy talks through it; the host resolved
	 * and validated the slot at load). Absent when the strategy has no transport slot.
	 */
	openTransport?: () => Promise<TransportInstance>;
	/**
	 * The writes of this context must not raise queue events (a migration, which raises one summary instead). Honoured by a strategy
	 * whose server raises the events (`capabilities.events: 'server'`): it asks the server to stay silent. Other strategies raise
	 * their events in the process, which simply does not hand them to a sink.
	 */
	suppressEvents?: boolean;
}

/**
 * A strategy plugin creates the backend of a project. `backendKind` and `capabilities` are declared by the plugin itself (so the
 * context can offer them before the lazy `create`); the instance's backend must report the same values.
 */
export interface StrategyPlugin extends Plugin<'strategy', StrategyInstance, StrategyContext> {
	readonly backendKind: BackendKind;
	readonly capabilities: BackendCapabilities;
	/**
	 * The capabilities once the project's declared fills are taken into account (a fill enables what the backend cannot do natively),
	 * and the validated options. Absent: the static ones. `strategy show` prints
	 * the answer for NO fill (the options still apply) with the declared fills as `emulated`.
	 */
	capabilitiesFor?(fills: DeclaredFills, options: Record<string, unknown>): BackendCapabilities;
	/** Capability -> the fill techniques this plugin implements (empty: everything is native, no fill applies). */
	readonly fillTechniques: Readonly<Record<string, readonly string[]>>;
	/**
	 * What is only partly true of a declared capability, in one sentence each (`strategy show` prints the row as `partial`):
	 * keys are capability names or `linkTypes.<type>`.
	 */
	readonly capabilityNotes?: Readonly<Record<string, string>>;
	/**
	 * Checks the options against the project (every status mapped, every type representable) at load, like `validate` does for the
	 * options alone: the same single-sentence shape, a problem about one option starting with its dotted key and ": ".
	 */
	validateForProject?(options: Record<string, unknown>, project: ProjectFacts): string | undefined;
	/**
	 * What the backend keeps and where its limits are (`task migrate` reads it to build the loss table before it writes). Called with
	 * options that passed `validate`. Absent: the plugin promises nothing (the migration then assumes the backend keeps nothing).
	 */
	traitsFor?(options: Record<string, unknown>, fills: DeclaredFills, project: ProjectFacts): BackendTraits;
	/**
	 * Where the tasks live, as a string two projects share only when they share the storage (the repository of a forge). `task migrate`
	 * refuses a migration whose two sides have the same location. Absent: the storage is private to the project (the data folder).
	 */
	locationOf?(options: Record<string, unknown>): string | undefined;
}

/** What a transport plugin builds (design 3.1): how bytes reach the server. It never parses protocol payloads. */
export interface TransportInstance extends PluginInstance {
	baseUrl: string;
	headers(): Record<string, string>;
	/** Applies the per-request timeout and never follows redirects. */
	fetch(path: string, init?: { method?: string; headers?: Record<string, string>; body?: string }): Promise<Response>;
	/** Lines for `strategy check`. */
	describe(): string[];
}

export interface TransportContext {
	env: NodeJS.ProcessEnv;
	/** The HTTP client to use (tests inject a fake one). Default: the global `fetch`. */
	fetch?: typeof fetch;
	/** The timers the time limit of a request uses (tests drive them by hand). Default: the global ones. */
	timers?: { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout };
}

export type TransportPlugin = Plugin<'transport', TransportInstance, TransportContext>;

/** What an ordering plugin compares: the facts a list summary carries, with the priority already resolved to the effective one. */
export interface OrderingRow {
	id: string;
	status: string;
	/** ISO instant. */
	createdAt: string;
	/** The EFFECTIVE priority: the stored one, else the project default. */
	priority: string;
	assignee?: string;
}

/** What the project says that an ordering needs. */
export interface OrderingFacts {
	/** The valid priorities, highest first: the index of a priority is its rank (lower = more urgent). */
	priorities: readonly string[];
}

/** What an ordering plugin builds (stage 2 of priority/assignee/claim): a total order over list rows. */
export interface OrderingInstance extends PluginInstance {
	/** Negative when `a` comes first, positive when `b` does, 0 only for the same row. Pure, no I/O. */
	compare(a: OrderingRow, b: OrderingRow, facts: OrderingFacts): number;
}

/** Nothing is handed to an ordering plugin at creation (reserved for options). */
export type OrderingContext = Record<string, never>;

export type OrderingPlugin = Plugin<'ordering', OrderingInstance, OrderingContext>;

/** The kinds of plugin a task host knows. A new kind needs its instance interface here and a slot in the config schema. */
export type TaskPluginKinds = {
	strategy: StrategyPlugin;
	transport: TransportPlugin;
	ordering: OrderingPlugin;
};

export type TaskPluginRegistry = PluginRegistry<TaskPluginKinds>;

/** A plugin that is registered but whose implementation arrives in a later stage: opening it fails loudly, never silently. */
export class PluginNotImplementedError extends Error {
	constructor(
		readonly ref: string,
		readonly stage: string,
		readonly hint: string
	) {
		super(`plugin "${ref}" is registered but not implemented in this version (it arrives in ${stage})`);
		this.name = 'PluginNotImplementedError';
	}
}

/** The operations of the port that carry priority, assignee and claim (capabilities `priority`, `assignee`, `claim`). */
export type TaskFieldOperation =
	'setPriority' | 'clearPriority' | 'setAssignee' | 'clearAssignee' | 'claim' | 'release';

const FIELD_OPERATIONS: Record<TaskFieldOperation, { capability: 'priority' | 'assignee' | 'claim'; text: string }> = {
	setPriority: { capability: 'priority', text: 'setting a priority' },
	clearPriority: { capability: 'priority', text: 'clearing a priority' },
	setAssignee: { capability: 'assignee', text: 'setting an assignee' },
	clearAssignee: { capability: 'assignee', text: 'clearing an assignee' },
	claim: { capability: 'claim', text: 'claiming a task' },
	release: { capability: 'claim', text: 'releasing a task' },
};

/**
 * The answer of a backend that does not carry priority, assignee and claim yet (every strategy but `local`): a rejected promise
 * with an UnsupportedByBackendError that says so and what to do. The caller returns it from the operation.
 */
export function refuseTaskField(kind: BackendKind, operation: TaskFieldOperation): Promise<never> {
	const { capability, text } = FIELD_OPERATIONS[operation];
	return Promise.reject(
		new UnsupportedByBackendError(
			kind,
			text,
			capability,
			`Priority, assignee and claim are not available on the ${kind} storage strategy yet. Use a project with the local strategy (no strategy section in its config.yml) to use them.`
		)
	);
}
