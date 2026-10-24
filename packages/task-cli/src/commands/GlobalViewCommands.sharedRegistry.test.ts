import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { addProject, defaultRegistryDir } from '@wadeck-app/project-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runTaskCommand } from '../TaskIndex.js';

// Stage 1 of the shared project registry in the cross-project views: registered projects first, legacy ones marked.

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

async function initProject(name: string, title: string): Promise<string> {
	const dir = path.join(root, name);
	fs.mkdirSync(dir);
	await runTaskCommand(['init'], dir);
	await runTaskCommand(['new', title], dir);
	return dir;
}

/** A shared project (registry) and a legacy-only one, each with one task. */
async function sharedAndLegacy(): Promise<{ shared: string; legacy: string; id: string }> {
	const shared = await initProject('shared-dir', 'shared task');
	const legacy = await initProject('legacy-dir', 'legacy task');
	// `task init` registered both in the legacy projects.json: the shared one is also in the shared registry, under another name.
	const project = await addProject(defaultRegistryDir(process.env), { name: 'shop', path: shared });
	stderr.length = 0;
	return { shared, legacy, id: project.id };
}

describe('task list --all-projects with the shared registry', () => {
	it('lists the registered project under its registry name, then the legacy one', async () => {
		await sharedAndLegacy();

		const result = await runTaskCommand(['list', '--all-projects'], root);

		expect(result.exitCode).toBe(0);
		const rows = result.output.split('\n').slice(1);
		expect(rows[1]).toMatch(/^shop\s+\w+\s+backlog\s+shared task$/);
		expect(rows[0]).toMatch(/^legacy-dir\s+\w+\s+backlog\s+legacy task$/);
		// The shared project is not listed twice although projects.json also names it.
		expect(rows).toHaveLength(2);
	});

	it('--json tags the tasks with the project id when registered, and says which projects are not', async () => {
		const { id, legacy } = await sharedAndLegacy();

		const answer = JSON.parse((await runTaskCommand(['--json', 'list', '--all-projects'], root)).output) as {
			tasks: Array<{ title: string; project: { id?: string; name: string; path: string } }>;
		};

		const byTitle = Object.fromEntries(answer.tasks.map(task => [task.title, task.project]));
		expect(byTitle['shared task']!.id).toBe(id);
		expect(byTitle['shared task']!.name).toBe('shop');
		expect(byTitle['legacy task']).toEqual({ name: 'legacy-dir', path: legacy });
		expect(stderr.join('')).toBe('');
	});

	it('text mode names the unregistered projects on stderr with the command to register each', async () => {
		const { legacy } = await sharedAndLegacy();

		await runTaskCommand(['list', '--all-projects'], root);

		const text = stderr.join('');
		expect(text).toContain(`project add "${legacy}"`);
		expect(text).not.toContain('shared-dir');
		expect(text.split('\n').filter(Boolean)).toHaveLength(1);
	});

	it('an unreadable shared registry is a stderr warning in text mode and a key of the JSON answer; the legacy projects still list', async () => {
		await sharedAndLegacy();
		fs.writeFileSync(path.join(defaultRegistryDir(process.env), 'registry.json'), '{ nope');

		const text = await runTaskCommand(['list', '--all-projects'], root);
		const warning = stderr.join('');
		const json = JSON.parse((await runTaskCommand(['--json', 'list', '--all-projects'], root)).output) as {
			registryProblem?: string;
		};

		expect(text.exitCode).toBe(0);
		expect(text.output).toContain('legacy task');
		expect(warning).toContain('registry.json');
		expect(json.registryProblem).toContain('registry.json');
	});
});

describe('task projects summary with the shared registry', () => {
	it('lists the registered project first under its registry name; JSON carries id and registered', async () => {
		const { id } = await sharedAndLegacy();

		const text = await runTaskCommand(['projects', 'summary'], root);
		const json = JSON.parse((await runTaskCommand(['--json', 'projects', 'summary'], root)).output) as {
			projects: Array<{ id?: string; name: string; registered: boolean }>;
		};

		const lines = text.output.split('\n').filter(line => /^(shop|legacy-dir)\s/.test(line));
		expect(lines.map(line => line.split(/\s+/)[0])).toEqual(['shop', 'legacy-dir']);
		expect(json.projects.map(p => [p.id, p.name, p.registered])).toEqual([
			[id, 'shop', true],
			[undefined, 'legacy-dir', false],
		]);
	});

	it('text mode names the unregistered projects on stderr', async () => {
		const { legacy } = await sharedAndLegacy();

		await runTaskCommand(['projects', 'summary'], root);

		expect(stderr.join('')).toContain(`project add "${legacy}"`);
	});
});
