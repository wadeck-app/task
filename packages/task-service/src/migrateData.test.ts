import * as fs from 'node:fs';
import * as path from 'node:path';

import { DataMigrationError } from './errors.js';
import { migrateData } from './migrateData.js';
import { openResolvedProject } from './openContext.js';
import { resolveProject } from './resolveProject.js';
import type { ResolvedProject } from './resolveProject.js';
import { ownConfigFile } from './storage.js';
import { createSharedRegistrySandbox } from './testHelpers.js';
import type { SharedRegistrySandbox } from './testHelpers.js';

let sandbox: SharedRegistrySandbox;

beforeEach(() => {
	sandbox = createSharedRegistrySandbox();
});

afterEach(() => {
	sandbox.cleanup();
});

interface LegacyFixture {
	dir: string;
	taskDir: string;
	files: Record<string, string>;
}

/** A `.task` with N tasks (real records, so the store can read them after the copy), an index and a config. */
function legacyProject(
	name: string,
	options: { tasks?: number; index?: boolean; config?: boolean } = {}
): LegacyFixture {
	const { tasks = 2, index = true, config = true } = options;
	const dir = sandbox.dir(name);
	const taskDir = path.join(dir, '.task');
	fs.mkdirSync(path.join(taskDir, 'tasks'), { recursive: true });
	const files: Record<string, string> = {};
	const summaries: unknown[] = [];
	for (let i = 0; i < tasks; i++) {
		const id = `task000${i}`;
		const record = {
			id,
			title: `Task ${i}`,
			description: `Task ${i}`,
			status: 'backlog',
			createdAt: `2026-10-0${i + 1}T00:00:00.000Z`,
			updatedAt: `2026-10-0${i + 1}T00:00:00.000Z`,
			history: [{ status: 'backlog', timestamp: `2026-10-0${i + 1}T00:00:00.000Z` }],
		};
		files[`tasks/${id}.json`] = JSON.stringify(record, null, 2);
		summaries.push({ id, title: record.title, status: 'backlog', createdAt: record.createdAt });
	}
	if (index) files['task-index.json'] = JSON.stringify({ tasks: summaries }, null, 2);
	if (config) files['config.yml'] = 'types:\n  - bug\n';
	for (const [relative, content] of Object.entries(files)) {
		fs.writeFileSync(path.join(taskDir, relative), content);
	}
	return { dir, taskDir, files };
}

async function resolved(name: string, dir: string): Promise<ResolvedProject> {
	await sandbox.register(name, dir);
	return resolveProject({ cwd: dir, env: sandbox.env });
}

function snapshot(dir: string): Record<string, string> {
	const out: Record<string, string> = {};
	const walk = (current: string): void => {
		for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
			const full = path.join(current, entry.name);
			if (entry.isDirectory()) walk(full);
			else out[path.relative(dir, full).split(path.sep).join('/')] = fs.readFileSync(full, 'utf8');
		}
	};
	walk(dir);
	return out;
}

function failureOf(action: () => unknown): DataMigrationError {
	try {
		action();
	} catch (error) {
		expect(error).toBeInstanceOf(DataMigrationError);
		return error as DataMigrationError;
	}
	throw new Error('expected the migration to fail');
}

describe('migrateData: copy the .task of a registered project into the shared registry', () => {
	it('copies tasks, index and config byte for byte, reports what was copied and the next step, and never touches the source', async () => {
		const fixture = legacyProject('shop');
		const project = await resolved('shop', fixture.dir);
		const before = snapshot(fixture.taskDir);

		const result = migrateData(project);

		expect(result).toMatchObject({
			dryRun: false,
			project: { id: project.id, name: 'shop' },
			source: fixture.taskDir,
			destination: { dataDir: project.storage.dataDir, configFile: ownConfigFile(project.storage) },
			tasks: { count: 2 },
			index: { copied: true },
			config: { copied: true },
			notCopied: [],
			warnings: [],
		});
		expect(result.tasks.bytes).toBe(
			Object.entries(fixture.files)
				.filter(([name]) => name.startsWith('tasks/'))
				.reduce((sum, [, content]) => sum + Buffer.byteLength(content), 0)
		);
		for (const [relative, content] of Object.entries(fixture.files)) {
			const target =
				relative === 'config.yml'
					? ownConfigFile(project.storage)
					: path.join(project.storage.dataDir, relative);
			expect(fs.readFileSync(target, 'utf8'), relative).toBe(content);
		}
		expect(snapshot(fixture.taskDir)).toEqual(before);
		expect(result.nextStep).toContain('task list -p shop --all');
		expect(result.nextStep).toContain(fixture.taskDir);
		expect(result.nextStep).toContain('by hand');
		// Until then the commands use the registry copy and print the one-line note.
		expect(result.nextStep).toContain('use the registry copy');
		expect(result.nextStep).toContain('old copy');
	});

	it('before the copy the project runs on its .task with the deprecation line; after it, on the registry copy with the old-copy note', async () => {
		const fixture = legacyProject('shop');
		const project = await resolved('shop', fixture.dir);
		expect(openResolvedProject(project).notices?.[0]).toContain(
			'Deprecated: project shop still keeps its task data'
		);

		migrateData(project);
		const ctx = openResolvedProject(project);

		expect(ctx.storage.kind).toBe('registry');
		expect(ctx.notices).toEqual([`old copy still in ${fixture.taskDir}: delete it by hand once checked`]);
		expect(
			ctx.store
				.list()
				.map(task => task.id)
				.sort()
		).toEqual(['task0000', 'task0001']);
		expect(ctx.config.types).toEqual(['bug']);
	});

	it('--dry-run reports the same figures and writes nothing anywhere', async () => {
		const fixture = legacyProject('shop');
		const project = await resolved('shop', fixture.dir);
		const before = snapshot(sandbox.root);

		const result = migrateData(project, { dryRun: true });

		expect(result).toMatchObject({
			dryRun: true,
			tasks: { count: 2 },
			index: { copied: true },
			config: { copied: true },
		});
		expect(snapshot(sandbox.root)).toEqual(before);
		expect(fs.existsSync(project.storage.dataDir)).toBe(false);
	});

	it('copies a .task that has no config, or no index, and says what is missing (nothing is rebuilt)', async () => {
		const fixture = legacyProject('shop', { config: false, index: false });
		const project = await resolved('shop', fixture.dir);

		const result = migrateData(project);

		expect(result.config).toMatchObject({ copied: false });
		expect(result.index).toMatchObject({ copied: false });
		expect(result.warnings.join('\n')).toContain('task-index.json');
		expect(result.warnings.join('\n')).toContain('not rebuilt');
		expect(fs.existsSync(path.join(project.storage.dataDir, 'task-index.json'))).toBe(false);
	});

	it('lists what it did not copy (not .json files of tasks/, other entries of .task) instead of ignoring them', async () => {
		const fixture = legacyProject('shop');
		fs.writeFileSync(path.join(fixture.taskDir, 'tasks', 'notes.txt'), 'x');
		fs.writeFileSync(path.join(fixture.taskDir, 'scratch.md'), 'x');
		const project = await resolved('shop', fixture.dir);

		const result = migrateData(project);

		expect(result.notCopied.sort()).toEqual(['scratch.md', 'tasks/notes.txt']);
		expect(fs.existsSync(path.join(project.storage.dataDir, 'tasks', 'notes.txt'))).toBe(false);
	});
});

