import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { addProject, defaultRegistryDir } from '@wadeck-app/project-sdk';
import { ownConfigFile, resolveProject } from '@wadeck-app/task-service';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runTaskCommand } from '../TaskIndex.js';

// `task status list`: the valid statuses of the resolved project, from the merged project config (the list set-status validates).

let root: string;
let previousXdg: string | undefined;
let previousProject: string | undefined;

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-status-cmd-'));
	previousXdg = process.env['XDG_CONFIG_HOME'];
	previousProject = process.env['TASK_PROJECT'];
	delete process.env['TASK_PROJECT'];
	process.env['XDG_CONFIG_HOME'] = path.join(root, 'xdg');
	vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
	fs.rmSync(root, { recursive: true, force: true });
	process.env['XDG_CONFIG_HOME'] = previousXdg;
	if (previousProject === undefined) delete process.env['TASK_PROJECT'];
	else process.env['TASK_PROJECT'] = previousProject;
});

const CUSTOM_CONFIG = [
	'statuses:',
	'  - backlog',
	'  - name: doing',
	'    default: true',
	'  - name: done',
	'    terminal: true',
	'  - name: dropped',
	'    terminal: true',
	'',
].join('\n');

/** A registered project (its main path is a fresh folder), optionally with a config.yml in its own registry layer. */
async function project(name: string, config?: string): Promise<string> {
	const dir = path.join(root, 'work', name);
	fs.mkdirSync(dir, { recursive: true });
	await addProject(defaultRegistryDir(process.env), { name, path: dir });
	if (config !== undefined) {
		const file = ownConfigFile(resolveProject({ cwd: dir }).storage);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, config);
	}
	return dir;
}

describe('task status list', () => {
	it('prints one status per line, in config order, marking the default and the terminal ones', async () => {
		const dir = await project('shop', CUSTOM_CONFIG);

		const result = await runTaskCommand(['status', 'list'], dir);

		expect(result).toEqual({
			exitCode: 0,
			output: ['backlog', 'doing (default)', 'done (terminal)', 'dropped (terminal)'].join('\n'),
		});
	});

	it('--json is [{name, default, terminal}] in the same order', async () => {
		const dir = await project('shop', CUSTOM_CONFIG);

		const result = await runTaskCommand(['status', 'list', '--json'], dir);

		expect(result.exitCode).toBe(0);
		expect(JSON.parse(result.output)).toEqual([
			{ name: 'backlog', default: false, terminal: false },
			{ name: 'doing', default: true, terminal: false },
			{ name: 'done', default: false, terminal: true },
			{ name: 'dropped', default: false, terminal: true },
		]);
	});

	it('the global --json flag works before the command too', async () => {
		const dir = await project('shop', CUSTOM_CONFIG);

		const result = await runTaskCommand(['--json', 'status', 'list'], dir);

		expect((JSON.parse(result.output) as unknown[]).length).toBe(4);
	});

	it('without a config.yml: the default statuses, the first one is the default', async () => {
		const dir = await project('plain');

		const result = await runTaskCommand(['status', 'list', '--json'], dir);

		expect(JSON.parse(result.output)).toEqual([
			{ name: 'backlog', default: true, terminal: false },
			{ name: 'in-progress', default: false, terminal: false },
			{ name: 'done', default: false, terminal: false },
		]);
	});

	it('a status can be both the default and terminal: both markers', async () => {
		const dir = await project('odd', 'statuses:\n  - name: only\n    default: true\n    terminal: true\n');

		const result = await runTaskCommand(['status', 'list'], dir);

		expect(result.output).toBe('only (default, terminal)');
	});

	it('works for -p and TASK_PROJECT from any folder', async () => {
		await project('shop', CUSTOM_CONFIG);
		const elsewhere = path.join(root, 'elsewhere');
		fs.mkdirSync(elsewhere);

		const byFlag = await runTaskCommand(['status', 'list', '-p', 'shop', '--json'], elsewhere);
		process.env['TASK_PROJECT'] = 'shop';
		const byEnv = await runTaskCommand(['status', 'list', '--json'], elsewhere);

		for (const result of [byFlag, byEnv]) {
			expect((JSON.parse(result.output) as Array<{ name: string }>).map(s => s.name)).toEqual([
				'backlog',
				'doing',
				'done',
				'dropped',
			]);
		}
	});

	it('is exactly what set-status accepts: every listed status works, anything else is refused', async () => {
		const dir = await project('shop', CUSTOM_CONFIG);
		const created = JSON.parse((await runTaskCommand(['new', 'a task'], dir)).output) as {
			id: string;
			status: string;
		};
		const listed = JSON.parse((await runTaskCommand(['status', 'list', '--json'], dir)).output) as Array<{
			name: string;
			default: boolean;
		}>;

		expect(created.status).toBe(listed.find(s => s.default)!.name);
		// A task cannot be moved to the status it already has: walk the list starting from the default.
		let current = created.status;
		for (const { name } of listed.filter(s => s.name !== created.status)) {
			const changed = await runTaskCommand(['set-status', created.id, name], dir);
			expect(changed.exitCode, `${current} -> ${name}`).toBe(0);
			current = name;
		}
		const refused = await runTaskCommand(['set-status', created.id, 'nope'], dir);
		expect(refused.exitCode).toBe(1);
	});

	it('fails with the neutral registry error and the hint in a folder that is in no registered project', async () => {
		const result = await runTaskCommand(['status', 'list'], root);

		expect(result.exitCode).toBe(1);
		expect(result.output).toContain('no project in scope');
		expect(result.output).toContain(`project add "${path.resolve(root)}"`);
	});

	it('fails naming the file when the config is invalid, as {error, hint} with --json', async () => {
		const dir = await project('broken', 'statuses: [unclosed');

		const text = await runTaskCommand(['status', 'list'], dir);
		const json = await runTaskCommand(['status', 'list', '--json'], dir);

		expect(text.exitCode).toBe(1);
		expect(text.output).toContain('config.yml');
		expect(json.exitCode).toBe(1);
		expect((JSON.parse(json.output) as { error: string }).error).toContain('config.yml');
	});

	it('rejects an unknown subcommand and an extra argument with the usage', async () => {
		const dir = await project('shop', CUSTOM_CONFIG);

		const unknown = await runTaskCommand(['status', 'nope'], dir);
		const extra = await runTaskCommand(['status', 'list', 'extra'], dir);

		expect(unknown.exitCode).toBe(1);
		expect(unknown.output).toContain('unknown task status subcommand: nope');
		expect(unknown.output).toContain('Valid subcommands: list');
		expect(extra.exitCode).toBe(1);
		expect(extra.output).toContain('unexpected argument: extra');
		expect(extra.output).toContain('Usage: task status list [--json]');
	});

	it('task status and task status --help print the help without needing a project', async () => {
		for (const args of [['status'], ['status', '--help']]) {
			const result = await runTaskCommand(args, root);
			expect(result.exitCode, args.join(' ')).toBe(0);
			expect(result.output).toContain('task status list [--json]');
		}
	});

	it('is in the list of valid commands shown for an unknown command', async () => {
		const result = await runTaskCommand(['nope'], await project('shop'));

		expect(result.output).toContain('type, status, plugins');
	});
});
