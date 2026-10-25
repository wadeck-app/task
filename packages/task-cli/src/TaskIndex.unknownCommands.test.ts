import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { addProject, defaultRegistryDir } from '@wadeck-app/project-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runTaskCommand } from './TaskIndex.js';

// Commands that do not exist (any more) are plain unknown commands: standard message, exit 1, text or JSON, nothing on stderr,
// whatever the folder (the command word is checked before any project is looked up). Every test gets its own registry.

let root: string;
let previousXdg: string | undefined;
let stderr: string[];

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-unknown-commands-'));
	previousXdg = process.env['XDG_CONFIG_HOME'];
	process.env['XDG_CONFIG_HOME'] = path.join(root, 'xdg');
	stderr = [];
	vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
		stderr.push(String(chunk));
		return true;
	});
});

afterEach(() => {
	fs.rmSync(root, { recursive: true, force: true });
	process.env['XDG_CONFIG_HOME'] = previousXdg;
});

async function registeredDir(): Promise<string> {
	const dir = path.join(root, 'work', 'shop');
	fs.mkdirSync(dir, { recursive: true });
	await addProject(defaultRegistryDir(process.env), { name: 'shop', path: dir });
	return dir;
}

function unregisteredDir(): string {
	const dir = path.join(root, 'work', 'nowhere');
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

describe('task init', () => {
	it.each([
		['a registered folder', registeredDir],
		['a folder in no project', () => Promise.resolve(unregisteredDir())],
	])('in %s: unknown command, exit 1, no project lookup, nothing created', async (_where, makeDir) => {
		const dir = await makeDir();

		const result = await runTaskCommand(['init'], dir);

		expect(result.exitCode).toBe(1);
		expect(result.output).toContain('Error: unknown command: init');
		expect(result.output).toContain('Valid commands:');
		expect(result.output).not.toMatch(/project add|no project in scope|removed|moved/);
		expect(stderr.join('')).toBe('');
		expect(fs.readdirSync(dir)).toEqual([]);
	});

	it('--json: {error, hint} with the standard message', async () => {
		const result = await runTaskCommand(['init', '--json'], unregisteredDir());

		expect(result.exitCode).toBe(1);
		const body = JSON.parse(result.output) as { error: string; hint: string };
		expect(body.error).toBe('unknown command: init');
		expect(body.hint).toContain('Valid commands:');
	});
});

describe('task projects add|remove|move|prune|list', () => {
	it.each(['add', 'remove', 'move', 'prune', 'list'])(
		'%s: unknown subcommand naming summary as the only valid one',
		async sub => {
			const result = await runTaskCommand(['projects', sub, 'x'], root);

			expect(result.exitCode).toBe(1);
			expect(result.output).toContain(`Error: unknown task projects subcommand: ${sub}`);
			expect(result.output).toContain('Valid subcommand: summary');
			expect(result.output).not.toMatch(/project CLI|project add|removed|moved/);
			expect(stderr.join('')).toBe('');
		}
	);

	it('--json: {error, hint}', async () => {
		const result = await runTaskCommand(['projects', 'list', '--json'], root);

		expect(result.exitCode).toBe(1);
		expect(JSON.parse(result.output)).toEqual({
			error: 'unknown task projects subcommand: list',
			hint: 'Valid subcommand: summary',
		});
	});

	it('summary still works', async () => {
		const result = await runTaskCommand(['projects', 'summary', '--json'], root);

		expect(result.exitCode).toBe(0);
		expect(JSON.parse(result.output)).toMatchObject({ projects: [], open: 0, total: 0 });
	});
});

describe('task cli migrate-data', () => {
	it('is an unknown subcommand, and no hint or help names it', async () => {
		const result = await runTaskCommand(['cli', 'migrate-data', '--dry-run'], root);

		expect(result.exitCode).toBe(1);
		expect(result.output).toContain('Error: unknown task cli subcommand: migrate-data');
		expect(result.output.replace('unknown task cli subcommand: migrate-data', '')).not.toContain('migrate-data');
	});

	it('--json: {error, hint}', async () => {
		const result = await runTaskCommand(['cli', 'migrate-data', '--json'], root);

		expect(result.exitCode).toBe(1);
		expect((JSON.parse(result.output) as { error: string }).error).toBe(
			'unknown task cli subcommand: migrate-data'
		);
	});

	it('task cli --help does not list it', async () => {
		const written: string[] = [];
		vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
			written.push(String(chunk));
			return true;
		});

		await runTaskCommand(['cli', '--help'], root);

		expect(written.join('')).toContain('declare-events');
		expect(written.join('')).not.toContain('migrate-data');
	});
});

describe('task --help', () => {
	it('knows nothing of the old .task folder, the removed commands or the removed variables', async () => {
		const { output } = await runTaskCommand(['--help'], root);

		expect(output).not.toMatch(
			/migrate-data|task init|moved to the project CLI|PROJECT_DIR|--project-dir|Ignored|REMOVED|real split/
		);
		expect(output).not.toMatch(/(?<!~\/)\.task\b/);
		expect(output).toContain('<registry>/projects/<id>/task/data');
		expect(output).toContain('task projects summary');
		expect(output).toContain('Global config directory (default: ~/.task)');
	});

	it('task projects --help lists summary only', async () => {
		const { output } = await runTaskCommand(['projects', '--help'], root);

		expect(output).toContain('task projects summary');
		expect(output).not.toMatch(/project CLI|add\|remove|prune/);
	});
});

describe('--project-dir', () => {
	it.each([
		['after the command', ['list', '--project-dir', 'x']],
		['before the command', ['--project-dir', 'x', 'list']],
		['with =', ['list', '--project-dir=x']],
		['without a value', ['list', '--project-dir']],
	])('is an unknown option (%s): exit 1, nothing is read', async (_where, args) => {
		const dir = await registeredDir();

		const result = await runTaskCommand(args, dir);

		expect(result.exitCode).toBe(1);
		expect(result.output).toContain('unknown option: --project-dir');
		expect(result.output).toContain('-p <id|name|alias>');
		expect(result.output).not.toMatch(/removed/);
	});

	it('--json: {error, hint}', async () => {
		const dir = await registeredDir();

		const result = await runTaskCommand(['list', '--project-dir', dir, '--json'], dir);

		expect(result.exitCode).toBe(1);
		expect((JSON.parse(result.output) as { error: string }).error).toBe('unknown option: --project-dir');
	});
});

describe('TASK_PROJECT_DIR', () => {
	it('is an ordinary variable task does not read: no line on stderr', async () => {
		const dir = await registeredDir();
		process.env['TASK_PROJECT_DIR'] = unregisteredDir();
		try {
			const result = await runTaskCommand(['list', '--json'], dir);

			expect(result.exitCode).toBe(0);
			expect(stderr.join('')).toBe('');
		} finally {
			delete process.env['TASK_PROJECT_DIR'];
		}
	});
});
