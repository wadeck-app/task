import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { addProject, defaultRegistryDir } from '@wadeck-app/project-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runTaskCommand } from './TaskIndex.js';

// Stage 2b-1: a folder the shared registry does not know is not a project any more, and the old ways to name one are refused or
// ignored loudly. Every test gets its own registry (XDG_CONFIG_HOME -> temp dir).

let root: string;
let previousXdg: string | undefined;
let previousEnv: Record<string, string | undefined>;
let stderr: string[];

const ENV_NAMES = ['TASK_PROJECT', 'TASK_PROJECT_DIR', 'PROJECT_DIR'];

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-legacy-removed-'));
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

function dir(name: string, options: { task?: boolean } = {}): string {
	const folder = path.join(root, 'work', name);
	fs.mkdirSync(options.task === true ? path.join(folder, '.task', 'tasks') : folder, { recursive: true });
	return folder;
}

async function register(name: string, folder: string): Promise<{ id: string }> {
	return addProject(defaultRegistryDir(process.env), { name, path: folder });
}

const REMOVED_FLAG = 'removed: use -p <id|name|alias> or run from a registered folder';
const IGNORED_ENV = 'Ignored: TASK_PROJECT_DIR was removed, use TASK_PROJECT';

describe('a folder the shared registry does not know', () => {
	it('is not a project, even when it holds a .task: the neutral registry error and the hint to register it, nothing else', async () => {
		const old = dir('old', { task: true });

		const result = await runTaskCommand(['list'], old);

		expect(result.exitCode).toBe(1);
		expect(result.output).toContain(`no project in scope for ${path.resolve(old)}`);
		expect(result.output).toContain(`project add "${path.resolve(old)}"`);
		expect(result.output).not.toMatch(/deprecated|migrate-data|task init|\.task/i);
		expect(stderr.join('')).not.toMatch(/deprecated/i);
	});

	it('answers {error, hint} in JSON mode and writes nothing in the folder', async () => {
		const old = dir('old', { task: true });

		const result = await runTaskCommand(['new', 'x', '--json'], old);

		expect(result.exitCode).toBe(1);
		const body = JSON.parse(result.output) as { error: string; hint: string };
		expect(body.error).toContain('no project in scope');
		expect(body.hint).toContain(`project add "${path.resolve(old)}"`);
		expect(fs.readdirSync(path.join(old, '.task', 'tasks'))).toEqual([]);
	});

	it('a subfolder with a .task of its own inside a registered folder resolves to the registered project', async () => {
		const parent = dir('mono');
		const nested = path.join(parent, 'packages', 'app');
		fs.mkdirSync(path.join(nested, '.task', 'tasks'), { recursive: true });
		await register('mono', parent);

		await runTaskCommand(['new', 'in the registry'], nested);
		const listed = await runTaskCommand(['list', '--json'], parent);

		expect(JSON.parse(listed.output)).toHaveLength(1);
		expect(fs.readdirSync(path.join(nested, '.task', 'tasks'))).toEqual([]);
	});
});

describe('--project-dir', () => {
	it.each([
		['after the command', ['list', '--project-dir', 'x']],
		['before the command', ['--project-dir', 'x', 'list']],
		['with =', ['list', '--project-dir=x']],
		['without a value', ['list', '--project-dir']],
	])('is refused (%s): exit 1, nothing is read', async (_where, args) => {
		const shop = dir('shop');
		await register('shop', shop);

		const result = await runTaskCommand(args, shop);

		expect(result.exitCode).toBe(1);
		expect(result.output).toContain(`--project-dir was ${REMOVED_FLAG}`);
	});

	it('is refused in JSON mode as {error, hint}, and also next to -p', async () => {
		const shop = dir('shop');
		await register('shop', shop);

		const result = await runTaskCommand(['list', '-p', 'shop', '--project-dir', shop, '--json'], shop);

		expect(result.exitCode).toBe(1);
		expect((JSON.parse(result.output) as { error: string }).error).toContain(REMOVED_FLAG);
	});

	it('is refused by --all-projects and by projects summary too', async () => {
		for (const args of [
			['list', '--all-projects', '--project-dir', 'x'],
			['projects', 'summary', '--project-dir', 'x'],
		]) {
			const result = await runTaskCommand(args, root);
			expect(result.exitCode, args.join(' ')).toBe(1);
			expect(result.output, args.join(' ')).toContain(REMOVED_FLAG);
		}
	});
});

