import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { defaultRegistryDir } from '@wadeck-app/project-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runTaskCommand } from '../TaskIndex.js';
import { registerTestProject } from '../testHelpers.js';

// The cross-project views read the shared registry only: rows carry the registry id and name, a registry that cannot be read is reported.

let root: string;
let previousXdg: string | undefined;
let stderr: string[];

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-global-shared-'));
	previousXdg = process.env['XDG_CONFIG_HOME'];
	process.env['XDG_CONFIG_HOME'] = path.join(root, 'xdg');
	stderr = [];
	vi.spyOn(process.stderr, 'write').mockImplementation(chunk => {
		stderr.push(String(chunk));
		return true;
	});
});

afterEach(() => {
	vi.restoreAllMocks();
	process.env['XDG_CONFIG_HOME'] = previousXdg;
	fs.rmSync(root, { recursive: true, force: true });
});

/** Two registered projects, each with one task. */
async function twoRegistered(): Promise<{ shop: { id: string; dir: string }; blog: { id: string; dir: string } }> {
	const result: Record<string, { id: string; dir: string }> = {};
	for (const [name, title] of [
		['shop', 'shop task'],
		['blog', 'blog task'],
	] as const) {
		const dir = path.join(root, `${name}-dir`);
		fs.mkdirSync(dir);
		const project = await registerTestProject(dir, { name });
		await runTaskCommand(['new', title, '-p', name], root);
		result[name] = { id: project.id, dir };
	}
	stderr.length = 0;
	return { shop: result['shop']!, blog: result['blog']! };
}

function corruptRegistry(): void {
	fs.writeFileSync(path.join(defaultRegistryDir(process.env), 'registry.json'), '{ nope');
}

describe('task list --all-projects with the shared registry', () => {
	it('lists the registered projects under their registry names, sorted by name', async () => {
		await twoRegistered();

		const result = await runTaskCommand(['list', '--all-projects'], root);

		expect(result.exitCode).toBe(0);
		const rows = result.output.split('\n').slice(1);
		expect(rows[0]).toMatch(/^blog\s+\w+\s+backlog\s+blog task$/);
		expect(rows[1]).toMatch(/^shop\s+\w+\s+backlog\s+shop task$/);
		expect(rows).toHaveLength(2);
		expect(stderr.join('')).toBe('');
	});

	it('--json tags the tasks with the project id, name and path, and says nothing on stderr', async () => {
		const { shop, blog } = await twoRegistered();

		const answer = JSON.parse((await runTaskCommand(['--json', 'list', '--all-projects'], root)).output) as {
			tasks: Array<{ title: string; project: { id?: string; name: string; path: string } }>;
		};

		const byTitle = Object.fromEntries(answer.tasks.map(task => [task.title, task.project]));
		expect(byTitle['shop task']).toEqual({ id: shop.id, name: 'shop', path: shop.dir });
		expect(byTitle['blog task']).toEqual({ id: blog.id, name: 'blog', path: blog.dir });
		expect(stderr.join('')).toBe('');
	});

	it('an unreadable shared registry is a stderr warning in text mode and a key of the JSON answer: no project is listed', async () => {
		await twoRegistered();
		corruptRegistry();

		const text = await runTaskCommand(['list', '--all-projects'], root);
		const warning = stderr.join('');
		const json = JSON.parse((await runTaskCommand(['--json', 'list', '--all-projects'], root)).output) as {
			tasks: unknown[];
			registryProblem?: string;
		};

		expect(text.exitCode).toBe(0);
		expect(text.output).not.toContain('shop task');
		expect(warning).toContain('Warning: the shared project registry was not read, so no project is listed:');
		expect(warning).toContain('registry.json');
		expect(json.tasks).toEqual([]);
		expect(json.registryProblem).toContain('registry.json');
	});
});

describe('task projects summary with the shared registry', () => {
	it('lists the registered projects under their registry names; JSON carries the id and no legacy flag', async () => {
		const { shop, blog } = await twoRegistered();

		const text = await runTaskCommand(['projects', 'summary'], root);
		const json = JSON.parse((await runTaskCommand(['--json', 'projects', 'summary'], root)).output) as {
			projects: Array<Record<string, unknown>>;
		};

		const lines = text.output.split('\n').filter(line => /^(shop|blog)\s/.test(line));
		expect(lines.map(line => line.split(/\s+/)[0])).toEqual(['shop', 'blog']);
		expect(json.projects.map(p => [p['id'], p['name']])).toEqual([
			[shop.id, 'shop'],
			[blog.id, 'blog'],
		]);
		for (const project of json.projects) {
			expect(project).not.toHaveProperty('registered');
			expect(project).not.toHaveProperty('initialized');
		}
		expect(stderr.join('')).toBe('');
	});

	it('an unreadable shared registry is a stderr warning in text mode and a key of the JSON answer', async () => {
		await twoRegistered();
		corruptRegistry();

		await runTaskCommand(['projects', 'summary'], root);
		const warning = stderr.join('');
		const json = JSON.parse((await runTaskCommand(['--json', 'projects', 'summary'], root)).output) as {
			projects: unknown[];
			registryProblem?: string;
		};

		expect(warning).toContain('Warning: the shared project registry was not read, so no project is listed:');
		expect(json.projects).toEqual([]);
		expect(json.registryProblem).toContain('registry.json');
	});
});
