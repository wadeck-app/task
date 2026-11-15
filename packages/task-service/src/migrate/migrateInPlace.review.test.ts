import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FakeGitHub } from '../plugins/github/fakeGitHub.testkit.js';
import { openResolvedProject } from '../openContext.js';
import { resolveProject } from '../resolveProject.js';
import type { ResolvedProject } from '../resolveProject.js';
import { startTaskServer } from '../server/taskServer.js';
import type { RunningTaskServer } from '../server/taskServer.js';
import { ownConfigFile } from '../storage.js';
import { createSharedRegistrySandbox } from '../testHelpers.js';
import type { SharedRegistrySandbox } from '../testHelpers.js';
import { MigrationRefusedError, MigrationStateError } from './migrateErrors.js';
import { BACKUP_SUFFIX, migrateInPlace } from './migrateInPlace.js';
import type { MigrateInPlaceInput } from './migrateInPlace.js';
import { DEFAULT_MIGRATION_OPTIONS } from './migrateTypes.js';
import type { MigrationOptions } from './migrateTypes.js';

// The findings of the review of `task migrate --in-place`: each test pins one of them.
let sandbox: SharedRegistrySandbox;
let fake: FakeGitHub | undefined;
let server: RunningTaskServer | undefined;
const TOKEN_VARIABLE = 'TASK_INPLACE_REVIEW_TOKEN';
const OTHER_VARIABLE = 'TASK_INPLACE_REVIEW_OTHER_TOKEN';
const SERVER_TOKEN = 'review-server-token-0123456789';
const ALLOW = ['history', 'created-at', 'marker'];

beforeEach(() => {
	sandbox = createSharedRegistrySandbox();
});

afterEach(async () => {
	await fake?.stop();
	fake = undefined;
	await server?.close();
	server = undefined;
	sandbox.cleanup();
});

const STATUSES_CONFIG = `statuses:
    - backlog
    - in-progress
    - { name: done, terminal: true }
`;
const OLD_CONFIG = STATUSES_CONFIG;
const GLOBAL = (): string => path.join(sandbox.root, 'global');

function githubStrategy(repo: string, extra = '', tokenVariable = TOKEN_VARIABLE): string {
	return `strategy:
    type: github
    options:
        repo: ${repo}
        baseUrl: ${fake!.baseUrl}
        tokenEnv: ${tokenVariable}
        writeSpacingSeconds: 0
        timeoutSeconds: 3
        ${extra}
        statusMap:
            backlog: { state: open }
            in-progress: { state: open, label: 'status:in-progress' }
            done: { state: closed }
`;
}

async function project(name: string, config: string | undefined = OLD_CONFIG): Promise<ResolvedProject> {
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

const githubDraft = (extra = '', name = 'draft.yml'): string =>
	draftFile(STATUSES_CONFIG + githubStrategy('acme/shop', extra), name);

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
		env: { ...sandbox.env, [TOKEN_VARIABLE]: fake?.token ?? '', [OTHER_VARIABLE]: fake?.token ?? '' },
		...extra,
	});
}

async function seed(target: ResolvedProject): Promise<string[]> {
	const ctx = openResolvedProject(target, GLOBAL());
	const epic = await ctx.store.create({ title: 'Epic', status: 'backlog' });
	const child = await ctx.store.create({ title: 'Child', status: 'backlog', parentId: epic.id });
	const shipped = await ctx.store.create({ title: 'Shipped', status: 'backlog' });
	await ctx.dispose?.();
	return [epic.id, child.id, shipped.id];
}

function journalOf(target: ResolvedProject): {
	status: string;
	inPlace: { switched: boolean; verified: boolean; acceptedDifferences?: unknown[] };
} {
	return JSON.parse(
		fs.readFileSync(path.join(target.storage.dataDir, `migrate-journal-${target.id}-inplace.json`), 'utf8')
	) as ReturnType<typeof journalOf>;
}

const idMapPath = (target: ResolvedProject): string =>
	path.join(target.storage.dataDir, `migrate-idmap-${target.id}.json`);

