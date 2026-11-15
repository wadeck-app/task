import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { LOCAL_CAPABILITIES, LOCAL_TRAITS, NO_TRAITS, createLocalBackend } from '@wadeck-app/task-core';
import type { BackendCapabilities, BackendTraits } from '@wadeck-app/task-core';

import { openTaskContext } from '../../openContext.js';
import { checkStrategy } from '../../strategyCheck.js';
import { StrategyConfigError, parseStrategySection } from '../../strategyConfig.js';
import { resolveStrategy, subStrategyViews } from '../../strategyResolve.js';
import type { ProjectFacts, StrategyPlugin, TaskPluginRegistry } from '../kinds.js';
import { createBuiltinRegistry } from '../builtinPlugins.js';
import { migratingPlugin } from './migratingPlugin.js';

const FILE = '/reg/projects/p1/task/config/config.yml';
const FACTS: ProjectFacts = {
	statuses: [
		{ name: 'backlog', terminal: false, default: true, outcome: undefined },
		{ name: 'done', terminal: true, default: false, outcome: 'positive' },
	],
	types: [],
};

function resolve(strategy: unknown, registry: TaskPluginRegistry = createBuiltinRegistry()) {
	return resolveStrategy(parseStrategySection(FILE, strategy), FILE, registry, FACTS);
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

const OK = { type: 'migrating', options: { current: { type: 'local' }, new: { type: 'local' } } };

describe('the migrating strategy is a built-in', () => {
	it('is registered as plugins.migrating.default with the alias migrating', () => {
		const registry = createBuiltinRegistry();

		expect(registry.lookup('migrating', 'strategy')).toBe(migratingPlugin);
		expect(registry.lookup('plugins.migrating.default', 'strategy')).toBe(migratingPlugin);
		expect(migratingPlugin.backendKind).toBe('migrating');
		expect(migratingPlugin.strategySlots).toEqual(['current', 'new']);
	});

	it('implements no fill: every capability it has comes from the two sides', () => {
		expect(migratingPlugin.fillTechniques).toEqual({});
		expect(failure({ ...OK, options: { ...OK.options, fills: { meta: 'labels' } } }).message).toContain(
			'strategy.options.fills.meta'
		);
	});

	it('describes itself with a snippet that names both blocks and the budget', () => {
		const description = migratingPlugin.describe();

		expect(description.summary).toContain('current');
		expect(Object.keys(description.options)).toEqual(['current', 'new', 'budget']);
		expect(description.snippet).toContain('current:');
		expect(description.snippet).toContain('requestsPerMinute');
	});
});

describe('the options of the migrating strategy', () => {
	it('resolves with two blocks and no budget', () => {
		const resolved = resolve(OK);
		expect(resolved.plugin).toBe(migratingPlugin);
		expect(Object.keys(resolved.subs ?? {})).toEqual(['current', 'new']);
	});

	it.each([
		[{ new: { type: 'local' } }, 'strategy.options.current: required'],
		[{ current: { type: 'local' } }, 'strategy.options.new: required'],
		[{ current: 'x', new: { type: 'local' } }, 'strategy.options.current: must be a full strategy block'],
		[{ current: { type: 'local' }, new: { type: 'local' }, other: 1 }, 'strategy.options.other: unknown option'],
	])('%j is refused naming %s', (options, text) => {
		expect(failure({ type: 'migrating', options }).message).toContain(text);
	});

	it('a missing block says what to write', () => {
		const error = failure({ type: 'migrating', options: { new: { type: 'local' } } });
		expect(error.hint).toContain('Options of plugins.migrating.default: current, new, budget');
		expect(error.message).toContain('a full strategy block');
	});

	it.each([
		[{ requestsPerMinute: 30 }, undefined],
		[{ requestsPerMinute: 1 }, undefined],
		[{}, undefined],
		[{ requestsPerMinute: 0 }, 'strategy.options.budget.requestsPerMinute: must be a positive whole number'],
		[{ requestsPerMinute: -3 }, 'strategy.options.budget.requestsPerMinute: must be a positive whole number'],
		[{ requestsPerMinute: 1.5 }, 'strategy.options.budget.requestsPerMinute: must be a positive whole number'],
		[{ requestsPerMinute: '30' }, 'strategy.options.budget.requestsPerMinute: must be a positive whole number'],
		[{ perHour: 5 }, 'strategy.options.budget.perHour: unknown option (known: requestsPerMinute)'],
	])('budget %j', (budget, problem) => {
		const strategy = { type: 'migrating', options: { ...OK.options, budget } };
		if (problem === undefined) {
			expect(() => resolve(strategy)).not.toThrow();
		} else {
			expect(failure(strategy).message).toContain(problem);
		}
	});

	it('a budget that is not a mapping is refused', () => {
		expect(failure({ type: 'migrating', options: { ...OK.options, budget: 30 } }).message).toContain(
			'strategy.options.budget: must be a mapping'
		);
	});

	it('a migrating strategy inside a migrating one is refused in v1 with an actionable error', () => {
		const error = failure({
			type: 'migrating',
			options: { current: { type: 'local' }, new: { type: 'migrating', options: OK.options } },
		});
		expect(error.message).toContain(
			'strategy.options.new.type: "migrating" holds other strategies and cannot be nested'
		);
		expect(error.hint).toContain('plain strategy');
	});

	it('both blocks naming the same storage are refused (nothing to move)', () => {
		const registry = createBuiltinRegistry();
		const where: StrategyPlugin = {
			...registry.lookup('local', 'strategy'),
			backendKind: 'github',
			locationOf: () => 'somewhere shared',
		};
		registry.register('plugins.shared.default', where, ['shared']);

		const error = failure(
			{ type: 'migrating', options: { current: { type: 'shared' }, new: { type: 'shared' } } },
			registry
		);

		expect(error.message).toContain('strategy.options.new: the same storage as "current" (somewhere shared)');
	});

	it('sides that cannot be combined are refused at load naming the capability', () => {
		const registry = createBuiltinRegistry();
		const server: StrategyPlugin = {
			...registry.lookup('local', 'strategy'),
			capabilities: { ...LOCAL_CAPABILITIES, events: 'server' },
			capabilitiesFor: undefined,
		};
		registry.register('plugins.server.default', server, ['server']);

		const error = failure(
			{ type: 'migrating', options: { current: { type: 'local' }, new: { type: 'server' } } },
			registry
		);

		expect(error.message).toContain(
			'strategy.options: the two strategies cannot be combined: events: one side raises the queue events'
		);
	});
});

describe('what the migrating strategy reports about its sides', () => {
	function sided(
		current: Partial<BackendCapabilities>,
		next: Partial<BackendCapabilities>,
		traits?: [BackendTraits, BackendTraits]
	) {
		const registry = createBuiltinRegistry();
		const make = (
			capabilities: Partial<BackendCapabilities>,
			trait: BackendTraits | undefined,
			where?: string
		): StrategyPlugin => ({
			...registry.lookup('local', 'strategy'),
			capabilities: { ...LOCAL_CAPABILITIES, ...capabilities },
			capabilitiesFor: undefined,
			...(trait === undefined ? { traitsFor: undefined } : { traitsFor: () => trait }),
			...(where === undefined ? {} : { locationOf: () => where }),
		});
		registry.register('plugins.sidea.default', make(current, traits?.[0], 'place a'), ['sidea']);
		registry.register('plugins.sideb.default', make(next, traits?.[1], 'place b'), ['sideb']);
		return resolve(
			{ type: 'migrating', options: { current: { type: 'sidea' }, new: { type: 'sideb' } } },
			registry
		);
	}

	it('capabilities are the intersection of the two sides', () => {
		const resolved = sided({}, { meta: false, hierarchy: 'limited', delete: 'no' });

		const caps = resolved.plugin.capabilitiesFor!(resolved.fills, resolved.options, subStrategyViews(resolved));

		expect(caps).toMatchObject({ meta: false, hierarchy: 'limited', delete: 'no', labels: true });
	});

	it('capabilitiesFor without the views of the sides is a bug of the caller, said loudly', () => {
		expect(() => migratingPlugin.capabilitiesFor!({}, OK.options)).toThrow(
			'the migrating strategy needs the resolved strategies of "current" and "new" to know what it can do'
		);
	});

	it('traits are the combination of the two sides, a side that declares none keeping nothing', () => {
		const resolved = sided({}, {}, [LOCAL_TRAITS, { ...NO_TRAITS, hierarchyDepth: 2 }]);

		const traits = resolved.plugin.traitsFor!(resolved.options, resolved.fills, FACTS, subStrategyViews(resolved));

		expect(traits).toMatchObject({
			keepsCreatedAt: false,
			authoredComments: false,
			hierarchyDepth: 2,
			commentTextMax: 10000,
		});
	});

	it('the location is both locations joined, so a migration into either storage is refused', () => {
		const resolved = sided({}, {});
		expect(resolved.plugin.locationOf!(resolved.options, subStrategyViews(resolved))).toBe('place a + place b');
	});

	it('the location is the one the sides have when only one says; none when neither does', () => {
		const registry = createBuiltinRegistry();
		const resolvedLocal = resolveStrategy(parseStrategySection(FILE, OK), FILE, registry, FACTS);
		expect(
			resolvedLocal.plugin.locationOf!(resolvedLocal.options, subStrategyViews(resolvedLocal))
		).toBeUndefined();
	});
});

describe('the migrating strategy once opened (state in-a)', () => {
	let root: string;

	beforeEach(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-service-open-'));
	});

	afterEach(() => {
		fs.rmSync(root, { recursive: true, force: true });
	});

	function open(extra = '', registry = createBuiltinRegistry()) {
		const configFile = path.join(root, 'config', 'config.yml');
		fs.mkdirSync(path.dirname(configFile), { recursive: true });
		fs.writeFileSync(
			configFile,
			`strategy:\n    type: migrating\n    options:\n        current: { type: local }\n        new: { type: local }\n${extra}`,
			'utf8'
		);
		return openTaskContext({
			storage: { dataDir: path.join(root, 'data'), configFiles: [configFile] },
			globalConfigDir: path.join(root, 'global'),
			project: { name: 'shop', path: root },
			registry,
		});
	}

	it('writes go to current only: new is opened in a folder of its own and stays empty', async () => {
		const ctx = open();
		const created = await ctx.store.create({ title: 'first', status: 'backlog' });

		expect((await ctx.store.get(created.id)).title).toBe('first');
		expect(fs.readdirSync(path.join(root, 'data', 'tasks'))).toHaveLength(1);
		await ctx.dispose?.();
		const newTasks = path.join(root, 'data', 'migrating', 'new', 'tasks');
		expect(!fs.existsSync(newTasks) || fs.readdirSync(newTasks).length === 0).toBe(true);
	});

	it('the store reports the kind and the intersected capabilities before anything is opened', () => {
		const ctx = open();

		expect(ctx.store.kind).toBe('migrating');
		expect(ctx.store.capabilities).toEqual(LOCAL_CAPABILITIES);
		expect(fs.existsSync(path.join(root, 'data'))).toBe(false);
	});

	it('shares the options of the budget with nobody: describe lists both sides and the budget', async () => {
		const ctx = open('        budget: { requestsPerMinute: 30 }\n');
		await ctx.store.list();

		expect(ctx.strategy?.options['budget']).toEqual({ requestsPerMinute: 30 });
		await ctx.dispose?.();
	});

	it('a failing side makes the creation fail naming the migrating strategy and the cause', async () => {
		const registry = createBuiltinRegistry();
		const local = registry.lookup('local', 'strategy');
		registry.register(
			'plugins.broken.default',
			{ ...local, create: () => Promise.reject(new Error('cannot open it')) },
			['broken']
		);
		const configFile = path.join(root, 'config', 'config.yml');
		fs.mkdirSync(path.dirname(configFile), { recursive: true });
		fs.writeFileSync(
			configFile,
			'strategy:\n    type: migrating\n    options:\n        current: { type: local }\n        new: { type: broken }\n',
			'utf8'
		);
		const ctx = openTaskContext({
			storage: { dataDir: path.join(root, 'data'), configFiles: [configFile] },
			globalConfigDir: path.join(root, 'global'),
			project: { name: 'shop', path: root },
			registry,
		});

		await expect(ctx.store.list()).rejects.toThrow(
			/plugins\.migrating\.default.*plugins\.broken\.default.*cannot open it/s
		);
	});
});

