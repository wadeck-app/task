import * as fs from 'node:fs';
import * as path from 'node:path';

import { writeFileAtomic } from '@wadeck-app/project-sdk';
import { BackendRejectedError, TaskConfigLoader } from '@wadeck-app/task-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ABORT_BACKUP_SUFFIX, abortProjectMigration, finalizeProjectMigration } from './migrationEnd.js';
import type { MigrationEndInput } from './migrationEnd.js';
import { BACKUP_SUFFIX } from './migrate/migrateInPlace.js';
import { openMigration, openMigrationControl } from './migrationService.js';
import { openResolvedProject } from './openContext.js';
import { FakeGitHub } from './plugins/github/fakeGitHub.testkit.js';
import { resolveProject } from './resolveProject.js';
import type { ResolvedProject } from './resolveProject.js';
import { ownConfigFile } from './storage.js';
import { createSharedRegistrySandbox } from './testHelpers.js';
import type { SharedRegistrySandbox } from './testHelpers.js';

// The end of a background migration over a REAL project of the shared registry (real config.yml, real data folder, real files of the
// migration) and the fake GitHub server as "new": finalize and abort as the CLI runs them. The checks and the fault matrix of the
// plugin are in plugins/migrating/migrationFinish.test.ts; what is tested here is what belongs to the host: the project config.
let sandbox: SharedRegistrySandbox;
let fake: FakeGitHub;
let project: ResolvedProject;
const TOKEN_VARIABLE = 'TASK_END_TEST_TOKEN';

const STATUSES = `statuses:
    - backlog
    - in-progress
    - { name: done, terminal: true }
priorities:
    - high
    - low
`;

const NEW_BLOCK = (): string => `            type: github
            options:
                repo: ${fake.repo}
                baseUrl: ${fake.baseUrl}
                tokenEnv: ${TOKEN_VARIABLE}
                writeSpacingSeconds: 0
                timeoutSeconds: 3
                cache: { ttlSeconds: 0 }
                priorityStorage: label
                fills: { meta: labels }
                statusMap:
                    backlog: { state: open }
                    in-progress: { state: open, label: 'status:in-progress' }
                    done: { state: closed }
`;

const migratingConfig = (newBlock = NEW_BLOCK()): string => `${STATUSES}strategy:
    type: migrating
    options:
        current: { type: local }
        new:
${newBlock}`;

const GLOBAL = (): string => path.join(sandbox.root, 'global');
const configFile = (): string => ownConfigFile(project.storage);
const env = (): NodeJS.ProcessEnv => ({ ...sandbox.env, [TOKEN_VARIABLE]: fake.token });
const input = (extra: Partial<MigrationEndInput> = {}): MigrationEndInput => ({
	project,
	globalConfigDir: GLOBAL(),
	env: env(),
	...extra,
});
const parsedConfig = (): Record<string, unknown> =>
	TaskConfigLoader.parseConfigText<Record<string, unknown>>(fs.readFileSync(configFile(), 'utf8'), 'config.yml') ??
	{};
const controlOf = () => openMigrationControl(project.storage);

/** Three tasks in "current" through the plain local project, then the migrating config. Returns their titles by id. */
async function seedAndConfigure(): Promise<Record<string, string>> {
	fs.mkdirSync(path.dirname(configFile()), { recursive: true });
	fs.writeFileSync(configFile(), STATUSES);
	const ctx = openResolvedProject(project, GLOBAL(), { env: env() });
	const epic = await ctx.store.create({ title: 'Epic', status: 'backlog' });
	const child = await ctx.store.create({ title: 'Child', status: 'in-progress', parentId: epic.id });
	const loose = await ctx.store.create({ title: 'Loose', status: 'backlog' });
	await ctx.dispose?.();
	fs.writeFileSync(configFile(), migratingConfig());
	return { [epic.id]: 'Epic', [child.id]: 'Child', [loose.id]: 'Loose' };
}

/** `start` then the worker, in this process (no spawn), until the migration is ready to finalize (or says why not). */
async function startAndRun(): Promise<string> {
	const ctx = openResolvedProject(project, GLOBAL(), { env: env() });
	try {
		const migration = await openMigration(ctx);
		await migration.start({ acceptedLosses: ['all'] });
		const result = await migration.runWorker({
			sleep: ms => new Promise(resolve => setTimeout(resolve, Math.min(ms, 5))),
		});
		return result.status;
	} finally {
		await ctx.dispose?.();
	}
}

