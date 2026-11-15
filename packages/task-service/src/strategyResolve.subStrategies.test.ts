import { LOCAL_CAPABILITIES, LOCAL_TRAITS, NO_TRAITS } from '@wadeck-app/task-core';

import { createBuiltinRegistry } from './plugins/builtinPlugins.js';
import type { ProjectFacts, StrategyPlugin, SubStrategyViews, TaskPluginRegistry } from './plugins/kinds.js';
import { parseStrategySection, StrategyConfigError } from './strategyConfig.js';
import { resolveStrategy, subStrategyViews } from './strategyResolve.js';

// The host side of a meta-plugin: the options named in `strategySlots` are full strategy blocks, checked at load like a project's own
// `strategy` section and handed to the plugin's hooks as views. A fake meta-plugin stands in, so the host is tested without any real one.
const FILE = '/reg/projects/p1/task/config/config.yml';
const FACTS: ProjectFacts = { statuses: [], types: [] };

interface Seen {
	capabilities?: SubStrategyViews;
	validated?: SubStrategyViews;
	forProject?: SubStrategyViews;
}

function metaPlugin(seen: Seen = {}, extra: Partial<StrategyPlugin> = {}): StrategyPlugin {
	return {
		extensionPoint: 'strategy',
		backendKind: 'migrating',
		capabilities: LOCAL_CAPABILITIES,
		fillTechniques: {},
		strategySlots: ['current', 'new'],
		validate: options => (options['current'] === undefined ? 'current: required (a strategy block)' : undefined),
		validateSubStrategies: (_options, views) => {
			seen.validated = views;
			return undefined;
		},
		validateForProject: (_options, _facts, views) => {
			seen.forProject = views;
			return undefined;
		},
		capabilitiesFor: (_fills, _options, views) => {
			if (views !== undefined) seen.capabilities = views;
			return LOCAL_CAPABILITIES;
		},
		create: () => Promise.reject(new Error('not used')),
		describe: () => ({ summary: 'fake meta', options: { current: '', new: '' }, snippet: '' }),
		...extra,
	};
}

function registryWith(plugin: StrategyPlugin): TaskPluginRegistry {
	const registry = createBuiltinRegistry();
	registry.register('plugins.fakemeta.default', plugin, ['fakemeta']);
	return registry;
}

function resolve(strategy: unknown, plugin: StrategyPlugin = metaPlugin()) {
	return resolveStrategy(parseStrategySection(FILE, strategy), FILE, registryWith(plugin), FACTS);
}

function failure(strategy: unknown, plugin?: StrategyPlugin): StrategyConfigError {
	try {
		resolve(strategy, plugin);
	} catch (error) {
		expect(error).toBeInstanceOf(StrategyConfigError);
		return error as StrategyConfigError;
	}
	throw new Error(`expected a refusal for ${JSON.stringify(strategy)}`);
}

const OK = { type: 'fakemeta', options: { current: { type: 'local' }, new: { type: 'local' } } };