describe('migrateData: refusals (nothing is written)', () => {
	it('refuses when the destination already holds task data, naming both folders', async () => {
		const fixture = legacyProject('shop');
		const project = await resolved('shop', fixture.dir);
		fs.mkdirSync(path.join(project.storage.dataDir, 'tasks'), { recursive: true });
		fs.writeFileSync(path.join(project.storage.dataDir, 'tasks', 'existing.json'), '{}');
		const before = snapshot(sandbox.root);

		const error = failureOf(() => migrateData(project));

		expect(error.message).toContain(fixture.taskDir);
		expect(error.message).toContain(project.storage.dataDir);
		expect(error.hint).toBeTruthy();
		expect(snapshot(sandbox.root)).toEqual(before);
	});

	it('refuses when both sides have a config.yml, naming the destination file', async () => {
		const fixture = legacyProject('shop', { tasks: 1 });
		const project = await resolved('shop', fixture.dir);
		fs.mkdirSync(path.dirname(ownConfigFile(project.storage)), { recursive: true });
		fs.writeFileSync(ownConfigFile(project.storage), 'types: [other]\n');
		const before = snapshot(sandbox.root);

		const error = failureOf(() => migrateData(project));

		expect(error.message).toContain(ownConfigFile(project.storage));
		expect(snapshot(sandbox.root)).toEqual(before);
	});

	it('a virtual project has no .task to copy', async () => {
		await sandbox.register('notes', undefined);
		const project = resolveProject({ cwd: sandbox.root, projectRef: 'notes', env: sandbox.env });

		const error = failureOf(() => migrateData(project));

		expect(error.message).toContain('notes');
		expect(error.message).toContain('virtual');
	});

	it('a folder found by the legacy rule must be registered first: the hint is project add', () => {
		const fixture = legacyProject('old');
		const project = resolveProject({ cwd: fixture.dir, env: sandbox.env });

		const error = failureOf(() => migrateData(project));

		expect(error.message).toContain('not in the shared project registry');
		expect(error.hint).toContain(`project add "${fixture.dir}"`);
	});

	it('nothing to copy: a main path without .task data or config', async () => {
		const project = await resolved('shop', sandbox.dir('shop'));

		const error = failureOf(() => migrateData(project));

		expect(error.message).toContain('nothing to migrate');
		expect(error.message).toContain(path.join(path.resolve(sandbox.dir('shop')), '.task'));
	});
});

describe('migrateData: a failed copy leaves nothing behind', () => {
	it('removes what it already copied when the config cannot be written, and the source is intact', async () => {
		const fixture = legacyProject('shop');
		const project = await resolved('shop', fixture.dir);
		// The config folder is a FILE: the config copy fails after tasks and index were copied.
		const configDir = path.dirname(ownConfigFile(project.storage));
		fs.mkdirSync(path.dirname(configDir), { recursive: true });
		fs.writeFileSync(configDir, 'in the way');
		const sourceBefore = snapshot(fixture.taskDir);

		const error = failureOf(() => migrateData(project));

		expect(error.message).toContain(configDir);
		expect(error.message).toContain('rolled back');
		expect(fs.existsSync(path.join(project.storage.dataDir, 'task-index.json'))).toBe(false);
		expect(fs.readdirSync(path.join(project.storage.dataDir, 'tasks'))).toEqual([]);
		expect(snapshot(fixture.taskDir)).toEqual(sourceBefore);
	});
});
