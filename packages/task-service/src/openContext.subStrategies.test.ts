import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { LOCAL_CAPABILITIES } from '@wadeck-app/task-core';
import type { BackendCapabilities } from '@wadeck-app/task-core';

import { openTaskContext } from './openContext.js';
import { createBuiltinRegistry } from './plugins/builtinPlugins.js';
import type { StrategyContext, StrategyInstance, StrategyPlugin, SubStrategyViews } from './plugins/kinds.js';
import type { TaskStorage } from './storage.js';

// The runtime side of a meta-plugin: `openStrategy(slot)` opens a block the host resolved at load, in a folder of its own when asked,
// and disposes it with the parent. A fake meta-plugin records what it was given; the sub-strategies are the real local plugin.
let root: string;

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-service-open-'));
});

afterEach(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

const CONFIG = `strategy:
    type: fakemeta
    options:
        current: { type: local }
        new: { type: local }
`;

function storageWith(configYml: string): TaskStorage {
	const configFile = path.join(root, 'config', 'config.yml');
	fs.mkdirSync(path.dirname(configFile), { recursive: true });
	fs.writeFileSync(configFile, configYml, 'utf8');
	return { dataDir: path.join(root, 'data'), configFiles: [configFile] };
}

interface Probe {
	contexts: StrategyContext[];
	capabilityViews: SubStrategyViews[];
	events: string[];
}

function fakeMeta(
	probe: Probe,
	body: (context: StrategyContext) => Promise<StrategyInstance['backend']>
): StrategyPlugin {
	return {
		extensionPoint: 'strategy',
		backendKind: 'migrating',
		capabilities: LOCAL_CAPABILITIES,
		fillTechniques: {},
		strategySlots: ['current', 'new'],
		validate: () => undefined,
		capabilitiesFor: (_fills, _options, views) => {
			if (views !== undefined) probe.capabilityViews.push(views);
			return { ...LOCAL_CAPABILITIES, meta: false } satisfies BackendCapabilities;
		},
		create: async (_options, context) => {
			probe.contexts.push(context);
			const backend = await body(context);
			return {
				backend,
				describe: () => [],
				check: () => Promise.resolve([]),
				dispose: () => {
					probe.events.push('parent disposed');
					return Promise.resolve();
				},
			};
		},
		describe: () => ({ summary: 'fake meta', options: {}, snippet: '' }),
	};
}

function open(
	plugin: StrategyPlugin,
	configYml = CONFIG,
	extra: { freshReads?: boolean; suppressEvents?: boolean } = {}
) {
	const registry = createBuiltinRegistry();
	registry.register('plugins.fakemeta.default', plugin, ['fakemeta']);
	return openTaskContext({
		storage: storageWith(configYml),
		globalConfigDir: path.join(root, 'global'),
		project: { name: 'shop', path: root },
		registry,
		...extra,
	});
}

function probe(): Probe {
	return { contexts: [], capabilityViews: [], events: [] };
}

describe('openTaskContext: openStrategy for a meta-plugin', () => {
	it('opens the block of a slot as a working strategy in the project data folder', async () => {
		const p = probe();
		const ctx = open(
			fakeMeta(p, async context => {
				const current = await context.openStrategy!('current');
				await current.backend.create({ title: 'in current', status: 'backlog' });
				return current.backend;
			})
		);

		await ctx.store.list();

		expect(fs.readdirSync(path.join(root, 'data', 'tasks')).length).toBeGreaterThan(0);
		await ctx.dispose?.();
	});

	it('gives a sub-strategy a folder of its own when asked: two local sub-strategies never share their files', async () => {
		const p = probe();
		const ctx = open(
			fakeMeta(p, async context => {
				const current = await context.openStrategy!('current');
				const other = await context.openStrategy!('new', { dataSubdir: path.join('migrating', 'new') });
				await other.backend.create({ title: 'in new', status: 'backlog' });
				expect(await current.backend.list()).toEqual([]);
				expect((await other.backend.list()).map(task => task.title)).toEqual(['in new']);
				return current.backend;
			})
		);

		await ctx.store.list();

		expect(fs.existsSync(path.join(root, 'data', 'migrating', 'new', 'tasks'))).toBe(true);
		expect(fs.existsSync(path.join(root, 'data', 'tasks'))).toBe(false);
		await ctx.dispose?.();
	});

	it('answers the same instance for the same slot and folder', async () => {
		const p = probe();
		const ctx = open(
			fakeMeta(p, async context => {
				const first = await context.openStrategy!('current');
				const second = await context.openStrategy!('current');
				expect(second).toBe(first);
				return first.backend;
			})
		);

		await ctx.store.list();
		await ctx.dispose?.();
	});

	it('disposes what it opened, once, after the instance of the parent', async () => {
		const p = probe();
		const registry = createBuiltinRegistry();
		const local = registry.lookup('local', 'strategy');
		registry.register(
			'plugins.tracked.default',
			{
				...local,
				create: async (options: Record<string, unknown>, context: StrategyContext) => {
					const instance = await local.create(options, context);
					return {
						...instance,
						dispose: () => {
							p.events.push(
								`sub disposed (${context.dataDir === path.join(root, 'data') ? 'current' : 'new'})`
							);
							return Promise.resolve();
						},
					};
				},
			},
			['tracked']
		);
		registry.register(
			'plugins.fakemeta.default',
			fakeMeta(p, async context => {
				await context.openStrategy!('current');
				await context.openStrategy!('new', { dataSubdir: 'n' });
				return (await context.openStrategy!('current')).backend;
			}),
			['fakemeta']
		);
		const ctx = openTaskContext({
			storage: storageWith(CONFIG.replaceAll('type: local', 'type: tracked')),
			globalConfigDir: path.join(root, 'global'),
			project: { name: 'shop', path: root },
			registry,
		});

		await ctx.store.list();
		await ctx.dispose?.();
		await ctx.dispose?.();

		expect(p.events).toEqual(['parent disposed', 'sub disposed (current)', 'sub disposed (new)']);
	});

	it('refuses a slot the plugin did not declare or the config did not write, naming the slot and what is available', async () => {
		const p = probe();
		const ctx = open(
			fakeMeta(p, async context => {
				await expect(context.openStrategy!('nope')).rejects.toThrow(
					'strategy slot "nope" is not an option of this strategy that holds a strategy (available: current)'
				);
				return (await context.openStrategy!('current')).backend;
			}),
			'strategy:\n    type: fakemeta\n    options:\n        current: { type: local }\n'
		);

		await ctx.store.list();
		await expect(ctx.store.list()).resolves.toEqual([]);
		await ctx.dispose?.();
	});

	it('hands the plugin the views of its sub-strategies, and its capabilities come from them', async () => {
		const p = probe();
		const ctx = open(fakeMeta(p, async context => (await context.openStrategy!('current')).backend));

		expect(ctx.store.capabilities.meta).toBe(false);
		await ctx.store.list();

		expect(p.capabilityViews[0]?.['current']?.kind).toBe('local');
		expect(p.contexts[0]?.subStrategies?.['new']?.slot).toBe('new');
		await ctx.dispose?.();
	});

	it('a sub-strategy sees the same file, statuses and options as the project, its own fidelity and fills, and no further openStrategy', async () => {
		const p = probe();
		const seen: StrategyContext[] = [];
		const registry = createBuiltinRegistry();
		const local = registry.lookup('local', 'strategy');
		registry.register(
			'plugins.spy.default',
			{
				...local,
				create: (options: Record<string, unknown>, context: StrategyContext) => {
					seen.push(context);
					return local.create(options, context);
				},
			},
			['spy']
		);
		registry.register(
			'plugins.fakemeta.default',
			fakeMeta(p, async context => (await context.openStrategy!('current')).backend),
			['fakemeta']
		);
		const ctx = openTaskContext({
			storage: storageWith(
				'strategy:\n    type: fakemeta\n    options:\n        current: { type: spy, fidelity: degrade }\n        new: { type: local }\n'
			),
			globalConfigDir: path.join(root, 'global'),
			project: { name: 'shop', path: root },
			registry,
			freshReads: true,
			suppressEvents: true,
			memoryCache: true,
		});

		await ctx.store.list();

		expect(seen).toHaveLength(1);
		expect(seen[0]).toMatchObject({
			source: p.contexts[0]?.source,
			fidelity: 'degrade',
			freshReads: true,
			suppressEvents: true,
			memoryCache: true,
			dataDir: path.join(root, 'data'),
		});
		expect(seen[0]?.openStrategy).toBeUndefined();
		expect(seen[0]?.subStrategies).toBeUndefined();
		await ctx.dispose?.();
	});

	it('a project whose strategy holds no strategy gets no openStrategy', async () => {
		const seen: StrategyContext[] = [];
		const registry = createBuiltinRegistry();
		const local = registry.lookup('local', 'strategy');
		registry.register(
			'plugins.spy.default',
			{
				...local,
				create: (options: Record<string, unknown>, context: StrategyContext) => {
					seen.push(context);
					return local.create(options, context);
				},
			},
			['spy']
		);
		const ctx = openTaskContext({
			storage: storageWith('strategy:\n    type: spy\n'),
			globalConfigDir: path.join(root, 'global'),
			project: { name: 'shop', path: root },
			registry,
		});

		await ctx.store.list();

		expect(seen[0]?.openStrategy).toBeUndefined();
		await ctx.dispose?.();
	});

	it('every sub-strategy is disposed even when one of them fails, and the failure is reported naming it', async () => {
		const p = probe();
		const registry = createBuiltinRegistry();
		const local = registry.lookup('local', 'strategy');
		registry.register(
			'plugins.broken.default',
			{
				...local,
				create: async (options: Record<string, unknown>, context: StrategyContext) => ({
					...(await local.create(options, context)),
					dispose: () => Promise.reject(new Error('cannot let go')),
				}),
			},
			['broken']
		);
		registry.register(
			'plugins.fakemeta.default',
			fakeMeta(p, async context => {
				await context.openStrategy!('new', { dataSubdir: 'n' });
				return (await context.openStrategy!('current')).backend;
			}),
			['fakemeta']
		);
		const ctx = openTaskContext({
			storage: storageWith(
				'strategy:\n    type: fakemeta\n    options:\n        current: { type: local }\n        new: { type: broken }\n'
			),
			globalConfigDir: path.join(root, 'global'),
			project: { name: 'shop', path: root },
			registry,
		});

		await ctx.store.list();

		await expect(ctx.dispose?.()).rejects.toThrow('could not release the strategy "new": cannot let go');
	});
});
