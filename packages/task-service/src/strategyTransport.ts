// Opens the transport a remote strategy talks through: the `strategy.options.transport` slot was resolved and validated at load
// (resolveStrategy); the instance is created when the strategy first needs it, like the strategy's own backend.
import { PluginCreateError, createInstance } from './plugin-host/index.js';
import type { TransportInstance } from './plugins/kinds.js';
import type { ResolvedStrategy } from './strategyResolve.js';

/**
 * A function that opens the transport of the strategy, or undefined when the strategy has no transport slot. A transport that cannot
 * open (a missing token) throws ITS error, not a second "failed to create" wrapper around it: the strategy that asked wraps it once.
 */
export function transportOpener(
	strategy: ResolvedStrategy,
	env: NodeJS.ProcessEnv
): (() => Promise<TransportInstance>) | undefined {
	const slot = strategy.transport;
	if (slot === undefined) return undefined;
	return async () => {
		try {
			return await createInstance(slot, { env });
		} catch (error) {
			if (error instanceof PluginCreateError && error.cause instanceof Error) throw error.cause;
			throw error;
		}
	};
}
