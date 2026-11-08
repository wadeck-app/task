import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { LOCAL_CAPABILITIES } from '@wadeck-app/task-core';

import type { StrategyContext } from '../kinds.js';
import { localPlugin } from './localPlugin.js';

let root: string;

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-service-'));
});

afterEach(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

function contextAt(dataDir: string): StrategyContext {
	return {
		project: { name: 'shop' },
		dataDir,
		tasksDir: path.join(dataDir, 'tasks'),
		writeFile: (file, content) => fs.writeFileSync(file, content, 'utf8'),
		env: {},
		fidelity: 'strict',
		fills: {},
	};
}

describe('the local strategy plugin', () => {
	it('is the strategy kind, declares the local capabilities and implements no fill', () => {
		expect(localPlugin.extensionPoint).toBe('strategy');
		expect(localPlugin.backendKind).toBe('local');
		expect(localPlugin.capabilities).toBe(LOCAL_CAPABILITIES);
		expect(localPlugin.fillTechniques).toEqual({});
	});

	it('takes no option: any key is refused, naming it', () => {
		expect(localPlugin.validate({}, { slot: 'strategy' })).toBeUndefined();
		expect(localPlugin.validate({ path: '/x' }, { slot: 'strategy' })).toBe(
			'path: unknown option for strategy "local" (it takes no option: the data lives in the shared project registry)'
		);
	});

	it('documents itself', () => {
		const description = localPlugin.describe();

		expect(description.summary).toMatch(/project folder of the shared project registry/);
		expect(description.options).toEqual({});
		expect(description.snippet).toContain('type: local');
	});

	it('creates a working backend over the tasks folder', async () => {
		const instance = await localPlugin.create({}, contextAt(path.join(root, 'data')));

		const task = await instance.backend.create({ title: 'first', status: 'backlog' });

		expect(task.title).toBe('first');
		expect(fs.existsSync(path.join(root, 'data', 'tasks'))).toBe(true);
		expect(instance.backend.kind).toBe('local');
		await instance.dispose();
	});

	it('check on a fresh project: nothing created yet is fine, and nothing is created by the check', async () => {
		const dataDir = path.join(root, 'data');
		const instance = await localPlugin.create({}, contextAt(dataDir));

		const lines = await instance.check();

		expect(lines).toEqual([
			{ name: 'data', status: 'ok', text: `${dataDir} (not created yet: the first write creates it)` },
			{ name: 'writable', status: 'ok', text: `${root} is writable` },
			{ name: 'tasks', status: 'ok', text: '0 tasks' },
		]);
		expect(fs.existsSync(dataDir)).toBe(false);
	});

	it('check says "1 task", not "1 tasks"', async () => {
		const instance = await localPlugin.create({}, contextAt(path.join(root, 'data')));
		await instance.backend.create({ title: 'a', status: 'backlog' });

		const lines = await instance.check();

		expect(lines.find(line => line.name === 'tasks')?.text).toBe('1 task (backlog 1)');
	});

	it('check counts the tasks by status', async () => {
		const dataDir = path.join(root, 'data');
		const instance = await localPlugin.create({}, contextAt(dataDir));
		await instance.backend.create({ title: 'a', status: 'backlog' });
		await instance.backend.create({ title: 'b', status: 'backlog' });
		await instance.backend.create({ title: 'c', status: 'done' });

		const lines = await instance.check();

		expect(lines.find(line => line.name === 'tasks')).toEqual({
			name: 'tasks',
			status: 'ok',
			text: '3 tasks (backlog 2, done 1)',
		});
		expect(lines.find(line => line.name === 'data')).toEqual({ name: 'data', status: 'ok', text: dataDir });
		expect(lines.find(line => line.name === 'writable')?.status).toBe('ok');
	});

	it('check reports a data folder that cannot be created, with the fix', async () => {
		const blocker = path.join(root, 'blocker');
		fs.writeFileSync(blocker, 'a file where a folder is needed');
		const dataDir = path.join(blocker, 'data');
		const instance = await localPlugin.create({}, contextAt(dataDir));

		const lines = await instance.check();

		const writable = lines.find(line => line.name === 'writable');
		expect(writable?.status).toBe('error');
		expect(writable?.text).toContain(blocker);
		expect(writable?.fix).toMatch(/not a folder/);
	});

	it('check reports an unreadable task index instead of throwing', async () => {
		const dataDir = path.join(root, 'data');
		const instance = await localPlugin.create({}, contextAt(dataDir));
		await instance.backend.create({ title: 'a', status: 'backlog' });
		fs.writeFileSync(path.join(dataDir, 'task-index.json'), '{ not json');

		const lines = await instance.check();

		const tasks = lines.find(line => line.name === 'tasks');
		expect(tasks?.status).toBe('error');
		expect(tasks?.fix).toContain('task-index.json');
	});

	it('describe lists where the data lives', async () => {
		const dataDir = path.join(root, 'data');
		const instance = await localPlugin.create({}, contextAt(dataDir));

		expect(instance.describe()).toEqual([`data: ${dataDir}`]);
	});
});
