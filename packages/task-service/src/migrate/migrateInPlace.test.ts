import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FakeGitHub } from '../plugins/github/fakeGitHub.testkit.js';
import { openResolvedProject } from '../openContext.js';
import { resolveProject } from '../resolveProject.js';
import type { ResolvedProject } from '../resolveProject.js';
import { ownConfigFile } from '../storage.js';
import { createSharedRegistrySandbox } from '../testHelpers.js';
import type { SharedRegistrySandbox } from '../testHelpers.js';
import { MigrationRefusedError } from './migrateErrors.js';
import { BACKUP_SUFFIX, migrateInPlace } from './migrateInPlace.js';
import type { MigrateInPlaceInput } from './migrateInPlace.js';
import { DEFAULT_MIGRATION_OPTIONS } from './migrateTypes.js';
import type { MigrationOptions } from './migrateTypes.js';

// `task migrate --in-place`: one registered project changes storage. Local files -> the fake GitHub, the engine is the one tested in
// migrateRun.test.ts; what is tested here is what in-place adds: the draft, the id map, the journal of one project, the switch.
let sandbox: SharedRegistrySandbox;
let fake: FakeGitHub | undefined;
const TOKEN_VARIABLE = 'TASK_INPLACE_TEST_TOKEN';
const ALLOW = ['history', 'created-at', 'marker'];

beforeEach(() => {
	sandbox = createSharedRegistrySandbox();
});

afterEach(async () => {
	await fake?.stop();
	fake = undefined;
	sandbox.cleanup();
});

const STATUSES_CONFIG = `statuses:
    - backlog
    - in-progress
    - { name: done, terminal: true }
`;

function githubStrategy(repo: string, extra = ''): string {
	return `strategy:
    type: github
    options:
        repo: ${repo}
        baseUrl: ${fake!.baseUrl}
        tokenEnv: ${TOKEN_VARIABLE}
        writeSpacingSeconds: 0
        timeoutSeconds: 3
        ${extra}
        statusMap:
            backlog: { state: open }
            in-progress: { state: open, label: 'status:in-progress' }
            done: { state: closed }
`;
}

const OLD_CONFIG = STATUSES_CONFIG;

async function localProject(name: string, config = OLD_CONFIG): Promise<ResolvedProject> {
	const dir = sandbox.dir(name);
	const added = await sandbox.register(name, dir);
	const resolved = resolveProject({ cwd: dir, projectRef: added.id, env: sandbox.env });
	fs.mkdirSync(path.dirname(ownConfigFile(resolved.storage)), { recursive: true });
	fs.writeFileSync(ownConfigFile(resolved.storage), config);
	return resolved;
}

function draft(content: string, name = 'draft.yml'): string {
	const file = path.join(sandbox.root, 'drafts', name);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content);
	return file;
}

function githubDraft(extra = ''): string {
	return draft(STATUSES_CONFIG + githubStrategy('acme/shop', extra));
}

const GLOBAL = (): string => path.join(sandbox.root, 'global');

function migrate(
	project: ResolvedProject,
	draftFile: string,
	options: Partial<MigrationOptions> = {},
	extra: Partial<MigrateInPlaceInput> = {}
) {
	return migrateInPlace({
		project,
		draftFile,
		options: { ...DEFAULT_MIGRATION_OPTIONS, ...options },
		resumeCommand: 'task migrate --in-place --to-config draft.yml --resume',
		globalConfigDir: GLOBAL(),
		env: { ...sandbox.env, [TOKEN_VARIABLE]: fake?.token ?? '' },
		...extra,
	});
}

async function seed(project: ResolvedProject): Promise<Record<string, string>> {
	const ctx = openResolvedProject(project, GLOBAL());
	const epic = await ctx.store.create({ title: 'Epic', status: 'backlog' });
	const child = await ctx.store.create({ title: 'Child', status: 'backlog', parentId: epic.id });
	await ctx.store.addLabel(epic.id, 'planning');
	await ctx.store.updateStatus(child.id, 'in-progress');
	const shipped = await ctx.store.create({ title: 'Shipped', status: 'done' });
	await ctx.store.addLink(child.id, 'blockedBy', shipped.id);
	await ctx.store.addComment(epic.id, 'a note', { author: 'ann' });
	await ctx.dispose?.();
	return { Epic: epic.id, Child: child.id, Shipped: shipped.id };
}

function readIdMap(file: string): Array<{ from: string; to: string }> {
	return JSON.parse(fs.readFileSync(file, 'utf8')) as Array<{ from: string; to: string }>;
}

