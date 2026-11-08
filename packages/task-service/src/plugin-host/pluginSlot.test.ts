import { fixturePlugin, newFixtureRegistry } from './pluginContract.testkit.js';
import { createInstance, PluginCreateError } from './createInstance.js';
import { PluginSlotError, resolveSlot } from './resolveSlot.js';

const LOCATION = { file: '/reg/config.yml', path: 'strategy' };

function registryWith(overrides = {}) {
	const registry = newFixtureRegistry();
	const plugin = fixturePlugin('alpha', overrides);
	registry.register('plugins.one.default', plugin, ['one']);
	return { registry, plugin };
}

describe('resolveSlot', () => {
	it('resolves a type given by alias and hands back the plugin with its options', () => {
		const { registry, plugin } = registryWith();

		const resolved = resolveSlot(registry, 'alpha', { type: 'one', options: { a: 1 } }, LOCATION);

		expect(resolved).toEqual({ ref: 'plugins.one.default', plugin, options: { a: 1 } });
	});

	it('an omitted type takes the default, omitted options are an empty mapping', () => {
		const { registry } = registryWith();

		const resolved = resolveSlot(registry, 'alpha', {}, LOCATION, 'one');

		expect(resolved.ref).toBe('plugins.one.default');
		expect(resolved.options).toEqual({});
	});

	it('an omitted type without a default is an error naming the key, with the registered refs as hint', () => {
		const { registry } = registryWith();

		let caught: unknown;
		try {
			resolveSlot(registry, 'alpha', {}, LOCATION);
		} catch (error) {
			caught = error;
		}

		expect((caught as PluginSlotError).message).toBe('/reg/config.yml: strategy.type: required');
		expect((caught as PluginSlotError).hint).toBe('Registered alpha plugins: one (plugins.one.default)');
	});

	it('an unknown type is an error naming file and key and listing the registered ones', () => {
		const { registry } = registryWith();

		let caught: unknown;
		try {
			resolveSlot(registry, 'alpha', { type: 'nope' }, LOCATION);
		} catch (error) {
			caught = error;
		}

		expect(caught).toBeInstanceOf(PluginSlotError);
		const error = caught as PluginSlotError;
		expect(error.file).toBe('/reg/config.yml');
		expect(error.path).toBe('strategy.type');
		expect(error.message).toBe('/reg/config.yml: strategy.type: unknown alpha plugin "nope"');
		expect(error.hint).toBe('Registered alpha plugins: one (plugins.one.default)');
	});

	it('a type that is not a string is an error', () => {
		const { registry } = registryWith();

		expect(() => resolveSlot(registry, 'alpha', { type: 3 }, LOCATION)).toThrow(
			'/reg/config.yml: strategy.type: must be a string, found 3'
		);
	});

	it.each([[[]], ['text'], [3]])('options that are not a mapping (%j) are an error', options => {
		const { registry } = registryWith();

		expect(() => resolveSlot(registry, 'alpha', { type: 'one', options }, LOCATION)).toThrow(
			/strategy\.options: must be a mapping/
		);
	});

	it('wraps the plugin validate message as <file>: <slot path>: <message>', () => {
		const { registry } = registryWith({ validate: () => 'needs something' });

		expect(() => resolveSlot(registry, 'alpha', { type: 'one' }, LOCATION)).toThrow(
			'/reg/config.yml: strategy.options: needs something'
		);
	});

	it('a refused option comes with the options the plugin documents, as the way out', () => {
		const { registry } = registryWith({
			validate: () => 'url: required',
			describe: () => ({ summary: '', options: { url: 'the address', tokenEnv: 'the variable' }, snippet: '' }),
		});

		let caught: unknown;
		try {
			resolveSlot(registry, 'alpha', { type: 'one' }, LOCATION);
		} catch (error) {
			caught = error;
		}

		expect((caught as PluginSlotError).hint).toBe('Options of plugins.one.default: url, tokenEnv');
	});

	it('a plugin that documents no option says so in the hint', () => {
		const { registry } = registryWith({ validate: () => 'x: unknown option' });

		let caught: unknown;
		try {
			resolveSlot(registry, 'alpha', { type: 'one' }, LOCATION);
		} catch (error) {
			caught = error;
		}

		expect((caught as PluginSlotError).hint).toBe('Options of plugins.one.default: none');
	});

	it('a validate message starting with an option key names the dotted key', () => {
		const { registry } = registryWith({ validate: () => 'url: required' });

		let caught: unknown;
		try {
			resolveSlot(registry, 'alpha', { type: 'one' }, LOCATION);
		} catch (error) {
			caught = error;
		}

		expect((caught as PluginSlotError).message).toBe('/reg/config.yml: strategy.options.url: required');
		expect((caught as PluginSlotError).path).toBe('strategy.options.url');
	});

	it('passes the slot path to validate', () => {
		const validate = vi.fn(() => undefined);
		const { registry } = registryWith({ validate });

		resolveSlot(registry, 'alpha', { type: 'one', options: { a: 1 } }, LOCATION);

		expect(validate).toHaveBeenCalledWith({ a: 1 }, { slot: 'strategy' });
	});
});

