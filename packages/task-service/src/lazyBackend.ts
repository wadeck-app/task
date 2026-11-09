// The backend of a context, created at its first call (design 3A.3: construction stays cheap and synchronous, a remote or forge
// instance connects when it is first needed). `kind` and `capabilities` are answered by the plugin before anything is created.
import type { BackendCapabilities, TaskBackend } from '@wadeck-app/task-core';

import type { StrategyInstance, StrategyPlugin } from './plugins/kinds.js';

export interface LazyBackend {
	backend: TaskBackend;
	/** The instance, once a call created it. */
	opened(): StrategyInstance | undefined;
	/** Disposes the instance once if it was created; creates nothing. A call after this is refused. */
	dispose(): Promise<void>;
}

export function createLazyBackend(
	plugin: StrategyPlugin,
	open: () => Promise<StrategyInstance>,
	/** What the backend can do for this project (its fills included); default the static ones of the plugin. */
	capabilities: BackendCapabilities = plugin.capabilities
): LazyBackend {
	let pending: Promise<StrategyInstance> | undefined;
	let created: StrategyInstance | undefined;
	let disposed = false;
	let disposal: Promise<void> | undefined;

	const instance = (): Promise<StrategyInstance> => {
		if (disposed) return Promise.reject(new Error(`the ${plugin.backendKind} backend was already disposed`));
		pending ??= open().then(opened => (created = opened));
		return pending;
	};

	const backend = new Proxy({} as TaskBackend, {
		get(_target, property) {
			if (property === 'kind') return plugin.backendKind;
			if (property === 'capabilities') return capabilities;
			// A symbol or `then` must read as absent: the proxy is awaited and logged like any object.
			if (typeof property === 'symbol' || property === 'then') return undefined;
			return async (...args: unknown[]): Promise<unknown> => {
				const { backend: real } = await instance();
				const method = (real as unknown as Record<string, unknown>)[property];
				if (typeof method !== 'function') {
					throw new TypeError(`the ${plugin.backendKind} backend has no method "${property}"`);
				}
				return (method as (...a: unknown[]) => unknown).apply(real, args);
			};
		},
	});

	return {
		backend,
		opened: () => created,
		dispose() {
			if (disposal !== undefined) return disposal;
			disposed = true;
			// A creation still in flight is awaited so its instance is released too.
			disposal = (pending ?? Promise.resolve(undefined)).then(
				opened => opened?.dispose(),
				() => undefined
			);
			return disposal;
		},
	};
}