async function startOnly(): Promise<void> {
	const ctx = openResolvedProject(project, GLOBAL(), { env: env() });
	try {
		await (await openMigration(ctx)).start({ acceptedLosses: ['all'] });
	} finally {
		await ctx.dispose?.();
	}
}

const titlesOfProject = async (): Promise<string[]> => {
	const ctx = openResolvedProject(project, GLOBAL(), { env: env() });
	try {
		return (await ctx.store.list()).map(task => task.title).sort();
	} finally {
		await ctx.dispose?.();
	}
};

beforeEach(async () => {
	sandbox = createSharedRegistrySandbox();
	fake = await FakeGitHub.start({ repo: 'acme/shop', searchLagRequests: 0 });
	const dir = sandbox.dir('shop');
	const added = await sandbox.register('shop', dir);
	project = resolveProject({ cwd: dir, projectRef: added.id, env: sandbox.env });
});

afterEach(async () => {
	await fake.stop();
	sandbox.cleanup();
});

describe('finalizeProjectMigration over a real project and the fake GitHub', () => {
	it('switches config.yml to the "new" block (other keys kept), backs the old one up, raises the summary event once, and the project reads from the new strategy alone', async () => {
		const tasks = await seedAndConfigure();
		const before = fs.readFileSync(configFile(), 'utf8');
		expect(await startAndRun()).toBe('ready-to-finalize');

		const result = await finalizeProjectMigration(input());

		expect(result).toMatchObject({ outcome: 'finished', moved: 3, madeInNew: 0, project: { id: project.id } });
		// config: the strategy is the github block as written, the rest of the file is as it was
		const config = parsedConfig();
		expect(config['strategy']).toMatchObject({
			type: 'github',
			options: { repo: fake.repo, fills: { meta: 'labels' } },
		});
		expect(config['statuses']).toEqual(TaskConfigLoader.parseConfigText(before, 'x')!['statuses']);
		expect(config['priorities']).toEqual(['high', 'low']);
		expect(JSON.stringify(config)).not.toContain('migrating');
		// the old config is kept, byte for byte
		expect(fs.readFileSync(`${configFile()}${BACKUP_SUFFIX}`, 'utf8')).toBe(before);
		// the event: the shape of `task migrate`'s summary
		expect(result.events).toHaveLength(1);
		expect(result.events[0]).toMatchObject({
			name: 'onTasksMigrated',
			payload: {
				fromProjectId: project.id,
				toProjectId: project.id,
				created: 3,
				resumed: 0,
				skipped: 0,
				failed: 0,
				remaining: 0,
				complete: true,
				taskProjectId: project.id,
			},
		});
		// the project, opened the normal way, shows the tasks from GitHub
		expect(await titlesOfProject()).toEqual(Object.values(tasks).sort());
		// the old ids are in the map, and the map is said loudly to be the only way to find them
		const map = JSON.parse(fs.readFileSync(result.idMap.file, 'utf8')) as Array<{ from: string; to: string }>;
		expect(map.map(entry => entry.from).sort()).toEqual(Object.keys(tasks).sort());
		expect(result.warnings.join(' ')).toMatch(/old id no longer resolves/);
		const ctx = openResolvedProject(project, GLOBAL(), { env: env() });
		const [oldId] = Object.keys(tasks);
		await expect(ctx.store.findByPrefix(oldId!)).rejects.toThrow(/not found|no task/i);
		await ctx.dispose?.();
	});

	it('finalizing again changes nothing, opens nothing, and raises no event', async () => {
		await seedAndConfigure();
		await startAndRun();
		await finalizeProjectMigration(input());
		const config = fs.readFileSync(configFile(), 'utf8');
		const requests = fake.requests.length;

		const again = await finalizeProjectMigration(input());

		expect(again).toMatchObject({ outcome: 'already-finished', events: [] });
		expect(fs.readFileSync(configFile(), 'utf8')).toBe(config);
		expect(fake.requests.length).toBe(requests);
	});

	it('refuses while the migration is not ready, with the fix, touching neither the config nor GitHub', async () => {
		await seedAndConfigure();
		await startOnly();
		const before = fs.readFileSync(configFile(), 'utf8');
		const requests = fake.requests.length;

		const error = await finalizeProjectMigration(input()).then(
			() => undefined,
			(caught: unknown) => caught
		);

		expect(error).toBeInstanceOf(BackendRejectedError);
		expect((error as BackendRejectedError).message).toMatch(/still running|still in "current"/);
		expect((error as BackendRejectedError).hint).toContain('task strategy migrate');
		expect(fs.readFileSync(configFile(), 'utf8')).toBe(before);
		expect(fake.requests.length).toBe(requests);
		expect(fs.existsSync(`${configFile()}${BACKUP_SUFFIX}`)).toBe(false);
	});

	it('refuses a config.yml.before-migration with other content (the rollback copy of an earlier switch), before any store is read', async () => {
		await seedAndConfigure();
		await startAndRun();
		fs.writeFileSync(`${configFile()}${BACKUP_SUFFIX}`, 'an older config\n');
		const before = fs.readFileSync(configFile(), 'utf8');
		const requests = fake.requests.length;

		const error = await finalizeProjectMigration(input()).then(
			() => undefined,
			(caught: unknown) => caught
		);

		expect((error as BackendRejectedError).message).toContain(`${configFile()}${BACKUP_SUFFIX}`);
		expect((error as BackendRejectedError).hint).toMatch(/rename/);
		expect(fs.readFileSync(configFile(), 'utf8')).toBe(before);
		expect(fake.requests.length).toBe(requests);
	});

	it('refuses a "new" block that is not a valid project section (a literal token), naming the file and the fix, writing nothing', async () => {
		await seedAndConfigure();
		await startAndRun();
		const bad = fs
			.readFileSync(configFile(), 'utf8')
			.replace(`tokenEnv: ${TOKEN_VARIABLE}`, 'tokenEnv: ghp_abcdefghijklmnopqrstuvwxyz0123456789');
		fs.writeFileSync(configFile(), bad);

		const error = await finalizeProjectMigration(input()).then(
			() => undefined,
			(caught: unknown) => caught
		);

		expect((error as Error).message).toContain(configFile());
		expect(fs.readFileSync(configFile(), 'utf8')).toBe(bad);
		expect(fs.existsSync(`${configFile()}${BACKUP_SUFFIX}`)).toBe(false);
	});

	it('a project that never started a migration: refused with the command that plans one', async () => {
		await seedAndConfigure();
		fs.writeFileSync(configFile(), STATUSES);

		const error = await finalizeProjectMigration(input()).then(
			() => undefined,
			(caught: unknown) => caught
		);

		expect((error as BackendRejectedError).message).toMatch(/no migration was started/);
		expect((error as BackendRejectedError).hint).toContain('task strategy migrate start --dry-run');
	});

	it('a config that is no longer migrating although the state says a migration is ready: refused, naming the strategy it has', async () => {
		await seedAndConfigure();
		await startAndRun();
		fs.writeFileSync(configFile(), STATUSES);

		const error = await finalizeProjectMigration(input()).then(
			() => undefined,
			(caught: unknown) => caught
		);

		expect((error as BackendRejectedError).message).toMatch(/"local", not a migrating one/);
		expect(fs.readFileSync(configFile(), 'utf8')).toBe(STATUSES);
	});

	it('a process that dies right after writing the config: the next run completes the bookkeeping, opens no store, raises the event', async () => {
		await seedAndConfigure();
		await startAndRun();
		const dying = (file: string, content: string): void => {
			writeFileAtomic(file, content);
			if (file === configFile()) throw new Error('injected fault: the process died after the config write');
		};

		await expect(finalizeProjectMigration(input({ writeFile: dying }))).rejects.toThrow(/died after/);

		// the config is the new one, the state is not finished: the status says so
		expect(parsedConfig()['strategy']).toMatchObject({ type: 'github' });
		const { control, input: controlInput } = controlOf();
		expect(control.status(controlInput)).toMatchObject({ status: 'ready-to-finalize' });
		expect(control.status(controlInput).problems.join(' ')).toMatch(/finalize was interrupted/);
		const requests = fake.requests.length;

		const result = await finalizeProjectMigration(input());

		expect(result).toMatchObject({ outcome: 'bookkeeping-completed' });
		expect(result.events).toHaveLength(1);
		expect(fake.requests.length).toBe(requests);
		expect(control.status(controlInput)).toMatchObject({ status: 'finished' });
		expect((await finalizeProjectMigration(input())).events).toEqual([]);
	});

	it('the config write fails (read-only folder): the old config stays, nothing is half written, a rerun works', async () => {
		await seedAndConfigure();
		await startAndRun();
		const before = fs.readFileSync(configFile(), 'utf8');
		const failing = (file: string, content: string): void => {
			if (file === configFile()) throw new Error('injected fault: the config cannot be written');
			writeFileAtomic(file, content);
		};

		await expect(finalizeProjectMigration(input({ writeFile: failing }))).rejects.toThrow(/cannot be written/);

		expect(fs.readFileSync(configFile(), 'utf8')).toBe(before);
		expect((await finalizeProjectMigration(input())).outcome).toBe('finished');
		expect(parsedConfig()['strategy']).toMatchObject({ type: 'github' });
	});
});

