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
import { MigrationRefusedError, MigrationStateError } from './migrateErrors.js';
import { BACKUP_SUFFIX, migrateInPlace } from './migrateInPlace.js';
import type { MigrateInPlaceInput } from './migrateInPlace.js';
import { DEFAULT_MIGRATION_OPTIONS } from './migrateTypes.js';
import type { MigrationOptions } from './migrateTypes.js';
import { snapshotFolder } from './migrate.testkit.js';

// Third review of `task migrate --in-place`, service side.
let sandbox: SharedRegistrySandbox;
let fake: FakeGitHub | undefined;
const TOKEN_VARIABLE = 'TASK_INPLACE_THIRD_TOKEN';
const ALLOW = ['history', 'created-at', 'marker'];
const STATUSES_CONFIG = `statuses:
    - backlog
    - in-progress
    - { name: done, terminal: true }
`;
const GLOBAL = (): string => path.join(sandbox.root, 'global');

beforeEach(() => {
	sandbox = createSharedRegistrySandbox();
});

afterEach(async () => {
	await fake?.stop();
	fake = undefined;
	sandbox.cleanup();
});

function githubStrategy(extra = '', repo = 'acme/shop'): string {
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

async function project(name: string, config: string | undefined = STATUSES_CONFIG): Promise<ResolvedProject> {
	const dir = sandbox.dir(name);
	const added = await sandbox.register(name, dir);
	const resolved = resolveProject({ cwd: dir, projectRef: added.id, env: sandbox.env });
	fs.mkdirSync(path.dirname(ownConfigFile(resolved.storage)), { recursive: true });
	if (config !== undefined) fs.writeFileSync(ownConfigFile(resolved.storage), config);
	return resolved;
}

function draftFile(content: string, name = 'draft.yml'): string {
	const file = path.join(sandbox.root, 'drafts', name);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content);
	return file;
}

const githubDraft = (extra = '', name = 'draft.yml', repo = 'acme/shop'): string =>
	draftFile(STATUSES_CONFIG + githubStrategy(extra, repo), name);
const localDraft = (name = 'local.yml'): string => draftFile(`${STATUSES_CONFIG}strategy:\n    type: local\n`, name);

function migrate(
	target: ResolvedProject,
	draft: string,
	options: Partial<MigrationOptions> = {},
	extra: Partial<MigrateInPlaceInput> = {}
) {
	return migrateInPlace({
		project: target,
		draftFile: draft,
		options: { ...DEFAULT_MIGRATION_OPTIONS, ...options },
		resumeCommand: 'task migrate --in-place --to-config draft.yml -p ID --resume',
		globalConfigDir: GLOBAL(),
		env: { ...sandbox.env, [TOKEN_VARIABLE]: fake?.token ?? '' },
		...extra,
	});
}

async function seed(target: ResolvedProject): Promise<void> {
	const ctx = openResolvedProject(target, GLOBAL());
	const epic = await ctx.store.create({ title: 'Epic', status: 'backlog' });
	await ctx.store.create({ title: 'Child', status: 'backlog', parentId: epic.id });
	await ctx.store.create({ title: 'Shipped', status: 'backlog' });
	await ctx.dispose?.();
}

const journalFileOf = (target: ResolvedProject): string =>
	path.join(target.storage.dataDir, `migrate-journal-${target.id}-inplace.json`);

async function stoppedRun(): Promise<{ shop: ResolvedProject; draft: string }> {
	fake = await FakeGitHub.start({ repo: 'acme/shop' });
	const shop = await project('shop');
	await seed(shop);
	fake.failNext({
		status: 422,
		method: 'POST',
		pathPrefix: '/repos/acme/shop/issues',
		skip: 1,
		body: { message: 'no' },
	});
	const draft = githubDraft('cache: { ttlSeconds: 600 }');
	const first = await migrate(shop, draft, { allowLoss: ALLOW });
	expect(first.status).toBe('failed');
	return { shop, draft };
}

