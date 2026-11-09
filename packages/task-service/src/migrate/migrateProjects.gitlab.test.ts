import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FakeGitLab } from '../plugins/gitlab/fakeGitLab.testkit.js';
import type { FakeTier } from '../plugins/gitlab/fakeGitLab.testkit.js';
import { openResolvedProject } from '../openContext.js';
import { resolveProject } from '../resolveProject.js';
import type { ResolvedProject } from '../resolveProject.js';
import { ownConfigFile } from '../storage.js';
import { createSharedRegistrySandbox } from '../testHelpers.js';
import type { SharedRegistrySandbox } from '../testHelpers.js';
import { migrateProjects } from './migrateProjects.js';
import { DEFAULT_MIGRATION_OPTIONS } from './migrateTypes.js';
import type { MigrationOptions } from './migrateTypes.js';

// task migrate between a local project and a gitlab one, over the fake server, per tier. NOT verified against a real GitLab.
let sandbox: SharedRegistrySandbox;
let fake: FakeGitLab | undefined;
const TOKEN_VARIABLE = 'TASK_MIGRATE_GITLAB_TEST_TOKEN';

beforeEach(() => {
	sandbox = createSharedRegistrySandbox();
});

afterEach(async () => {
	await fake?.stop();
	fake = undefined;
	sandbox.cleanup();
});

function gitlabConfig(tier: FakeTier): string {
	const sep = tier === 'free' ? ':' : '::';
	return `strategy:
    type: gitlab
    options:
        project: ${fake!.project}
        tier: ${tier}
        baseUrl: ${fake!.baseUrl}
        tokenEnv: ${TOKEN_VARIABLE}
        writeSpacingSeconds: 0
        timeoutSeconds: 3
        statusMap:
            backlog: { state: open }
            in-progress: { state: open, label: 'status${sep}in-progress' }
            done: { state: closed }
        fills:
            meta: labels
`;
}

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

function migrate(from: ResolvedProject, to: ResolvedProject, options: Partial<MigrationOptions> = {}) {
	return migrateProjects({
		from,
		to,
		options: { ...DEFAULT_MIGRATION_OPTIONS, ...options },
		resumeCommand: 'task migrate --resume',
		globalConfigDir: path.join(sandbox.root, 'global'),
		env: { ...sandbox.env, [TOKEN_VARIABLE]: fake?.token ?? '' },
	});
}

async function seedLocal(from: ResolvedProject): Promise<void> {
	const ctx = openResolvedProject(from, path.join(sandbox.root, 'global'));
	const epic = await ctx.store.create({ title: 'Epic', status: 'backlog' });
	const child = await ctx.store.create({ title: 'Child', status: 'backlog', parentId: epic.id });
	await ctx.store.addLabel(epic.id, 'planning');
	await ctx.store.setMeta(epic.id, 'owner', 'ann');
	await ctx.store.updateStatus(child.id, 'in-progress');
	const shipped = await ctx.store.create({ title: 'Shipped', status: 'done' });
	await ctx.store.addLink(child.id, 'blockedBy', shipped.id);
	await ctx.store.addComment(epic.id, 'a note', { author: 'ann' });
	await ctx.dispose?.();
}

describe.each<FakeTier>(['free', 'premium'])('migrate local -> gitlab -> local, tier %s', tier => {
	const lossesOf = (): MigrationOptions['allowLoss'] =>
		[
			'history',
			'created-at',
			'hierarchy:unsupported',
			...(tier === 'free' ? ['links:blockedBy'] : []),
		] as MigrationOptions['allowLoss'];

	it('the plan names every loss of this tier, and a dry run writes nothing', async () => {
		fake = await FakeGitLab.start({ project: 'acme/shop', tier });
		const from = await project('old');
		const to = await project('shop', gitlabConfig(tier));
		await seedLocal(from);

		const dry = await migrate(from, to, { dryRun: true });

		// Hierarchy has no GitLab equivalent on any tier; blocking links exist on premium and ultimate only.
		expect(dry.blocking).toContain('hierarchy:unsupported');
		expect(dry.blocking.includes('links:blockedBy')).toBe(tier === 'free');
		expect(fake.writes()).toEqual([]);
	});

	it('creates the issues with status, labels, meta and comments, drops the parent, then does nothing the second time', async () => {
		fake = await FakeGitLab.start({ project: 'acme/shop', tier });
		const from = await project('old');
		const to = await project('shop', gitlabConfig(tier));
		await seedLocal(from);

		const result = await migrate(from, to, { allowLoss: lossesOf() });

		expect(result.status).toBe('completed');
		expect(result.verification!.mismatches).toEqual([]);
		const issues = [1, 2, 3].map(iid => fake!.issue(iid)!);
		expect(issues.map(issue => issue.title).sort()).toEqual(['Child', 'Epic', 'Shipped']);
		const byTitle = new Map(issues.map(issue => [issue.title, issue]));
		expect(byTitle.get('Epic')!.labels).toContain('planning');
		expect(byTitle.get('Child')!.labels).toContain(`status${tier === 'free' ? ':' : '::'}in-progress`);
		expect(byTitle.get('Shipped')!.state).toBe('closed');
		expect(fake.notes(byTitle.get('Epic')!.iid)[0]!.body).toMatch(/^Originally posted \S+ by ann \[migrated from /);
		const childLinks = fake.links(byTitle.get('Child')!.iid);
		if (tier === 'free') expect(childLinks).toEqual([]);
		else expect(childLinks).toEqual([{ iid: byTitle.get('Shipped')!.iid, type: 'is_blocked_by' }]);

		const writes = fake.writes().length;
		const again = await migrate(from, to, { allowLoss: lossesOf() });
		expect(again.counts).toMatchObject({ created: 0, skipped: 3 });
		expect(fake.writes().length).toBe(writes);
	});

	it('gitlab to local: the issues become tasks, comments and links come back', async () => {
		fake = await FakeGitLab.start({ project: 'acme/shop', tier });
		const sep = tier === 'free' ? ':' : '::';
		const alpha = fake.seedIssue({ title: 'Alpha', description: 'The body', labels: ['billing'] });
		const beta = fake.seedIssue({ title: 'Beta', labels: [`status${sep}in-progress`] });
		const gamma = fake.seedIssue({ title: 'Gamma', state: 'closed' });
		if (tier !== 'free') fake.seedLink(gamma, beta, 'is_blocked_by');
		fake.seedNote(beta, 'from the forge', 'ann');
		const from = await project('shop', gitlabConfig(tier));
		const to = await project('local');

		const result = await migrate(from, to, { allowLoss: ['all'] });

		expect(result.status).toBe('completed');
		const ctx = openResolvedProject(to, path.join(sandbox.root, 'global'));
		const tasks = await Promise.all((await ctx.store.list()).map(summary => ctx.store.get(summary.id)));
		const byTitle = new Map(tasks.map(task => [task.title, task]));
		expect(byTitle.get('Alpha')).toMatchObject({ description: 'The body', labels: ['billing'], status: 'backlog' });
		expect(byTitle.get('Beta')).toMatchObject({ status: 'in-progress' });
		expect(byTitle.get('Gamma')).toMatchObject({ status: 'done' });
		if (tier !== 'free') {
			expect(byTitle.get('Gamma')!.links).toEqual([{ type: 'blockedBy', target: byTitle.get('Beta')!.id }]);
		}
		expect(byTitle.get('Beta')!.comments![0]).toMatchObject({ author: 'ann' });
		expect(byTitle.get('Alpha')!.meta).toEqual({ migratedFrom: `${from.id}/${alpha}` });
		await ctx.dispose?.();
	});
});
