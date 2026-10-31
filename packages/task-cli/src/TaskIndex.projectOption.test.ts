import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	ProjectOptionError,
	addProject,
	defaultRegistryDir,
	loadRegistry,
	resolveProjectFromArgs,
} from '@wadeck-app/project-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runTaskCommand } from './TaskIndex.js';

// The project flag and TASK_PROJECT are read by the shared SDK (`resolveProjectFromArgs`), not by task. This table runs the same
// argv/env through the SDK and through `runTaskCommand` and requires the same project (or the same error message).

let root: string;
let previousXdg: string | undefined;
let previousEnv: string | undefined;
let cwd: string;

beforeEach(async () => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-shared-cli-'));
	previousXdg = process.env['XDG_CONFIG_HOME'];
	previousEnv = process.env['TASK_PROJECT'];
	process.env['XDG_CONFIG_HOME'] = path.join(root, 'xdg');
	delete process.env['TASK_PROJECT'];
	vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
	const registryDir = defaultRegistryDir(process.env);
	for (const name of ['alpha', 'beta', 'gamma']) {
		const dir = path.join(root, 'work', name);
		fs.mkdirSync(dir, { recursive: true });
		await addProject(registryDir, { name, aliases: [], path: dir });
	}
	cwd = path.join(root, 'work', 'gamma');
	for (const name of ['alpha', 'beta', 'gamma']) {
		await runTaskCommand(['new', `task of ${name}`, '-p', name], cwd);
	}
});

afterEach(() => {
	fs.rmSync(root, { recursive: true, force: true });
	process.env['XDG_CONFIG_HOME'] = previousXdg;
	if (previousEnv === undefined) delete process.env['TASK_PROJECT'];
	else process.env['TASK_PROJECT'] = previousEnv;
});

interface Case {
	name: string;
	argv: string[];
	env?: string;
	/** The SDK reads no project here, but the task command itself rejects what is left (no command accepts the `--` terminator). */
	commandError?: string;
}

const CASES: Case[] = [
	{ name: 'flag after the command: -p x', argv: ['list', '-p', 'alpha'] },
	{ name: 'flag before the command: -p x', argv: ['-p', 'alpha', 'list'] },
	{ name: 'flag in the middle: --project x', argv: ['list', '--project', 'beta', '--all'] },
	{ name: '--project=x', argv: ['list', '--project=beta'] },
	{ name: '--project= (empty value)', argv: ['list', '--project='] },
	{ name: 'missing value: last argument', argv: ['list', '-p'] },
	{ name: 'missing value: followed by a flag', argv: ['list', '--project', '--all'] },
	{ name: 'repeated flag: same spelling', argv: ['list', '-p', 'alpha', '-p', 'alpha'] },
	{ name: 'repeated flag: two spellings', argv: ['list', '-p', 'alpha', '--project=beta'] },
	// Deliberate difference: the flag is NOT read (a project named after -p would be an error if it were), but `list` rejects `--` itself.
	{
		name: 'flag after --: not read',
		argv: ['list', '--', '-p', 'nothing-like-it'],
		commandError: 'unknown flag: --',
	},
	{ name: 'env set', argv: ['list'], env: 'beta' },
	{ name: 'env blank: unset', argv: ['list'], env: '   ' },
	{ name: 'env empty: unset', argv: ['list'], env: '' },
	{ name: 'flag beats env', argv: ['list', '-p', 'alpha'], env: 'beta' },
	{ name: 'no flag, no env: the cwd', argv: ['list'] },
];

describe('project flag and TASK_PROJECT: same behaviour as the shared SDK', () => {
	it.each(CASES)('$name', async ({ argv, env, commandError }) => {
		const environment: NodeJS.ProcessEnv = { ...process.env };
		if (env === undefined) delete environment['TASK_PROJECT'];
		else environment['TASK_PROJECT'] = env;
		process.env['TASK_PROJECT'] = environment['TASK_PROJECT'];
		if (env === undefined) delete process.env['TASK_PROJECT'];

		let expected: { project: string } | { error: string; optionError: boolean };
		try {
			const registry = loadRegistry(defaultRegistryDir(environment));
			expected = {
				project: resolveProjectFromArgs(registry, argv, environment, 'TASK_PROJECT', cwd).scope.project.name,
			};
		} catch (error) {
			expect(error).toBeInstanceOf(Error);
			expected = { error: (error as Error).message, optionError: error instanceof ProjectOptionError };
		}

		const result = await runTaskCommand(['--json', ...argv], cwd);

		if (commandError !== undefined) {
			// The SDK resolved the cwd project (no error): the flag was left alone, and the command refused the rest.
			expect(expected).toEqual({ project: 'gamma' });
			expect(result.exitCode).toBe(1);
			expect((JSON.parse(result.output) as { error: string }).error).toBe(commandError);
			return;
		}

		if ('error' in expected) {
			expect(result.exitCode).toBe(1);
			const body = JSON.parse(result.output) as { error: string; hint?: string };
			expect(body.error).toBe(expected.error);
			// Our own errors for a malformed flag carry the fix; the SDK's resolution errors keep it in their message.
			if (expected.optionError) expect(body.hint).toMatch(/\S/);
		} else {
			expect({ exitCode: result.exitCode, output: result.exitCode === 0 ? '' : result.output }).toEqual({
				exitCode: 0,
				output: '',
			});
			const titles = (JSON.parse(result.output) as { title: string }[]).map(task => task.title);
			expect(titles).toEqual([`task of ${expected.project}`]);
		}
	});
});

