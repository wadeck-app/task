import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { LOCAL_CAPABILITIES } from '@wadeck-app/task-core';

import { openTaskContext } from './openContext.js';
import { createBuiltinRegistry } from './plugins/builtinPlugins.js';
import type { StrategyContext, StrategyPlugin } from './plugins/kinds.js';
import { StrategyConfigError } from './strategyConfig.js';
import type { TaskStorage } from './storage.js';

let root: string;

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-service-open-'));
});

afterEach(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

function storageWith(configYml: string | undefined): TaskStorage {
	const configFile = path.join(root, 'config', 'config.yml');
	if (configYml !== undefined) {
		fs.mkdirSync(path.dirname(configFile), { recursive: true });
		fs.writeFileSync(configFile, configYml, 'utf8');
	}
	return { dataDir: path.join(root, 'data'), configFiles: [configFile] };
}

function open(configYml: string | undefined, registry = createBuiltinRegistry()) {
	return openTaskContext({
		storage: storageWith(configYml),
		globalConfigDir: path.join(root, 'global'),
		project: { name: 'shop', path: root },
		registry,
	});
}

describe('openTaskContext: the strategy', () => {
	it('a project without a strategy section opens the local backend, exactly as before, and says nothing', async () => {
		const ctx = open(undefined);

		expect(ctx.strategy).toMatchObject({ declared: false, type: 'local' });
		expect(ctx.store.kind).toBe('local');
		expect(ctx.store.capabilities).toBe(LOCAL_CAPABILITIES);
		const created = await ctx.store.create({ title: 'first', status: 'backlog' });
		expect(created.title).toBe('first');
		expect(fs.existsSync(path.join(root, 'data', 'tasks'))).toBe(true);
		await ctx.dispose?.();
	});

	it('strategy: { type: local } behaves the same and counts as declared', async () => {
		const ctx = open('strategy:\n    type: local\n');

		expect(ctx.strategy?.declared).toBe(true);
		expect(await ctx.store.list()).toEqual([]);
	});

	it('opening reads nothing from the data folder and creates nothing (construction is cheap)', () => {
		open('strategy:\n    type: local\n');

		expect(fs.existsSync(path.join(root, 'data'))).toBe(false);
	});

	it('a declared type with no plugin fails at open, loudly, naming the file: no local fallback', () => {
		expect(() => open('strategy:\n    type: github\n')).toThrow(StrategyConfigError);
		expect(() => open('strategy:\n    type: github\n')).toThrow(
			'strategy type github is declared but no plugin is installed; built-in types: local'
		);
	});

	it('hands the plugin the project folders, the fidelity and the declared fills; creates the instance once, at the first call', async () => {
		const seen: StrategyContext[] = [];
		const created = vi.fn();
		const registry = createBuiltinRegistry();
		const local = registry.lookup('local', 'strategy');
		const fake: StrategyPlugin = {
			...local,
			backendKind: 'local',
			fillTechniques: { meta: ['labels'] },
			validate: () => undefined,
			create: async (options, context) => {
				seen.push(context);
				created(options);
				return local.create({}, context);
			},
		};
		registry.register('plugins.fake.default', fake, ['fake']);
		const ctx = open(
			'strategy:\n    type: fake\n    fidelity: degrade\n    options:\n        fills:\n            meta: labels\n        extra: 1\n',
			registry
		);
		expect(created).not.toHaveBeenCalled();

		await ctx.store.list();
		await ctx.store.list();

		expect(created).toHaveBeenCalledTimes(1);
		expect(created).toHaveBeenCalledWith({ extra: 1 });
		expect(seen[0]).toMatchObject({
			project: { name: 'shop', path: root },
			dataDir: path.join(root, 'data'),
			tasksDir: path.join(root, 'data', 'tasks'),
			fidelity: 'degrade',
			fills: { meta: { use: 'labels', fidelity: 'degrade' } },
		});
	});

	it('dispose reaches the created instance once and is safe to call twice', async () => {
		const dispose = vi.fn(() => Promise.resolve());
		const registry = createBuiltinRegistry();
		const local = registry.lookup('local', 'strategy');
		const fake: StrategyPlugin = {
			...local,
			create: async (options, context) => ({ ...(await local.create(options, context)), dispose }),
		};
		registry.register('plugins.fake.default', fake, ['fake']);
		const ctx = open('strategy:\n    type: fake\n', registry);
		await ctx.store.list();

		await ctx.dispose?.();
		await ctx.dispose?.();

		expect(dispose).toHaveBeenCalledTimes(1);
	});

	it('dispose on a context that never used its backend opens nothing', async () => {
		const create = vi.fn();
		const registry = createBuiltinRegistry();
		registry.register('plugins.fake.default', { ...registry.lookup('local', 'strategy'), create }, ['fake']);
		const ctx = open('strategy:\n    type: fake\n', registry);

		await ctx.dispose?.();

		expect(create).not.toHaveBeenCalled();
	});
});
