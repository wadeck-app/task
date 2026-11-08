// Fixture plugins and helpers for the tests of this seam, reusable by any host of it (test-only: imports no task module).
import type { Plugin, PluginInstance } from './Plugin.js';
import { createPluginRegistry } from './PluginRegistry.js';
import type { PluginRegistry } from './PluginRegistry.js';

export type FixturePlugin<K extends string> = Plugin<K, PluginInstance, { note: string }>;

export type FixtureKinds = {
	alpha: FixturePlugin<'alpha'>;
	beta: FixturePlugin<'beta'>;
};

/** A well-formed plugin of the given kind: validates every option, creates an instance whose dispose counts its calls. */
export function fixturePlugin<K extends 'alpha' | 'beta'>(
	kind: K,
	overrides: Partial<FixturePlugin<K>> = {}
): FixturePlugin<K> & { disposed: number } {
	const plugin = {
		disposed: 0,
		extensionPoint: kind,
		validate: () => undefined,
		create: () =>
			Promise.resolve({
				dispose: () => {
					plugin.disposed += 1;
					return Promise.resolve();
				},
			}),
		describe: () => ({ summary: `fixture ${kind}`, options: {}, snippet: `type: plugins.${kind}.default` }),
		...overrides,
	};
	return plugin;
}

/** Values that are not plugins, with what the shape guard must say about each. */
export const MALFORMED_PLUGINS: ReadonlyArray<{ label: string; value: unknown; problem: RegExp }> = [
	{ label: 'null', value: null, problem: /not an object/ },
	{ label: 'a string', value: 'alpha', problem: /not an object/ },
	{ label: 'no extensionPoint', value: { validate() {}, create() {}, describe() {} }, problem: /extensionPoint/ },
	{
		label: 'an empty extensionPoint',
		value: { extensionPoint: '', validate() {}, create() {}, describe() {} },
		problem: /extensionPoint/,
	},
	{ label: 'no validate', value: { extensionPoint: 'alpha', create() {}, describe() {} }, problem: /validate/ },
	{ label: 'no create', value: { extensionPoint: 'alpha', validate() {}, describe() {} }, problem: /create/ },
	{ label: 'no describe', value: { extensionPoint: 'alpha', validate() {}, create() {} }, problem: /describe/ },
];

export function newFixtureRegistry(): PluginRegistry<FixtureKinds> {
	return createPluginRegistry<FixtureKinds>();
}
