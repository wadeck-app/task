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
import { TEMPLATE_CONFIG } from './testHelpers.js';

// Stage 2a: the data and the config of a REGISTERED project live in the shared registry (projects/<id>/task/{data,config}),
// never in <main path>/.task. Every test gets its own registry (XDG_CONFIG_HOME -> temp dir, restored afterwards).

let root: string;
let previousXdg: string | undefined;
let stderr: string[];

const ENV_NAMES = ['TASK_PROJECT', 'TASK_PROJECT_DIR', 'PROJECT_DIR'];
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

describe('a registered project whose data is still in <main path>/.task keeps working on it (stage 1 behaviour) with ONE deprecation line; only a real split is refused', () => {
	async function unmigrated(): Promise<{ dir: string; id: string }> {
		const dir = workDir('shop');
		fs.mkdirSync(path.join(dir, '.task', 'tasks'), { recursive: true });
		fs.writeFileSync(path.join(dir, '.task', 'config.yml'), TEMPLATE_CONFIG);
		fs.writeFileSync(
			path.join(dir, '.task', 'tasks', 'abc12345.json'),
			JSON.stringify({
				id: 'abc12345',
				title: 'old',
				description: 'old',
				status: 'backlog',
				createdAt: 'x',
				updatedAt: 'x',
				history: [],
			})
		);
		fs.writeFileSync(
			path.join(dir, '.task', 'task-index.json'),
			JSON.stringify({ tasks: [{ id: 'abc12345', title: 'old', status: 'backlog', createdAt: 'x' }] })
		);
		const project = await register('shop', dir);
		return { dir, id: project.id };
	}

	const deprecation = (dir: string): string =>
		`Deprecated: project shop still keeps its task data in ${path.join(path.resolve(dir), '.task')}; copy it with: task cli migrate-data -p shop (then delete .task by hand)`;

	it('list / new / type list work on the .task exactly like stage 1, the registry stays untouched, stderr has exactly the one line', async () => {
		const { dir, id } = await unmigrated();

		const listed = await runTaskCommand(['list', '--json', '-p', 'shop'], root);
		const lines = stderr.join('').split('\n').filter(Boolean);
		expect(listed.exitCode).toBe(0);
		expect(titlesIn(listed.output)).toEqual(['old']);
		expect(lines).toEqual([deprecation(dir)]);

		stderr.length = 0;
		const created = await runTaskCommand(['new', 'added', '-p', 'shop'], root);
		const newId = (JSON.parse(created.output) as { id: string }).id;
		expect(created.exitCode).toBe(0);
		expect(fs.existsSync(path.join(dir, '.task', 'tasks', `${newId}.json`))).toBe(true);
		expect(stderr.join('').split('\n').filter(Boolean)).toEqual([deprecation(dir)]);

		stderr.length = 0;
		const types = await runTaskCommand(['type', 'list', '-p', 'shop'], root);
		expect(types.exitCode).toBe(0);
		expect(stderr.join('').split('\n').filter(Boolean)).toEqual([deprecation(dir)]);
		// Nothing was created in the registry.
		expect(fs.existsSync(dataDirOf(id))).toBe(false);
	});

	it('the line is on stderr only, also with --json: stdout stays the pure answer', async () => {
		const { dir } = await unmigrated();

		const result = await runTaskCommand(['--json', 'list', '-p', 'shop'], root);

		expect(() => JSON.parse(result.output) as unknown).not.toThrow();
		expect(result.output).not.toContain('Deprecated');
		expect(stderr.join('').trim()).toBe(deprecation(dir));
	});

	it('the cwd inside the registered folder behaves the same', async () => {
		const { dir } = await unmigrated();

		const result = await runTaskCommand(['list', '--json'], dir);

		expect(titlesIn(result.output)).toEqual(['old']);
		expect(stderr.join('').trim()).toBe(deprecation(dir));
	});

	it('a REAL split (tasks in both places, different ids) fails naming both folders and the two ways out, in text and in JSON', async () => {
		const { dir, id } = await unmigrated();
		fs.mkdirSync(path.join(dataDirOf(id), 'tasks'), { recursive: true });
		fs.writeFileSync(path.join(dataDirOf(id), 'tasks', 'other999.json'), '{}');

		const text = await runTaskCommand(['list', '-p', 'shop'], root);
		const json = await runTaskCommand(['--json', 'new', 'x', '-p', 'shop'], root);

		const legacyDir = path.join(path.resolve(dir), '.task');
		// JSON escapes the backslashes of Windows paths: compare the decoded error and hint.
		const parsed = JSON.parse(json.output) as { error: string; hint: string };
		for (const [exitCode, output] of [
			[text.exitCode, text.output],
			[json.exitCode, `${parsed.error}\n${parsed.hint}`],
		] as const) {
			expect(exitCode).toBe(1);
			expect(output).toContain(legacyDir);
			expect(output).toContain(dataDirOf(id));
			expect(output).toContain(`delete ${legacyDir} by hand`);
			expect(output).toContain(`move ${dataDirOf(id)} away`);
		}
		expect(JSON.parse(json.output)).toMatchObject({
			error: expect.any(String),
			hint: expect.stringContaining('Keep one'),
		});
		// The split was not made worse: nothing was written.
		expect(fs.readdirSync(path.join(dataDirOf(id), 'tasks'))).toEqual(['other999.json']);
	});

	it('task cli migrate-data copies the data, then the project works on the copy, and the .task is left untouched', async () => {
		const { dir, id } = await unmigrated();
		const before = fs.readdirSync(path.join(dir, '.task', 'tasks'));
		stderr.length = 0;

		const migrated = await runTaskCommand(['cli', 'migrate-data', '-p', 'shop'], root);
		const listed = await runTaskCommand(['list', '--json', '-p', 'shop'], root);

		expect(migrated.exitCode).toBe(0);
		expect(migrated.output).toContain('Copied');
		expect(migrated.output).toContain('1 task');
		expect(migrated.output).toContain(path.join(path.resolve(dir), '.task'));
		expect(migrated.output).toContain(dataDirOf(id));
		expect(migrated.output).toContain('delete');
		expect(titlesIn(listed.output)).toEqual(['old']);
		expect(fs.readdirSync(path.join(dir, '.task', 'tasks'))).toEqual(before);
		// Right after the copy both places hold the same tasks: the registry is used and the old copy is noted, once.
		const noted = stderr
			.join('')
			.split('\n')
			.filter(line => line.includes('old copy'));
		expect(noted).toEqual([
			`old copy still in ${path.join(path.resolve(dir), '.task')}: delete it by hand once checked`,
		]);
		expect(stderr.join('')).not.toContain('Deprecated');
	});

	it('migrate-data --dry-run writes nothing, --json prints the structured result', async () => {
		const { id } = await unmigrated();

		const dry = await runTaskCommand(['cli', 'migrate-data', '-p', 'shop', '--dry-run'], root);
		const json = await runTaskCommand(['--json', 'cli', 'migrate-data', '-p', 'shop', '--dry-run'], root);

		expect(dry.exitCode).toBe(0);
		expect(dry.output).toContain('Dry run');
		expect(fs.existsSync(dataDirOf(id))).toBe(false);
		expect(JSON.parse(json.output)).toMatchObject({
			dryRun: true,
			tasks: { count: 1 },
			project: { name: 'shop', id },
		});
	});

	it('migrate-data without -p uses the cwd project, and refuses a second copy naming both folders', async () => {
		const { dir, id } = await unmigrated();

		const first = await runTaskCommand(['cli', 'migrate-data'], dir);
		const second = await runTaskCommand(['cli', 'migrate-data'], dir);

		expect(first.exitCode).toBe(0);
		expect(second.exitCode).toBe(1);
		expect(second.output).toContain(dataDirOf(id));
		expect(second.output).toContain(path.join(path.resolve(dir), '.task'));
	});

	it('migrate-data on a folder that is not registered says to run project add first', async () => {
		const dir = workDir('old');
		fs.mkdirSync(path.join(dir, '.task', 'tasks'), { recursive: true });

		const result = await runTaskCommand(['cli', 'migrate-data'], dir);

		expect(result.exitCode).toBe(1);
		expect(result.output).toContain(`project add "${dir}"`);
	});

	it('migrate-data on a virtual project says there is no .task to copy', async () => {
		await register('notes', undefined);

		const result = await runTaskCommand(['cli', 'migrate-data', '-p', 'notes'], root);

		expect(result.exitCode).toBe(1);
		expect(result.output).toContain('virtual');
	});

	it('migrate-data rejects unknown arguments and shows up in the usage', async () => {
		const result = await runTaskCommand(['cli', 'migrate-data', '--dryrun'], root);

		expect(result.exitCode).toBe(1);
		expect(result.output).toContain('--dryrun');
		expect(result.output).toContain('--dry-run');
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

describe('task init and task projects add|remove|move|prune|list point to the project CLI', () => {
	it('task init fails with the project add command for the directory', async () => {
		const dir = workDir('new-one');

		const result = await runTaskCommand(['init'], dir);

		expect(result.exitCode).toBe(1);
		expect(result.output).toContain('task init');
		expect(result.output).toContain(`project add "${dir}"`);
		expect(fs.existsSync(path.join(dir, '.task'))).toBe(false);
	});

	it.each([
		[['projects', 'add', 'somewhere'], 'project add'],
		[['projects', 'add'], 'project add'],
		[['projects', 'remove', 'somewhere'], 'project remove'],
		[['projects', 'move', 'a', 'b'], 'project paths move'],
		[['projects', 'prune'], 'project remove'],
		[['projects', 'list'], 'project list'],
	])('task %j answers with the replacement %s', async (args, expected) => {
		const result = await runTaskCommand(args, root);

		expect(result.exitCode).toBe(1);
		expect(result.output).toContain(`task ${args[0]} ${args[1]}`);
		expect(result.output).toContain(expected);
	});

	it('task projects add <dir> suggests the directory resolved against the cwd', async () => {
		const result = await runTaskCommand(['projects', 'add', 'rel'], root);

		expect(result.output).toContain(`project add "${path.join(root, 'rel')}"`);
	});

	it('task projects summary still works', async () => {
		const result = await runTaskCommand(['projects', 'summary', '--json'], root);

		expect(result.exitCode).toBe(0);
		expect(JSON.parse(result.output)).toMatchObject({ projects: [], open: 0, total: 0 });
	});
});

describe('discoverability', () => {
	it('task cli --help lists migrate-data, and the unknown-subcommand hint too', async () => {
		const written: string[] = [];
		vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
			written.push(String(chunk));
			return true;
		});

		await runTaskCommand(['cli', '--help'], root);
		const unknown = await runTaskCommand(['cli', 'nope'], root);

		expect(written.join('')).toContain('migrate-data [-p <ref>] [--dry-run]');
		expect(unknown.output).toContain('migrate-data');
	});

	it('an unknown task projects subcommand names the only valid one and where the others went', async () => {
		const result = await runTaskCommand(['projects', 'frobnicate'], root);

		expect(result.exitCode).toBe(1);
		expect(result.output).toContain('summary');
		expect(result.output).toContain('project CLI');
	});

	it('task --help no longer lists task init and documents migrate-data and the registry storage', async () => {
		const { output } = await runTaskCommand(['--help'], root);

		expect(output).not.toMatch(/^\s+task init\s/m);
		expect(output).toContain('task cli migrate-data');
		expect(output).toContain('<registry>/projects/<id>/task/data');
		// A registered project that still has its tasks in .task keeps working on them, with one stderr line.
		expect(output).toContain('keeps working on that folder');
		expect(output).toContain('old copy still in');
		expect(output).toContain('real split');
	});
});
