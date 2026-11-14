// An in-process registry of plugins: an INSTANCE (tests and hosts build their own, no module-level map, no test-only reset),
// filled from a static list of built-ins. Registry lookup only: nothing is imported dynamically (design R11).
import { PLUGIN_ID_PATTERN, pluginProblem } from './Plugin.js';
import type { AnyPlugin } from './Plugin.js';

const REF_PATTERN = /^plugins\.([a-z][a-z0-9-]{0,63})\.([a-z][a-z0-9-]{0,63})$/;

/** A registration that cannot be accepted (malformed ref or alias, taken name, not a plugin). Nothing was registered. */
export class PluginRegistrationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'PluginRegistrationError';
	}
}

/** A lookup that finds no plugin of the asked kind; `available` and `hint` say what can be used instead. */
export class PluginLookupError extends Error {
	constructor(
		message: string,
		/** `alias (ref)` of every plugin of the kind, sorted by ref. */
		readonly available: string[],
		readonly hint: string
	) {
		super(message);
		this.name = 'PluginLookupError';
	}
}

/** One entry of the static built-in list. */
export interface BuiltinPluginEntry<TPlugin extends AnyPlugin = AnyPlugin> {
	ref: string;
	plugin: TPlugin;
	aliases?: readonly string[];
}

export interface RegisteredPlugin<TPlugin extends AnyPlugin = AnyPlugin> {
	ref: string;
	aliases: string[];
	plugin: TPlugin;
}

/** `TByKind` maps a kind (a plugin's `extensionPoint`) to the plugin type of that kind. */
export interface PluginRegistry<TByKind extends Record<string, AnyPlugin>> {
	/** Throws {@link PluginRegistrationError} and registers nothing when the ref, an alias or the plugin is refused. */
	register(ref: string, plugin: TByKind[keyof TByKind & string], aliases?: readonly string[]): void;
	/** The plugin of `kind` named by its ref or alias; throws {@link PluginLookupError} listing the registered ones. */
	lookup<K extends keyof TByKind & string>(refOrAlias: string, kind: K): TByKind[K];
	/** The plugins of a kind, sorted by ref. */
	list<K extends keyof TByKind & string>(kind: K): Array<RegisteredPlugin<TByKind[K]>>;
}

function label(entry: RegisteredPlugin): string {
	return entry.aliases.length === 0 ? entry.ref : `${entry.aliases[0]} (${entry.ref})`;
}

export function createPluginRegistry<TByKind extends Record<string, AnyPlugin>>(
	builtins: ReadonlyArray<BuiltinPluginEntry<TByKind[keyof TByKind & string]>> = []
): PluginRegistry<TByKind> {
	const byName = new Map<string, RegisteredPlugin>();
	const entries: RegisteredPlugin[] = [];

	const register: PluginRegistry<TByKind>['register'] = (ref, plugin, aliases = []) => {
		if (!REF_PATTERN.test(ref)) {
			throw new PluginRegistrationError(
				`cannot register "${ref}": a plugin ref is plugins.<id>.<impl> with ids of lowercase letters, digits and dashes starting with a letter (up to 64 characters each)`
			);
		}
		const problem = pluginProblem(plugin);
		if (problem !== undefined) throw new PluginRegistrationError(`cannot register "${ref}": ${problem}`);
		const owner = byName.get(ref);
		if (owner !== undefined) {
			throw new PluginRegistrationError(`cannot register "${ref}": "${ref}" is already registered`);
		}
		const seen = new Set<string>();
		for (const alias of aliases) {
			if (!PLUGIN_ID_PATTERN.test(alias)) {
				throw new PluginRegistrationError(
					`cannot register "${ref}": alias "${alias}" must match ${PLUGIN_ID_PATTERN.source}`
				);
			}
			if (seen.has(alias)) {
				throw new PluginRegistrationError(`cannot register "${ref}": alias "${alias}" is repeated`);
			}
			seen.add(alias);
			const holder = byName.get(alias);
			if (holder !== undefined) {
				throw new PluginRegistrationError(
					`cannot register "${ref}": alias "${alias}" is already used by "${holder.ref}"`
				);
			}
		}
		// Everything is checked: commit.
		const entry: RegisteredPlugin = { ref, aliases: [...aliases], plugin };
		entries.push(entry);
		byName.set(ref, entry);
		for (const alias of aliases) byName.set(alias, entry);
	};

	for (const builtin of builtins) register(builtin.ref, builtin.plugin, builtin.aliases);

	return {
		register,
		lookup(refOrAlias, kind) {
			const sameKind = entries.filter(entry => entry.plugin.extensionPoint === kind).sort(byRef);
			const entry = byName.get(refOrAlias);
			if (entry !== undefined && entry.plugin.extensionPoint !== kind) {
				const actual = entry.plugin.extensionPoint;
				throw new PluginLookupError(
					`"${refOrAlias}" is ${article(actual)} ${actual} plugin, not ${article(kind)} ${kind} one: use it where ${article(actual)} ${actual} plugin is expected`,
					sameKind.map(label),
					listing(kind, sameKind)
				);
			}
			if (entry === undefined) {
				throw new PluginLookupError(
					`unknown ${kind} plugin "${refOrAlias}"`,
					sameKind.map(label),
					listing(kind, sameKind)
				);
			}
			return entry.plugin as TByKind[typeof kind];
		},
		list(kind) {
			return entries
				.filter(entry => entry.plugin.extensionPoint === kind)
				.sort(byRef)
				.map(entry => ({ ...entry, aliases: [...entry.aliases] })) as Array<
				RegisteredPlugin<TByKind[typeof kind]>
			>;
		},
	};
}

function byRef(a: RegisteredPlugin, b: RegisteredPlugin): number {
	return a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0;
}

function article(word: string): string {
	return /^[aeiou]/.test(word) ? 'an' : 'a';
}

function listing(kind: string, entries: RegisteredPlugin[]): string {
	return entries.length === 0
		? `No ${kind} plugin is registered`
		: `Registered ${kind} plugins: ${entries.map(label).join(', ')}`;
}