describe('resolveStrategy: the strategy blocks of a meta-plugin', () => {
	it('resolves each present slot like a project strategy and keeps it under subs', () => {
		const resolved = resolve(OK);

		expect(resolved.subs?.['current']).toMatchObject({
			type: 'local',
			ref: 'plugins.local.default',
			fidelity: 'strict',
		});
		expect(resolved.subs?.['new']?.plugin.backendKind).toBe('local');
	});

	it('hands the views to the hooks: capabilities with the sub fills, kind, traits and location', () => {
		const seen: Seen = {};
		const resolved = resolve(OK, metaPlugin(seen));
		// The capabilities hook is called by the callers that need the capabilities, with the same views.
		resolved.plugin.capabilitiesFor?.(resolved.fills, resolved.options, subStrategyViews(resolved));

		const view = seen.capabilities?.['current'];
		expect(view).toMatchObject({ slot: 'current', type: 'local', ref: 'plugins.local.default', kind: 'local' });
		expect(view?.capabilities).toEqual(LOCAL_CAPABILITIES);
		expect(view?.traits(FACTS)).toEqual(LOCAL_TRAITS);
		expect(view?.location).toBeUndefined();
		expect(seen.validated?.['new']?.slot).toBe('new');
		expect(seen.forProject?.['new']?.slot).toBe('new');
	});

	it('a sub-strategy whose plugin declares no traits keeps nothing (NO_TRAITS), never an invented default', () => {
		const registry = registryWith(metaPlugin());
		registry.register(
			'plugins.bare.default',
			{
				extensionPoint: 'strategy',
				backendKind: 'github',
				capabilities: LOCAL_CAPABILITIES,
				fillTechniques: {},
				validate: () => undefined,
				create: () => Promise.reject(new Error('not used')),
				describe: () => ({ summary: 'bare', options: {}, snippet: '' }),
			},
			['bare']
		);
		const resolved = resolveStrategy(
			parseStrategySection(FILE, {
				type: 'fakemeta',
				options: { current: { type: 'bare' }, new: { type: 'local' } },
			}),
			FILE,
			registry,
			FACTS
		);

		expect(subStrategyViews(resolved)['current']?.traits(FACTS)).toEqual(NO_TRAITS);
	});

	it('a plugin without strategySlots has no subs and no views', () => {
		const resolved = resolveStrategy(
			parseStrategySection(FILE, { type: 'local' }),
			FILE,
			createBuiltinRegistry(),
			FACTS
		);

		expect(resolved.subs).toBeUndefined();
		expect(subStrategyViews(resolved)).toEqual({});
	});

	it('an absent slot is left to the plugin: its own validate says it is required', () => {
		expect(failure({ type: 'fakemeta', options: { new: { type: 'local' } } }).message).toBe(
			`${FILE}: strategy.options.current: required (a strategy block)`
		);
	});

	it('a slot that is not a mapping names the dotted key', () => {
		const error = failure({ type: 'fakemeta', options: { current: 'local', new: { type: 'local' } } });
		expect(error.message).toContain(
			`${FILE}: strategy.options.current: must be a mapping of type, fidelity and options`
		);
	});

	it('a slot without type is refused: no silent local', () => {
		const error = failure({ type: 'fakemeta', options: { current: { options: {} }, new: { type: 'local' } } });
		expect(error.message).toContain(`${FILE}: strategy.options.current.type: required`);
		expect(error.hint).toContain('Registered strategy plugins');
	});

	it('an unknown type names the slot and lists the registered ones', () => {
		const error = failure({ type: 'fakemeta', options: { current: { type: 'local' }, new: { type: 'nope' } } });
		expect(error.message).toContain(`${FILE}: strategy.options.new.type: unknown strategy plugin "nope"`);
		expect(error.hint).toContain('local');
	});

	it('an option the sub-plugin refuses is named under the slot', () => {
		const error = failure({
			type: 'fakemeta',
			options: { current: { type: 'local' }, new: { type: 'local', options: { bogus: 1 } } },
		});
		expect(error.message).toContain(
			`${FILE}: strategy.options.new.options.bogus: unknown option for strategy "local"`
		);
	});

	it('a literal credential in a sub-strategy is refused with the tokenEnv fix, under the slot', () => {
		const error = failure({
			type: 'fakemeta',
			options: { current: { type: 'local' }, new: { type: 'local', options: { token: 'abc' } } },
		});
		expect(error.message).toBe(
			`${FILE}: strategy.options.new.options.token: a credential must not be written in the config file`
		);
		expect(error.hint).toContain('tokenEnv: <VARIABLE_NAME>');
	});

	it('a fill the sub-plugin does not implement is named under the slot', () => {
		const error = failure({
			type: 'fakemeta',
			options: { current: { type: 'local' }, new: { type: 'local', options: { fills: { meta: 'labels' } } } },
		});
		expect(error.message).toContain(
			`${FILE}: strategy.options.new.options.fills.meta: the "local" strategy does not implement the fill "labels"`
		);
	});

	it('a meta-plugin inside a meta-plugin is refused in v1, with what to write instead', () => {
		const error = failure({
			type: 'fakemeta',
			options: {
				current: { type: 'local' },
				new: { type: 'fakemeta', options: { current: { type: 'local' }, new: { type: 'local' } } },
			},
		});
		expect(error.message).toContain(
			`${FILE}: strategy.options.new.type: "fakemeta" holds other strategies and cannot be nested in another one`
		);
		expect(error.hint).toContain('plain strategy');
	});

	it('a pair the plugin cannot combine is a keyed problem naming the slot', () => {
		const error = failure(
			OK,
			metaPlugin({}, { validateSubStrategies: () => 'new: cannot be combined with current' })
		);
		expect(error.message).toBe(`${FILE}: strategy.options.new: cannot be combined with current`);
	});

	it('a combination problem without a key is named on the strategy options', () => {
		const error = failure(OK, metaPlugin({}, { validateSubStrategies: () => 'the two sides are the same' }));
		expect(error.message).toBe(`${FILE}: strategy.options: the two sides are the same`);
	});
});
