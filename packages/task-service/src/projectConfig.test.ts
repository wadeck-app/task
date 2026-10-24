import * as fs from 'node:fs';
import * as path from 'node:path';

import { ConfigSchemaError, loadRegistry, setParent } from '@wadeck-app/project-sdk';

import { loadTaskConfig, TASK_CONFIG_SCHEMA } from './projectConfig.js';
import { legacyStorage } from './legacyData.js';
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

/** Writes a config layer file (and its directory). */
function write(file: string, yml: string): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, yml);
}

/** A child project `shop` under a parent `base`; returns the storage of the child (files: [base, shop]). */
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

async function single(): Promise<TaskStorage> {
	const project = await sandbox.register('shop', sandbox.dir('shop'));
	return registryStorage(loadRegistry(sandbox.registryDir), sandbox.registryDir, project);
}

describe('the schema of the task config', () => {
	it('declares the five sections with their scope: statuses, types, fields and hooks local; defaults inherited deeply', () => {
		expect(TASK_CONFIG_SCHEMA.sections).toEqual({
			statuses: { scope: 'local' },
			types: { scope: 'local' },
			fields: { scope: 'local' },
			hooks: { scope: 'local' },
			defaults: { scope: 'inherit', merge: 'deep' },
		});
	});
});

describe('loadTaskConfig: a project of the shared registry', () => {
	it('uses the defaults when no config file exists anywhere', async () => {
		const config = loadTaskConfig(await single(), sandbox.root);

		expect(config.statuses).toEqual(['backlog', 'in-progress', 'done']);
		expect(config.types).toEqual([]);
		expect(config.defaults.priority).toBe('medium');
	});

	it('reads the own config layer', async () => {
		const storage = await single();
		write(ownConfigFile(storage), 'statuses:\n  - todo\n  - name: done\n    terminal: true\ntypes:\n  - bug\n');

		const config = loadTaskConfig(storage, sandbox.root);

		expect(config.statuses).toEqual(['todo', 'done']);
		expect(config.terminalStatuses).toEqual(['done']);
		expect(config.types).toEqual(['bug']);
	});

	it('inherits defaults along the parent chain; the child wins, the global config is the last fallback', async () => {
		const storage = await chain();
		const [parentFile, childFile] = storage.configFiles as [string, string];
		write(path.join(sandbox.root, 'global', 'config.yml'), 'defaults:\n  priority: low\n');

		expect(loadTaskConfig(storage, path.join(sandbox.root, 'global')).defaults.priority).toBe('low');

		write(parentFile, 'defaults:\n  priority: high\n');
		expect(loadTaskConfig(storage, path.join(sandbox.root, 'global')).defaults.priority).toBe('high');

		write(childFile, 'defaults:\n  priority: critical\n');
		expect(loadTaskConfig(storage, path.join(sandbox.root, 'global')).defaults.priority).toBe('critical');
	});

	it('statuses, types and hooks are local: the parent values are valid there but never reach the child', async () => {
		const storage = await chain();
		const [parentFile] = storage.configFiles as [string, string];
		write(
			parentFile,
			'statuses:\n  - only-parent\ntypes:\n  - parent-type\nhooks:\n  onTaskCreated: echo parent\n'
		);

		const config = loadTaskConfig(storage, sandbox.root);

		expect(config.statuses).toEqual(['backlog', 'in-progress', 'done']);
		expect(config.types).toEqual([]);
		expect(config.projectHooks).toEqual({});
	});

	it('keeps the global hooks of the task global config apart from the project hooks', async () => {
		const storage = await single();
		write(path.join(sandbox.root, 'global', 'config.yml'), 'hooks:\n  onTaskCreated: echo global\n');
		write(ownConfigFile(storage), 'hooks:\n  onStatusChange: echo project\n');

		const config = loadTaskConfig(storage, path.join(sandbox.root, 'global'));

		expect(config.globalHooks).toEqual({ onTaskCreated: 'echo global' });
		expect(config.projectHooks).toEqual({ onStatusChange: 'echo project' });
	});

	it('an unknown or misplaced key is an error naming the FILE and the key', async () => {
		const storage = await single();
		write(ownConfigFile(storage), 'statuses:\n  - todo\ncolour: red\n');

		let failure: unknown;
		try {
			loadTaskConfig(storage, sandbox.root);
		} catch (error) {
			failure = error;
		}

		expect(failure).toBeInstanceOf(ConfigSchemaError);
		expect((failure as Error).message).toContain(ownConfigFile(storage));
		expect((failure as Error).message).toContain('colour');
	});

	it('names the file of an ANCESTOR when its key is the problem', async () => {
		const storage = await chain();
		const [parentFile] = storage.configFiles as [string, string];
		write(parentFile, 'prioirty: high\n');

		expect(() => loadTaskConfig(storage, sandbox.root)).toThrow(parentFile);
	});

	it('keeps the status validation on the merged value: at least one, one default at most, the file is named', async () => {
		const storage = await single();
		write(ownConfigFile(storage), 'statuses: []\n');
		expect(() => loadTaskConfig(storage, sandbox.root)).toThrow(new RegExp('at least one status'));
		expect(() => loadTaskConfig(storage, sandbox.root)).toThrow(ownConfigFile(storage));

		write(ownConfigFile(storage), 'statuses:\n  - name: a\n    default: true\n  - name: b\n    default: true\n');
		expect(() => loadTaskConfig(storage, sandbox.root)).toThrow(/Only one status can be the default/);
	});

	it('an invalid YAML file is an error naming the file', async () => {
		const storage = await single();
		write(ownConfigFile(storage), 'statuses: [a, b');

		expect(() => loadTaskConfig(storage, sandbox.root)).toThrow(ownConfigFile(storage));
	});
});

describe('loadTaskConfig: the legacy storage behaves as before', () => {
	it('reads <dir>/.task/config.yml and ignores keys it does not know', () => {
		const dir = sandbox.dir('legacy', { task: true });
		write(path.join(dir, '.task', 'config.yml'), 'statuses:\n  - todo\ncolour: red\n');

		const config = loadTaskConfig(legacyStorage(dir), sandbox.root);

		expect(config.statuses).toEqual(['todo']);
	});
});
