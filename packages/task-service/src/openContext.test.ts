import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { loadRegistry } from '@wadeck-app/project-sdk';

import { ProjectDataSplitError } from './errors.js';
import { openResolvedProject, openTaskContext } from './openContext.js';
import { resolveProject } from './resolveProject.js';
import { ownConfigFile, registryStorage } from './storage.js';
import { createSharedRegistrySandbox } from './testHelpers.js';
import type { SharedRegistrySandbox } from './testHelpers.js';

let root: string;

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-service-open-'));
});

afterEach(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

function initProject(configYml: string): string {
	const projectDir = path.join(root, 'my-project');
	fs.mkdirSync(path.join(projectDir, '.task', 'tasks'), { recursive: true });
	fs.writeFileSync(path.join(projectDir, '.task', 'config.yml'), configYml, 'utf8');
	return projectDir;
}

describe('openTaskContext', () => {
	it('names the project after its directory and keeps the directory as path', () => {
		const projectDir = initProject('statuses:\n  - todo\n  - done\n');
		expect(openTaskContext({ projectDir }).project).toEqual({ name: 'my-project', path: projectDir });
	});

	it('takes the identity of a registered project (id and name of the shared registry) and still reads <path>/.task', () => {
		const projectDir = initProject('statuses:\n  - todo\n');

		const { project, store } = openTaskContext({ projectDir, project: { id: 'a1b2c3d4', name: 'shop' } });

		expect(project).toEqual({ id: 'a1b2c3d4', name: 'shop', path: projectDir });
		expect(store.create('x', 'todo').id).toBeTruthy();
		expect(fs.readdirSync(path.join(projectDir, '.task', 'tasks'))).not.toEqual([]);
	});

	it('has no id key for a project that is not registered', () => {
		const projectDir = initProject('statuses:\n  - todo\n');

		expect(Object.keys(openTaskContext({ projectDir }).project)).toEqual(['name', 'path']);
	});

	it('resolves the project config.yml', () => {
		const projectDir = initProject('statuses:\n  - todo\n  - name: done\n    terminal: true\n');
		const { config } = openTaskContext({ projectDir });
		expect(config.statuses).toEqual(['todo', 'done']);
		expect(config.terminalStatuses).toEqual(['done']);
	});

	it('stores tasks under <project>/.task/tasks', () => {
		const projectDir = initProject('statuses:\n  - todo\n');
		const { store } = openTaskContext({ projectDir });
		const task = store.create('hello', 'todo');
		expect(fs.readdirSync(path.join(projectDir, '.task', 'tasks')).some(file => file.includes(task.id))).toBe(true);
	});

	it('reads the global hooks from the given global config dir', () => {
		const projectDir = initProject('statuses:\n  - todo\n');
		const globalDir = path.join(root, 'global');
		fs.mkdirSync(globalDir);
		fs.writeFileSync(path.join(globalDir, 'config.yml'), 'hooks:\n  onTaskCreated: echo hi\n', 'utf8');
		expect(openTaskContext({ projectDir, globalConfigDir: globalDir }).config.globalHooks).toEqual({
			onTaskCreated: 'echo hi',
		});
	});

	it('fails loudly on an invalid config.yml instead of falling back to defaults', () => {
		const projectDir = initProject('statuses: []\n');
		expect(() => openTaskContext({ projectDir })).toThrow('at least one status');
	});
});

describe('openTaskContext: a project of the shared registry', () => {
	let sandbox: SharedRegistrySandbox;

	beforeEach(() => {
		sandbox = createSharedRegistrySandbox();
	});

	afterEach(() => {
		sandbox.cleanup();
	});

	async function registryStorageOf(name: string, dir: string | undefined = sandbox.dir(name)) {
		const project = await sandbox.register(name, dir);
		const storage = registryStorage(loadRegistry(sandbox.registryDir), sandbox.registryDir, project);
		return { project, storage };
	}

	it('keeps the tasks in <data>/tasks and the index in <data>/task-index.json, created by the first write', async () => {
		const { project, storage } = await registryStorageOf('shop');
		const { store, storage: used } = openTaskContext({ storage, project: { id: project.id, name: 'shop' } });
		expect(fs.existsSync(storage.dataDir)).toBe(false);

		const task = store.create('first', 'backlog');

		expect(used).toBe(storage);
		expect(fs.existsSync(path.join(storage.dataDir, 'tasks', `${task.id}.json`))).toBe(true);
		expect(fs.existsSync(path.join(storage.dataDir, 'task-index.json'))).toBe(true);
		// Nothing is written in the project folder.
		expect(fs.existsSync(path.join(sandbox.dir('shop'), '.task'))).toBe(false);
	});

	it('reading a fresh project creates nothing', async () => {
		const { project, storage } = await registryStorageOf('shop');

		const { store } = openTaskContext({ storage, project: { id: project.id, name: 'shop' } });

		expect(store.list()).toEqual([]);
		expect(fs.existsSync(path.join(sandbox.registryDir, 'projects', project.id))).toBe(false);
	});

	it('resolves the config from the project config layers', async () => {
		const { project, storage } = await registryStorageOf('shop');
		fs.mkdirSync(path.dirname(ownConfigFile(storage)), { recursive: true });
		fs.writeFileSync(ownConfigFile(storage), 'types:\n  - bug\n');

		const { config } = openTaskContext({ storage, project: { id: project.id, name: 'shop' } });

		expect(config.types).toEqual(['bug']);
	});

	it('UNMIGRATED: keeps reading and writing the .task of the main path like stage 1, keeps the registry identity, and carries the deprecation line', async () => {
		const dir = sandbox.dir('shop', { task: true });
		fs.writeFileSync(path.join(dir, '.task', 'config.yml'), 'types:\n  - old\n');
		const { project, storage } = await registryStorageOf('shop', dir);
		const first = openTaskContext({ storage, project: { id: project.id, name: 'shop', path: dir } });
		const task = first.store.create('written in the .task', 'backlog');
		expect(fs.existsSync(path.join(dir, '.task', 'tasks', `${task.id}.json`))).toBe(true);

		const ctx = openTaskContext({ storage, project: { id: project.id, name: 'shop', path: dir } });

		expect(ctx.storage.kind).toBe('legacy');
		expect(ctx.project).toEqual({ id: project.id, name: 'shop', path: dir });
		expect(ctx.store.list().map(t => t.id)).toEqual([task.id]);
		expect(ctx.config.types).toEqual(['old']);
		expect(ctx.notices).toEqual([
			`Deprecated: project shop still keeps its task data in ${path.join(path.resolve(dir), '.task')}; copy it with: task cli migrate-data -p shop (then delete .task by hand)`,
		]);
		// Nothing was created in the registry.
		expect(fs.existsSync(storage.dataDir)).toBe(false);
	});

	it('a registry project with no data anywhere is fresh: registry storage, no notice', async () => {
		const { project, storage } = await registryStorageOf('shop');

		const ctx = openTaskContext({ storage, project: { id: project.id, name: 'shop' } });

		expect(ctx.storage.kind).toBe('registry');
		expect(ctx.notices).toEqual([]);
	});

	it('refuses a REAL split (tasks in both places, different ids), naming both folders', async () => {
		const dir = sandbox.dir('shop', { task: true });
		fs.writeFileSync(path.join(dir, '.task', 'tasks', 'one.json'), '{}');
		const { project, storage } = await registryStorageOf('shop', dir);
		fs.mkdirSync(path.join(storage.dataDir, 'tasks'), { recursive: true });
		fs.writeFileSync(path.join(storage.dataDir, 'tasks', 'two.json'), '{}');

		expect(() => openTaskContext({ storage, project: { id: project.id, name: 'shop' } })).toThrow(
			ProjectDataSplitError
		);
	});

	it('a virtual project has data, and no path in its identity', async () => {
		const { project, storage } = await registryStorageOf('notes', undefined);

		const { project: identity, store } = openTaskContext({ storage, project: { id: project.id, name: 'notes' } });
		store.create('t', 'backlog');

		expect(identity).toEqual({ id: project.id, name: 'notes' });
		expect(fs.readdirSync(path.join(storage.dataDir, 'tasks'))).toHaveLength(1);
	});

	it('needs a storage or a projectDir', () => {
		expect(() => openTaskContext({})).toThrow(/projectDir|storage/);
	});
});

describe('openResolvedProject', () => {
	let sandbox: SharedRegistrySandbox;

	beforeEach(() => {
		sandbox = createSharedRegistrySandbox();
	});

	afterEach(() => {
		sandbox.cleanup();
	});

	it('opens a registered project on its registry data, with its id, name and main path', async () => {
		const dir = sandbox.dir('shop');
		const project = await sandbox.register('shop', dir);

		const ctx = openResolvedProject(resolveProject({ cwd: dir, env: sandbox.env }));

		expect(ctx.project).toEqual({ id: project.id, name: 'shop', path: path.resolve(dir) });
		expect(ctx.storage.kind).toBe('registry');
	});

	it('opens a legacy folder on its .task, without id', () => {
		const dir = sandbox.dir('old', { task: true });

		const ctx = openResolvedProject(resolveProject({ cwd: dir, env: sandbox.env }));

		expect(ctx.project).toEqual({ name: 'old', path: path.resolve(dir) });
		expect(ctx.storage.kind).toBe('legacy');
	});

	it('opens an unmigrated registered project on its .task (stage 1 behaviour) with the notice', async () => {
		const dir = sandbox.dir('shop', { task: true });
		fs.writeFileSync(path.join(dir, '.task', 'tasks', 'one.json'), '{}');
		const project = await sandbox.register('shop', dir);

		const ctx = openResolvedProject(resolveProject({ cwd: dir, env: sandbox.env }));

		expect(ctx.storage.kind).toBe('legacy');
		expect(ctx.project.id).toBe(project.id);
		expect(ctx.notices).toHaveLength(1);
		expect(ctx.notices![0]).toContain('task cli migrate-data -p shop');
	});
});