describe('createInstance', () => {
	const ctx = { note: 'n' };

	it('creates the instance with the options and the host context', async () => {
		const create = vi.fn(() => Promise.resolve({ dispose: () => Promise.resolve() }));
		const { registry } = registryWith({ create });
		const resolved = resolveSlot(registry, 'alpha', { type: 'one', options: { a: 1 } }, LOCATION);

		await createInstance(resolved, ctx);

		expect(create).toHaveBeenCalledWith({ a: 1 }, ctx);
	});

	it('wraps a failing create with the ref and keeps the cause', async () => {
		const cause = new Error('boom');
		const { registry } = registryWith({ create: () => Promise.reject(cause) });
		const resolved = resolveSlot(registry, 'alpha', { type: 'one' }, LOCATION);

		const error = await createInstance(resolved, ctx).catch((e: unknown) => e);

		expect(error).toBeInstanceOf(PluginCreateError);
		expect((error as PluginCreateError).message).toBe(
			'Plugin "plugins.one.default" failed to create its instance: boom'
		);
		expect((error as PluginCreateError).cause).toBe(cause);
	});

	it('wraps a create that throws synchronously the same way', async () => {
		const { registry } = registryWith({
			create: () => {
				throw new Error('sync boom');
			},
		});
		const resolved = resolveSlot(registry, 'alpha', { type: 'one' }, LOCATION);

		await expect(createInstance(resolved, ctx)).rejects.toThrow(
			'Plugin "plugins.one.default" failed to create its instance: sync boom'
		);
	});

	it('refuses an instance without dispose', async () => {
		const { registry } = registryWith({ create: () => Promise.resolve({}) as never });
		const resolved = resolveSlot(registry, 'alpha', { type: 'one' }, LOCATION);

		await expect(createInstance(resolved, ctx)).rejects.toThrow(
			'Plugin "plugins.one.default" failed to create its instance: the instance has no dispose()'
		);
	});

	it('gives a factory that never answers a time limit', async () => {
		const { registry } = registryWith({ create: () => new Promise(() => undefined) });
		const resolved = resolveSlot(registry, 'alpha', { type: 'one' }, LOCATION);

		await expect(createInstance(resolved, ctx, { timeoutMs: 20 })).rejects.toThrow(
			'Plugin "plugins.one.default" failed to create its instance: no answer within 0.02 s'
		);
	});

	it('dispose reaches the plugin once, whatever the number of calls', async () => {
		const { registry, plugin } = registryWith();
		const resolved = resolveSlot(registry, 'alpha', { type: 'one' }, LOCATION);
		const instance = await createInstance(resolved, ctx);

		await instance.dispose();
		await instance.dispose();

		expect(plugin.disposed).toBe(1);
	});
});
