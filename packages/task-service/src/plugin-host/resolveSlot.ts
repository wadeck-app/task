// Resolves a config slot `{ type, options }` against a registry and a kind. The caller gives the file and the dotted path of the
// slot, so this knows no config schema; every problem is one error whose message reads `<file>: <dotted key>: <problem>`.
import type { AnyPlugin } from './Plugin.js';
import { PluginLookupError } from './PluginRegistry.js';
import type { PluginRegistry } from './PluginRegistry.js';

/** Where the slot is written: the config file and the dotted path of the slot in it (`strategy`). */
export interface SlotLocation {
	file: string;
	path: string;
}

/** A slot that cannot be resolved: `file` and `path` name the exact key; `hint` says what to write instead. */
export class PluginSlotError extends Error {
	constructor(
		readonly file: string,
		readonly path: string,
		readonly problem: string,
		readonly hint?: string
	) {
		super(`${file}: ${path}: ${problem}`);
		this.name = 'PluginSlotError';
	}
}

export interface ResolvedSlot<TPlugin extends AnyPlugin> {
	ref: string;
	plugin: TPlugin;
	options: Record<string, unknown>;
}

/** A plugin message about one option starts with its dotted key: `url: required`, `timeoutSeconds: must be a positive number`. */
const OPTION_PROBLEM = /^([A-Za-z][A-Za-z0-9_.-]*): ([\s\S]+)$/;

/**
 * The plugin a slot selects, with its options, after the plugin's own `validate`. `defaultType` is used when `type` is absent;
 * without it an absent type is an error. A plugin never has an option stripped silently: `validate` decides.
 */
export function resolveSlot<TByKind extends Record<string, AnyPlugin>, K extends keyof TByKind & string>(
	registry: PluginRegistry<TByKind>,
	kind: K,
	slot: { type?: unknown; options?: unknown },
	location: SlotLocation,
	defaultType?: string
): ResolvedSlot<TByKind[K]> {
	const typePath = `${location.path}.type`;
	const type = slot.type ?? defaultType;
	if (type === undefined) {
		const registered = registry.list(kind);
		throw new PluginSlotError(
			location.file,
			typePath,
			'required',
			registered.length === 0
				? `No ${kind} plugin is registered`
				: `Registered ${kind} plugins: ${registered.map(e => (e.aliases[0] === undefined ? e.ref : `${e.aliases[0]} (${e.ref})`)).join(', ')}`
		);
	}
	if (typeof type !== 'string') {
		throw new PluginSlotError(location.file, typePath, `must be a string, found ${JSON.stringify(type)}`);
	}
	let plugin: TByKind[K];
	let ref: string;
	try {
		plugin = registry.lookup(type, kind);
		ref = registry.list(kind).find(entry => entry.plugin === plugin)!.ref;
	} catch (error) {
		if (error instanceof PluginLookupError) {
			throw new PluginSlotError(location.file, typePath, error.message, error.hint);
		}
		throw error;
	}

	const optionsPath = `${location.path}.options`;
	const options = slot.options ?? {};
	if (typeof options !== 'object' || options === null || Array.isArray(options)) {
		throw new PluginSlotError(
			location.file,
			optionsPath,
			`must be a mapping of option names to values, found ${Array.isArray(options) ? 'a list' : JSON.stringify(options)}`
		);
	}
	const problem = plugin.validate(options as Record<string, unknown>, { slot: location.path });
	if (problem !== undefined) {
		const keyed = OPTION_PROBLEM.exec(problem);
		// The way out of a refused option is the list of the options the plugin documents.
		const documented = Object.keys(plugin.describe().options);
		const hint = `Options of ${ref}: ${documented.length === 0 ? 'none' : documented.join(', ')}`;
		throw keyed === null
			? new PluginSlotError(location.file, optionsPath, problem, hint)
			: new PluginSlotError(location.file, `${optionsPath}.${keyed[1]}`, keyed[2]!, hint);
	}
	return { ref, plugin, options: options as Record<string, unknown> };
}