describe('finding 1: a run that crashed right after replacing config.yml is finished from the journal', () => {
	it.each([
		['a project with a config.yml', OLD_CONFIG],
		['a project with no config.yml (no backup exists)', undefined],
	])('%s: --resume only does the bookkeeping, nothing is read or created, no refusal', async (_name, config) => {
		fake = await FakeGitHub.start({ repo: 'acme/shop' });
		const shop = await project('shop', config);
		await seed(shop);
		const draft = githubDraft();
		const configFile = ownConfigFile(shop.storage);
		// The config is replaced, then the process "dies" before the journal says so.
		const crash = (file: string, content: string): void => {
			fs.writeFileSync(file, content);
			if (file === configFile) throw new Error('crash right after replacing the config');
		};
		const first = await migrate(shop, draft, { allowLoss: ['all'] }, { writeFile: crash });
		expect(first.failure).toMatchObject({ step: 'switch' });
		expect(fs.readFileSync(configFile, 'utf8')).toBe(fs.readFileSync(draft, 'utf8'));
		expect(journalOf(shop)).toMatchObject({ status: 'stopped', inPlace: { switched: false, verified: true } });
		const requests = fake.requests.length;

		// Without --resume the unfinished journal is still named, with the fix.
		const plain = await migrate(shop, draft, { allowLoss: ['all'] }).catch((caught: unknown) => caught);
		expect((plain as MigrationRefusedError).hint).toContain('--resume');
		const second = await migrate(shop, draft, { allowLoss: ['all'], resume: true });

		expect(second.status).toBe('completed');
		expect(second.counts).toMatchObject({ source: 3, created: 0, skipped: 3, failed: 0 });
		expect(second.inPlace!.switched).toBe(true);
		expect(second.notes.join(' ')).toMatch(/bookkeeping/);
		expect(second.events.map(event => event.name)).toEqual(['onTasksMigrated']);
		expect(second.idMap).toHaveLength(3);
		expect(fake.requests.length).toBe(requests);
		expect(journalOf(shop)).toMatchObject({ status: 'completed', inPlace: { switched: true } });
		expect(JSON.parse(fs.readFileSync(idMapPath(shop), 'utf8'))).toHaveLength(3);
	});
});

describe('finding 2: a finished migration is archived, never overwritten', () => {
	it('a second migration of the same project archives the journal and the id map, keeps the old mapping and starts its own', async () => {
		fake = await FakeGitHub.start({ repo: 'acme/shop' });
		const shop = await project('shop');
		await seed(shop);
		const draft = githubDraft();
		const configFile = ownConfigFile(shop.storage);
		await migrate(shop, draft, { allowLoss: ALLOW });
		const firstMap = fs.readFileSync(idMapPath(shop), 'utf8');
		// Rolled back by hand, as the output says: the project is local again, the tasks are still in its files.
		fs.copyFileSync(`${configFile}${BACKUP_SUFFIX}`, configFile);
		fs.rmSync(`${configFile}${BACKUP_SUFFIX}`);

		// A dry run ignores the finished journal and archives nothing.
		const dry = await migrate(shop, draft, { dryRun: true });
		expect(dry.counts).toMatchObject({ created: 3, skipped: 0 });
		expect(dry.notes.join(' ')).toMatch(/archived/);
		expect(fs.existsSync(idMapPath(shop))).toBe(true);
		// A resume of a completed run has nothing to resume.
		await expect(migrate(shop, draft, { allowLoss: ALLOW, resume: true })).rejects.toThrow(/nothing to resume/);

		const second = await migrate(shop, draft, { allowLoss: ALLOW });

		expect(second.status).toBe('completed');
		expect(second.inPlace!.switched).toBe(true);
		const files = fs.readdirSync(shop.storage.dataDir);
		const archivedMap = files.find(name => /^migrate-idmap-.*\.archived-.*\.json$/.test(name))!;
		expect(files.some(name => /^migrate-journal-.*-inplace\.archived-.*\.json$/.test(name))).toBe(true);
		expect(fs.readFileSync(path.join(shop.storage.dataDir, archivedMap), 'utf8')).toBe(firstMap);
		const newMap = JSON.parse(fs.readFileSync(idMapPath(shop), 'utf8')) as Array<{ to: string }>;
		expect(newMap).toHaveLength(3);
		expect(newMap.map(entry => entry.to)).not.toEqual(
			(JSON.parse(firstMap) as Array<{ to: string }>).map(entry => entry.to)
		);
		expect(journalOf(shop)).toMatchObject({ status: 'completed', inPlace: { switched: true } });
	});
});

