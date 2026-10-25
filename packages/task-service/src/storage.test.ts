import * as fs from 'node:fs';
import * as path from 'node:path';

import { loadRegistry, projectToolDir, setParent } from '@wadeck-app/project-sdk';

import { ownConfigFile, registryStorage, tasksDirOf } from './storage.js';
import { createSharedRegistrySandbox } from './testHelpers.js';
import type { SharedRegistrySandbox } from './testHelpers.js';

let sandbox: SharedRegistrySandbox;

beforeEach(() => {
	sandbox = createSharedRegistrySandbox();
});

afterEach(() => {
	sandbox.cleanup();
});

describe('registryStorage', () => {
	it('puts the data in the SDK data dir of the task tool and pins the layout <data>/tasks + <data>/task-index.json', async () => {
		const project = await sandbox.register('shop', sandbox.dir('shop'));

		const storage = registryStorage(loadRegistry(sandbox.registryDir), sandbox.registryDir, project);

		const data = projectToolDir(sandbox.registryDir, project.id, 'task', 'data');

		expect(storage.dataDir).toBe(data);
		expect(tasksDirOf(storage)).toBe(path.join(data, 'tasks'));
		// The store derives the index as <tasksDir>/../task-index.json: it lands next to tasks/, in the data dir.
		expect(path.join(tasksDirOf(storage), '..', 'task-index.json')).toBe(path.join(data, 'task-index.json'));
	});

	it('does not create anything on disk (reading a fresh project writes nothing in the registry)', async () => {
		const project = await sandbox.register('shop', sandbox.dir('shop'));

		registryStorage(loadRegistry(sandbox.registryDir), sandbox.registryDir, project);

		expect(fs.existsSync(path.join(sandbox.registryDir, 'projects', project.id))).toBe(false);
	});

	it('lists the config files root first, the project own file last', async () => {
		const parent = await sandbox.register('base', sandbox.dir('base'));
		const child = await sandbox.register('shop', sandbox.dir('shop'));
		await setParent(sandbox.registryDir, 'shop', 'base');

		const registry = loadRegistry(sandbox.registryDir);
		const storage = registryStorage(
			registry,
			sandbox.registryDir,
			registry.projects.find(p => p.id === child.id)!
		);

		expect(storage.configFiles).toEqual([
			path.join(projectToolDir(sandbox.registryDir, parent.id, 'task', 'config'), 'config.yml'),
			path.join(projectToolDir(sandbox.registryDir, child.id, 'task', 'config'), 'config.yml'),
		]);
		expect(ownConfigFile(storage)).toBe(storage.configFiles[1]);
	});

	it('a virtual project has data and config dirs', async () => {
		const project = await sandbox.register('notes', undefined);

		const storage = registryStorage(loadRegistry(sandbox.registryDir), sandbox.registryDir, project);

		expect(storage.dataDir).toBe(projectToolDir(sandbox.registryDir, project.id, 'task', 'data'));
	});
});
