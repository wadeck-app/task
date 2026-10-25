import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { addProject, defaultRegistryDir, projectToolDir, setParent } from '@wadeck-app/project-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Queue delivery is observed at the SDK boundary (a fake publisher), the real sink is under test (see TaskIndex.events.test.ts).
const publishMock = vi.hoisted(() => vi.fn());
const createPublisherMock = vi.hoisted(() => vi.fn());
vi.mock('@wadeck-app/queue-sdk', () => ({ createQueuePublisher: createPublisherMock }));
vi.unmock('@wadeck-app/task-service');

import { runTaskCommand } from './TaskIndex.js';

// The data and the config of a REGISTERED project live in the shared registry (projects/<id>/task/{data,config}),
// never in <main path>/.task. Every test gets its own registry (XDG_CONFIG_HOME -> temp dir, restored afterwards).

let root: string;
let previousXdg: string | undefined;
let stderr: string[];

const ENV_NAMES = ['TASK_PROJECT'];
let previousEnv: Record<string, string | undefined>;

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-registry-data-'));
	previousXdg = process.env['XDG_CONFIG_HOME'];
	process.env['XDG_CONFIG_HOME'] = path.join(root, 'xdg');
	previousEnv = Object.fromEntries(ENV_NAMES.map(name => [name, process.env[name]]));
	for (const name of ENV_NAMES) delete process.env[name];
	stderr = [];
	vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
		stderr.push(String(chunk));
		return true;
	});
	publishMock.mockImplementation(() => Promise.resolve({ status: 'queued', eventId: 'e1' }));
	createPublisherMock.mockImplementation(() => ({
		publishAndWait: publishMock,
		registerEvents: () => Promise.resolve({ status: 'registered', count: 11 }),
		flush: () => Promise.resolve(),
	}));
});

afterEach(() => {
	fs.rmSync(root, { recursive: true, force: true });
	process.env['XDG_CONFIG_HOME'] = previousXdg;
	for (const name of ENV_NAMES) {
		if (previousEnv[name] === undefined) delete process.env[name];
		else process.env[name] = previousEnv[name];
	}
});

const registryDir = (): string => defaultRegistryDir(process.env);

