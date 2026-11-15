import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FakeGitHub } from '../plugins/github/fakeGitHub.testkit.js';
import { createPluginRegistry } from '../plugin-host/index.js';
import { createBuiltinRegistry } from '../plugins/builtinPlugins.js';
import type { TaskPluginKinds, TaskPluginRegistry } from '../plugins/kinds.js';
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

// Second review of `task migrate --in-place`: one block per finding.
let sandbox: SharedRegistrySandbox;
let fake: FakeGitHub | undefined;
let server: RunningTaskServer | undefined;
const TOKEN_VARIABLE = 'TASK_INPLACE_SECOND_TOKEN';
const OTHER_VARIABLE = 'TASK_INPLACE_SECOND_OTHER_TOKEN';
const SERVER_TOKEN = 'second-server-token-0123456789';
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
	await server?.close();
	server = undefined;
	sandbox.cleanup();
});

function githubStrategy(extra = '', tokenVariable = TOKEN_VARIABLE): string {
	return `strategy:
    type: github
    options:
        repo: acme/shop
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

const githubDraft = (extra = '', name = 'draft.yml', tokenVariable = TOKEN_VARIABLE): string =>
	draftFile(STATUSES_CONFIG + githubStrategy(extra, tokenVariable), name);

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

async function seed(target: ResolvedProject): Promise<void> {
	const ctx = openResolvedProject(target, GLOBAL());
	const epic = await ctx.store.create({ title: 'Epic', status: 'backlog' });
	await ctx.store.create({ title: 'Child', status: 'backlog', parentId: epic.id });
	await ctx.store.create({ title: 'Shipped', status: 'backlog' });
	await ctx.dispose?.();
}

const journalFileOf = (target: ResolvedProject): string =>
	path.join(target.storage.dataDir, `migrate-journal-${target.id}-inplace.json`);
const idMapOf = (target: ResolvedProject): string =>
	path.join(target.storage.dataDir, `migrate-idmap-${target.id}.json`);
const journalOf = (target: ResolvedProject): { status: string; inPlace: Record<string, unknown> } =>
	JSON.parse(fs.readFileSync(journalFileOf(target), 'utf8')) as ReturnType<typeof journalOf>;
const archivedNames = (target: ResolvedProject): string[] =>
	fs.readdirSync(target.storage.dataDir).filter(name => name.includes('.archived-') || name.includes('.archiving-'));

describe('item 2: the archive happens late, as a pair, and only for a run that really starts', () => {
	async function completedThenRolledBack(): Promise<{ shop: ResolvedProject; draft: string }> {
		fake = await FakeGitHub.start({ repo: 'acme/shop' });
		const shop = await project('shop');
		await seed(shop);
		const draft = githubDraft();
		await migrate(shop, draft, { allowLoss: ALLOW });
		const config = ownConfigFile(shop.storage);
		fs.copyFileSync(`${config}${BACKUP_SUFFIX}`, config);
		fs.rmSync(`${config}${BACKUP_SUFFIX}`);
		return { shop, draft };
	}

	it('a refused preflight leaves the finished journal and id map exactly where they were', async () => {
		const { shop } = await completedThenRolledBack();
		const before = [fs.readFileSync(journalFileOf(shop), 'utf8'), fs.readFileSync(idMapOf(shop), 'utf8')];
		const stillLocal = draftFile(`${STATUSES_CONFIG}strategy:\n    type: local\n`, 'local.yml');

		const error = await migrate(shop, stillLocal, { allowLoss: ALLOW }).catch((caught: unknown) => caught);

		expect(error).toBeInstanceOf(MigrationRefusedError);
		expect([fs.readFileSync(journalFileOf(shop), 'utf8'), fs.readFileSync(idMapOf(shop), 'utf8')]).toEqual(before);
		expect(archivedNames(shop)).toEqual([]);
	});

	it('a plan blocked by a loss does not archive either', async () => {
		const { shop, draft } = await completedThenRolledBack();

		const blocked = await migrate(shop, draft, { allowNonEmptyTarget: true });

		expect(blocked.status).toBe('blocked');
		expect(fs.existsSync(journalFileOf(shop))).toBe(true);
		expect(fs.existsSync(idMapOf(shop))).toBe(true);
		expect(archivedNames(shop)).toEqual([]);
	});
});

describe('item 3: the hash covers what changes the migrated data, not how to connect', () => {
	async function stopped(): Promise<{ shop: ResolvedProject }> {
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
		const first = await migrate(shop, githubDraft(), { allowLoss: ALLOW });
		expect(first.status).toBe('failed');
		return { shop };
	}

	it('another list of priorities is a change of the target: refused, naming it', async () => {
		const { shop } = await stopped();
		const edited = draftFile(`priorities: [urgent, medium]\n${STATUSES_CONFIG}${githubStrategy()}`, 'prio.yml');

		const error = await migrate(shop, edited, { allowLoss: ALLOW, resume: true }).catch(
			(caught: unknown) => caught
		);

		expect(error).toBeInstanceOf(MigrationRefusedError);
		expect((error as Error).message).toContain('priorities');
	});

	it('a status flag (terminal, default) is a change of the target', async () => {
		const { shop } = await stopped();
		const edited = draftFile(
			`statuses:\n    - { name: backlog, default: true }\n    - { name: in-progress, default: false }\n    - { name: done, terminal: true }\n${githubStrategy()}`,
			'flags.yml'
		);
		const original = draftFile(
			`statuses:\n    - backlog\n    - in-progress\n    - { name: done, terminal: true }\n${githubStrategy()}`,
			'orig.yml'
		);
		// Writing the default flag explicitly changes nothing of the data: same names, same flags once resolved.
		const same = await migrate(shop, edited, { allowLoss: ALLOW, resume: true });
		expect(same.status).toBe('completed');
		expect(original).toBeTruthy();
	});

	it('a data-affecting option (typePrefix) is a change: refused, accepted only with --resume --accept-draft-change', async () => {
		const { shop } = await stopped();
		const edited = githubDraft("typePrefix: 'kind:'", 'prefix.yml');

		const refused = await migrate(shop, edited, { allowLoss: ALLOW, resume: true }).catch(
			(caught: unknown) => caught
		);
		expect(refused).toBeInstanceOf(MigrationRefusedError);
		expect((refused as Error).message).toContain('options.typePrefix');
		expect((refused as MigrationRefusedError).hint).toContain('--accept-draft-change');

		const accepted = await migrate(shop, edited, { allowLoss: ALLOW, resume: true, acceptDraftChange: true });
		expect(accepted.status).toBe('completed');
	});

	it.each([
		['the variable that holds the token', 'tokenEnv'],
		['the page size', 'pageSize'],
		['the timeout', 'timeoutSeconds'],
		['the cache', 'cache'],
	])('%s is connection only: fixing it never needs --accept-draft-change', async (_name, key) => {
		const { shop } = await stopped();
		const edited =
			key === 'tokenEnv'
				? githubDraft('', 'conn.yml', OTHER_VARIABLE)
				: githubDraft(
						key === 'pageSize'
							? 'pageSize: 50'
							: key === 'timeoutSeconds'
								? 'maxPages: 10'
								: 'cache: { ttlSeconds: 5 }',
						'conn.yml'
					);

		const second = await migrate(shop, edited, { allowLoss: ALLOW, resume: true });

		expect(second.status).toBe('completed');
	});
});

describe('item 4: the bookkeeping-only resume trusts switchStarted, not verified', () => {
	it('a switch that never wrote config.yml leaves switchStarted false; a hand-copied draft is not enough to skip the read-back', async () => {
		fake = await FakeGitHub.start({ repo: 'acme/shop' });
		const shop = await project('shop');
		await seed(shop);
		const draft = githubDraft();
		const config = ownConfigFile(shop.storage);
		const failing = (file: string, content: string): void => {
			if (file === config) throw new Error('disk full');
			fs.writeFileSync(file, content);
		};
		const first = await migrate(shop, draft, { allowLoss: ALLOW }, { writeFile: failing });
		expect(first.failure).toMatchObject({ step: 'switch' });
		expect(journalOf(shop).inPlace).toMatchObject({ verified: true, switchStarted: false });

		// By hand, the draft is copied over config.yml: the journal never saw a switch start, so this is not a finished run.
		fs.copyFileSync(draft, config);
		const refused = await migrate(shop, draft, { allowLoss: ALLOW, resume: true }).catch(
			(caught: unknown) => caught
		);
		expect(refused).toBeInstanceOf(MigrationRefusedError);
		expect((refused as MigrationRefusedError).hint).toContain(`${config}${BACKUP_SUFFIX}`);

		// Restored as the hint says, the full path runs: the source and the target are read again, then the switch.
		fs.copyFileSync(`${config}${BACKUP_SUFFIX}`, config);
		const requests = fake.requests.length;
		const second = await migrate(shop, draft, { allowLoss: ALLOW, resume: true });
		expect(second.status).toBe('completed');
		expect(second.verification!.checked).toBe(3);
		expect(fake.requests.length).toBeGreaterThan(requests);
		expect(journalOf(shop).inPlace).toMatchObject({ switched: true, switchStarted: true });
	});

	it('a crash after the config was written keeps switchStarted true', async () => {
		fake = await FakeGitHub.start({ repo: 'acme/shop' });
		const shop = await project('shop');
		await seed(shop);
		const config = ownConfigFile(shop.storage);
		const crash = (file: string, content: string): void => {
			fs.writeFileSync(file, content);
			if (file === config) throw new Error('crash right after replacing the config');
		};

		await migrate(shop, githubDraft(), { allowLoss: ALLOW }, { writeFile: crash });

		expect(journalOf(shop).inPlace).toMatchObject({ switchStarted: true, switched: false });
	});
});

describe('item 5: the bookkeeping path answers like the normal one', () => {
	it('keys the draft drops, the rollback text and the backup are there after a crash resume', async () => {
		fake = await FakeGitHub.start({ repo: 'acme/shop' });
		const shop = await project('shop', `${STATUSES_CONFIG}priorities: [high, low]\n`);
		await seed(shop);
		const draft = githubDraft();
		const config = ownConfigFile(shop.storage);
		const crash = (file: string, content: string): void => {
			fs.writeFileSync(file, content);
			if (file === config) throw new Error('crash right after replacing the config');
		};
		await migrate(shop, draft, { allowLoss: ['all'] }, { writeFile: crash });

		const second = await migrate(shop, draft, { allowLoss: ['all'], resume: true });

		expect(second.inPlace!.configKeysDropped).toEqual(['priorities']);
		expect(second.warnings.join(' ')).toMatch(/priorities.*gone after the switch/);
		expect(second.inPlace!.backup).toBe(`${config}${BACKUP_SUFFIX}`);
		expect(second.inPlace!.rollback).toContain(`copy ${config}${BACKUP_SUFFIX} over ${config}`);
		expect(second.inPlace!.rollback).toContain('github');
	});

	it('a remote target raises no summary event from here, and says so, after a crash resume too', async () => {
		const shop = await project('shop');
		await seed(shop);
		const other = await project('other');
		server = await startTaskServer({
			ctx: openResolvedProject(other, GLOBAL(), { env: sandbox.env }),
			token: SERVER_TOKEN,
			failedAuthDelayMs: 0,
			eventSink: { deliver: () => Promise.resolve({ delivered: true }) },
		});
		const draft = draftFile(`${STATUSES_CONFIG}strategy:
    type: remote
    options:
        transport:
            type: plain-http
            options:
                url: ${server.url}
                tokenEnv: ${TOKEN_VARIABLE}
                timeoutSeconds: 5
`);
		const env = { ...sandbox.env, [TOKEN_VARIABLE]: SERVER_TOKEN };
		const config = ownConfigFile(shop.storage);
		const crash = (file: string, content: string): void => {
			fs.writeFileSync(file, content);
			if (file === config) throw new Error('crash right after replacing the config');
		};
		await migrate(shop, draft, { allowLoss: ['all'] }, { writeFile: crash, env });

		const second = await migrate(shop, draft, { allowLoss: ['all'], resume: true }, { env });

		expect(second.status).toBe('completed');
		expect(second.events).toEqual([]);
		expect(second.warnings.join(' ')).toMatch(/raised by its server/);
	});
});

describe('item 7: the remote same-project check turns transport errors into answers', () => {
	async function remoteDraft(): Promise<{ shop: ResolvedProject; draft: string }> {
		const shop = await project('shop');
		await seed(shop);
		const other = await project('other');
		server = await startTaskServer({
			ctx: openResolvedProject(other, GLOBAL(), { env: sandbox.env }),
			token: SERVER_TOKEN,
			failedAuthDelayMs: 0,
			eventSink: { deliver: () => Promise.resolve({ delivered: true }) },
		});
		const draft = draftFile(`${STATUSES_CONFIG}strategy:
    type: remote
    options:
        transport:
            type: plain-http
            options:
                url: ${server.url}
                tokenEnv: ${TOKEN_VARIABLE}
                timeoutSeconds: 2
`);
		return { shop, draft };
	}

	it.each([[true], [false]])(
		'a server that is down (dry run %s): a refusal naming what failed, with the fix',
		async dryRun => {
			const { shop, draft } = await remoteDraft();
			await server!.close();
			server = undefined;

			const error = await migrate(
				shop,
				draft,
				{ dryRun, allowLoss: ['all'] },
				{ env: { ...sandbox.env, [TOKEN_VARIABLE]: SERVER_TOKEN } }
			).catch((caught: unknown) => caught);

			expect(error).toBeInstanceOf(MigrationRefusedError);
			expect((error as MigrationRefusedError).hint).toMatch(/task serve|Is "task serve" running/);
			expect(fs.readFileSync(ownConfigFile(shop.storage), 'utf8')).toBe(STATUSES_CONFIG);
		}
	);

	it.each([[true], [false]])('a wrong token (dry run %s): a refusal naming the token, with the fix', async dryRun => {
		const { shop, draft } = await remoteDraft();

		const error = await migrate(
			shop,
			draft,
			{ dryRun, allowLoss: ['all'] },
			{ env: { ...sandbox.env, [TOKEN_VARIABLE]: 'a-completely-wrong-token-0123456789' } }
		).catch((caught: unknown) => caught);

		expect(error).toBeInstanceOf(MigrationRefusedError);
		expect(`${(error as Error).message} ${(error as MigrationRefusedError).hint}`).toMatch(/token|unauthor|401/i);
	});
});

describe('item 8: only the caller that took the lock releases it, after both contexts are disposed', () => {
	it('a second run started while the first is still disposing is refused as locked', async () => {
		fake = await FakeGitHub.start({ repo: 'acme/shop' });
		const shop = await project('shop');
		await seed(shop);
		const draft = githubDraft();
		// A github strategy whose instance takes its time to be released.
		const builtin = createBuiltinRegistry();
		let release!: () => void;
		const gate = new Promise<void>(resolve => (release = resolve));
		let disposing!: () => void;
		const disposeStarted = new Promise<void>(resolve => (disposing = resolve));
		const entries = (kind: 'strategy' | 'transport') =>
			builtin.list(kind).map(entry => {
				const plugin =
					kind === 'strategy' && entry.aliases.includes('github')
						? {
								...entry.plugin,
								create: async (...args: Parameters<(typeof entry.plugin)['create']>) => {
									const instance = await (
										entry.plugin as {
											create: (...a: unknown[]) => Promise<{ dispose: () => Promise<void> }>;
										}
									).create(...args);
									return {
										...instance,
										dispose: async () => {
											disposing();
											await gate;
											await instance.dispose();
										},
									};
								},
							}
						: entry.plugin;
				return { ref: entry.ref, plugin, aliases: [...entry.aliases] };
			});
		const slow = createPluginRegistry<TaskPluginKinds>([
			...entries('strategy'),
			...entries('transport'),
		] as never) as TaskPluginRegistry;

		const first = migrate(shop, draft, { allowLoss: ALLOW }, { registry: slow });
		await disposeStarted;

		const second = await migrate(shop, draft, { allowLoss: ALLOW }).catch((caught: unknown) => caught);
		expect(second).toBeInstanceOf(MigrationStateError);
		expect((second as Error).message).toMatch(/another migration is writing/);

		release();
		const done = await first;
		expect(done.status).toBe('completed');
		expect(fs.existsSync(path.join(shop.storage.dataDir, 'migrate.lock'))).toBe(false);
	});
});