describe('commands that need no project ignore a valid project flag', () => {
	it.each([
		['--help'],
		['status', '--help'],
		['projects', 'summary', '-p', 'alpha'],
		['projects', 'summary', '--project=alpha'],
	])('task %s', async (...argv) => {
		const result = await runTaskCommand(argv, root);
		expect({ exitCode: result.exitCode, output: result.exitCode === 0 ? '' : result.output }).toEqual({
			exitCode: 0,
			output: '',
		});
	});
});

describe('a valid project flag given to a command that is not scoped to a project', () => {
	// The stderr spy is shared by the whole file: forget what earlier tests (and the registry setup) wrote.
	beforeEach(() => {
		vi.mocked(process.stderr.write).mockClear();
	});

	function notes(): string[] {
		return vi
			.mocked(process.stderr.write)
			.mock.calls.map(call => String(call[0]))
			.filter(text => text.includes('ignored'));
	}

	it.each([
		[['projects', 'summary', '-p', 'alpha'], 'note: -p alpha ignored: this command is not scoped to a project\n'],
		[
			['projects', 'summary', '--project=alpha'],
			'note: --project=alpha ignored: this command is not scoped to a project\n',
		],
		[
			['projects', 'summary', '--project', 'alpha'],
			'note: --project alpha ignored: this command is not scoped to a project\n',
		],
		[['-p', 'alpha', 'projects', 'summary'], 'note: -p alpha ignored: this command is not scoped to a project\n'],
		[['status', '--help', '-p', 'alpha'], 'note: -p alpha ignored: this command is not scoped to a project\n'],
		[['--help', '-p', 'alpha'], 'note: -p alpha ignored: this command is not scoped to a project\n'],
		[['--version', '-p', 'alpha'], 'note: -p alpha ignored: this command is not scoped to a project\n'],
		[['plugins', '--help', '-p', 'alpha'], 'note: -p alpha ignored: this command is not scoped to a project\n'],
		[['cli', '--help', '-p', 'alpha'], 'note: -p alpha ignored: this command is not scoped to a project\n'],
	])('task %j prints exactly one note on stderr', async (argv, note) => {
		await runTaskCommand(argv, root);
		expect(notes()).toEqual([note]);
	});

	it('keeps stdout pure JSON, and the exit code, with --json', async () => {
		const plain = await runTaskCommand(['projects', 'summary', '--json'], root);
		vi.mocked(process.stderr.write).mockClear();
		const flagged = await runTaskCommand(['projects', 'summary', '--json', '-p', 'alpha'], root);
		expect(flagged.exitCode).toBe(plain.exitCode);
		expect(flagged.output).toBe(plain.output);
		expect(() => JSON.parse(flagged.output)).not.toThrow();
		expect(notes()).toHaveLength(1);
	});

	it('prints nothing for TASK_PROJECT alone', async () => {
		process.env['TASK_PROJECT'] = 'alpha';
		await runTaskCommand(['projects', 'summary'], root);
		expect(notes()).toEqual([]);
	});

	it('prints nothing without a flag', async () => {
		await runTaskCommand(['projects', 'summary'], root);
		await runTaskCommand(['--help'], root);
		expect(notes()).toEqual([]);
	});

	it('prints nothing for a project-scoped command', async () => {
		await runTaskCommand(['list', '-p', 'alpha'], root);
		await runTaskCommand(['status', 'list', '-p', 'alpha'], root);
		expect(notes()).toEqual([]);
	});

	it('keeps the loud error for a malformed flag (no note)', async () => {
		const missing = await runTaskCommand(['list', '-p'], cwd);
		expect(missing.exitCode).toBe(1);
		const repeated = await runTaskCommand(['list', '-p', 'alpha', '--project=beta'], cwd);
		expect(repeated.exitCode).toBe(1);
		expect(notes()).toEqual([]);
	});
});

describe('--all-projects with a malformed project flag', () => {
	it('names the flag problem (exit 1), not a silent success', async () => {
		const result = await runTaskCommand(['list', '--all-projects', '-p'], cwd);
		expect(result.exitCode).toBe(1);
		expect(result.output).toContain('-p needs a value');
	});

	it('still refuses --project=x and TASK_PROJECT', async () => {
		const flag = await runTaskCommand(['list', '--all-projects', '--project=alpha'], cwd);
		expect(flag.exitCode).toBe(1);
		expect(flag.output).toContain('--project');
		process.env['TASK_PROJECT'] = 'alpha';
		const env = await runTaskCommand(['list', '--all-projects'], cwd);
		expect(env.exitCode).toBe(1);
		expect(env.output).toContain('TASK_PROJECT');
	});
});