function workDir(name: string): string {
	const dir = path.join(root, 'work', name);
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

async function register(name: string, dir: string | undefined): Promise<{ id: string }> {
	return addProject(registryDir(), { name, aliases: [], ...(dir === undefined ? {} : { path: dir }) });
}

const dataDirOf = (id: string): string => projectToolDir(registryDir(), id, 'task', 'data');
const configDirOf = (id: string): string => projectToolDir(registryDir(), id, 'task', 'config');

function titlesIn(output: string): string[] {
	return (JSON.parse(output) as { title?: string; description?: string }[]).map(t => t.title ?? t.description ?? '');
}

describe('a registered project keeps its data in the shared registry', () => {
	it('new / list / set-status work from any folder, the tasks land in <data>/tasks and <data>/task-index.json, and the project folder stays clean', async () => {
		const dir = workDir('shop');
		const project = await register('shop', dir);
		const elsewhere = workDir('elsewhere');

		const created = await runTaskCommand(['new', 'first task', '-p', 'shop'], elsewhere);
		const id = (JSON.parse(created.output) as { id: string }).id;
		const status = await runTaskCommand(['set-status', id.slice(0, 4), 'in-progress', '-p', 'shop'], elsewhere);
		const listed = await runTaskCommand(['list', '--json', '-p', 'shop'], elsewhere);

		expect(created.exitCode).toBe(0);
		expect(status.exitCode).toBe(0);
		expect(titlesIn(listed.output)).toEqual(['first task']);
		expect(fs.existsSync(path.join(dataDirOf(project.id), 'tasks', `${id}.json`))).toBe(true);
		expect(fs.existsSync(path.join(dataDirOf(project.id), 'task-index.json'))).toBe(true);
		expect(fs.existsSync(path.join(dir, '.task'))).toBe(false);
		expect(stderr.join('')).toBe('');
	});

	it('a project with no data anywhere is a fresh project: reading it is empty and creates nothing, the first write creates the folders', async () => {
		const dir = workDir('fresh');
		const project = await register('fresh', dir);

		const empty = await runTaskCommand(['list', '--json', '-p', 'fresh'], root);

		expect(empty.exitCode).toBe(0);
		expect(titlesIn(empty.output)).toEqual([]);
		expect(fs.existsSync(path.join(registryDir(), 'projects', project.id))).toBe(false);

		await runTaskCommand(['new', 'x', '-p', 'fresh'], root);

		expect(fs.existsSync(path.join(dataDirOf(project.id), 'tasks'))).toBe(true);
	});

	it('the cwd inside the registered folder selects it, and the events keep the main path as cwd with the id', async () => {
		const dir = workDir('shop');
		const project = await register('shop', dir);
		const sub = path.join(dir, 'src');
		fs.mkdirSync(sub);

		await runTaskCommand(['new', 'x'], sub);

		expect(publishMock).toHaveBeenCalledTimes(1);
		const [name, payload, options] = publishMock.mock.calls[0] as [
			string,
			Record<string, unknown>,
			{ cwd: string },
		];
		expect(name).toBe('onTaskCreated');
		expect(payload).toMatchObject({
			taskProjectId: project.id,
			taskProjectName: 'shop',
			taskProjectPath: path.resolve(dir),
		});
		expect(options.cwd).toBe(path.resolve(dir));
	});

	it('task type add writes the project OWN config layer (created), type list reads it, type remove edits it', async () => {
		const dir = workDir('shop');
		const project = await register('shop', dir);

		const added = await runTaskCommand(['type', 'add', 'bug', '-p', 'shop'], root);
		const listed = await runTaskCommand(['type', 'list', '-p', 'shop'], root);
		const configFile = path.join(configDirOf(project.id), 'config.yml');

		expect(added.exitCode).toBe(0);
		expect(listed.output).toBe('bug');
		expect(fs.readFileSync(configFile, 'utf8')).toContain('bug');
		expect(fs.existsSync(path.join(dir, '.task'))).toBe(false);

		await runTaskCommand(['type', 'remove', 'bug', '-p', 'shop'], root);
		expect((await runTaskCommand(['type', 'list', '-p', 'shop'], root)).output).toContain('no types configured');
	});

	it('the config comes from the project chain: defaults are inherited, statuses stay local', async () => {
		const parentDir = workDir('base');
		const childDir = workDir('shop');
		const parent = await register('base', parentDir);
		const child = await register('shop', childDir);
		await setParent(registryDir(), 'shop', 'base');
		fs.mkdirSync(configDirOf(parent.id), { recursive: true });
		fs.writeFileSync(
			path.join(configDirOf(parent.id), 'config.yml'),
			'statuses:\n  - parent-only\ndefaults:\n  priority: high\n'
		);
		fs.mkdirSync(configDirOf(child.id), { recursive: true });
		fs.writeFileSync(path.join(configDirOf(child.id), 'config.yml'), 'statuses:\n  - todo\n  - done\n');

		const created = await runTaskCommand(['new', 'x', '-p', 'shop'], root);

		expect((JSON.parse(created.output) as { status: string }).status).toBe('todo');
	});

	it('a misplaced key in a config layer is an error naming the file and the key, nothing is written', async () => {
		const dir = workDir('shop');
		const project = await register('shop', dir);
		const file = path.join(configDirOf(project.id), 'config.yml');
		fs.mkdirSync(configDirOf(project.id), { recursive: true });
		fs.writeFileSync(file, 'colour: red\n');

		const result = await runTaskCommand(['new', 'x', '-p', 'shop'], root);

		expect(result.exitCode).toBe(1);
		expect(result.output).toContain(file);
		expect(result.output).toContain('colour');
		expect(fs.existsSync(path.join(dataDirOf(project.id), 'tasks'))).toBe(false);
	});
});

describe('a virtual project (registered, no folder)', () => {
	it('keeps its data in the registry, the command succeeds, and the event is undelivered with a reason naming the virtual project (never the current directory)', async () => {
		const project = await register('notes', undefined);

		const created = await runTaskCommand(['new', 'idea', '-p', 'notes'], root);

		expect(created.exitCode).toBe(0);
		expect(fs.readdirSync(path.join(dataDirOf(project.id), 'tasks'))).toHaveLength(1);
		expect(publishMock).not.toHaveBeenCalled();
		expect(stderr.join('')).toContain('virtual project notes');
		expect(titlesIn((await runTaskCommand(['list', '--json', '-p', 'notes'], root)).output)).toEqual(['idea']);
	});
});
