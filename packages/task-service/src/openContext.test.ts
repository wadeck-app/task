import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { openTaskContext } from './openContext.js';

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
