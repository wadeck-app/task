import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ownConfigFile } from '@wadeck-app/task-service';

import { runTaskCommand } from '../TaskIndex.js';
import { type RegisteredTestProject, registerTestProject } from '../testHelpers.js';

let tmpDir: string;
let project: RegisteredTestProject;
let stderr: string[];

beforeEach(async () => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-strategy-cmd-'));
	project = await registerTestProject(path.join(tmpDir, 'shop'));
	stderr = [];
	vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
		stderr.push(String(chunk));
		return true;
	});
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Adds a strategy section to the own config layer of the project. */
function writeStrategy(yml: string): void {
	const file = ownConfigFile(project.storage);
	fs.appendFileSync(file, `\n${yml}`);
}

describe('task strategy: help and arguments', () => {
	it.each([[['strategy']], [['strategy', '--help']]])('%j prints the help and needs no project', async args => {
		const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'task-strategy-cmd-'));
		try {
			const result = await runTaskCommand(args, outside);

			expect(result.exitCode).toBe(0);
			expect(result.output).toContain('task strategy show [-p <project>] [--json]');
			expect(result.output).toContain('task strategy check [-p <project>] [--json]');
		} finally {
			fs.rmSync(outside, { recursive: true, force: true });
		}
	});

	it('an unknown subcommand is an error naming the valid ones, before any project is looked up', async () => {
		const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'task-strategy-cmd-'));
		try {
			const result = await runTaskCommand(['strategy', 'set', 'github'], outside);

			expect(result.exitCode).toBe(1);
			expect(result.output).toBe('Error: unknown task strategy subcommand: set\nValid subcommands: show, check');
		} finally {
			fs.rmSync(outside, { recursive: true, force: true });
		}
	});

	it('an extra argument is refused with the usage', async () => {
		const result = await runTaskCommand(['strategy', 'show', 'github'], project.dir);

		expect(result.exitCode).toBe(1);
		expect(result.output).toBe(
			'Error: unexpected argument: github\nUsage: task strategy show [-p <project>] [--json]'
		);
	});

	it('a folder in no registered project is the usual error, with the fix', async () => {
		const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'task-strategy-cmd-'));
		try {
			const result = await runTaskCommand(['strategy', 'check'], outside);

			expect(result.exitCode).toBe(1);
			expect(result.output).toContain('no project in scope');
			expect(result.output).toContain('project add');
		} finally {
			fs.rmSync(outside, { recursive: true, force: true });
		}
	});

	it('-p selects the project from anywhere', async () => {
		const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'task-strategy-cmd-'));
		try {
			const result = await runTaskCommand(['strategy', 'show', '-p', project.name, '--json'], outside);

			expect(result.exitCode).toBe(0);
			expect((JSON.parse(result.output) as { project: { id: string } }).project.id).toBe(project.id);
		} finally {
			fs.rmSync(outside, { recursive: true, force: true });
		}
	});
});

describe('task strategy show', () => {
	it('a project without a strategy section: local by default, nothing warned', async () => {
		const result = await runTaskCommand(['strategy', 'show'], project.dir);

		expect(result.exitCode).toBe(0);
		expect(result.output).toContain(`Project:   ${project.name} (${project.id})`);
		expect(result.output).toContain(
			'Strategy:  local (plugins.local.default), default: the config has no strategy section'
		);
		expect(result.output).toContain('Fidelity:  strict');
		expect(result.output).toContain(`Data:      ${project.storage.dataDir}`);
		expect(result.output).toContain('Fills:     none');
		expect(result.output).toContain('Tokens:    none');
		expect(result.output).toMatch(/hierarchy\s+native\s+unlimited/);
		expect(result.output).toMatch(/linkTypes\s+native\s+blockedBy, duplicateOf, causedBy/);
		expect(stderr.join('')).toBe('');
	});

	it('a declared local strategy says it is configured', async () => {
		writeStrategy('strategy:\n    type: local\n    fidelity: degrade\n');

		const result = await runTaskCommand(['strategy', 'show'], project.dir);

		expect(result.output).toContain('Strategy:  local (plugins.local.default), configured in');
		expect(result.output).toContain('Fidelity:  degrade');
	});

	it('--json is the report: strategy, fidelity, fills, capabilities', async () => {
		const result = await runTaskCommand(['strategy', 'show', '--json'], project.dir);

		const report = JSON.parse(result.output) as Record<string, unknown>;
		expect(report).toMatchObject({
			declared: false,
			type: 'local',
			ref: 'plugins.local.default',
			kind: 'local',
			fidelity: 'strict',
			fills: [],
			tokens: [],
		});
		expect((report['capabilities'] as unknown[]).length).toBe(13);
	});

	it('creates nothing in the data folder', async () => {
		await runTaskCommand(['strategy', 'show'], project.dir);

		expect(fs.existsSync(project.storage.dataDir)).toBe(false);
	});

	it('type: github fails loudly with the file and the key, exit 1, and the fix', async () => {
		writeStrategy('strategy:\n    type: github\n');

		const result = await runTaskCommand(['strategy', 'show'], project.dir);

		expect(result.exitCode).toBe(1);
		expect(result.output).toContain(
			`Error: ${ownConfigFile(project.storage)}: strategy.type: strategy type github is declared but no plugin is installed; built-in types: local`
		);
		expect(result.output).toContain('Set strategy.type to a built-in type (local) or remove the strategy section');
	});

	it('--json error is {error, hint}', async () => {
		writeStrategy('strategy:\n    type: github\n');

		const result = await runTaskCommand(['strategy', 'show', '--json'], project.dir);

		expect(result.exitCode).toBe(1);
		const body = JSON.parse(result.output) as { error: string; hint: string };
		expect(body.error).toContain('strategy.type: strategy type github is declared but no plugin is installed');
		expect(body.hint).toContain('built-in type (local)');
	});
});