describe('finding 3: config.yml changed during the run, and two runs at once', () => {
	it('refuses to replace a config that changed since the start, then --resume takes a new snapshot and keeps the fresh text as backup', async () => {
		fake = await FakeGitHub.start({ repo: 'acme/shop' });
		const shop = await project('shop');
		await seed(shop);
		const draft = githubDraft();
		const configFile = ownConfigFile(shop.storage);
		const edited = (): void => fs.appendFileSync(configFile, '# edited by hand\n');

		const first = await migrate(
			shop,
			draft,
			{ allowLoss: ALLOW },
			{
				onProgress: progress => {
					if (progress.stage === 'verify' && progress.done === progress.total) edited();
				},
			}
		);

		expect(first.status).toBe('failed');
		expect(first.failure).toMatchObject({
			step: 'switch',
			message: expect.stringContaining('changed since the migration started'),
		});
		expect(first.failure!.hint).toContain('--resume');
		expect(fs.readFileSync(configFile, 'utf8')).toBe(`${OLD_CONFIG}# edited by hand\n`);
		expect(fs.existsSync(`${configFile}${BACKUP_SUFFIX}`)).toBe(false);

		const second = await migrate(shop, draft, { allowLoss: ALLOW, resume: true });

		expect(second.status).toBe('completed');
		expect(fs.readFileSync(`${configFile}${BACKUP_SUFFIX}`, 'utf8')).toBe(`${OLD_CONFIG}# edited by hand\n`);
		expect(fs.readFileSync(configFile, 'utf8')).toBe(fs.readFileSync(draft, 'utf8'));
	});

	it('takes the lock before its checks: a run in progress is the answer, not a half-evaluated refusal', async () => {
		fake = await FakeGitHub.start({ repo: 'acme/shop' });
		const shop = await project('shop');
		await seed(shop);
		fs.mkdirSync(shop.storage.dataDir, { recursive: true });
		fs.writeFileSync(
			path.join(shop.storage.dataDir, 'migrate.lock'),
			JSON.stringify({ pid: 4242, startedAt: 'x', from: 'a', to: 'a' })
		);
		// Something the checks would refuse on their own: the rollback copy is in the way.
		fs.writeFileSync(`${ownConfigFile(shop.storage)}${BACKUP_SUFFIX}`, 'statuses: [x]\n');

		const error = await migrate(
			shop,
			githubDraft(),
			{ allowLoss: ALLOW },
			{ engine: { isAlive: () => true } }
		).catch((caught: unknown) => caught);

		expect(error).toBeInstanceOf(MigrationStateError);
		expect((error as Error).message).toMatch(/another migration is writing/);
	});

	it('releases the lock when done, whatever the outcome', async () => {
		fake = await FakeGitHub.start({ repo: 'acme/shop' });
		const shop = await project('shop');
		await seed(shop);

		await migrate(shop, githubDraft(), { allowLoss: ALLOW });
		await migrate(shop, githubDraft(), { allowLoss: ALLOW }).catch(() => undefined);

		expect(fs.existsSync(path.join(shop.storage.dataDir, 'migrate.lock'))).toBe(false);
	});
});

