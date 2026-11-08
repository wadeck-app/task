// Builds the instance of a resolved plugin with the lifecycle guarantees of the host: a failing or silent factory is reported
// with the plugin ref, an instance that cannot be disposed is refused, dispose reaches the plugin once.
import type { AnyPlugin, PluginInstance } from './Plugin.js';
import type { ResolvedSlot } from './resolveSlot.js';

/** The factory failed, did not answer in time, or returned something unusable. `cause` is the original error when there is one. */
export class PluginCreateError extends Error {
	constructor(ref: string, reason: string, cause?: unknown) {
		super(`Plugin "${ref}" failed to create its instance: ${reason}`, cause === undefined ? undefined : { cause });
		this.name = 'PluginCreateError';
	}
}

/** A factory gets 30 s (flow's limit). */
export const DEFAULT_CREATE_TIMEOUT_MS = 30_000;

type InstanceOf<TPlugin extends AnyPlugin> = TPlugin extends { create(...args: never[]): Promise<infer I> } ? I : never;

export async function createInstance<TPlugin extends AnyPlugin>(
	resolved: ResolvedSlot<TPlugin>,
	context: Parameters<TPlugin['create']>[1],
	options: { timeoutMs?: number } = {}
): Promise<InstanceOf<TPlugin>> {
	const { ref, plugin } = resolved;
	const timeoutMs = options.timeoutMs ?? DEFAULT_CREATE_TIMEOUT_MS;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let created: PluginInstance;
	try {
		const timeout = new Promise<never>((_resolve, reject) => {
			timer = setTimeout(() => reject(new Error(`no answer within ${timeoutMs / 1000} s`)), timeoutMs);
		});
		created = await Promise.race([
			(async () =>
				(plugin as unknown as { create(o: unknown, c: unknown): Promise<PluginInstance> }).create(
					resolved.options,
					context
				))(),
			timeout,
		]);
	} catch (error) {
		throw new PluginCreateError(ref, error instanceof Error ? error.message : String(error), error);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
	if (typeof (created as Partial<PluginInstance> | null)?.dispose !== 'function') {
		throw new PluginCreateError(ref, 'the instance has no dispose()');
	}
	// The plugin's own dispose runs once, whatever the number of calls (the host disposes per command, per project, at teardown).
	const dispose = created.dispose.bind(created);
	let disposal: Promise<void> | undefined;
	Object.defineProperty(created, 'dispose', {
		value: (): Promise<void> => (disposal ??= dispose()),
		configurable: true,
	});
	return created as InstanceOf<TPlugin>;
}
