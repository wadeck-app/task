import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ownConfigFile } from '@wadeck-app/task-service';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runTaskCommand } from '../TaskIndex.js';
import { type RegisteredTestProject, registerTestProject } from '../testHelpers.js';

interface JsonTask {
	id: string;
	title: string;
	status: string;
	project: { name: string; path: string };
}

interface JsonList {
	tasks: JsonTask[];
	readableCount: number;
	unreadable: Array<{ name: string; path: string; error: string }>;
}

interface JsonSummary {
	projects: Array<{ name: string; path: string; open: number | null; total: number | null; error: string | null }>;
	readableCount: number;
	open: number;
	total: number;
}

function restoreEnv(name: string, value: string | undefined): void {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

describe('global view commands (task list --all-projects, task projects summary)', () => {
	let root: string;
	let previousXdg: string | undefined;
	let stderr: string[];
	let previousTaskProjectDir: string | undefined;
	let previousProjectDir: string | undefined;

	beforeEach(() => {
		previousTaskProjectDir = process.env['TASK_PROJECT_DIR'];
		previousProjectDir = process.env['PROJECT_DIR'];
		delete process.env['TASK_PROJECT_DIR'];
		delete process.env['PROJECT_DIR'];
		root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-global-cmd-'));
		previousXdg = process.env['XDG_CONFIG_HOME'];
		process.env['XDG_CONFIG_HOME'] = path.join(root, 'xdg');
		stderr = [];
		registered.clear();
		vi.spyOn(process.stderr, 'write').mockImplementation(chunk => {
			stderr.push(String(chunk));
			return true;
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
		process.env['XDG_CONFIG_HOME'] = previousXdg;
		restoreEnv('TASK_PROJECT_DIR', previousTaskProjectDir);
		restoreEnv('PROJECT_DIR', previousProjectDir);
		fs.rmSync(root, { recursive: true, force: true });
	});

	// The registered projects of the test, by folder.
	const registered = new Map<string, RegisteredTestProject>();

	async function initProject(name: string): Promise<string> {
		const dir = path.join(root, name);
		fs.mkdirSync(dir);
		registered.set(dir, await registerTestProject(dir, { name }));
		return dir;
	}

	// Makes a registered project unreadable: its own config.yml is not valid YAML (the reason names that file).
	function breakProject(dir: string): string {
		const file = ownConfigFile(registered.get(dir)!.storage);
		fs.writeFileSync(file, 'statuses: [unclosed\n');
		return file;
	}

	async function addTask(dir: string, title: string, status?: string): Promise<string> {
		const created = await runTaskCommand(['new', title], dir);
		const { id } = JSON.parse(created.output) as { id: string };
		if (status !== undefined) {
			await runTaskCommand(['set-status', id, status], dir);
		}
		return id;
	}

	/** Two readable projects: alpha (1 open, 1 done) and beta (1 open). */
	async function twoProjects(): Promise<{ alpha: string; beta: string }> {
		const alpha = await initProject('alpha');
		const beta = await initProject('beta');
		await addTask(alpha, 'alpha open task');
		await addTask(alpha, 'alpha done task', 'done');
		await addTask(beta, 'beta open task');
		// The tests below assert on the stderr of the command under test only.
		stderr.length = 0;
		return { alpha, beta };
	}

	describe('task list --all-projects', () => {
		it('prints a Project column for every open task of every registered project, from a directory that is no project', async () => {
			await twoProjects();
			const result = await runTaskCommand(['list', '--all-projects'], root);
			expect(result.exitCode).toBe(0);
			const lines = result.output.split('\n');
			expect(lines[0]).toMatch(/^PROJECT\s+ID\s+STATUS\s+TITLE$/);
			expect(result.output).toMatch(/alpha\s+\w+\s+backlog\s+alpha open task/);
			expect(result.output).toMatch(/beta\s+\w+\s+backlog\s+beta open task/);
			expect(result.output).not.toContain('alpha done task');
		});

		it('--all includes the tasks in a terminal status', async () => {
			await twoProjects();
			const result = await runTaskCommand(['list', '--all-projects', '--all'], root);
			expect(result.output).toMatch(/alpha\s+\w+\s+done\s+alpha done task/);
		});

		it('--json prints the cross-project answer: tasks tagged with their project, readable count, unreadable projects', async () => {
			const { alpha } = await twoProjects();
			const result = await runTaskCommand(['--json', 'list', '--all-projects'], root);
			expect(result.exitCode).toBe(0);
			const parsed = JSON.parse(result.output) as JsonList;
			expect(parsed.readableCount).toBe(2);
			expect(parsed.unreadable).toEqual([]);
			expect(parsed.tasks.map(t => [t.project.name, t.title])).toEqual([
				['alpha', 'alpha open task'],
				['beta', 'beta open task'],
			]);
			expect(parsed.tasks[0]!.project.path).toBe(alpha);
		});

		it('--json works with the flag after the command too', async () => {
			await twoProjects();
			const result = await runTaskCommand(['list', '--all-projects', '--all', '--json'], root);
			expect((JSON.parse(result.output) as JsonList).tasks).toHaveLength(3);
		});

		it('reports an unreadable project on stderr with its reason and still lists the others (exit 0)', async () => {
			const { beta } = await twoProjects();
			const configFile = breakProject(beta);
			const result = await runTaskCommand(['list', '--all-projects'], root);
			expect(result.exitCode).toBe(0);
			expect(result.output).toContain('alpha open task');
			expect(stderr.join('')).toContain(beta);
			expect(stderr.join('')).toContain(configFile);
		});

		it('--json carries the unreadable projects in the answer and writes nothing to stderr', async () => {
			const { beta } = await twoProjects();
			breakProject(beta);
			const result = await runTaskCommand(['--json', 'list', '--all-projects'], root);
			const parsed = JSON.parse(result.output) as JsonList;
			expect(parsed.readableCount).toBe(1);
			expect(parsed.unreadable).toHaveLength(1);
			expect(parsed.unreadable[0]!.path).toBe(beta);
			expect(stderr.join('')).toBe('');
		});

		it('fails (exit 1) with every reason and the fix when no registered project can be read', async () => {
			const { alpha, beta } = await twoProjects();
			breakProject(alpha);
			breakProject(beta);
			const result = await runTaskCommand(['list', '--all-projects'], root);
			expect(result.exitCode).toBe(1);
			expect(result.output).toContain(alpha);
			expect(result.output).toContain(beta);
			expect(result.output).toContain('project CLI');
		});

		it('--json: that failure is {"error", "hint"}', async () => {
			const { alpha, beta } = await twoProjects();
			breakProject(alpha);
			breakProject(beta);
			const result = await runTaskCommand(['--json', 'list', '--all-projects'], root);
			expect(result.exitCode).toBe(1);
			const parsed = JSON.parse(result.output) as { error: string; hint: string };
			expect(parsed.error).toContain('none of the 2 registered projects');
			expect(parsed.hint).toContain('project CLI');
		});

		it('says what to do, exit 0, when no project is registered', async () => {
			const result = await runTaskCommand(['list', '--all-projects'], root);
			expect(result.exitCode).toBe(0);
			expect(result.output).toContain('no project registered');
			expect(result.output).toContain('project add');
		});

		it('--json: nothing registered is an empty answer, not an error', async () => {
			const result = await runTaskCommand(['--json', 'list', '--all-projects'], root);
			expect(result.exitCode).toBe(0);
			expect(JSON.parse(result.output)).toEqual({ tasks: [], readableCount: 0, unreadable: [] });
		});

		it('says there is no task (not "no project") when projects are readable but empty', async () => {
			await initProject('empty');
			const result = await runTaskCommand(['list', '--all-projects'], root);
			expect(result.exitCode).toBe(0);
			expect(result.output).toContain('no task');
			expect(result.output).toContain('--all');
		});

		it.each([
			['--follow', ['--follow']],
			['-f', ['-f']],
			['--tree', ['--tree']],
			['--parent', ['--parent', 'abc']],
		])('fails loudly and actionably when combined with %s', async (flag, extra) => {
			await twoProjects();
			const result = await runTaskCommand(['list', '--all-projects', ...extra], root);
			expect(result.exitCode).toBe(1);
			expect(result.output).toContain(`--all-projects cannot be combined with ${flag}`);
			expect(result.output).toContain('task list');
		});

		it('--json: a flag conflict is {"error", "hint"}', async () => {
			const result = await runTaskCommand(['--json', 'list', '--all-projects', '--tree'], root);
			expect(result.exitCode).toBe(1);
			const parsed = JSON.parse(result.output) as { error: string; hint: string };
			expect(parsed.error).toContain('--tree');
			expect(parsed.hint).toContain('task list');
		});

		it('fails on an unknown flag, with the usage', async () => {
			const result = await runTaskCommand(['list', '--all-projects', '--bogus'], root);
			expect(result.exitCode).toBe(1);
			expect(result.output).toContain('unknown flag: --bogus');
			expect(result.output).toContain('Usage: task list --all-projects');
		});

		it('is not shadowed by a per-project list: plain `task list` still prints the JSON array of the project', async () => {
			const { alpha } = await twoProjects();
			const result = await runTaskCommand(['list'], alpha);
			expect(Array.isArray(JSON.parse(result.output))).toBe(true);
		});
	});

	describe('project selection on `task projects summary` (it uses no project)', () => {
		it('summary ignores project selection (nothing contradicts): it works with TASK_PROJECT set, and says nothing on stderr', async () => {
			await twoProjects();
			process.env['TASK_PROJECT'] = 'alpha';
			try {
				const result = await runTaskCommand(['projects', 'summary'], root);
				expect(result.exitCode).toBe(0);
				expect(stderr.join('')).toBe('');
			} finally {
				delete process.env['TASK_PROJECT'];
			}
		});

		it('--config does not change the all-projects behaviour (not a project selection)', async () => {
			await twoProjects();
			const result = await runTaskCommand(
				['--config', path.join(root, 'other-config'), 'list', '--all-projects'],
				root
			);
			expect(result.exitCode).toBe(0);
			expect(result.output).toContain('alpha open task');
		});
	});

	describe('help text', () => {
		it('task --help documents that --all-projects cannot be combined with -p or TASK_PROJECT', async () => {
			const help = (await runTaskCommand(['--help'], root)).output;
			expect(help).toContain('cannot be combined with --follow, --tree, --parent, -p or TASK_PROJECT');
		});

		it('task projects --help says no project is used and where the removed subcommands went', async () => {
			const help = (await runTaskCommand(['projects', '--help'], root)).output;
			expect(help).toContain('-p and TASK_PROJECT are not used here');
			expect(help).toContain('project add');
			expect(help).toContain('moved to the project CLI');
		});
	});

	describe('task projects summary', () => {
		it('prints the totals, then one line per project with open/total', async () => {
			await twoProjects();
			const result = await runTaskCommand(['projects', 'summary'], root);
			expect(result.exitCode).toBe(0);
			expect(result.output).toContain('2 open / 3 total in 2 projects');
			expect(result.output).toMatch(/alpha\s+1 open \/ 2 total/);
			expect(result.output).toMatch(/beta\s+1 open \/ 1 total/);
		});

		it('shows an unreadable project with its reason and exits 0 while another can be read', async () => {
			const { beta } = await twoProjects();
			const configFile = breakProject(beta);
			const result = await runTaskCommand(['projects', 'summary'], root);
			expect(result.exitCode).toBe(0);
			expect(result.output).toContain('1 open / 2 total in 1 project');
			expect(result.output).toMatch(/beta\s+\[unreadable: .*config\.yml/);
			expect(result.output).toContain(configFile);
		});

		it('exits 1 with every reason and the fix when all projects fail', async () => {
			const { alpha, beta } = await twoProjects();
			breakProject(alpha);
			breakProject(beta);
			const result = await runTaskCommand(['projects', 'summary'], root);
			expect(result.exitCode).toBe(1);
			expect(result.output).toContain(alpha);
			expect(result.output).toContain('project CLI');
		});

		it('says what to do, exit 0, when no project is registered', async () => {
			const result = await runTaskCommand(['projects', 'summary'], root);
			expect(result.exitCode).toBe(0);
			expect(result.output).toContain('project add');
		});

		it('--json prints the summary of the service as it is', async () => {
			const { beta } = await twoProjects();
			await initProject('gamma');
			const configFile = breakProject(beta);
			const result = await runTaskCommand(['projects', 'summary', '--json'], root);
			expect(result.exitCode).toBe(0);
			const parsed = JSON.parse(result.output) as JsonSummary;
			expect(parsed).toMatchObject({ readableCount: 2, open: 1, total: 2 });
			expect(parsed.projects.map(p => p.name)).toEqual(['alpha', 'beta', 'gamma']);
			expect(parsed.projects[1]!.open).toBeNull();
			expect(parsed.projects[1]!.error).toContain(configFile);
		});

		it('--json: all failing is {"error", "hint"} with exit 1', async () => {
			const { alpha, beta } = await twoProjects();
			breakProject(alpha);
			breakProject(beta);
			const result = await runTaskCommand(['--json', 'projects', 'summary'], root);
			expect(result.exitCode).toBe(1);
			expect(JSON.parse(result.output)).toMatchObject({ error: expect.stringContaining('none of the 2') });
		});

		it('rejects an unexpected argument with the usage', async () => {
			const result = await runTaskCommand(['projects', 'summary', 'extra'], root);
			expect(result.exitCode).toBe(1);
			expect(result.output).toContain('unexpected argument: extra');
			expect(result.output).toContain('Usage: task projects summary [--json]');
		});

		it('is listed in the valid subcommands of an unknown projects subcommand', async () => {
			const result = await runTaskCommand(['projects', 'nope'], root);
			expect(result.output).toContain('summary');
		});
	});
});