describe('the migrating strategy and its routing index (phase P1)', () => {
	let root: string;

	beforeEach(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-service-open-'));
	});

	afterEach(() => {
		fs.rmSync(root, { recursive: true, force: true });
	});

	const indexFile = (): string => path.join(root, 'data', 'migrating', 'index.json');

	function target() {
		const configFile = path.join(root, 'config', 'config.yml');
		fs.mkdirSync(path.dirname(configFile), { recursive: true });
		fs.writeFileSync(
			configFile,
			'strategy:\n    type: migrating\n    options:\n        current: { type: local }\n        new: { type: local }\n',
			'utf8'
		);
		return {
			storage: { dataDir: path.join(root, 'data'), configFiles: [configFile] },
			globalConfigDir: path.join(root, 'global'),
			project: { name: 'shop', path: root },
		};
	}

	it('reads the index of the project data folder: a task it sends to new is read there, under its public id', async () => {
		const ctx = openTaskContext(target());
		const created = await ctx.store.create({ title: 'in current', status: 'backlog' });
		const side = createLocalBackend(path.join(root, 'data', 'migrating', 'new', 'tasks'));
		const copy = await side.create({ title: 'in new', status: 'backlog' });
		fs.mkdirSync(path.dirname(indexFile()), { recursive: true });
		fs.writeFileSync(
			indexFile(),
			JSON.stringify({
				format: 1,
				rows: [
					{
						publicId: created.id,
						a: created.id,
						b: copy.id,
						state: 'in-b',
						since: '2026-11-15T10:00:00.000Z',
						version: 1,
					},
				],
			}),
			'utf8'
		);

		const read = await ctx.store.get(created.id);

		expect(read.title).toBe('in new');
		expect(read.id).toBe(created.id);
		expect((await ctx.store.list()).map(task => task.title)).toEqual(['in new']);
		await ctx.dispose?.();
	});

	it('a damaged index makes every read fail naming the file, and the file is left as it was', async () => {
		fs.mkdirSync(path.dirname(indexFile()), { recursive: true });
		fs.writeFileSync(indexFile(), '{ broken', 'utf8');
		const ctx = openTaskContext(target());

		await expect(ctx.store.list()).rejects.toThrow(indexFile());

		expect(fs.readFileSync(indexFile(), 'utf8')).toBe('{ broken');
		await ctx.dispose?.();
	});

	it('strategy check reports the index: no file is fine, a healthy one is counted, a damaged one is an error with its fix', async () => {
		const names = (check: Awaited<ReturnType<typeof checkStrategy>>) =>
			check.lines.filter(line => line.name === 'index');

		const none = names(await checkStrategy(target()));
		expect(none).toHaveLength(1);
		expect(none[0]?.status).toBe('ok');
		expect(none[0]?.text).toContain('no task is routed away from current');

		fs.mkdirSync(path.dirname(indexFile()), { recursive: true });
		fs.writeFileSync(
			indexFile(),
			JSON.stringify({
				format: 1,
				rows: [{ publicId: 'n1', b: '1', state: 'in-b', since: '2026-11-15T10:00:00.000Z', version: 1 }],
			}),
			'utf8'
		);
		const healthy = names(await checkStrategy(target()));
		expect(healthy[0]?.status).toBe('ok');
		expect(healthy[0]?.text).toContain('1 task');
		expect(healthy[0]?.text).toContain('in-b 1');

		fs.writeFileSync(indexFile(), '{ broken', 'utf8');
		const damaged = names(await checkStrategy(target()));
		expect(damaged[0]?.status).toBe('error');
		expect(damaged[0]?.text).toContain(indexFile());
		expect(damaged[0]?.fix).toContain('Do not delete it');
		expect(fs.readFileSync(indexFile(), 'utf8')).toBe('{ broken');
	});
});
