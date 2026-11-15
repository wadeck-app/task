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
import { migrateInPlace } from './migrateInPlace.js';
import type { MigrateInPlaceInput } from './migrateInPlace.js';
import { DEFAULT_MIGRATION_OPTIONS } from './migrateTypes.js';
import type { MigrationOptions } from './migrateTypes.js';

// Fourth review of `task migrate --in-place`, service side.
let sandbox: SharedRegistrySandbox;
let fake: FakeGitHub | undefined;
const TOKEN_VARIABLE = 'TASK_INPLACE_FOURTH_TOKEN';
const ALLOW = ['history', 'created-at', 'marker'];
const STATUSES_CONFIG = `statuses:
    - backlog
    - in-progress
    - { name: done, terminal: true }
`;

beforeEach(() => {
	sandbox = createSharedRegistrySandbox();
});

afterEach(async () => {
	await fake?.stop();
	fake = undefined;
	sandbox.cleanup();
});

const githubStrategy = (): string => `strategy:
    type: github
    options:
        repo: acme/shop
        baseUrl: ${fake!.baseUrl}
        tokenEnv: ${TOKEN_VARIABLE}
        writeSpacingSeconds: 0
        timeoutSeconds: 3
        statusMap:
            backlog: { state: open }
            in-progress: { state: open, label: 'status:in-progress' }
            done: { state: closed }
`;

async function project(name: string): Promise<ResolvedProject> {
	const dir = sandbox.dir(name);
	const added = await sandbox.register(name, dir);
	const resolved = resolveProject({ cwd: dir, projectRef: added.id, env: sandbox.env });
	fs.mkdirSync(path.dirname(ownConfigFile(resolved.storage)), { recursive: true });
	fs.writeFileSync(ownConfigFile(resolved.storage), STATUSES_CONFIG);
	return resolved;
}

function draftFile(content: string): string {
	const file = path.join(sandbox.root, 'drafts', 'draft.yml');
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content);
	return file;
}

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
		globalConfigDir: path.join(sandbox.root, 'global'),
		env: { ...sandbox.env, [TOKEN_VARIABLE]: fake?.token ?? '' },
		...extra,
	});
}

async function seed(target: ResolvedProject): Promise<void> {
	const ctx = openResolvedProject(target, path.join(sandbox.root, 'global'));
	await ctx.store.create({ title: 'Epic', status: 'backlog' });
	await ctx.store.create({ title: 'Shipped', status: 'backlog' });
	await ctx.dispose?.();
}

describe('item 5: the target is listed once', () => {
	it('a dry run sends exactly one list request to the target repository for the plan and the foreign check together', async () => {
		fake = await FakeGitHub.start({ repo: 'acme/shop' });
		const shop = await project('shop');
		await seed(shop);
		const draft = draftFile(STATUSES_CONFIG + githubStrategy());
		// The strategy check reads one issue to probe the repository; the plan lists the whole repository.
		const lists = (): number =>
			fake!.requests.filter(
				request =>
					request.method === 'GET' &&
					request.path === '/repos/acme/shop/issues' &&
					request.query.includes('per_page=100')
			).length;

		await migrate(shop, draft, { allowLoss: ALLOW, dryRun: true });

		expect(lists()).toBe(1);
	});
});

describe('item 3: the summary event after a crash that left only the bookkeeping', () => {
	async function crashedAfterSwitch() {
		fake = await FakeGitHub.start({ repo: 'acme/shop' });
		const shop = await project('shop');
		await seed(shop);
		const draft = draftFile(STATUSES_CONFIG + githubStrategy());
		const config = ownConfigFile(shop.storage);
		const crash = (file: string, content: string): void => {
			fs.writeFileSync(file, content);
			if (file === config) throw new Error('crash right after replacing the config');
		};
		await migrate(shop, draft, { allowLoss: ALLOW }, { writeFile: crash });
		return { shop, draft };
	}
	const journalFileOf = (shop: ResolvedProject): string =>
		path.join(shop.storage.dataDir, `migrate-journal-${shop.id}-inplace.json`);

	it('the first run never produced it: the resume raises it', async () => {
		const { shop, draft } = await crashedAfterSwitch();

		const resumed = await migrate(shop, draft, { allowLoss: ALLOW, resume: true });

		expect(resumed.events.map(event => event.name)).toEqual(['onTasksMigrated']);
	});

	it('the journal says it was raised: the resume does not raise it again', async () => {
		const { shop, draft } = await crashedAfterSwitch();
		const journal = JSON.parse(fs.readFileSync(journalFileOf(shop), 'utf8')) as {
			inPlace: Record<string, unknown>;
		};
		journal.inPlace['summaryEventRaised'] = true;
		fs.writeFileSync(journalFileOf(shop), JSON.stringify(journal));

		const resumed = await migrate(shop, draft, { allowLoss: ALLOW, resume: true });

		expect(resumed.status).toBe('completed');
		expect(resumed.events).toEqual([]);
	});
});
