// The plugin kinds of task and their typed instances (design 3A.3): the one place where the generic host seam (../plugin-host)
// meets task types. Built-in plugins import this file, the seam and task-core types only (architecture rule PLUGINS_IMPORT_SEAM_ONLY).
import type { BackendCapabilities, BackendKind, TaskBackend } from '@wadeck-app/task-core';

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
 * through a declared fill that is only approximate (`emulated`: a human edit on the remote system may overwrite it).
 */
export interface ReadNotice {
	kind: 'stale' | 'ignored' | 'emulated';
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
}

export interface StrategyContext {
	/** The project's own config file: where the strategy is written, named in error messages. */
	source: string;
	/** The statuses (config order) and types of the project. */
	statuses: ProjectStatus[];
	types: string[];
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
}

/**
 * A strategy plugin creates the backend of a project. `backendKind` and `capabilities` are declared by the plugin itself (so the
 * context can offer them before the lazy `create`); the instance's backend must report the same values.
 */
export interface StrategyPlugin extends Plugin<'strategy', StrategyInstance, StrategyContext> {
	readonly backendKind: BackendKind;
	readonly capabilities: BackendCapabilities;
	/**
	 * The capabilities once the project's declared fills are taken into account (a fill enables what the backend cannot do natively).
	 * Absent: the static ones. `strategy show` still prints the static ones with the fills as `emulated`.
	 */
	capabilitiesFor?(fills: DeclaredFills): BackendCapabilities;
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
}

export type TransportPlugin = Plugin<'transport', TransportInstance, TransportContext>;

/** The kinds of plugin a task host knows. A new kind needs its instance interface here and a slot in the config schema. */
export type TaskPluginKinds = {
	strategy: StrategyPlugin;
	transport: TransportPlugin;
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