describe('task strategy check', () => {
	it('a project without a strategy section passes: exit 0, every line ok', async () => {
		const result = await runTaskCommand(['strategy', 'check'], project.dir);

		expect(result.exitCode).toBe(0);
		expect(result.output).toContain(`Strategy check for ${project.name} (${project.id})`);
		expect(result.output).toMatch(/config\s+ok\s+.*no strategy section, local by default/);
		expect(result.output).toMatch(/strategy\s+ok\s+local \(plugins\.local\.default\), fidelity strict/);
		expect(result.output).toMatch(/data\s+ok\s+.*not created yet: the first write creates it/);
		expect(result.output).toMatch(/writable\s+ok/);
		expect(result.output).toMatch(/tasks\s+ok\s+0 tasks/);
		expect(result.output).toContain('Result: ok (0 errors, 0 warnings)');
		expect(result.output).toMatch(/hierarchy\s+native\s+unlimited/);
		expect(fs.existsSync(project.storage.dataDir)).toBe(false);
	});

	it('counts the tasks of a project that has some', async () => {
		await runTaskCommand(['new', 'first task'], project.dir);
		await runTaskCommand(['new', 'second task'], project.dir);

		const result = await runTaskCommand(['strategy', 'check'], project.dir);

		expect(result.output).toMatch(/tasks\s+ok\s+2 tasks \(backlog 2\)/);
	});

	it('--json is the check: ok, errors, warnings, lines, report', async () => {
		const result = await runTaskCommand(['strategy', 'check', '--json'], project.dir);

		const body = JSON.parse(result.output) as {
			ok: boolean;
			errors: number;
			warnings: number;
			lines: Array<{ name: string }>;
		};
		expect(result.exitCode).toBe(0);
		expect(body).toMatchObject({ ok: true, errors: 0, warnings: 0 });
		expect(body.lines.map(line => line.name)).toEqual(['config', 'strategy', 'data', 'writable', 'tasks']);
	});

	it('a broken config is exit 1 with the error as a line and its fix, nothing else checked', async () => {
		writeStrategy('strategy:\n    type: github\n');

		const result = await runTaskCommand(['strategy', 'check'], project.dir);

		expect(result.exitCode).toBe(1);
		expect(result.output).toMatch(/config\s+error\s+.*strategy type github is declared but no plugin is installed/);
		expect(result.output).toContain('fix: Set strategy.type to a built-in type (local)');
		expect(result.output).toContain('Result: FAILED (1 error, 0 warnings)');
		expect(result.output).not.toMatch(/tasks\s+ok/);
	});

	it('a literal credential is exit 1 with the tokenEnv fix', async () => {
		writeStrategy('strategy:\n    options:\n        token: abc\n');

		const result = await runTaskCommand(['strategy', 'check'], project.dir);

		expect(result.exitCode).toBe(1);
		expect(result.output).toContain('strategy.options.token: a credential must not be written in the config file');
		expect(result.output).toContain('tokenEnv: <VARIABLE_NAME>');
	});

	it('--json on a failure keeps the structure and the exit code', async () => {
		writeStrategy('strategy:\n    type: github\n');

		const result = await runTaskCommand(['strategy', 'check', '--json'], project.dir);

		expect(result.exitCode).toBe(1);
		const body = JSON.parse(result.output) as {
			ok: boolean;
			errors: number;
			lines: Array<{ status: string; fix?: string }>;
		};
		expect(body.ok).toBe(false);
		expect(body.lines[0]).toMatchObject({ status: 'error' });
		expect(body.lines[0]!.fix).toBeDefined();
	});
});

describe('task plugins is gone', () => {
	it.each([[['plugins']], [['plugins', 'list']], [['plugins', 'config', 'none']], [['plugins', '--help']]])(
		'%j is an unknown command',
		async args => {
			const result = await runTaskCommand(args, project.dir);

			expect(result.exitCode).toBe(1);
			expect(result.output).toContain('Error: unknown command: plugins');
			expect(result.output).toContain('Valid commands:');
			expect(result.output).not.toMatch(/Valid commands:.*plugins/);
			expect(stderr.join('')).toBe('');
		}
	);
});