describe('finding 6: the draft hash is what defines the target', () => {
	async function stopped(): Promise<{ shop: ResolvedProject; draft: string }> {
		fake = await FakeGitHub.start({ repo: 'acme/shop' });
		const shop = await project('shop');
		await seed(shop);
		const draft = githubDraft();
		fake.failNext({
			status: 422,
			method: 'POST',
			pathPrefix: '/repos/acme/shop/issues',
			skip: 1,
			body: { message: 'no' },
		});
		const first = await migrate(shop, draft, { allowLoss: ALLOW });
		expect(first.status).toBe('failed');
		return { shop, draft };
	}

	it('a comment, key order or another key of the draft is not a change of the target', async () => {
		const { shop } = await stopped();
		const same = draftFile(
			`# the new storage of the shop\ndefaults: { leaseMinutes: 45 }\n${STATUSES_CONFIG}${githubStrategy('acme/shop')}`,
			'cosmetic.yml'
		);

		const second = await migrate(shop, same, { allowLoss: ALLOW, resume: true });

		expect(second.status).toBe('completed');
		expect(fs.readFileSync(ownConfigFile(shop.storage), 'utf8')).toBe(fs.readFileSync(same, 'utf8'));
	});

	it('a changed option at the same location is refused naming the part and the flag; --resume --accept-draft-change accepts it', async () => {
		const { shop } = await stopped();
		const renamed = draftFile(STATUSES_CONFIG + githubStrategy('acme/shop', "typePrefix: 'kind:'"), 'renamed.yml');

		const refused = await migrate(shop, renamed, { allowLoss: ALLOW, resume: true }).catch(
			(caught: unknown) => caught
		);
		expect(refused).toBeInstanceOf(MigrationRefusedError);
		expect((refused as Error).message).toContain('options.typePrefix');
		expect((refused as MigrationRefusedError).hint).toContain('--accept-draft-change');
		// The flag needs --resume: it only continues an unfinished run.
		const noResume = await migrate(shop, renamed, { allowLoss: ALLOW, acceptDraftChange: true }).catch(
			(caught: unknown) => caught
		);
		expect(noResume).toBeInstanceOf(MigrationRefusedError);

		const accepted = await migrate(shop, renamed, { allowLoss: ALLOW, resume: true, acceptDraftChange: true });

		expect(accepted.status).toBe('completed');
		expect(accepted.notes.join(' ')).toMatch(/accepted/);
		expect(fake!.issues.size).toBe(3);
	});

	it('another storage location is always refused, flag or not', async () => {
		const { shop } = await stopped();
		const elsewhere = draftFile(STATUSES_CONFIG + githubStrategy('acme/other'), 'elsewhere.yml');

		const error = await migrate(shop, elsewhere, { allowLoss: ALLOW, resume: true, acceptDraftChange: true }).catch(
			(caught: unknown) => caught
		);

		expect(error).toBeInstanceOf(MigrationRefusedError);
		expect((error as Error).message).toMatch(/another storage/);
		expect(fs.readFileSync(ownConfigFile(shop.storage), 'utf8')).toBe(OLD_CONFIG);
	});

	it('a dry run never fails on an unfinished journal: it prints the plan and a note', async () => {
		const { shop } = await stopped();
		const renamed = draftFile(STATUSES_CONFIG + githubStrategy('acme/shop', "typePrefix: 'kind:'"), 'renamed.yml');

		const dry = await migrate(shop, renamed, { dryRun: true });

		expect(dry.status).toBe('dry-run');
		expect(dry.notes.join(' ')).toMatch(/unfinished.*options.typePrefix/);
	});
});

describe('finding 7: the draft is read once', () => {
	it('a draft edited during the run: what is migrated and written is the text read at the start, and the output says so', async () => {
		fake = await FakeGitHub.start({ repo: 'acme/shop' });
		const shop = await project('shop');
		await seed(shop);
		const draft = githubDraft();
		const original = fs.readFileSync(draft, 'utf8');

		const result = await migrate(
			shop,
			draft,
			{ allowLoss: ALLOW },
			{
				onProgress: progress => {
					if (progress.stage === 'verify' && progress.done === progress.total) {
						fs.writeFileSync(draft, `${original}# edited during the run\n`);
					}
				},
			}
		);

		expect(result.status).toBe('completed');
		expect(fs.readFileSync(ownConfigFile(shop.storage), 'utf8')).toBe(original);
		expect(result.inPlace!.draftChangedOnDisk).toBe(true);
		expect(result.warnings.join(' ')).toMatch(
			/changed on disk while the migration ran: the config written is the text read at the start/
		);
	});
});

