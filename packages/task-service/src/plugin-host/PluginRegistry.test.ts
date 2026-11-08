import { isPlugin, pluginProblem } from './Plugin.js';
import { MALFORMED_PLUGINS, fixturePlugin, newFixtureRegistry } from './pluginContract.testkit.js';
import { PluginLookupError, PluginRegistrationError, createPluginRegistry } from './PluginRegistry.js';

describe('the plugin shape guard', () => {
	it('accepts a well-formed plugin', () => {
		expect(isPlugin(fixturePlugin('alpha'))).toBe(true);
		expect(pluginProblem(fixturePlugin('alpha'))).toBeUndefined();
	});

	it.each(MALFORMED_PLUGINS)('refuses $label and says what is missing', ({ value, problem }) => {
		expect(isPlugin(value)).toBe(false);
		expect(pluginProblem(value)).toMatch(problem);
	});
});

describe('registering plugins', () => {
	it('finds a plugin by its ref and by its alias', () => {
		const registry = newFixtureRegistry();
		const plugin = fixturePlugin('alpha');
		registry.register('plugins.one.default', plugin, ['one']);

		expect(registry.lookup('plugins.one.default', 'alpha')).toBe(plugin);
		expect(registry.lookup('one', 'alpha')).toBe(plugin);
	});

	it('a plugin without alias is found by its ref only', () => {
		const registry = newFixtureRegistry();
		registry.register('plugins.one.default', fixturePlugin('alpha'));

		expect(() => registry.lookup('one', 'alpha')).toThrow(PluginLookupError);
	});

	it('registering the same ref twice names the owner of the first one', () => {
		const registry = newFixtureRegistry();
		registry.register('plugins.one.default', fixturePlugin('alpha'));

		expect(() => registry.register('plugins.one.default', fixturePlugin('alpha'))).toThrow(
			/"plugins\.one\.default" is already registered/
		);
	});

	it('an alias taken by another plugin throws and names it', () => {
		const registry = newFixtureRegistry();
		registry.register('plugins.one.default', fixturePlugin('alpha'), ['shared']);

		expect(() => registry.register('plugins.two.default', fixturePlugin('beta'), ['shared'])).toThrow(
			/alias "shared" is already used by "plugins\.one\.default"/
		);
	});

	it('the same alias twice in one call throws', () => {
		const registry = newFixtureRegistry();

		expect(() => registry.register('plugins.one.default', fixturePlugin('alpha'), ['x', 'x'])).toThrow(
			/alias "x" is repeated/
		);
	});

	it.each(['One', 'plugins.one', 'plugins.one.default.more', 'plugins..default', '', 'plugins.1x.default'])(
		'refuses the malformed ref %j',
		ref => {
			const registry = newFixtureRegistry();

			expect(() => registry.register(ref, fixturePlugin('alpha'))).toThrow(PluginRegistrationError);
			expect(() => registry.register(ref, fixturePlugin('alpha'))).toThrow(/plugins\.<id>\.<impl>/);
		}
	);

	it.each(['Bad', 'a.b', '1a', '', 'a'.repeat(65)])('refuses the malformed alias %j', alias => {
		const registry = newFixtureRegistry();

		expect(() => registry.register('plugins.one.default', fixturePlugin('alpha'), [alias])).toThrow(
			/alias .* must match/
		);
	});

	it('refuses a value that is not a plugin, naming the problem', () => {
		const registry = newFixtureRegistry();

		expect(() => registry.register('plugins.one.default', { extensionPoint: 'alpha' } as never)).toThrow(
			/plugins\.one\.default.*validate/
		);
	});

	it('registers nothing when a call throws', () => {
		const registry = newFixtureRegistry();
		registry.register('plugins.one.default', fixturePlugin('alpha'), ['one']);

		expect(() => registry.register('plugins.two.default', fixturePlugin('alpha'), ['two', 'one'])).toThrow();

		expect(registry.list('alpha').map(entry => entry.ref)).toEqual(['plugins.one.default']);
		expect(() => registry.lookup('two', 'alpha')).toThrow(PluginLookupError);
		expect(() => registry.lookup('plugins.two.default', 'alpha')).toThrow(PluginLookupError);
	});

	it('two registries are independent', () => {
		const first = newFixtureRegistry();
		const second = newFixtureRegistry();
		first.register('plugins.one.default', fixturePlugin('alpha'));

		expect(second.list('alpha')).toEqual([]);
		expect(() => second.lookup('plugins.one.default', 'alpha')).toThrow(PluginLookupError);
	});

	it('builds from a static list of built-ins', () => {
		const plugin = fixturePlugin('alpha');
		const registry = createPluginRegistry<{ alpha: typeof plugin }>([
			{ ref: 'plugins.one.default', plugin, aliases: ['one'] },
		]);

		expect(registry.lookup('one', 'alpha')).toBe(plugin);
	});
});

describe('looking plugins up', () => {
	it('an unknown reference lists the refs and aliases of that kind, sorted, and says how to fix', () => {
		const registry = newFixtureRegistry();
		registry.register('plugins.zeta.default', fixturePlugin('alpha'), ['zeta']);
		registry.register('plugins.eta.default', fixturePlugin('alpha'), ['eta']);
		registry.register('plugins.other.default', fixturePlugin('beta'), ['other']);

		let caught: unknown;
		try {
			registry.lookup('nope', 'alpha');
		} catch (error) {
			caught = error;
		}

		expect(caught).toBeInstanceOf(PluginLookupError);
		const error = caught as PluginLookupError;
		expect(error.message).toBe('unknown alpha plugin "nope"');
		expect(error.available).toEqual(['eta (plugins.eta.default)', 'zeta (plugins.zeta.default)']);
		expect(error.hint).toBe('Registered alpha plugins: eta (plugins.eta.default), zeta (plugins.zeta.default)');
	});

	it('an empty kind says that nothing is registered', () => {
		const registry = newFixtureRegistry();

		let caught: unknown;
		try {
			registry.lookup('x', 'beta');
		} catch (error) {
			caught = error;
		}

		expect(caught).toBeInstanceOf(PluginLookupError);
		expect((caught as PluginLookupError).hint).toBe('No beta plugin is registered');
	});

	it('a plugin of another kind names the kind it belongs to', () => {
		const registry = newFixtureRegistry();
		registry.register('plugins.other.default', fixturePlugin('beta'), ['other']);

		expect(() => registry.lookup('other', 'alpha')).toThrow(
			/"other" is a beta plugin, not an alpha one: use it where a beta plugin is expected/
		);
	});

	it('list(kind) is sorted by ref and carries the aliases', () => {
		const registry = newFixtureRegistry();
		registry.register('plugins.b.default', fixturePlugin('alpha'), ['b', 'bee']);
		registry.register('plugins.a.default', fixturePlugin('alpha'));

		expect(registry.list('alpha').map(entry => [entry.ref, entry.aliases])).toEqual([
			['plugins.a.default', []],
			['plugins.b.default', ['b', 'bee']],
		]);
	});
});
