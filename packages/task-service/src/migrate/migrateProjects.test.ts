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
import { migrateProjects } from './migrateProjects.js';
import type { MigrateProjectsInput } from './migrateProjects.js';
import { DEFAULT_MIGRATION_OPTIONS } from './migrateTypes.js';
import type { MigrationOptions } from './migrateTypes.js';

// task migrate over registered projects: the projects come from a registry, their own config chooses the backend (local files here,
// GitHub over the fake server there), the engine is the one tested in migrateRun.test.ts.
let sandbox: SharedRegistrySandbox;
let fake: FakeGitHub | undefined;
const TOKEN_VARIABLE = 'TASK_MIGRATE_TEST_TOKEN';

beforeEach(() => {
	sandbox = createSharedRegistrySandbox();
});

afterEach(async () => {
	await fake?.stop();
	fake = undefined;
	sandbox.cleanup();
});

function githubConfig(repo: string, extra = ''): string {
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

/** The statuses every project of these tests has (the default config has no terminal status, and a forge needs one to close an issue). */
const STATUSES_CONFIG = `statuses:
    - backlog
    - in-progress
    - { name: done, terminal: true }
`;

async function project(name: string, config = ''): Promise<ResolvedProject> {
	const dir = sandbox.dir(name);
	const added = await sandbox.register(name, dir);
	const resolved = resolveProject({ cwd: dir, projectRef: added.id, env: sandbox.env });
	fs.mkdirSync(path.dirname(ownConfigFile(resolved.storage)), { recursive: true });
	fs.writeFileSync(ownConfigFile(resolved.storage), STATUSES_CONFIG + config);
	return resolved;
}

function migrate(
	from: ResolvedProject,
	to: ResolvedProject,
	options: Partial<MigrationOptions> = {},
	extra: Partial<MigrateProjectsInput> = {}
) {
	return migrateProjects({
		from,
		to,
		options: { ...DEFAULT_MIGRATION_OPTIONS, ...options },
		resumeCommand: 'task migrate --resume',
		globalConfigDir: path.join(sandbox.root, 'global'),
		env: { ...sandbox.env, [TOKEN_VARIABLE]: fake?.token ?? '' },
		...extra,
	});
}

async function seedLocal(from: ResolvedProject): Promise<void> {
	const ctx = openResolvedProject(from, path.join(sandbox.root, 'global'));
	const epic = await ctx.store.create({ title: 'Epic', status: 'backlog' });
	const child = await ctx.store.create({ title: 'Child', status: 'backlog', parentId: epic.id });
	await ctx.store.addLabel(epic.id, 'planning');
	await ctx.store.updateStatus(child.id, 'in-progress');
	const shipped = await ctx.store.create({ title: 'Shipped', status: 'done' });
	await ctx.store.addLink(child.id, 'blockedBy', shipped.id);
	await ctx.store.addComment(epic.id, 'a note', { author: 'ann' });
	await ctx.dispose?.();
}

describe('migrateProjects: local to local, through the registry', () => {
	it('opens both projects from their registry entries, puts the journal in the target data folder, and raises the summary for the target', async () => {
		const from = await project('old');
		const to = await project('new');
		await seedLocal(from);

		const result = await migrate(from, to, { allowLoss: ['history'] });

		expect(result.status).toBe('completed');
		expect(result.from).toMatchObject({ id: from.id, name: 'old', kind: 'local' });
		expect(result.to).toMatchObject({ id: to.id, name: 'new', kind: 'local' });
		expect(result.journal).toBe(path.join(to.storage.dataDir, `migrate-journal-${from.id}-${to.id}.json`));
		expect(fs.existsSync(result.journal)).toBe(true);
		const ctx = openResolvedProject(to, path.join(sandbox.root, 'global'));
		expect((await ctx.store.list()).map(task => task.title).sort()).toEqual(['Child', 'Epic', 'Shipped']);
		await ctx.dispose?.();
		expect(result.events.map(event => event.name)).toEqual(['onTasksMigrated']);
		expect(result.events[0]!.payload).toMatchObject({
			toProjectId: to.id,
			taskProjectId: to.id,
			taskProjectPath: to.path,
			created: 3,
		});
	});

	it('a second run does nothing', async () => {
		const from = await project('old');
		const to = await project('new');
		await seedLocal(from);
		await migrate(from, to, { allowLoss: ['history'] });

		const again = await migrate(from, to, { allowLoss: ['history'] });

		expect(again.counts).toMatchObject({ created: 0, skipped: 3 });
	});

	it('refuses a project migrated into itself', async () => {
		const only = await project('only');

		await expect(migrate(only, only)).rejects.toThrow(MigrationRefusedError);
		await expect(migrate(only, only)).rejects.toThrow(/same project/);
	});

	it('reports a config problem of either project as the error it is, naming the file', async () => {
		const from = await project('old');
		const to = await project('new', 'strategy:\n    type: nonsense\n');

		await expect(migrate(from, to)).rejects.toThrow(/config\.yml/);
	});
});

describe('migrateProjects: local to GitHub and back, over the fake server', () => {
	it('creates the issues, parents, labels, comments and statuses, then does nothing the second time', async () => {
		fake = await FakeGitHub.start({ repo: 'acme/shop' });
		const from = await project('old');
		const to = await project('shop', githubConfig('acme/shop'));
		await seedLocal(from);

		const dry = await migrate(from, to, { dryRun: true });
		expect(dry.blocking).toEqual(['history', 'created-at', 'marker']);
		expect(fake.writes()).toEqual([]);
		expect(dry.estimate.requests).toBeGreaterThan(0);

		const result = await migrate(from, to, { allowLoss: ['history', 'created-at', 'marker'] });

		expect(result.status).toBe('completed');
		expect(result.verification!.mismatches).toEqual([]);
		const all = [...fake.issues.values()];
		expect(all.map(issue => issue.title).sort()).toEqual(['Child', 'Epic', 'Shipped']);
		const [epic, child, shipped] = ['Epic', 'Child', 'Shipped'].map(title =>
			all.find(issue => issue.title === title)!
		);
		expect(child!.parent).toBe(epic!.number);
		expect(epic!.labels).toContain('planning');
		expect(child!.labels).toContain('status:in-progress');
		expect(shipped!.state).toBe('closed');
		expect(child!.blockedBy).toEqual([shipped!.number]);
		// GitHub writes the author itself (the token user), so the original author is in the first line.
		expect(epic!.comments[0]!.body).toMatch(/^Originally posted \S+ by ann \[migrated from /);
		expect(epic!.comments[0]!.body.endsWith('a note')).toBe(true);

		const writes = fake.writes().length;
		const again = await migrate(from, to, { allowLoss: ['history', 'created-at', 'marker'] });
		expect(again.counts).toMatchObject({ created: 0, skipped: 3 });
		expect(fake.writes().length).toBe(writes);
	});

	it('GitHub to local: the issues become tasks, the author of a comment is kept, the creation instant too', async () => {
		fake = await FakeGitHub.start({ repo: 'acme/shop' });
		fake.addIssue({ title: 'Alpha', body: 'The body', labels: ['billing'] });
		fake.addIssue({ title: 'Beta' });
		fake.addIssue({ title: 'Gamma', state: 'closed' });
		fake.setParent(2, 1);
		fake.addBlockedBy(3, 2);
		fake.addComment(2, 'from the forge', 'ann');
		const from = await project('shop', githubConfig('acme/shop'));
		const to = await project('local');

		const result = await migrate(from, to, { allowLoss: ['all'] });

		expect(result.status).toBe('completed');
		const ctx = openResolvedProject(to, path.join(sandbox.root, 'global'));
		const tasks = await Promise.all((await ctx.store.list()).map(summary => ctx.store.get(summary.id)));
		const byTitle = new Map(tasks.map(task => [task.title, task]));
		expect(byTitle.get('Alpha')).toMatchObject({ description: 'The body', labels: ['billing'], status: 'backlog' });
		expect(byTitle.get('Beta')!.parentId).toBe(byTitle.get('Alpha')!.id);
		expect(byTitle.get('Gamma')).toMatchObject({ status: 'done' });
		expect(byTitle.get('Gamma')!.links).toEqual([{ type: 'blockedBy', target: byTitle.get('Beta')!.id }]);
		expect(byTitle.get('Beta')!.comments![0]).toMatchObject({ author: 'ann' });
		expect(byTitle.get('Beta')!.comments![0]!.text).toMatch(/^Originally posted /);
		expect(byTitle.get('Alpha')!.createdAt).toBe(new Date(fake.issues.get(1)!.createdAt).toISOString());
		expect(byTitle.get('Alpha')!.meta).toEqual({ migratedFrom: `${from.id}/1` });
		await ctx.dispose?.();
	});

	it('reads the source fresh, whatever its cache setting says', async () => {
		fake = await FakeGitHub.start({ repo: 'acme/shop' });
		fake.addIssue({ title: 'Before' });
		const from = await project('shop', githubConfig('acme/shop', 'cache: { ttlSeconds: 3600 }'));
		const to = await project('local');
		// An earlier command filled the cache of the source: inside the hour, an ordinary read does not ask GitHub again.
		const warm = openResolvedProject(from, path.join(sandbox.root, 'global'), {
			env: { ...sandbox.env, [TOKEN_VARIABLE]: fake.token },
		});
		expect((await warm.store.list()).map(task => task.title)).toEqual(['Before']);
		await warm.dispose?.();
		fake.updateIssue(1, { title: 'After' });

		await migrate(from, to, { allowLoss: ['all'] });

		const ctx = openResolvedProject(to, path.join(sandbox.root, 'global'));
		expect((await ctx.store.list()).map(task => task.title)).toEqual(['After']);
		await ctx.dispose?.();
	});

	it('refuses two projects that are the same repository', async () => {
		fake = await FakeGitHub.start({ repo: 'acme/shop' });
		const from = await project('one', githubConfig('acme/shop'));
		const to = await project('two', githubConfig('acme/shop'));

		const error = await migrate(from, to).catch((caught: unknown) => caught);

		expect(error).toBeInstanceOf(MigrationRefusedError);
		expect((error as Error).message).toMatch(/same repository/);
		expect(fake.writes()).toEqual([]);
	});
});