describe('finding 8: the draft replaces the whole config.yml', () => {
	const WITH_EXTRAS = `${STATUSES_CONFIG}priorities: [high, low]\ndefaults:\n    priority: low\n`;

	it('lists the keys of the current config the draft drops, in the dry run and in the run', async () => {
		fake = await FakeGitHub.start({ repo: 'acme/shop' });
		const shop = await project('shop', WITH_EXTRAS);
		await seed(shop);
		const draft = githubDraft();

		const dry = await migrate(shop, draft, { dryRun: true });
		expect(dry.inPlace!.configKeysDropped).toEqual(['priorities', 'defaults']);
		expect(dry.warnings.join(' ')).toMatch(
			/priorities, defaults.*gone after the switch.*copy the current config\.yml, add the strategy section/
		);

		const real = await migrate(shop, draft, { allowLoss: ALLOW });
		expect(real.status).toBe('completed');
		expect(real.inPlace!.configKeysDropped).toEqual(['priorities', 'defaults']);
		expect(real.warnings.join(' ')).toContain(`${ownConfigFile(shop.storage)}${BACKUP_SUFFIX}`);
	});

	it('a draft that keeps every key drops nothing and warns of nothing', async () => {
		fake = await FakeGitHub.start({ repo: 'acme/shop' });
		const shop = await project('shop', WITH_EXTRAS);
		await seed(shop);
		const complete = draftFile(`${WITH_EXTRAS}${githubStrategy('acme/shop')}`);

		const dry = await migrate(shop, complete, { dryRun: true });

		expect(dry.inPlace!.configKeysDropped).toBeUndefined();
		expect(dry.warnings.join(' ')).not.toMatch(/gone after the switch/);
	});

	it('a draft without a strategy says it is the WHOLE new config.yml', async () => {
		const shop = await project('shop');

		const error = await migrate(shop, draftFile(STATUSES_CONFIG)).catch((caught: unknown) => caught);

		expect(error).toBeInstanceOf(MigrationRefusedError);
		expect((error as Error).message).toMatch(/WHOLE new config\.yml/);
		expect((error as MigrationRefusedError).hint).toMatch(
			/replaces config\.yml entirely.*copy the current config\.yml/
		);
	});
});

describe('finding 9: a task server that serves this very project is a loop', () => {
	async function serve(served: ResolvedProject): Promise<string> {
		server = await startTaskServer({
			ctx: openResolvedProject(served, GLOBAL(), { env: sandbox.env }),
			token: SERVER_TOKEN,
			failedAuthDelayMs: 0,
			eventSink: { deliver: () => Promise.resolve({ delivered: true }) },
		});
		return server.url;
	}

	const remoteDraft = (url: string): string =>
		draftFile(`${STATUSES_CONFIG}strategy:
    type: remote
    options:
        transport:
            type: plain-http
            options:
                url: ${url}
                tokenEnv: ${TOKEN_VARIABLE}
                timeoutSeconds: 5
`);

	it('refuses (dry run and real run) when the server serves the project being migrated', async () => {
		const shop = await project('shop');
		await seed(shop);
		const draft = remoteDraft(await serve(shop));
		const env = { ...sandbox.env, [TOKEN_VARIABLE]: SERVER_TOKEN };

		for (const dryRun of [true, false]) {
			const error = await migrate(shop, draft, { dryRun, allowLoss: ['all'] }, { env }).catch(
				(caught: unknown) => caught
			);
			expect(error).toBeInstanceOf(MigrationRefusedError);
			expect((error as Error).message).toMatch(/serves this very project/);
		}
		expect(fs.readFileSync(ownConfigFile(shop.storage), 'utf8')).toBe(OLD_CONFIG);
	});

	it('migrates into a server that serves another project', async () => {
		const shop = await project('shop');
		await seed(shop);
		const other = await project('other');
		const draft = remoteDraft(await serve(other));

		const result = await migrate(
			shop,
			draft,
			{ allowLoss: ['all'] },
			{ env: { ...sandbox.env, [TOKEN_VARIABLE]: SERVER_TOKEN } }
		);

		expect(result.status).toBe('completed');
		expect(result.to.kind).toBe('remote');
	});
});