/** Every file under the data and config folders of a project (but the read cache of the target, an internal detail), to prove a run wrote nothing. */
function snapshot(project: ResolvedProject): Record<string, string> {
	const found: Record<string, string> = {};
	const walk = (dir: string): void => {
		if (!fs.existsSync(dir)) return;
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				if (entry.name !== 'cache') walk(full);
			} else found[full] = fs.readFileSync(full, 'utf8');
		}
	};
	walk(project.storage.dataDir);
	walk(path.dirname(ownConfigFile(project.storage)));
	return found;
}

describe('migrateInPlace: local project to GitHub, over the fake server', () => {
	it('moves the tasks, keeps the project, saves the id map, then switches config.yml and keeps the old one', async () => {
		fake = await FakeGitHub.start({ repo: 'acme/shop' });
		const project = await localProject('shop');
		const ids = await seed(project);
		const draftFile = githubDraft();
		const draftText = fs.readFileSync(draftFile, 'utf8');

		const result = await migrate(project, draftFile, { allowLoss: ALLOW });

		expect(result.status).toBe('completed');
		expect(result.from).toMatchObject({ id: project.id, name: 'shop', kind: 'local' });
		expect(result.to).toMatchObject({ id: project.id, name: 'shop', kind: 'github' });
		expect(result.verification!.mismatches).toEqual([]);
		// The switch: the draft is the config now, the old one is kept next to it.
		const config = ownConfigFile(project.storage);
		expect(fs.readFileSync(config, 'utf8')).toBe(draftText);
		expect(fs.readFileSync(`${config}${BACKUP_SUFFIX}`, 'utf8')).toBe(OLD_CONFIG);
		expect(result.inPlace).toMatchObject({
			switched: true,
			config,
			backup: `${config}${BACKUP_SUFFIX}`,
			draft: draftFile,
		});
		expect(result.inPlace!.rollback).toContain('NOT deleted');
		// The id map: one {from, to} per task, in the file and in the result, the journal is the in-place one.
		const idMapFile = path.join(project.storage.dataDir, `migrate-idmap-${project.id}.json`);
		expect(result.inPlace!.idMapFile).toBe(idMapFile);
		const map = readIdMap(idMapFile);
		expect(map.map(entry => entry.from).sort()).toEqual(Object.values(ids).sort());
		expect(result.idMap).toEqual(map.map(entry => ({ source: entry.from, target: entry.to })));
		expect(result.journal).toBe(path.join(project.storage.dataDir, `migrate-journal-${project.id}-inplace.json`));
		expect(JSON.parse(fs.readFileSync(result.journal, 'utf8'))).toMatchObject({
			status: 'completed',
			inPlace: { switched: true },
		});
		// What GitHub holds, through the map: the parent and the blockedBy link follow the new ids.
		const numberOf = (title: string): number =>
			[...fake!.issues.values()].find(issue => issue.title === title)!.number;
		const target = (title: string): string => map.find(entry => entry.from === ids[title])!.to;
		expect(target('Epic')).toBe(String(numberOf('Epic')));
		expect(fake.issues.get(numberOf('Child'))!.parent).toBe(numberOf('Epic'));
		expect(fake.issues.get(numberOf('Child'))!.blockedBy).toEqual([numberOf('Shipped')]);
		// The project, opened again, reads GitHub; the local files are still there.
		const after = openResolvedProject(project, GLOBAL(), {
			env: { ...sandbox.env, [TOKEN_VARIABLE]: fake.token },
		});
		expect(after.store.kind).toBe('github');
		expect((await after.store.list()).map(task => task.title).sort()).toEqual(['Child', 'Epic', 'Shipped']);
		await after.dispose?.();
		expect(fs.existsSync(path.join(project.storage.dataDir, 'tasks'))).toBe(true);
		// Events: the summary only, for the same project on both sides, after the switch.
		expect(result.events.map(event => event.name)).toEqual(['onTasksMigrated']);
		expect(result.events[0]!.payload).toMatchObject({
			fromProjectId: project.id,
			toProjectId: project.id,
			created: 3,
			complete: true,
		});
	});

	it('a dry run writes nothing (no journal, lock, id map, backup, config, request) and prints the strategy checks', async () => {
		fake = await FakeGitHub.start({ repo: 'acme/shop' });
		const project = await localProject('shop');
		await seed(project);
		const before = snapshot(project);

		const result = await migrate(project, githubDraft(), { dryRun: true });

		expect(result.status).toBe('dry-run');
		expect(result.blocking).toEqual(['history', 'created-at', 'marker']);
		expect(result.counts).toMatchObject({ source: 3, created: 3 });
		expect(result.inPlace).toMatchObject({ switched: false });
		expect(result.inPlace!.checks!.map(line => line.name)).toEqual(
			expect.arrayContaining(['config', 'strategy', 'token'])
		);
		expect(result.inPlace!.checks!.some(line => line.name === 'reachable' && line.status === 'ok')).toBe(true);
		expect(snapshot(project)).toEqual(before);
		expect(fake.writes()).toEqual([]);
		expect(fs.existsSync(path.join(project.storage.dataDir, 'migrate.lock'))).toBe(false);
	});

	it('a dry run with a token that is not set stops with the check that says so, the plan cannot read the target', async () => {
		fake = await FakeGitHub.start({ repo: 'acme/shop' });
		const project = await localProject('shop');
		await seed(project);

		const error = await migrate(project, githubDraft(), { dryRun: true }, { env: { ...sandbox.env } }).catch(
			(caught: unknown) => caught
		);

		expect(error).toBeInstanceOf(MigrationRefusedError);
		expect((error as Error).message).toContain(TOKEN_VARIABLE);
		expect((error as MigrationRefusedError).hint).toContain('export');
	});

	it('is blocked by a loss: nothing is written, config.yml is untouched', async () => {
		fake = await FakeGitHub.start({ repo: 'acme/shop' });
		const project = await localProject('shop');
		await seed(project);
		const before = snapshot(project);

		const result = await migrate(project, githubDraft());

		expect(result.status).toBe('blocked');
		expect(result.inPlace!.switched).toBe(false);
		expect(snapshot(project)).toEqual(before);
		expect(fake.writes()).toEqual([]);
	});

	it('a draft that drops a status the tasks use is a blocking loss, said before anything is written', async () => {
		fake = await FakeGitHub.start({ repo: 'acme/shop' });
		const project = await localProject('shop');
		await seed(project);
		const narrow = draft(`statuses:
    - backlog
    - { name: done, terminal: true }
strategy:
    type: github
    options:
        repo: acme/shop
        baseUrl: ${fake.baseUrl}
        tokenEnv: ${TOKEN_VARIABLE}
        statusMap:
            backlog: { state: open }
            done: { state: closed }
`);

		const result = await migrate(project, narrow, { allowLoss: ['history', 'created-at', 'marker'] });

		expect(result.status).toBe('blocked');
		expect(result.blocking).toContain('status');
		expect(result.losses.find(row => row.kind === 'status')!.taskIds).toHaveLength(1);
		expect(fs.readFileSync(ownConfigFile(project.storage), 'utf8')).toBe(OLD_CONFIG);
		expect(fake.writes()).toEqual([]);
	});

	it('a failure midway leaves config.yml alone; --resume continues, creates nothing twice and then switches', async () => {
		fake = await FakeGitHub.start({ repo: 'acme/shop' });
		const project = await localProject('shop');
		await seed(project);
		const draftFile = githubDraft();
		fake.failNext({
			status: 422,
			method: 'POST',
			pathPrefix: '/repos/acme/shop/issues',
			skip: 1,
			body: { message: 'Validation Failed' },
		});

		const first = await migrate(project, draftFile, { allowLoss: ALLOW });

		expect(first.status).toBe('failed');
		expect(first.inPlace!.switched).toBe(false);
		expect(first.resumeCommand).toBe('task migrate --in-place --to-config draft.yml --resume');
		expect(fs.readFileSync(ownConfigFile(project.storage), 'utf8')).toBe(OLD_CONFIG);
		expect(fs.existsSync(`${ownConfigFile(project.storage)}${BACKUP_SUFFIX}`)).toBe(false);
		// The id map holds what was created so far, saved as it went.
		const partial = readIdMap(first.inPlace!.idMapFile);
		expect(partial).toHaveLength(1);
		expect(fake.issues.size).toBe(1);
		// Without --resume the unfinished journal is refused.
		await expect(migrate(project, draftFile, { allowLoss: ALLOW })).rejects.toThrow(/did not finish/);

		const second = await migrate(project, draftFile, { allowLoss: ALLOW, resume: true });

		expect(second.status).toBe('completed');
		expect(second.counts).toMatchObject({ created: 2, resumed: 1 });
		expect(fake.issues.size).toBe(3);
		expect(readIdMap(second.inPlace!.idMapFile)).toHaveLength(3);
		expect(readIdMap(second.inPlace!.idMapFile)[0]).toEqual(partial[0]);
		expect(fs.readFileSync(ownConfigFile(project.storage), 'utf8')).toBe(fs.readFileSync(draftFile, 'utf8'));
	});

	it('switches only after every task is written and read back, with the id map saved', async () => {
		fake = await FakeGitHub.start({ repo: 'acme/shop' });
		const project = await localProject('shop');
		await seed(project);
		const config = ownConfigFile(project.storage);
		const seen: Array<{ file: string; issues: number; mapped: number; configNow: string }> = [];

		await migrate(
			project,
			githubDraft(),
			{ allowLoss: ALLOW },
			{
				writeFile: (file, content) => {
					seen.push({
						file,
						issues: fake!.issues.size,
						mapped: readIdMap(path.join(project.storage.dataDir, `migrate-idmap-${project.id}.json`))
							.length,
						configNow: fs.readFileSync(config, 'utf8'),
					});
					fs.writeFileSync(file, content);
				},
			}
		);

		// The backup first, then the new config, both after the three issues exist and the map holds them.
		expect(seen.map(call => call.file)).toEqual([`${config}${BACKUP_SUFFIX}`, config]);
		for (const call of seen) {
			expect(call).toMatchObject({ issues: 3, mapped: 3, configNow: OLD_CONFIG });
		}
	});

	it('a switch that fails says so, leaves config.yml, and --resume only performs the switch', async () => {
		fake = await FakeGitHub.start({ repo: 'acme/shop' });
		const project = await localProject('shop');
		await seed(project);
		const draftFile = githubDraft();
		const config = ownConfigFile(project.storage);

		const first = await migrate(
			project,
			draftFile,
			{ allowLoss: ALLOW },
			{
				writeFile: (file, content) => {
					if (file === config) throw new Error('disk full');
					fs.writeFileSync(file, content);
				},
			}
		);

		expect(first.status).toBe('failed');
		expect(first.failure).toMatchObject({ step: 'switch', message: expect.stringContaining('disk full') });
		expect(first.counts).toMatchObject({ created: 3, failed: 0, remaining: 0 });
		expect(first.inPlace!.switched).toBe(false);
		expect(first.resumeCommand).toContain('--resume');
		expect(fs.readFileSync(config, 'utf8')).toBe(OLD_CONFIG);
		const created = fake.writes().length;

		// The backup of the failed attempt holds the very config still in place: it does not stand in the way.
		const second = await migrate(project, draftFile, { allowLoss: ALLOW, resume: true });

		expect(second.status).toBe('completed');
		expect(second.inPlace!.switched).toBe(true);
		expect(second.counts).toMatchObject({ created: 0, skipped: 3 });
		expect(fake.writes().length).toBe(created);
		expect(fake.issues.size).toBe(3);
		expect(fs.readFileSync(config, 'utf8')).toBe(fs.readFileSync(draftFile, 'utf8'));
		expect(fs.readFileSync(`${config}${BACKUP_SUFFIX}`, 'utf8')).toBe(OLD_CONFIG);
		expect(second.events.map(event => event.name)).toEqual(['onTasksMigrated']);
	});

	it('refuses to start when config.yml.before-migration exists, in a dry run too, before anything is written', async () => {
		fake = await FakeGitHub.start({ repo: 'acme/shop' });
		const project = await localProject('shop');
		await seed(project);
		const backup = `${ownConfigFile(project.storage)}${BACKUP_SUFFIX}`;
		fs.writeFileSync(backup, 'statuses: [other]\n');
		const before = snapshot(project);

		for (const dryRun of [true, false]) {
			const error = await migrate(project, githubDraft(), { allowLoss: ALLOW, dryRun }).catch(
				(caught: unknown) => caught
			);
			expect(error).toBeInstanceOf(MigrationRefusedError);
			expect((error as Error).message).toContain(backup);
			expect((error as MigrationRefusedError).hint).toMatch(/rename|delete/);
		}
		expect(snapshot(project)).toEqual(before);
		expect(fake.writes()).toEqual([]);
	});

	it('refuses to resume with another draft', async () => {
		fake = await FakeGitHub.start({ repo: 'acme/shop' });
		const project = await localProject('shop');
		await seed(project);
		fake.failNext({
			status: 422,
			method: 'POST',
			pathPrefix: '/repos/acme/shop/issues',
			skip: 1,
			body: { message: 'no' },
		});
		await migrate(project, githubDraft(), { allowLoss: ALLOW });

		const other = draft(STATUSES_CONFIG + githubStrategy('acme/shop', "typePrefix: 'kind:'"), 'other.yml');
		const error = await migrate(project, other, { allowLoss: ALLOW, resume: true }).catch(
			(caught: unknown) => caught
		);

		expect(error).toBeInstanceOf(MigrationRefusedError);
		expect((error as Error).message).toMatch(/draft changed .*options.typePrefix/);
		expect((error as MigrationRefusedError).hint).toContain('--accept-draft-change');
		expect(fs.readFileSync(ownConfigFile(project.storage), 'utf8')).toBe(OLD_CONFIG);
	});

	it('writes the --emit-events per-task events and the summary, in that order', async () => {
		fake = await FakeGitHub.start({ repo: 'acme/shop' });
		const project = await localProject('shop');
		await seed(project);

		const result = await migrate(project, githubDraft(), { allowLoss: ALLOW, emitEvents: true });

		const names = result.events.map(event => event.name);
		expect(names[0]).toBe('onTaskCreated');
		expect(names.at(-1)).toBe('onTasksMigrated');
		expect(names.filter(name => name === 'onTasksMigrated')).toHaveLength(1);
	});
});

