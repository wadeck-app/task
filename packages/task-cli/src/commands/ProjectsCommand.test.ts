import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { listRegisteredProjects, registerProject } from '@wadeck-app/task-service';

import { runTaskCommand } from '../TaskIndex.js';

interface Listing {
	path: string;
	exists: boolean;
	initialized: boolean;
	error: string | null;
}

describe('task projects', () => {
	let root: string;
	let configDir: string;
	let previousXdg: string | undefined;

	beforeEach(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-projects-cmd-'));
		// vitest.setup.ts already points XDG_CONFIG_HOME at a sandbox; a per-test one keeps the registries apart.
		previousXdg = process.env['XDG_CONFIG_HOME'];
		process.env['XDG_CONFIG_HOME'] = path.join(root, 'xdg');
		configDir = path.join(root, 'xdg', 'task');
	});

	afterEach(() => {
		process.env['XDG_CONFIG_HOME'] = previousXdg;
		fs.rmSync(root, { recursive: true, force: true });
	});

	async function initProject(name: string): Promise<string> {
		const dir = path.join(root, name);
		fs.mkdirSync(dir);
		await runTaskCommand(['init'], dir);
		return dir;
	}

	describe('list', () => {
		it('tells how to register a project when none is', async () => {
			const result = await runTaskCommand(['projects', 'list'], root);
			expect(result.exitCode).toBe(0);
			expect(result.output).toContain('no project registered');
			expect(result.output).toContain('task init');
		});

		it('--json prints an empty array when none is registered', async () => {
			const result = await runTaskCommand(['projects', 'list', '--json'], root);
			expect(result).toEqual({ exitCode: 0, output: '[]' });
		});

		it('flags the missing, uninitialized and healthy projects, in registration order', async () => {
			const healthy = await initProject('healthy');
			const gone = await initProject('gone');
			fs.rmSync(gone, { recursive: true });
			const bare = path.join(root, 'bare');
			fs.mkdirSync(bare);
			registerProject(configDir, bare);
			const result = await runTaskCommand(['projects', 'list', '--json'], root);
			expect(result.exitCode).toBe(0);
			const listing = JSON.parse(result.output) as Listing[];
			expect(listing.map(l => l.path)).toEqual([healthy, gone, bare]);
			expect(listing[0]).toEqual({ path: healthy, exists: true, initialized: true, error: null });
			expect(listing[1]).toMatchObject({ path: gone, exists: false, initialized: false });
			expect(listing[1]!.error).toContain('does not exist');
			expect(listing[2]).toMatchObject({ path: bare, exists: true, initialized: false });
			expect(listing[2]!.error).toContain('task init');
		});

		it('flags a project whose config cannot be read', async () => {
			const broken = await initProject('broken');
			fs.writeFileSync(path.join(broken, '.task', 'config.yml'), 'statuses: [unclosed');
			const result = await runTaskCommand(['projects', 'list', '--json'], root);
			const [entry] = JSON.parse(result.output) as Listing[];
			expect(entry).toMatchObject({ path: broken, exists: true, initialized: true });
			expect(entry!.error).toEqual(expect.any(String));
		});

		it('text output shows the path and a flag per problem', async () => {
			const healthy = await initProject('healthy');
			const gone = await initProject('gone');
			fs.rmSync(gone, { recursive: true });
			const result = await runTaskCommand(['projects', 'list'], root);
			const lines = result.output.split('\n');
			expect(lines.find(l => l.includes(healthy))).toContain('[ok]');
			expect(lines.find(l => l.includes(gone))).toContain('[missing]');
		});

		it('fails with the registry fix when projects.json is corrupt', async () => {
			fs.mkdirSync(configDir, { recursive: true });
			fs.writeFileSync(path.join(configDir, 'projects.json'), '{nope');
			const result = await runTaskCommand(['projects', 'list'], root);
			expect(result.exitCode).toBe(1);
			expect(result.output).toContain('Error: projects registry');
			expect(result.output).toContain('Fix or delete');
		});
	});

	describe('add', () => {
		it('registers the cwd by default when it holds a .task', async () => {
			const dir = path.join(root, 'p');
			fs.mkdirSync(path.join(dir, '.task'), { recursive: true });
			const result = await runTaskCommand(['projects', 'add'], dir);
			expect(result).toEqual({ exitCode: 0, output: `Registered project: ${dir}` });
			expect(listRegisteredProjects(configDir)).toEqual([dir]);
		});

		it('resolves a relative path against the cwd', async () => {
			const dir = path.join(root, 'p');
			fs.mkdirSync(path.join(dir, '.task'), { recursive: true });
			const result = await runTaskCommand(['projects', 'add', 'p'], root);
			expect(result.exitCode).toBe(0);
			expect(listRegisteredProjects(configDir)).toEqual([dir]);
		});

		it('is idempotent and says so', async () => {
			const dir = await initProject('p');
			const result = await runTaskCommand(['projects', 'add', dir], root);
			expect(result).toEqual({ exitCode: 0, output: `Already registered: ${dir}` });
			expect(listRegisteredProjects(configDir)).toEqual([dir]);
		});

		it('fails loudly with the task init hint for a directory that is not initialized', async () => {
			const bare = path.join(root, 'bare');
			fs.mkdirSync(bare);
			const result = await runTaskCommand(['projects', 'add', bare], root);
			expect(result.exitCode).toBe(1);
			expect(result.output).toContain(`Error: "${bare}" is not an initialized task project`);
			expect(result.output).toContain('Run `task init` there');
			expect(listRegisteredProjects(configDir)).toEqual([]);
		});

		it('--json prints the path and whether it was added', async () => {
			const dir = path.join(root, 'p');
			fs.mkdirSync(path.join(dir, '.task'), { recursive: true });
			const first = await runTaskCommand(['projects', 'add', dir, '--json'], root);
			expect(JSON.parse(first.output)).toEqual({ path: dir, added: true });
			const second = await runTaskCommand(['projects', 'add', dir, '--json'], root);
			expect(JSON.parse(second.output)).toEqual({ path: dir, added: false });
		});

		it('rejects a second directory', async () => {
			const result = await runTaskCommand(['projects', 'add', 'a', 'b'], root);
			expect(result.exitCode).toBe(1);
			expect(result.output).toContain('unexpected argument: b');
		});
	});

	describe('remove', () => {
		it('unregisters the directory and leaves its .task untouched', async () => {
			const a = await initProject('a');
			const b = await initProject('b');
			const result = await runTaskCommand(['projects', 'remove', a], root);
			expect(result).toEqual({ exitCode: 0, output: `Removed project: ${a}` });
			expect(listRegisteredProjects(configDir)).toEqual([b]);
			expect(fs.existsSync(path.join(a, '.task'))).toBe(true);
		});

		it('resolves a relative path against the cwd', async () => {
			const a = await initProject('a');
			const result = await runTaskCommand(['projects', 'remove', 'a'], root);
			expect(result.exitCode).toBe(0);
			expect(listRegisteredProjects(configDir)).toEqual([]);
			expect(result.output).toContain(a);
		});

		it.runIf(process.platform === 'win32')('ignores the case of the path on Windows', async () => {
			const a = await initProject('a');
			const result = await runTaskCommand(['projects', 'remove', a.toUpperCase()], root);
			expect(result.exitCode).toBe(0);
			expect(listRegisteredProjects(configDir)).toEqual([]);
		});

		it('works for a directory that no longer exists', async () => {
			const a = await initProject('a');
			fs.rmSync(a, { recursive: true });
			const result = await runTaskCommand(['projects', 'remove', a], root);
			expect(result.exitCode).toBe(0);
			expect(listRegisteredProjects(configDir)).toEqual([]);
		});

		it('--json prints the removed path', async () => {
			const a = await initProject('a');
			const result = await runTaskCommand(['projects', 'remove', a, '--json'], root);
			expect(result.exitCode).toBe(0);
			expect(JSON.parse(result.output)).toEqual({ removed: a });
		});

		it('fails loudly, naming the directory and how to list the registered ones, when it is not registered', async () => {
			const a = await initProject('a');
			const other = path.join(root, 'other');
			const result = await runTaskCommand(['projects', 'remove', other], root);
			expect(result.exitCode).toBe(1);
			expect(result.output).toContain(`Error: project "${other}" is not registered`);
			expect(result.output).toContain('task projects list');
			expect(listRegisteredProjects(configDir)).toEqual([a]);
		});

		it('--json reports that failure as {"error"}', async () => {
			const result = await runTaskCommand(['projects', 'remove', path.join(root, 'other'), '--json'], root);
			expect(result.exitCode).toBe(1);
			expect((JSON.parse(result.output) as { error: string }).error).toContain('is not registered');
		});

		it('requires a directory', async () => {
			const result = await runTaskCommand(['projects', 'remove'], root);
			expect(result.exitCode).toBe(1);
			expect(result.output).toContain('missing project directory');
			expect(result.output).toContain('Usage: task projects remove <dir>');
		});
	});

	describe('move', () => {
		it('replaces the registered directory by the new one, in place, and touches no data', async () => {
			const a = await initProject('a');
			const b = await initProject('b');
			const c = await initProject('c');
			const moved = await initProject('b2');
			// The registry holds a, b, c, b2: unregister b2 first so that it is only a candidate.
			await runTaskCommand(['projects', 'remove', moved], root);
			const result = await runTaskCommand(['projects', 'move', b, moved], root);
			expect(result).toEqual({ exitCode: 0, output: `Moved project: ${b} -> ${moved}` });
			expect(listRegisteredProjects(configDir)).toEqual([a, moved, c]);
			expect(fs.existsSync(path.join(b, '.task'))).toBe(true);
		});

		it('resolves relative paths against the cwd', async () => {
			const a = await initProject('a');
			const b = await initProject('b');
			await runTaskCommand(['projects', 'remove', b], root);
			const result = await runTaskCommand(['projects', 'move', 'a', 'b'], root);
			expect(result.output).toBe(`Moved project: ${a} -> ${b}`);
			expect(listRegisteredProjects(configDir)).toEqual([b]);
		});

		it('works when the registered directory is gone (the point of the command)', async () => {
			const a = await initProject('a');
			const next = await initProject('next');
			await runTaskCommand(['projects', 'remove', next], root);
			fs.rmSync(a, { recursive: true });
			const result = await runTaskCommand(['projects', 'move', a, next], root);
			expect(result.exitCode).toBe(0);
			expect(listRegisteredProjects(configDir)).toEqual([next]);
		});

		it('--json prints from and to', async () => {
			const a = await initProject('a');
			const next = await initProject('next');
			await runTaskCommand(['projects', 'remove', next], root);
			const result = await runTaskCommand(['projects', 'move', a, next, '--json'], root);
			expect(result.exitCode).toBe(0);
			expect(JSON.parse(result.output)).toEqual({ from: a, to: next });
		});

		it('fails when the old directory is not registered', async () => {
			const a = await initProject('a');
			const other = path.join(root, 'other');
			const result = await runTaskCommand(['projects', 'move', other, a], root);
			expect(result.exitCode).toBe(1);
			expect(result.output).toContain(`Error: project "${other}" is not registered`);
			expect(result.output).toContain('task projects list');
		});

		it('fails when the new directory is not an initialized project, with the fix', async () => {
			const a = await initProject('a');
			const bare = path.join(root, 'bare');
			fs.mkdirSync(bare);
			const result = await runTaskCommand(['projects', 'move', a, bare], root);
			expect(result.exitCode).toBe(1);
			expect(result.output).toContain('is not an initialized task project');
			expect(result.output).toContain('task init');
			expect(listRegisteredProjects(configDir)).toEqual([a]);
		});

		it('fails when the new directory is already registered', async () => {
			const a = await initProject('a');
			const b = await initProject('b');
			const result = await runTaskCommand(['projects', 'move', a, b, '--json'], root);
			expect(result.exitCode).toBe(1);
			expect((JSON.parse(result.output) as { error: string }).error).toContain('is already registered');
			expect(listRegisteredProjects(configDir)).toEqual([a, b]);
		});

		it('requires exactly two directories', async () => {
			const none = await runTaskCommand(['projects', 'move'], root);
			expect(none.exitCode).toBe(1);
			expect(none.output).toContain('Usage: task projects move <old-dir> <new-dir>');
			const one = await runTaskCommand(['projects', 'move', 'a'], root);
			expect(one.output).toContain('Usage: task projects move <old-dir> <new-dir>');
			const three = await runTaskCommand(['projects', 'move', 'a', 'b', 'c'], root);
			expect(three.output).toContain('unexpected argument: c');
		});

		it('is documented in the help', async () => {
			const help = await runTaskCommand(['projects', '--help'], root);
			expect(help.output).toContain('task projects move <old-dir> <new-dir>');
			expect((await runTaskCommand(['--help'], root)).output).toContain('task projects move');
			const unknown = await runTaskCommand(['projects', 'frobnicate'], root);
			expect(unknown.output).toContain('summary, move');
		});
	});

	describe('prune', () => {
		it('removes the entries whose directory is gone and prints each path', async () => {
			const kept = await initProject('kept');
			const gone1 = await initProject('gone1');
			const gone2 = await initProject('gone2');
			fs.rmSync(gone1, { recursive: true });
			fs.rmSync(gone2, { recursive: true });
			const result = await runTaskCommand(['projects', 'prune'], root);
			expect(result.exitCode).toBe(0);
			expect(result.output.split('\n')).toEqual([`Removed ${gone1}`, `Removed ${gone2}`]);
			expect(listRegisteredProjects(configDir)).toEqual([kept]);
		});

		it('--dry-run prints what would be removed and changes nothing', async () => {
			await initProject('kept');
			const gone = await initProject('gone');
			fs.rmSync(gone, { recursive: true });
			const before = listRegisteredProjects(configDir);
			const result = await runTaskCommand(['projects', 'prune', '--dry-run'], root);
			expect(result).toEqual({ exitCode: 0, output: `Would remove ${gone}` });
			expect(listRegisteredProjects(configDir)).toEqual(before);
		});

		it('says so when there is nothing to prune', async () => {
			await initProject('kept');
			const result = await runTaskCommand(['projects', 'prune'], root);
			expect(result).toEqual({ exitCode: 0, output: 'Nothing to prune: every registered directory exists.' });
		});

		it('--json lists the removed paths and whether it was a dry run', async () => {
			const gone = await initProject('gone');
			fs.rmSync(gone, { recursive: true });
			const dry = await runTaskCommand(['projects', 'prune', '--dry-run', '--json'], root);
			expect(JSON.parse(dry.output)).toEqual({ dryRun: true, removed: [gone] });
			const real = await runTaskCommand(['projects', 'prune', '--json'], root);
			expect(JSON.parse(real.output)).toEqual({ dryRun: false, removed: [gone] });
		});

		it('rejects an unknown flag instead of ignoring it', async () => {
			const result = await runTaskCommand(['projects', 'prune', '--dryrun'], root);
			expect(result.exitCode).toBe(1);
			expect(result.output).toContain('unknown flag: --dryrun');
		});
	});

	describe('dispatch', () => {
		it('works from a directory that is not an initialized project', async () => {
			const result = await runTaskCommand(['projects', 'list'], root);
			expect(result.output).not.toContain('project not initialized');
		});

		it('without subcommand or with --help prints the usage', async () => {
			for (const args of [['projects'], ['projects', '--help']]) {
				const result = await runTaskCommand(args, root);
				expect(result.exitCode).toBe(0);
				expect(result.output).toContain('task projects list');
				expect(result.output).toContain('task projects prune');
				expect(result.output).toContain('task projects add');
			}
		});

		it('an unknown subcommand names the valid ones', async () => {
			const result = await runTaskCommand(['projects', 'frobnicate'], root);
			expect(result.exitCode).toBe(1);
			expect(result.output).toContain('unknown task projects subcommand: frobnicate');
			expect(result.output).toContain('Valid subcommands: list, add, remove, prune');
		});

		it('is named in the --help and in the unknown-command hint', async () => {
			const project = await initProject('p');
			expect((await runTaskCommand(['--help'], root)).output).toContain('task projects list');
			expect((await runTaskCommand(['nope'], project)).output).toContain('plugins, projects');
		});
	});
});
