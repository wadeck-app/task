import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { addProject, defaultRegistryDir } from '@wadeck-app/project-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runTaskCommand } from './TaskIndex.js';

// Project selection through the shared registry (stage 1, unchanged in 2a): -p / --project, TASK_PROJECT, the registry lookup of the cwd, and the loud legacy path.
// Every test gets its own registry (XDG_CONFIG_HOME -> temp dir, set by vitest.setup.ts for the file and replaced here per test).

let root: string;
let previousXdg: string | undefined;
let previousEnv: Record<string, string | undefined>;
let stderr: string[];

const ENV_NAMES = ['TASK_PROJECT'];

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-shared-cli-'));
	previousXdg = process.env['XDG_CONFIG_HOME'];
	process.env['XDG_CONFIG_HOME'] = path.join(root, 'xdg');
	previousEnv = Object.fromEntries(ENV_NAMES.map(name => [name, process.env[name]]));
	for (const name of ENV_NAMES) delete process.env[name];
	stderr = [];
	vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
		stderr.push(String(chunk));
		return true;
	});
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

/** A project directory under the temp root. It gets registered by the test: its tasks then live in the registry, no .task needed. */
function plainDir(name: string): string {
	const dir = path.join(root, 'work', name);
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

async function register(name: string, dir: string | undefined, aliases: string[] = []): Promise<{ id: string }> {
	return addProject(registryDir(), { name, aliases, ...(dir === undefined ? {} : { path: dir }) });
}

function tasksIn(output: string): string[] {
	return (JSON.parse(output) as { description?: string; title?: string }[]).map(t => t.title ?? t.description ?? '');
}

describe('-p / --project and TASK_PROJECT', () => {
	it('-p <name> works from any directory, reads and writes the registry data (no .task), with no warning', async () => {
		const dir = plainDir('shop');
		await register('shop', dir);
		const elsewhere = path.join(root, 'elsewhere');
		fs.mkdirSync(elsewhere);

		await runTaskCommand(['new', 'first task', '-p', 'shop'], elsewhere);
		const listed = await runTaskCommand(['list', '--json', '--project', 'shop'], elsewhere);

		expect(listed.exitCode).toBe(0);
		expect(tasksIn(listed.output)).toEqual(['first task']);
		expect(fs.existsSync(path.join(dir, '.task'))).toBe(false);
		expect(stderr.join('')).not.toMatch(/registry/i);
	});

	it('-p before the command, an alias and an id prefix all select the project', async () => {
		const dir = plainDir('shop');
		const project = await register('shop', dir, ['store']);
		await runTaskCommand(['new', 'x'], dir);

		for (const ref of ['store', project.id, project.id.slice(0, 4)]) {
			const listed = await runTaskCommand(['-p', ref, 'list'], root);
			expect(tasksIn(listed.output), ref).toEqual(['x']);
		}
	});

	it('TASK_PROJECT selects the project and -p wins over it', async () => {
		const shop = plainDir('shop');
		const blog = plainDir('blog');
		await register('shop', shop);
		await register('blog', blog);
		await runTaskCommand(['new', 'in shop'], shop);
		await runTaskCommand(['new', 'in blog'], blog);
		process.env['TASK_PROJECT'] = 'blog';

		const fromEnv = await runTaskCommand(['list', '--json'], root);
		const fromFlag = await runTaskCommand(['list', '--json', '-p', 'shop'], root);

		expect(tasksIn(fromEnv.output)).toEqual(['in blog']);
		expect(tasksIn(fromFlag.output)).toEqual(['in shop']);
	});

	it('a cwd inside a registered folder resolves the project, without warning', async () => {
		const dir = plainDir('shop');
		await register('shop', dir);
		await runTaskCommand(['new', 'x'], dir);
		const sub = path.join(dir, 'src', 'deep');
		fs.mkdirSync(sub, { recursive: true });

		const listed = await runTaskCommand(['list', '--json'], sub);

		expect(tasksIn(listed.output)).toEqual(['x']);
		expect(stderr.join('')).toBe('');
	});

	it('an unknown project is an error with suggestions, in text and in JSON, and never falls back to the cwd', async () => {
		const dir = plainDir('shop');
		await register('shop', dir);

		const text = await runTaskCommand(['list', '-p', 'shpo'], dir);
		const json = await runTaskCommand(['--json', 'list', '-p', 'shpo'], dir);

		expect(text.exitCode).toBe(1);
		expect(text.output).toContain("no project matches 'shpo'");
		expect(text.output).toContain('did you mean: shop');
		expect(json.exitCode).toBe(1);
		expect((JSON.parse(json.output) as { error: string }).error).toContain("no project matches 'shpo'");
	});

	it('an unreadable registry is reported, with the file', async () => {
		fs.mkdirSync(registryDir(), { recursive: true });
		fs.writeFileSync(path.join(registryDir(), 'registry.json'), '{ nope');

		const result = await runTaskCommand(['list', '-p', 'shop'], root);

		expect(result.exitCode).toBe(1);
		expect(result.output).toContain('registry.json');
	});

	it('--all-projects cannot be combined with -p or TASK_PROJECT (one project and all contradict)', async () => {
		const byFlag = await runTaskCommand(['list', '--all-projects', '-p', 'shop'], root);
		process.env['TASK_PROJECT'] = 'shop';
		const byEnv = await runTaskCommand(['list', '--all-projects'], root);

		expect(byFlag.exitCode).toBe(1);
		expect(byFlag.output).toContain('--project');
		expect(byEnv.exitCode).toBe(1);
		expect(byEnv.output).toContain('TASK_PROJECT');
	});
});

describe('commands that resolve no project', () => {
	it('a command that fails before resolving a project prints no deprecation line', async () => {
		const result = await runTaskCommand(['--version'], root);

		expect(result.exitCode).toBe(0);
		expect(stderr.join('')).toBe('');
	});
});

describe('the task log records how the project was resolved', () => {
	function logLines(): string[] {
		const logDir = path.join(process.env['XDG_CONFIG_HOME']!, 'task', 'logs');
		return fs
			.readdirSync(logDir)
			.flatMap(file => fs.readFileSync(path.join(logDir, file), 'utf8').split('\n'))
			.filter(Boolean)
			.map(line => (JSON.parse(line) as { msg: string }).msg);
	}

	it('names the project, the source, the path and the registry dir', async () => {
		const dir = plainDir('shop');
		const project = await register('shop', dir);

		await runTaskCommand(['list', '-p', 'shop'], root);

		const line = logLines().find(msg => msg.includes(`shop (${project.id})`));
		expect(line).toBeDefined();
		expect(line).toContain('via --project');
		expect(line).toContain(registryDir());
	});
});

describe('--help', () => {
	it('lists -p / --project and TASK_PROJECT, and taskProjectId', async () => {
		const { output } = await runTaskCommand(['--help'], root);

		expect(output).toMatch(/-p, --project <ref>/);
		expect(output).toContain('TASK_PROJECT ');
		expect(output).toContain('taskProjectId');
	});
});