describe('migrateInPlace: what is refused', () => {
	it('a draft that is still local is the same storage', async () => {
		const project = await localProject('shop');
		const same = draft(`${STATUSES_CONFIG}strategy:\n    type: local\n`);

		const error = await migrate(project, same).catch((caught: unknown) => caught);

		expect(error).toBeInstanceOf(MigrationRefusedError);
		expect((error as Error).message).toMatch(/same storage/);
	});

	it('a draft that points to the repository the project already uses is the same storage', async () => {
		fake = await FakeGitHub.start({ repo: 'acme/shop' });
		const project = await localProject('shop', STATUSES_CONFIG + githubStrategy('acme/shop'));

		const error = await migrate(project, githubDraft('pageSize: 50')).catch((caught: unknown) => caught);

		expect(error).toBeInstanceOf(MigrationRefusedError);
		expect((error as Error).message).toMatch(/already are in .*acme\/shop/);
		expect(fake.writes()).toEqual([]);
	});

	it('a draft with a literal token is refused with the existing hint, naming the draft file', async () => {
		const project = await localProject('shop');
		const leaky = draft(`${STATUSES_CONFIG}strategy:
    type: github
    options:
        repo: acme/shop
        token: ghp_abcdefghijklmnopqrstuvwxyz0123456789
`);

		const error = await migrate(project, leaky).catch((caught: unknown) => caught);

		expect((error as Error).message).toContain(leaky);
		expect((error as Error & { hint?: string }).hint).toMatch(/tokenEnv/);
		expect(fs.readFileSync(ownConfigFile(project.storage), 'utf8')).toBe(OLD_CONFIG);
	});

	it('a draft without a strategy section, or missing, is refused with what to write', async () => {
		const project = await localProject('shop');

		const bare = await migrate(project, draft(STATUSES_CONFIG)).catch((caught: unknown) => caught);
		const missing = await migrate(project, path.join(sandbox.root, 'nope.yml')).catch((caught: unknown) => caught);

		expect(bare).toBeInstanceOf(MigrationRefusedError);
		expect((bare as Error).message).toMatch(/no strategy section/);
		expect(missing).toBeInstanceOf(MigrationRefusedError);
		expect((missing as Error).message).toMatch(/does not exist/);
	});

	it('a draft with an invalid key names the draft file, not the project config', async () => {
		const project = await localProject('shop');
		const bad = draft(`${STATUSES_CONFIG}nonsense: 1\nstrategy: { type: local }\n`);

		const error = await migrate(project, bad).catch((caught: unknown) => caught);

		expect((error as Error).message).toContain(bad);
	});

	it('an already switched project says so', async () => {
		fake = await FakeGitHub.start({ repo: 'acme/shop' });
		const project = await localProject('shop');
		await seed(project);
		const draftFile = githubDraft();
		await migrate(project, draftFile, { allowLoss: ALLOW });

		const error = await migrate(project, draftFile, { allowLoss: ALLOW }).catch((caught: unknown) => caught);

		expect(error).toBeInstanceOf(MigrationRefusedError);
		expect((error as Error).message).toMatch(/already is the draft/);
	});
});
