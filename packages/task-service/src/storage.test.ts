import * as fs from 'node:fs';
import * as path from 'node:path';

import { loadRegistry, projectToolDir, setParent } from '@wadeck-app/project-sdk';

import { ProjectDataSplitError } from './errors.js';
import {
	chooseDataLocation,
	describeLegacyData,
	hasTaskData,
	legacyStorage,
	ownConfigFile,
	registryStorage,
	tasksDirOf,
} from './storage.js';
import { createSharedRegistrySandbox } from './testHelpers.js';
import type { SharedRegistrySandbox } from './testHelpers.js';

let sandbox: SharedRegistrySandbox;

beforeEach(() => {
	sandbox = createSharedRegistrySandbox();
});

afterEach(() => {
	sandbox.cleanup();
});

function writeLegacyTask(dir: string, id: string): void {
	const tasks = path.join(dir, '.task', 'tasks');
	fs.mkdirSync(tasks, { recursive: true });
	fs.writeFileSync(path.join(tasks, `${id}.json`), '{}');
}

describe('legacyStorage', () => {
	it('keeps everything in <dir>/.task: tasks/, task-index.json and config.yml', () => {
		const storage = legacyStorage('/work/app');

		expect(storage.kind).toBe('legacy');
		expect(storage.dataDir).toBe(path.join('/work/app', '.task'));
		expect(tasksDirOf(storage)).toBe(path.join('/work/app', '.task', 'tasks'));
		expect(storage.configFiles).toEqual([path.join('/work/app', '.task', 'config.yml')]);
		expect(ownConfigFile(storage)).toBe(path.join('/work/app', '.task', 'config.yml'));
		expect(storage.legacyDir).toBeUndefined();
	});
});

