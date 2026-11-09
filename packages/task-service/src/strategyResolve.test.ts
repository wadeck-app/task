import { LOCAL_CAPABILITIES } from '@wadeck-app/task-core';

import { createBuiltinRegistry } from './plugins/builtinPlugins.js';
import type { StrategyPlugin, TaskPluginRegistry } from './plugins/kinds.js';
import { registryWithout } from './plugins/registryWithout.testkit.js';
import { parseStrategySection, StrategyConfigError } from './strategyConfig.js';
import { resolveStrategy } from './strategyResolve.js';

const FILE = '/reg/projects/p1/task/config/config.yml';

function resolve(strategy: unknown, registry: TaskPluginRegistry = createBuiltinRegistry()) {
	return resolveStrategy(parseStrategySection(FILE, strategy), FILE, registry);
}

function failure(strategy: unknown, registry?: TaskPluginRegistry): StrategyConfigError {
	try {
		resolve(strategy, registry);
	} catch (error) {
		expect(error).toBeInstanceOf(StrategyConfigError);
		return error as StrategyConfigError;
	}
	throw new Error(`expected a refusal for ${JSON.stringify(strategy)}`);
}

/** A strategy plugin that takes a token and implements two fills, to exercise what `local` cannot. */
function fakeStrategy(): StrategyPlugin {
	return {
		extensionPoint: 'strategy',
		backendKind: 'github',
		capabilities: LOCAL_CAPABILITIES,
		fillTechniques: { meta: ['labels'] },
		validate: options => (options['repo'] === undefined ? 'repo: required' : undefined),
		create: () => Promise.reject(new Error('not used')),
		describe: () => ({ summary: 'fake', options: {}, snippet: '' }),
	};
}

describe('resolveStrategy: the default', () => {
	it('a project without a strategy section is local, strict, with no fill, and not "declared"', () => {
		const resolved = resolve(undefined);

		expect(resolved).toMatchObject({
			source: FILE,
			declared: false,
			type: 'local',
			ref: 'plugins.local.default',
			fidelity: 'strict',
			fills: {},
			options: {},
		});
		expect(resolved.plugin.backendKind).toBe('local');
		expect(resolved.transport).toBeUndefined();
	});

	it.each([[{ type: 'local' }], [{ type: 'plugins.local.default' }], [{}], [{ fidelity: 'degrade' }]])(
		'%j resolves to local and counts as declared',
		strategy => {
			const resolved = resolve(strategy);

			expect(resolved.declared).toBe(true);
			expect(resolved.ref).toBe('plugins.local.default');
		}
	);

	it('keeps the fidelity written', () => {
		expect(resolve({ type: 'local', fidelity: 'degrade' }).fidelity).toBe('degrade');
	});
});

describe('resolveStrategy: types declared but not installed fail loudly, never fall back to local', () => {
	it.each(['gitlab', 'plugins.gitlab.default'])('%s', type => {
		const error = failure({ type }, registryWithout('gitlab'));
		const bare = type.replace(/^plugins\.|\.default$/g, '');

		expect(error.message).toBe(
			`${FILE}: strategy.type: strategy type ${bare} is declared but no plugin is installed; built-in types: github, local, remote`
		);
		expect(error.path).toBe('strategy.type');
		expect(error.hint).toMatch(
			/Set strategy.type to a built-in type \((github, local, remote)\) or remove the strategy section/
		);
	});

	it('a type that is not even declared lists what is registered and what is declared but missing', () => {
		const error = failure({ type: 'foo' }, registryWithout('gitlab'));

		expect(error.message).toBe(`${FILE}: strategy.type: unknown strategy plugin "foo"`);
		expect(error.hint).toBe(
			'Registered strategy plugins: github (plugins.github.default), local (plugins.local.default), remote (plugins.remote.default). Declared but not installed: gitlab.'
		);
	});

	it('a transport asked as a strategy names the right slot', () => {
		expect(failure({ type: 'plain-http' }).message).toMatch(
			/"plain-http" is a transport plugin, not a strategy one/
		);
	});
});

describe('resolveStrategy: the plugin validates its options', () => {
	it('local takes none: the option is named with its dotted key', () => {
		const error = failure({ type: 'local', options: { path: '/x' } });

		expect(error.path).toBe('strategy.options.path');
		expect(error.message).toBe(
			`${FILE}: strategy.options.path: unknown option for strategy "local" (it takes no option: the data lives in the shared project registry)`
		);
	});

	it('a fill the plugin does not implement is refused, with what it does implement', () => {
		const error = failure({ type: 'local', options: { fills: { meta: 'labels' } } });

		expect(error.message).toBe(
			`${FILE}: strategy.options.fills.meta: the "local" strategy does not implement the fill "labels" for meta (it implements none: every capability is native)`
		);
		expect(error.path).toBe('strategy.options.fills.meta');
	});

	it('a fill the plugin implements is kept', () => {
		const registry = createBuiltinRegistry();
		registry.register('plugins.fake.default', fakeStrategy(), ['fake']);

		const resolved = resolve({ type: 'fake', options: { repo: 'o/n', fills: { meta: 'labels' } } }, registry);

		expect(resolved.fills).toEqual({ meta: { use: 'labels', fidelity: 'strict' } });
		expect(resolved.options).toEqual({ repo: 'o/n' });
	});

	it('a technique of the table that this plugin lacks lists the ones it has', () => {
		const registry = createBuiltinRegistry();
		registry.register('plugins.fake.default', fakeStrategy(), ['fake']);

		const error = failure(
			{ type: 'fake', fidelity: 'degrade', options: { repo: 'o/n', fills: { meta: 'body-block' } } },
			registry
		);

		expect(error.message).toBe(
			`${FILE}: strategy.options.fills.meta: the "fake" strategy does not implement the fill "body-block" for meta (it implements: labels)`
		);
	});

	it('a plugin message about a required option names the dotted key', () => {
		const registry = createBuiltinRegistry();
		registry.register('plugins.fake.default', fakeStrategy(), ['fake']);

		expect(failure({ type: 'fake' }, registry).message).toBe(`${FILE}: strategy.options.repo: required`);
	});
});

