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

/** What a strategy plugin builds: the backend of a project plus what `strategy show|check` needs to talk about it. */
export interface StrategyInstance extends PluginInstance {
	backend: TaskBackend;
	/** Lines about the instance for `strategy show` (where the data lives, which server...). */
	describe(): string[];
	/** Probes the backend (reachable, writable, counts...). Never throws for an expected problem: it reports it as an `error` line. */
	check(): Promise<CheckLine[]>;
}

/** The fills (design 2A) as declared in the project config: capability -> technique, with its own fidelity when it has one. */
export type DeclaredFills = Record<string, { use: string; fidelity: 'strict' | 'degrade' }>;

export interface StrategyContext {
	project: { id?: string; name: string; path?: string };
	/** The folder of the task files and the data folder of the project (local backends only; others ignore them). */
	tasksDir: string;
	dataDir: string;
	/** Atomic writer of the task files. */
	writeFile: (file: string, content: string) => void;
	env: NodeJS.ProcessEnv;
	fidelity: 'strict' | 'degrade';
	fills: DeclaredFills;
}

/**
 * A strategy plugin creates the backend of a project. `backendKind` and `capabilities` are declared by the plugin itself (so the
 * context can offer them before the lazy `create`); the instance's backend must report the same values.
 */
export interface StrategyPlugin extends Plugin<'strategy', StrategyInstance, StrategyContext> {
	readonly backendKind: BackendKind;
	readonly capabilities: BackendCapabilities;
	/** Capability -> the fill techniques this plugin implements (empty: everything is native, no fill applies). */
	readonly fillTechniques: Readonly<Record<string, readonly string[]>>;
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