describe('TASK_PROJECT_DIR and PROJECT_DIR', () => {
	it('TASK_PROJECT_DIR: one stderr line, then the cwd decides (it is not a failure: a parent may set it)', async () => {
		const shop = dir('shop');
		await register('shop', shop);
		const other = dir('other', { task: true });
		process.env['TASK_PROJECT_DIR'] = other;

		const result = await runTaskCommand(['list', '--json'], shop);

		expect(result.exitCode).toBe(0);
		expect(stderr.join('').split(IGNORED_ENV).length - 1).toBe(1);
		expect(stderr.join('')).toContain(`${IGNORED_ENV}\n`);
	});

	it('TASK_PROJECT_DIR does not turn an unregistered cwd into a project', async () => {
		const other = dir('other', { task: true });
		process.env['TASK_PROJECT_DIR'] = other;

		const result = await runTaskCommand(['list'], root);

		expect(result.exitCode).toBe(1);
		expect(result.output).toContain('no project in scope');
		expect(stderr.join('')).toContain(IGNORED_ENV);
	});

	it('an empty TASK_PROJECT_DIR counts as unset: no line', async () => {
		const shop = dir('shop');
		await register('shop', shop);
		process.env['TASK_PROJECT_DIR'] = '';

		await runTaskCommand(['list'], shop);

		expect(stderr.join('')).not.toContain('TASK_PROJECT_DIR');
	});

	it('TASK_PROJECT_DIR is not a contradiction of --all-projects any more: the line, then the list', async () => {
		const shop = dir('shop');
		await register('shop', shop);
		process.env['TASK_PROJECT_DIR'] = shop;

		const result = await runTaskCommand(['list', '--all-projects', '--json'], root);

		expect(result.exitCode).toBe(0);
		expect(stderr.join('')).toContain(IGNORED_ENV);
	});

	it('PROJECT_DIR is a generic variable of other tools: silently unused, with every command, --all-projects included', async () => {
		const shop = dir('shop');
		await register('shop', shop);
		const other = dir('other', { task: true });
		process.env['PROJECT_DIR'] = other;

		const inProject = await runTaskCommand(['list', '--json'], shop);
		const elsewhere = await runTaskCommand(['list'], other);
		const all = await runTaskCommand(['list', '--all-projects'], root);

		expect(inProject.exitCode).toBe(0);
		expect(elsewhere.exitCode).toBe(1);
		expect(all.exitCode).toBe(0);
		expect(stderr.join('')).not.toContain('PROJECT_DIR');
	});
});

describe('--help', () => {
	it('says --project-dir, TASK_PROJECT_DIR were removed (the refusal and the ignore line), and no longer offers them', async () => {
		const { output } = await runTaskCommand(['--help'], root);

		expect(output).toContain('--project-dir was removed');
		expect(output).toContain('TASK_PROJECT_DIR was removed');
		expect(output).not.toMatch(/--project-dir <dir>/);
		expect(output).not.toMatch(/Projects not in the shared registry/);
		expect(output).not.toMatch(/PROJECT_DIR\s+DEPRECATED/);
		expect(output).not.toMatch(/Deprecated: /);
	});

	it('names no .task folder in the usage lines of the commands (set-status takes its values from the project config)', async () => {
		const { output } = await runTaskCommand(['--help'], root);
		const setStatus = output.split('\n').find(line => line.includes('task set-status')) ?? '';

		expect(setStatus).not.toContain('.task');
		expect(setStatus).toContain('task status list');
	});

	it('lists task status list', async () => {
		const { output } = await runTaskCommand(['--help'], root);

		expect(output).toMatch(/task status list \[--json\]\s+List the valid statuses/);
	});
});