describe('abortProjectMigration over a real project and the fake GitHub', () => {
	const abortInput = (extra: Partial<Parameters<typeof abortProjectMigration>[0]> = {}) => ({
		...input(),
		keepMoved: false,
		sleep: () => Promise.resolve(),
		waitMs: 50,
		...extra,
	});

	it('with nothing moved: config.yml goes back to the "current" block, the migrating one is kept as config.yml.before-abort, the tasks are all there', async () => {
		const tasks = await seedAndConfigure();
		const before = fs.readFileSync(configFile(), 'utf8');
		await startOnly();

		const result = await abortProjectMigration(abortInput());

		expect(result).toMatchObject({ outcome: 'aborted', leftovers: [], moved: [], project: { id: project.id } });
		expect(parsedConfig()['strategy']).toEqual({ type: 'local' });
		expect(parsedConfig()['statuses']).toBeDefined();
		expect(fs.readFileSync(`${configFile()}${ABORT_BACKUP_SUFFIX}`, 'utf8')).toBe(before);
		expect(await titlesOfProject()).toEqual(Object.values(tasks).sort());
		expect(fake.writes()).toEqual([]);
		expect(controlOf().control.status(controlOf().input)).toMatchObject({ status: 'aborted' });
		// repeating it changes nothing
		expect((await abortProjectMigration(abortInput())).outcome).toBe('already-aborted');
	});

	it('with tasks already in "new": refused without --keep-moved, with it the copies stay in GitHub (nothing is closed or deleted) and the warning says they left the project', async () => {
		const tasks = await seedAndConfigure();
		await startAndRun();
		const before = fs.readFileSync(configFile(), 'utf8');

		const error = await abortProjectMigration(abortInput()).then(
			() => undefined,
			(caught: unknown) => caught
		);
		expect(error).toBeInstanceOf(BackendRejectedError);
		expect((error as BackendRejectedError).hint).toContain('--keep-moved');
		expect(fs.readFileSync(configFile(), 'utf8')).toBe(before);

		const writes = fake.writes().length;
		const result = await abortProjectMigration(abortInput({ keepMoved: true }));

		expect(result.moved.map(task => task.task).sort()).toEqual(Object.keys(tasks).sort());
		expect(result.warnings.join(' ')).toMatch(/older copy/);
		expect(parsedConfig()['strategy']).toEqual({ type: 'local' });
		// the project reads "current" again (the copies kept there at the move) and GitHub was not written to
		expect(await titlesOfProject()).toEqual(Object.values(tasks).sort());
		expect(fake.writes().length).toBe(writes);
	});

	it('a missing token or an unreachable server does not matter: abort opens no side', async () => {
		await seedAndConfigure();
		await startOnly();

		const result = await abortProjectMigration({
			...abortInput(),
			env: { ...sandbox.env },
		});

		expect(result.outcome).toBe('aborted');
	});

	it('refuses a config.yml.before-abort with other content', async () => {
		await seedAndConfigure();
		await startOnly();
		fs.writeFileSync(`${configFile()}${ABORT_BACKUP_SUFFIX}`, 'older\n');

		const error = await abortProjectMigration(abortInput()).then(
			() => undefined,
			(caught: unknown) => caught
		);

		expect((error as BackendRejectedError).message).toContain(`${configFile()}${ABORT_BACKUP_SUFFIX}`);
		expect(parsedConfig()['strategy']).toMatchObject({ type: 'migrating' });
	});

	it('a process that dies right after the config write: the rerun completes the bookkeeping', async () => {
		await seedAndConfigure();
		await startOnly();
		const dying = (file: string, content: string): void => {
			writeFileAtomic(file, content);
			if (file === configFile()) throw new Error('injected fault: the process died after the config write');
		};

		await expect(abortProjectMigration(abortInput({ writeFile: dying }))).rejects.toThrow(/died after/);
		expect(parsedConfig()['strategy']).toEqual({ type: 'local' });

		const result = await abortProjectMigration(abortInput());

		expect(result.outcome).toBe('bookkeeping-completed');
		expect(controlOf().control.status(controlOf().input)).toMatchObject({ status: 'aborted' });
	});
});