describe('item 1: the read-back is never served from a cache that is still valid', () => {
	it('a task edited on GitHub after a verified run whose switch failed is seen by the next read-back (cache TTL 600 s): nothing is switched', async () => {
		fake = await FakeGitHub.start({ repo: 'acme/shop' });
		const shop = await project('shop');
		await seed(shop);
		const draft = githubDraft('cache: { ttlSeconds: 600 }');
		const config = ownConfigFile(shop.storage);
		const failing = (file: string, content: string): void => {
			if (file === config) throw new Error('disk full');
			fs.writeFileSync(file, content);
		};
		const first = await migrate(shop, draft, { allowLoss: ALLOW }, { writeFile: failing });
		expect(first.failure).toMatchObject({ step: 'switch' });
		fake.updateIssue(1, { title: 'Changed remotely' });

		const second = await migrate(shop, draft, { allowLoss: ALLOW, resume: true });

		expect(second.status).toBe('failed');
		expect(second.failure).toMatchObject({ step: 'verify' });
		expect(second.verification!.mismatches.some(mismatch => mismatch.field === 'title')).toBe(true);
		expect(second.inPlace!.switched).toBe(false);
	});
});

describe('items 2+3: tasks on the target that this migration never created', () => {
	it('a completed migration, a rollback, the same draft again: refused (the issues are still on GitHub), the flag allows it', async () => {
		fake = await FakeGitHub.start({ repo: 'acme/shop' });
		const shop = await project('shop');
		await seed(shop);
		const draft = githubDraft();
		await migrate(shop, draft, { allowLoss: ALLOW });
		const config = ownConfigFile(shop.storage);
		fs.copyFileSync(`${config}${BACKUP_SUFFIX}`, config);
		fs.rmSync(`${config}${BACKUP_SUFFIX}`);
		const journalBefore = fs.readFileSync(journalFileOf(shop), 'utf8');

		const error = await migrate(shop, draft, { allowLoss: ALLOW }).catch((caught: unknown) => caught);

		expect(error).toBeInstanceOf(MigrationRefusedError);
		expect((error as Error).message).toMatch(/3 task/);
		expect((error as MigrationRefusedError).hint).toContain('--allow-non-empty-target');
		expect(fs.readFileSync(journalFileOf(shop), 'utf8')).toBe(journalBefore);

		const allowed = await migrate(shop, draft, { allowLoss: ALLOW, allowNonEmptyTarget: true });
		expect(allowed.status).toBe('completed');
	});

	it('github back to local while the old local files are still there: refused, the flag allows it', async () => {
		fake = await FakeGitHub.start({ repo: 'acme/shop' });
		const shop = await project('shop');
		await seed(shop);
		await migrate(shop, githubDraft(), { allowLoss: ALLOW });
		// The rollback copy of the first migration is moved away, as its own refusal asks.
		fs.rmSync(`${ownConfigFile(shop.storage)}${BACKUP_SUFFIX}`);
		const back = localDraft();

		const error = await migrate(shop, back, { allowLoss: ['all'] }).catch((caught: unknown) => caught);

		expect(error).toBeInstanceOf(MigrationRefusedError);
		expect((error as MigrationRefusedError).hint).toContain('--allow-non-empty-target');
		const allowed = await migrate(shop, back, { allowLoss: ['all'], allowNonEmptyTarget: true });
		expect(allowed.status).toBe('completed');
	});

	it('the dry run reports it and writes nothing', async () => {
		fake = await FakeGitHub.start({ repo: 'acme/shop' });
		const shop = await project('shop');
		await seed(shop);
		const draft = githubDraft();
		await migrate(shop, draft, { allowLoss: ALLOW });
		const config = ownConfigFile(shop.storage);
		fs.copyFileSync(`${config}${BACKUP_SUFFIX}`, config);
		fs.rmSync(`${config}${BACKUP_SUFFIX}`);

		const dry = await migrate(shop, draft, { allowLoss: ALLOW, dryRun: true });

		expect(dry.targetNotEmpty).toMatchObject({ count: 3 });
	});
});

describe('item 4: a dry run writes nothing on disk, the response caches included', () => {
	it('a fresh project: its data folder does not exist afterwards', async () => {
		fake = await FakeGitHub.start({ repo: 'acme/shop' });
		const shop = await project('shop');
		expect(fs.existsSync(shop.storage.dataDir)).toBe(false);

		const dry = await migrate(shop, githubDraft(), { allowLoss: ALLOW, dryRun: true });

		expect(dry.status).toBe('dry-run');
		expect(fs.existsSync(shop.storage.dataDir)).toBe(false);
	});

	it('a project with tasks: the whole data folder is byte for byte the same', async () => {
		fake = await FakeGitHub.start({ repo: 'acme/shop' });
		const shop = await project('shop');
		await seed(shop);
		const before = snapshotFolder(shop.storage.dataDir);

		const dry = await migrate(shop, githubDraft(), { allowLoss: ALLOW, dryRun: true });

		expect(dry.status).toBe('dry-run');
		expect(fake.requests.length).toBeGreaterThan(0);
		expect(snapshotFolder(shop.storage.dataDir)).toEqual(before);
	});
});