describe('resolveStrategy: the transport slot of a declared remote strategy', () => {
	it('is validated first: a typo in the transport options is reported, not "no plugin installed"', () => {
		const error = failure({
			type: 'remote',
			options: {
				transport: { type: 'plain-http', options: { url: 'http://nas.lan:7788', tokenEnv: 'T', urll: 'x' } },
			},
		});

		expect(error.path).toBe('strategy.options.transport.options.urll');
		expect(error.message).toBe(
			`${FILE}: strategy.options.transport.options.urll: unknown option for transport "plain-http" (known: url, tokenEnv, tokenFile, timeoutSeconds)`
		);
	});

	it('an unknown transport type lists the registered ones', () => {
		const error = failure({ type: 'remote', options: { transport: { type: 'carrier-pigeon' } } });

		expect(error.path).toBe('strategy.options.transport.type');
		expect(error.hint).toBe('Registered transport plugins: plain-http (plugins.plain-http.default)');
	});

	it('an omitted transport type is plain-http, so its required options are asked for', () => {
		const error = failure({ type: 'remote', options: { transport: { options: {} } } });

		expect(error.path).toBe('strategy.options.transport.options.url');
	});

	it('a valid transport resolves with the remote strategy, which carries the resolved transport slot', () => {
		const resolved = resolve({
			type: 'remote',
			options: { transport: { type: 'plain-http', options: { url: 'http://nas.lan:7788', tokenEnv: 'T' } } },
		});

		expect(resolved.ref).toBe('plugins.remote.default');
		expect(resolved.plugin.backendKind).toBe('remote');
		expect(resolved.transport?.ref).toBe('plugins.plain-http.default');
		expect(resolved.transport?.options).toEqual({ url: 'http://nas.lan:7788', tokenEnv: 'T' });
	});

	it('the remote strategy needs its transport slot, and refuses an unknown option, naming the key', () => {
		expect(failure({ type: 'remote', options: {} }).message).toBe(
			`${FILE}: strategy.options.transport: required (how to reach the server: { type: plain-http, options: { url, tokenEnv } })`
		);
		expect(
			failure({
				type: 'remote',
				options: {
					prject: 'shop',
					transport: { options: { url: 'http://nas.lan:7788', tokenEnv: 'T' } },
				},
			}).path
		).toBe('strategy.options.prject');
	});
});

describe('resolveStrategy: the plugin checks its options against the project (statuses, types)', () => {
	const facts = {
		statuses: [
			{ name: 'todo', terminal: false, default: true, outcome: undefined },
			{ name: 'done', terminal: true, default: false, outcome: 'positive' as const },
		],
		types: ['bug'],
	};

	function withProjectCheck(check: StrategyPlugin['validateForProject']): TaskPluginRegistry {
		const registry = createBuiltinRegistry();
		registry.register('plugins.fake.default', { ...fakeStrategy(), validateForProject: check }, ['fake']);
		return registry;
	}

	it('hands the plugin the statuses of the project and names the file and key of its message', () => {
		const seen = vi.fn();
		const registry = withProjectCheck((options, project) => {
			seen(options, project);
			return 'statusMap.done: no entry for the status "done"';
		});

		let error: unknown;
		try {
			resolveStrategy(
				parseStrategySection(FILE, { type: 'fake', options: { repo: 'o/n' } }),
				FILE,
				registry,
				facts
			);
		} catch (caught) {
			error = caught;
		}

		expect(error).toBeInstanceOf(StrategyConfigError);
		expect((error as StrategyConfigError).message).toBe(
			`${FILE}: strategy.options.statusMap.done: no entry for the status "done"`
		);
		expect((error as StrategyConfigError).path).toBe('strategy.options.statusMap.done');
		expect(seen).toHaveBeenCalledWith({ repo: 'o/n' }, facts);
	});

	it('is not asked when the caller gives no facts (a bare resolution)', () => {
		const check = vi.fn(() => 'never');
		const registry = withProjectCheck(check);

		expect(
			resolveStrategy(parseStrategySection(FILE, { type: 'fake', options: { repo: 'o/n' } }), FILE, registry)
		).toBeDefined();
		expect(check).not.toHaveBeenCalled();
	});

	it('a plugin without the check resolves as before', () => {
		const registry = withProjectCheck(undefined);

		expect(
			resolveStrategy(
				parseStrategySection(FILE, { type: 'fake', options: { repo: 'o/n' } }),
				FILE,
				registry,
				facts
			).type
		).toBe('fake');
	});
});