describe('registryStorage', () => {
	it('puts the data in the SDK data dir of the task tool and pins the layout <data>/tasks + <data>/task-index.json', async () => {
		const project = await sandbox.register('shop', sandbox.dir('shop'));

		const storage = registryStorage(loadRegistry(sandbox.registryDir), sandbox.registryDir, project);

		const data = projectToolDir(sandbox.registryDir, project.id, 'task', 'data');
		expect(storage.kind).toBe('registry');
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

	it('lists the config files root first, the project own file last, and names the legacy .task of the main path', async () => {
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
		expect(storage.legacyDir).toBe(path.join(path.resolve(sandbox.dir('shop')), '.task'));
	});

	it('a virtual project has data and config dirs, and no legacy dir', async () => {
		const project = await sandbox.register('notes', undefined);

		const storage = registryStorage(loadRegistry(sandbox.registryDir), sandbox.registryDir, project);

		expect(storage.dataDir).toBe(projectToolDir(sandbox.registryDir, project.id, 'task', 'data'));
		expect(storage.legacyDir).toBeUndefined();
	});
});

describe('hasTaskData / describeLegacyData', () => {
	it('an absent or empty data dir holds no task data; a task file or the index is data', () => {
		const data = path.join(sandbox.root, 'data');
		expect(hasTaskData(data)).toBe(false);
		fs.mkdirSync(path.join(data, 'tasks'), { recursive: true });
		expect(hasTaskData(data)).toBe(false);
		fs.writeFileSync(path.join(data, 'tasks', 'a.json'), '{}');
		expect(hasTaskData(data)).toBe(true);
		fs.rmSync(path.join(data, 'tasks', 'a.json'));
		fs.writeFileSync(path.join(data, 'task-index.json'), '{"tasks":[]}');
		expect(hasTaskData(data)).toBe(true);
	});

	it('counts the task files, the index and the config of a .task', () => {
		const dir = sandbox.dir('shop');
		writeLegacyTask(dir, 'one');
		writeLegacyTask(dir, 'two');
		fs.writeFileSync(path.join(dir, '.task', 'config.yml'), 'types: [bug]\n');

		expect(describeLegacyData(path.join(dir, '.task'))).toEqual({ tasks: 2, index: false, config: true });
		expect(describeLegacyData(path.join(dir, 'nothing-here'))).toEqual({ tasks: 0, index: false, config: false });
	});
});

describe('chooseDataLocation: an unmigrated project keeps working on its .task, a real split is the only error', () => {
	async function open(name: string, dir: string | undefined = sandbox.dir(name)) {
		const project = await sandbox.register(name, dir);
		return { project, storage: registryStorage(loadRegistry(sandbox.registryDir), sandbox.registryDir, project) };
	}

	function writeRegistryTask(dataDir: string, id: string): void {
		fs.mkdirSync(path.join(dataDir, 'tasks'), { recursive: true });
		fs.writeFileSync(path.join(dataDir, 'tasks', `${id}.json`), '{}');
	}

	it('a fresh project (no data in the registry, no .task) uses the registry, silently', async () => {
		const { project, storage } = await open('shop');

		const chosen = chooseDataLocation(storage, project.name);

		expect(chosen.storage).toBe(storage);
		expect(chosen.notice).toBeUndefined();
	});

	it('a registry that holds the data and no .task uses the registry, silently', async () => {
		const { project, storage } = await open('shop');
		writeRegistryTask(storage.dataDir, 'one');

		const chosen = chooseDataLocation(storage, project.name);

		expect(chosen.storage).toBe(storage);
		expect(chosen.notice).toBeUndefined();
	});

	it('UNMIGRATED (the .task holds tasks, the registry none): keeps working on the .task exactly like stage 1, with the one deprecation line', async () => {
		const dir = sandbox.dir('shop');
		writeLegacyTask(dir, 'one');
		const { project, storage } = await open('shop', dir);

		const chosen = chooseDataLocation(storage, project.name);

		const legacyDir = path.join(path.resolve(dir), '.task');
		expect(chosen.storage).toEqual({
			kind: 'legacy',
			dataDir: legacyDir,
			configFiles: [path.join(legacyDir, 'config.yml')],
		});
		expect(chosen.notice).toBe(
			`Deprecated: project shop still keeps its task data in ${legacyDir}; copy it with: task cli migrate-data -p shop (then delete .task by hand)`
		);
	});

	it('UNMIGRATED with a .task that holds only a config.yml (the registry has neither data nor own config): also stage 1 behaviour', async () => {
		const dir = sandbox.dir('shop');
		fs.mkdirSync(path.join(dir, '.task'), { recursive: true });
		fs.writeFileSync(path.join(dir, '.task', 'config.yml'), 'types: [bug]\n');
		const { project, storage } = await open('shop', dir);

		const chosen = chooseDataLocation(storage, project.name);

		expect(chosen.storage.kind).toBe('legacy');
		expect(chosen.notice).toContain('task cli migrate-data -p shop');
	});

	it('a .task with nothing in it (an empty tasks/ only) is not data: the registry is used silently', async () => {
		const dir = sandbox.dir('shop', { task: true });
		const { project, storage } = await open('shop', dir);

		const chosen = chooseDataLocation(storage, project.name);

		expect(chosen.storage).toBe(storage);
		expect(chosen.notice).toBeUndefined();
	});

	it('RIGHT AFTER MIGRATION (both places hold the same task ids): uses the registry and notes the old copy', async () => {
		const dir = sandbox.dir('shop');
		writeLegacyTask(dir, 'one');
		writeLegacyTask(dir, 'two');
		const { project, storage } = await open('shop', dir);
		writeRegistryTask(storage.dataDir, 'two');
		writeRegistryTask(storage.dataDir, 'one');

		const chosen = chooseDataLocation(storage, project.name);

		expect(chosen.storage).toBe(storage);
		expect(chosen.notice).toBe(
			`old copy still in ${path.join(path.resolve(dir), '.task')}: delete it by hand once checked`
		);
	});

	it('a REAL SPLIT (both hold tasks, the ids differ) fails with both folders and the two ways out', async () => {
		const dir = sandbox.dir('shop');
		writeLegacyTask(dir, 'one');
		const { project, storage } = await open('shop', dir);
		writeRegistryTask(storage.dataDir, 'other');

		let failure: unknown;
		try {
			chooseDataLocation(storage, project.name);
		} catch (error) {
			failure = error;
		}

		expect(failure).toBeInstanceOf(ProjectDataSplitError);
		const error = failure as ProjectDataSplitError;
		const legacyDir = path.join(path.resolve(dir), '.task');
		expect(error.message).toContain(legacyDir);
		expect(error.message).toContain(storage.dataDir);
		expect(error.message).toContain('shop');
		expect(error.hint).toContain(`delete ${legacyDir} by hand`);
		expect(error.hint).toContain(`move ${storage.dataDir} away`);
	});

	it('the same ids with one extra task on either side is a real split', async () => {
		const dir = sandbox.dir('shop');
		writeLegacyTask(dir, 'one');
		writeLegacyTask(dir, 'extra');
		const { project, storage } = await open('shop', dir);
		writeRegistryTask(storage.dataDir, 'one');

		expect(() => chooseDataLocation(storage, project.name)).toThrow(ProjectDataSplitError);
	});

	it('does nothing for the legacy storage', () => {
		const storage = legacyStorage(sandbox.dir('x', { task: true }));

		const chosen = chooseDataLocation(storage, 'x');

		expect(chosen.storage).toBe(storage);
		expect(chosen.notice).toBeUndefined();
	});
});
