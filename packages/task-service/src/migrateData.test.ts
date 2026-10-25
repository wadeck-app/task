import * as fs from 'node:fs';
import * as path from 'node:path';

import { DataMigrationError, ProjectDataSplitError, UnmigratedDataError } from './errors.js';
import { assertDataMigrated, migrateData } from './migrateData.js';
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
		// Until then the commands use the registry copy; the leftover folder is ignored, not announced.
		expect(result.nextStep).toContain('use the registry copy');
		expect(result.nextStep).not.toContain('old copy');
	});

	it('before the copy the project is refused with both folders and the command; after it, it opens on the registry copy, silently', async () => {
		const fixture = legacyProject('shop');
		const project = await resolved('shop', fixture.dir);
		expect(() => openResolvedProject(project)).toThrow(UnmigratedDataError);

		migrateData(project);
		const ctx = openResolvedProject(project);

		expect(ctx.storage.dataDir).toBe(project.storage.dataDir);
		expect(ctx).not.toHaveProperty('notices');
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

describe('assertDataMigrated: the registry is the only place task reads; an old .task is an error, never a fallback', () => {
	function writeRegistryTask(dataDir: string, id: string): void {
		fs.mkdirSync(path.join(dataDir, 'tasks'), { recursive: true });
		fs.writeFileSync(path.join(dataDir, 'tasks', `${id}.json`), '{}');
	}

	function writeOldTask(dir: string, id: string): void {
		fs.mkdirSync(path.join(dir, '.task', 'tasks'), { recursive: true });
		fs.writeFileSync(path.join(dir, '.task', 'tasks', `${id}.json`), '{}');
	}

	function failureOfCheck(project: ResolvedProject): unknown {
		try {
			assertDataMigrated(project.storage, 'shop');
		} catch (error) {
			return error;
		}
		return undefined;
	}

	it('a fresh project (no data in the registry, no .task) passes', async () => {
		expect(failureOfCheck(await resolved('shop', sandbox.dir('shop')))).toBeUndefined();
	});

	it('a .task with nothing in it (an empty tasks/ only) is not data: passes', async () => {
		expect(failureOfCheck(await resolved('shop', sandbox.dir('shop', { task: true })))).toBeUndefined();
	});

	it('a virtual project passes (it has no main path, hence no .task)', async () => {
		await sandbox.register('notes', undefined);
		const project = resolveProject({ cwd: sandbox.root, projectRef: 'notes', env: sandbox.env });

		expect(() => assertDataMigrated(project.storage, 'notes')).not.toThrow();
	});

	it('UNMIGRATED (the .task holds tasks, the registry none): fails naming both folders and the exact command', async () => {
		const dir = sandbox.dir('shop');
		writeOldTask(dir, 'one');
		const project = await resolved('shop', dir);

		const failure = failureOfCheck(project);

		expect(failure).toBeInstanceOf(UnmigratedDataError);
		const error = failure as UnmigratedDataError;
		const oldDir = path.join(path.resolve(dir), '.task');
		expect(error.message).toContain(oldDir);
		expect(error.message).toContain(project.storage.dataDir);
		expect(error.message).toContain('shop');
		expect(error.hint).toBe(
			`Copy the tasks into the registry with: task cli migrate-data -p shop, check them (task list -p shop --all), then delete ${oldDir} by hand.`
		);
		// Looking creates nothing.
		expect(fs.existsSync(project.storage.dataDir)).toBe(false);
	});

	it('UNMIGRATED with a .task that holds only a config.yml the registry lacks: also an error', async () => {
		const dir = sandbox.dir('shop', { task: true });
		fs.writeFileSync(path.join(dir, '.task', 'config.yml'), 'types: [bug]\n');

		expect(failureOfCheck(await resolved('shop', dir))).toBeInstanceOf(UnmigratedDataError);
	});

	it('a .task config.yml next to a registry that has its own config is not data: passes', async () => {
		const dir = sandbox.dir('shop', { task: true });
		fs.writeFileSync(path.join(dir, '.task', 'config.yml'), 'types: [bug]\n');
		const project = await resolved('shop', dir);
		fs.mkdirSync(path.dirname(ownConfigFile(project.storage)), { recursive: true });
		fs.writeFileSync(ownConfigFile(project.storage), 'types: [new]\n');

		expect(() => assertDataMigrated(project.storage, 'shop')).not.toThrow();
	});

	it('the registry holds the data and no .task is left: passes', async () => {
		const project = await resolved('shop', sandbox.dir('shop'));
		writeRegistryTask(project.storage.dataDir, 'one');

		expect(() => assertDataMigrated(project.storage, 'shop')).not.toThrow();
	});

	it('RIGHT AFTER MIGRATION (both places hold the same task ids): passes, the registry wins, nothing is announced', async () => {
		const dir = sandbox.dir('shop');
		writeOldTask(dir, 'one');
		writeOldTask(dir, 'two');
		const project = await resolved('shop', dir);
		writeRegistryTask(project.storage.dataDir, 'two');
		writeRegistryTask(project.storage.dataDir, 'one');

		expect(assertDataMigrated(project.storage, 'shop')).toBeUndefined();
	});

	it('a REAL SPLIT (both hold tasks, the ids differ) fails with both folders and the two ways out', async () => {
		const dir = sandbox.dir('shop');
		writeOldTask(dir, 'one');
		const project = await resolved('shop', dir);
		writeRegistryTask(project.storage.dataDir, 'other');

		const failure = failureOfCheck(project);

		expect(failure).toBeInstanceOf(ProjectDataSplitError);
		const error = failure as ProjectDataSplitError;
		const oldDir = path.join(path.resolve(dir), '.task');
		expect(error.message).toContain(oldDir);
		expect(error.message).toContain(project.storage.dataDir);
		expect(error.hint).toContain(`delete ${oldDir} by hand`);
		expect(error.hint).toContain(`move ${project.storage.dataDir} away`);
	});

	it('the same ids with one extra task on either side is a real split', async () => {
		const dir = sandbox.dir('shop');
		writeOldTask(dir, 'one');
		writeOldTask(dir, 'extra');
		const project = await resolved('shop', dir);
		writeRegistryTask(project.storage.dataDir, 'one');

		expect(failureOfCheck(project)).toBeInstanceOf(ProjectDataSplitError);
	});
});
