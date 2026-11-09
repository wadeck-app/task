// Test support: the built-in registry minus some strategies, for the tests of the path "a type the schema knows has no plugin
// installed" (every declared type has a plugin now, so such a registry has to be built).
import { createPluginRegistry } from '../plugin-host/index.js';
import { createBuiltinRegistry } from './builtinPlugins.js';
import type { TaskPluginKinds, TaskPluginRegistry } from './kinds.js';

/** The built-ins without the plugins that answer to one of `aliases` (`gitlab`, `plugins.gitlab.default`...). */
export function registryWithout(...aliases: string[]): TaskPluginRegistry {
	const all = createBuiltinRegistry();
	const dropped = (entry: { ref: string; aliases: readonly string[] }): boolean =>
		aliases.some(alias => alias === entry.ref || entry.aliases.includes(alias));
	return createPluginRegistry<TaskPluginKinds>([
		...all
			.list('strategy')
			.filter(entry => !dropped(entry))
			.map(entry => ({ ref: entry.ref, plugin: entry.plugin, aliases: [...entry.aliases] })),
		...all
			.list('transport')
			.filter(entry => !dropped(entry))
			.map(entry => ({ ref: entry.ref, plugin: entry.plugin, aliases: [...entry.aliases] })),
	]);
}
