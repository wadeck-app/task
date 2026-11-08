import * as fs from 'node:fs';
import * as path from 'node:path';

import { loadRegistry, setParent } from '@wadeck-app/project-sdk';

import { createBuiltinRegistry } from './plugins/builtinPlugins.js';
import { loadProjectSetup, loadTaskConfig } from './projectConfig.js';
import { StrategyConfigError } from './strategyConfig.js';
import { ownConfigFile, registryStorage } from './storage.js';
import type { TaskStorage } from './storage.js';
import { createSharedRegistrySandbox } from './testHelpers.js';
import type { SharedRegistrySandbox } from './testHelpers.js';

let sandbox: SharedRegistrySandbox;

beforeEach(() => {
	sandbox = createSharedRegistrySandbox();
});

afterEach(() => {
	sandbox.cleanup();
});

function write(file: string, yml: string): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, yml);
}

async function single(): Promise<TaskStorage> {
	const project = await sandbox.register('shop', sandbox.dir('shop'));
	return registryStorage(loadRegistry(sandbox.registryDir), sandbox.registryDir, project);
}

async function chain(): Promise<TaskStorage> {
	await sandbox.register('base', sandbox.dir('base'));
	const child = await sandbox.register('shop', sandbox.dir('shop'));
	await setParent(sandbox.registryDir, 'shop', 'base');
	const registry = loadRegistry(sandbox.registryDir);
	return registryStorage(
		registry,
		sandbox.registryDir,
		registry.projects.find(p => p.id === child.id)!
	);
}

function setup(storage: TaskStorage) {
	return loadProjectSetup(storage, {
		globalConfigDir: path.join(sandbox.root, 'global'),
		registry: createBuiltinRegistry(),
	});
}

describe('loadProjectSetup: a project without a strategy section', () => {
	it('is local, strict, not declared, and says nothing', async () => {
		const storage = await single();

		const { strategy, config } = setup(storage);

		expect(strategy).toMatchObject({
			declared: false,
			type: 'local',
			fidelity: 'strict',
			source: ownConfigFile(storage),
		});
		expect(config.statuses).toEqual(['backlog', 'in-progress', 'done']);
	});

	it('an existing config without the section behaves exactly as before', async () => {
		const storage = await single();
		write(ownConfigFile(storage), 'statuses:\n  - todo\n  - done\ntypes:\n  - bug\n');

		const { strategy, config } = setup(storage);

		expect(strategy.declared).toBe(false);
		expect(config.types).toEqual(['bug']);
	});
});

describe('loadProjectSetup: the strategy section', () => {
	it('reads strategy: { type: local } as declared', async () => {
		const storage = await single();
		write(ownConfigFile(storage), 'strategy:\n    type: local\n');

		expect(setup(storage).strategy).toMatchObject({ declared: true, type: 'local', ref: 'plugins.local.default' });
	});

	it('is local scope: a parent strategy is valid in its file but never reaches the child', async () => {
		const storage = await chain();
		const [parentFile] = storage.configFiles as [string, string];
		write(parentFile, 'strategy:\n    type: local\n    fidelity: degrade\n');

		const { strategy } = setup(storage);

		expect(strategy).toMatchObject({ declared: false, fidelity: 'strict' });
	});

	it('a parent whose strategy is a type with no plugin does not break the child that has none', async () => {
		const storage = await chain();
		const [parentFile] = storage.configFiles as [string, string];
		write(parentFile, 'strategy:\n    type: gitlab\n');

		expect(setup(storage).strategy.type).toBe('local');
	});

	it('a structural error in an ANCESTOR layer names the ancestor file', async () => {
		const storage = await chain();
		const [parentFile] = storage.configFiles as [string, string];
		write(parentFile, 'strategy:\n    repo: o/n\n');

		expect(() => loadTaskConfig(storage, sandbox.root)).toThrow(`${parentFile}: strategy.repo: unknown key`);
	});

	it('a structural error in the own layer names the file and the dotted key, from loadTaskConfig too', async () => {
		const storage = await single();
		write(ownConfigFile(storage), 'strategy:\n    options:\n        token: abc\n');

		let failure: unknown;
		try {
			loadTaskConfig(storage, sandbox.root);
		} catch (error) {
			failure = error;
		}

		expect(failure).toBeInstanceOf(StrategyConfigError);
		expect((failure as StrategyConfigError).message).toBe(
			`${ownConfigFile(storage)}: strategy.options.token: a credential must not be written in the config file`
		);
	});

	it('type: gitlab fails loudly in setup, naming the file', async () => {
		const storage = await single();
		write(ownConfigFile(storage), 'strategy:\n    type: gitlab\n');

		expect(() => setup(storage)).toThrow(
			`${ownConfigFile(storage)}: strategy.type: strategy type gitlab is declared but no plugin is installed; built-in types: github, local`
		);
	});

	it('an option the plugin refuses names the file and the dotted key', async () => {
		const storage = await single();
		write(ownConfigFile(storage), 'strategy:\n    type: local\n    options:\n        repo: o/n\n');

		expect(() => setup(storage)).toThrow(
			`${ownConfigFile(storage)}: strategy.options.repo: unknown option for strategy "local"`
		);
	});

	it('pluginsDir is refused with its reason', async () => {
		const storage = await single();
		write(ownConfigFile(storage), 'strategy:\n    pluginsDir: /plugins\n');

		expect(() => setup(storage)).toThrow(
			/strategy\.pluginsDir: external plugins are not supported in this version/
		);
	});

	it('an empty "strategy:" key is refused, not read as the default', async () => {
		const storage = await single();
		write(ownConfigFile(storage), 'strategy:\n');

		expect(() => setup(storage)).toThrow(/strategy: must be a mapping of type, fidelity and options, found null/);
	});
});

describe('the global config', () => {
	it('refuses a strategy: it belongs to one project, with the file named', async () => {
		const storage = await single();
		const globalFile = path.join(sandbox.root, 'global', 'config.yml');
		write(globalFile, 'strategy:\n    type: local\n');

		let failure: unknown;
		try {
			setup(storage);
		} catch (error) {
			failure = error;
		}

		expect(failure).toBeInstanceOf(StrategyConfigError);
		expect((failure as StrategyConfigError).message).toBe(
			`${globalFile}: strategy: not allowed in the global config (it holds defaults and hooks only)`
		);
		expect((failure as StrategyConfigError).hint).toMatch(/config\.yml of the project/);
	});
});