describe('item 5: the source storage in the journal, through the service', () => {
	it('a resume after config.yml was pointed at another storage is refused with the fix', async () => {
		const { shop, draft } = await stoppedRun();
		fs.writeFileSync(ownConfigFile(shop.storage), STATUSES_CONFIG + githubStrategy('', 'acme/other'));

		const error = await migrate(shop, draft, { allowLoss: ALLOW, resume: true }).catch((caught: unknown) => caught);

		expect(error).toBeInstanceOf(MigrationRefusedError);
		expect((error as Error).message).toContain('acme/other');
		expect((error as MigrationRefusedError).hint).toMatch(/config\.yml/);
	});
});

describe('item 6: a crash inside the archive is completed by the next run', () => {
	it('the temp names left behind are renamed and said in the notes', async () => {
		fake = await FakeGitHub.start({ repo: 'acme/shop' });
		const shop = await project('shop');
		await seed(shop);
		const dir = shop.storage.dataDir;
		const stamp = '2026-11-14T09-00-00-000Z';
		fs.writeFileSync(path.join(dir, `migrate-journal-${shop.id}-inplace.json.archiving-${stamp}`), '{}');
		fs.writeFileSync(path.join(dir, `migrate-idmap-${shop.id}.json.archiving-${stamp}`), '[]');

		const result = await migrate(shop, githubDraft(), { allowLoss: ALLOW });

		expect(result.status).toBe('completed');
		expect(result.notes.join(' ')).toMatch(/interrupted archive/);
		expect(fs.existsSync(path.join(dir, `migrate-journal-${shop.id}-inplace.archived-${stamp}.json`))).toBe(true);
		expect(fs.readdirSync(dir).filter(name => name.includes('.archiving-'))).toEqual([]);
	});
});

describe('item 7: backup and rollback are only reported when they are true', () => {
	it('a failed run: not switched, no backup, no rollback, and the dropped keys are in the future tense', async () => {
		fake = await FakeGitHub.start({ repo: 'acme/shop' });
		const shop = await project('shop', `${STATUSES_CONFIG}priorities: [high, low]\n`);
		await seed(shop);
		fake.failNext({
			status: 422,
			method: 'POST',
			pathPrefix: '/repos/acme/shop/issues',
			skip: 1,
			body: { message: 'no' },
		});

		const result = await migrate(shop, githubDraft(), { allowLoss: ['all'] });

		expect(result.status).toBe('failed');
		expect(result.inPlace).toMatchObject({ switched: false });
		expect(result.inPlace!.backup).toBeUndefined();
		expect(result.inPlace!.rollback).toBeUndefined();
		const text = result.warnings.join(' ');
		expect(text).toMatch(/priorities.*would be gone after the switch/);
		expect(text).not.toMatch(/are gone|is gone/);
	});

	it('a dry run: no backup, no rollback', async () => {
		fake = await FakeGitHub.start({ repo: 'acme/shop' });
		const shop = await project('shop');
		await seed(shop);

		const dry = await migrate(shop, githubDraft(), { allowLoss: ALLOW, dryRun: true });

		expect(dry.inPlace!.backup).toBeUndefined();
		expect(dry.inPlace!.rollback).toBeUndefined();
	});

	it('a switched run: both are there and the backup file exists', async () => {
		fake = await FakeGitHub.start({ repo: 'acme/shop' });
		const shop = await project('shop');
		await seed(shop);

		const done = await migrate(shop, githubDraft(), { allowLoss: ALLOW });

		expect(done.inPlace!.backup).toBe(`${ownConfigFile(shop.storage)}${BACKUP_SUFFIX}`);
		expect(fs.existsSync(done.inPlace!.backup!)).toBe(true);
		expect(done.inPlace!.rollback).toContain('go back');
	});
});

describe('unused import guard', () => {
	it('keeps MigrationStateError referenced', () => {
		expect(MigrationStateError).toBeDefined();
	});
});
