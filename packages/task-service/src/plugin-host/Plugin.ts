// The plugin contract of the host seam. Generic on purpose: kinds, instances and the host context are type parameters, so this
// folder knows nothing of task and can move to a shared package unchanged (design 3A.5). Imports nothing but itself.

/** What every plugin instance owes its host: a way to release what it holds (sockets, caches). */
export interface PluginInstance {
	dispose(): Promise<void>;
}

/** The text a plugin documents itself with (one place to edit: the plugin, never a catalogue kept elsewhere). */
export interface PluginDescription {
	summary: string;
	/** Option name -> what it means (required ones say so). */
	options: Record<string, string>;
	/** A config snippet that selects the plugin. */
	snippet: string;
}

/**
 * A plugin of one kind (`extensionPoint`). `validate` is pure and never throws: it returns the first problem of the options as a
 * sentence, or undefined; a problem about one option starts with its dotted key and ": " (`url: required`). `create` builds the
 * instance lazily, with the context the host hands over.
 */
export interface Plugin<
	TKind extends string = string,
	TInstance extends PluginInstance = PluginInstance,
	TContext = unknown,
> {
	readonly extensionPoint: TKind;
	validate(options: Record<string, unknown>, context: { slot: string }): string | undefined;
	create(options: Record<string, unknown>, context: TContext): Promise<TInstance>;
	describe(): PluginDescription;
}

/** A plugin of any kind, as the registry stores it. */
export type AnyPlugin = Plugin<string, PluginInstance, never>;

/** The id part of a ref and the alias: lowercase letters, digits and dashes, starting with a letter (queue's action pattern). */
export const PLUGIN_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;

/** What is wrong with a value that should be a plugin, as a sentence; undefined when it has the shape of one. */
export function pluginProblem(value: unknown): string | undefined {
	if (typeof value !== 'object' || value === null) return 'it is not an object';
	const candidate = value as Record<string, unknown>;
	if (typeof candidate['extensionPoint'] !== 'string' || candidate['extensionPoint'] === '') {
		return 'it has no extensionPoint (a non-empty string naming its kind)';
	}
	for (const method of ['validate', 'create', 'describe']) {
		if (typeof candidate[method] !== 'function') return `it has no ${method}() function`;
	}
	return undefined;
}

export function isPlugin(value: unknown): value is AnyPlugin {
	return pluginProblem(value) === undefined;
}
