import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { UnsupportedByBackendError } from '@wadeck-app/task-core';

import { describeError } from '../../describeError.js';
import { addLabel, setMeta, setType } from '../../taskFields.js';
import { createTask } from '../../createTask.js';
import { executeDelete, planDelete } from '../../deleteTasks.js';
import { linkTasks } from '../../links.js';
import { listTasks } from '../../listTasks.js';
import { openTaskContext } from '../../openContext.js';
import { setParent } from '../../hierarchy.js';
import { setStatus } from '../../setStatus.js';
import { setTaskText } from '../../setTaskText.js';
import { addComment } from '../../comments.js';
import { checkStrategy } from '../../strategyCheck.js';
import { showStrategy } from '../../strategyReport.js';
import type { StrategyTarget } from '../../strategyReport.js';
import { StrategyConfigError } from '../../strategyConfig.js';
import { createBuiltinRegistry } from '../builtinPlugins.js';
import type { CheckLine, StrategyContext } from '../kinds.js';
import { FakeGitHub } from './fakeGitHub.testkit.js';
import { sendsTokenInClear } from './githubCheck.js';
import { githubPlugin, webBaseOf } from './githubPlugin.js';

let root: string;
let fake: FakeGitHub;

beforeEach(async () => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-service-open-'));
	fake = await FakeGitHub.start({ repo: 'acme/shop' });
});

afterEach(async () => {
	await fake.stop();
	fs.rmSync(root, { recursive: true, force: true });
});

const STATUSES = `statuses:
    - backlog
    - in-progress
    - { name: done, terminal: true }
    - { name: cancelled, terminal: true, outcome: negative }
`;

function config(extraOptions = '', section = 'github'): string {
	return `${STATUSES}strategy:
    type: ${section}
    options:
        repo: acme/shop
        baseUrl: ${fake.baseUrl}
        tokenEnv: GH_TOKEN_FOR_TESTS
        cache: { ttlSeconds: 0 }
        writeSpacingSeconds: 0
        statusMap:
            backlog: { state: open }
            in-progress: { state: open, label: 'status:in-progress' }
            done: { state: closed }
            cancelled: { state: closed, reason: not_planned }
${extraOptions}`;
}

function storage(configYml: string) {
	const configFile = path.join(root, 'config', 'config.yml');
	fs.mkdirSync(path.dirname(configFile), { recursive: true });
	fs.writeFileSync(configFile, configYml, 'utf8');
	return { dataDir: path.join(root, 'data'), configFiles: [configFile] };
}

function open(configYml: string, env: NodeJS.ProcessEnv = { GH_TOKEN_FOR_TESTS: fake.token }) {
	return openTaskContext({
		storage: storage(configYml),
		globalConfigDir: path.join(root, 'global'),
		project: { id: 'a1b2c3d4', name: 'shop', path: root },
		env,
	});
}

function target(configYml: string, env: NodeJS.ProcessEnv = { GH_TOKEN_FOR_TESTS: fake.token }): StrategyTarget {
	return {
		storage: storage(configYml),
		project: { id: 'a1b2c3d4', name: 'shop', path: root },
		globalConfigDir: path.join(root, 'global'),
		env,
	};
}

const line = (lines: CheckLine[], name: string): CheckLine | undefined => lines.find(l => l.name === name);

describe('the plugin is registered', () => {
	it('under its ref and its alias, as a strategy', () => {
		const registry = createBuiltinRegistry();

		expect(registry.lookup('github', 'strategy')).toBe(githubPlugin);
		expect(registry.lookup('plugins.github.default', 'strategy')).toBe(githubPlugin);
		expect(registry.list('strategy').map(entry => entry.aliases[0])).toEqual(['github', 'local']);
	});

	it('declares its capabilities and the one fill it implements', () => {
		expect(githubPlugin.backendKind).toBe('github');
		expect(githubPlugin.capabilities).toMatchObject({
			writes: 'full',
			ids: 'assigned',
			search: 'native',
			meta: false,
			delete: 'no',
		});
		expect(githubPlugin.fillTechniques).toEqual({
			meta: ['labels', 'body-block'],
			delete: ['tombstone', 'hard'],
			'linkTypes.duplicateOf': ['duplicate-marker'],
		});
	});

	it('documents itself: every option, and a snippet that is a working config', () => {
		const { summary, options, snippet } = githubPlugin.describe();

		expect(summary).toMatch(/read and written/i);
		expect(summary).not.toMatch(/read-only/i);
		expect(Object.keys(options)).toEqual(
			expect.arrayContaining([
				'repo',
				'baseUrl',
				'tokenEnv',
				'tokenFile',
				'statusMap',
				'typeMap',
				'cache',
				'writeSpacingSeconds',
				'fills',
			])
		);
		expect(snippet).toContain('type: github');
		expect(snippet).toContain('tokenEnv: GITHUB_TOKEN');
	});
});

describe('webBaseOf: where the issue pages are', () => {
	it.each([
		['https://api.github.com', 'https://github.com'],
		['https://ghe.example.com/api/v3', 'https://ghe.example.com'],
		['https://ghe.example.com/api/v3/', 'https://ghe.example.com'],
		['http://127.0.0.1:5000', 'http://127.0.0.1:5000'],
	])('%s -> %s', (api, web) => {
		expect(webBaseOf(api)).toBe(web);
	});
});

describe('configuration errors name the file and the key, at load', () => {
	it('a status without an entry in the map', () => {
		const text = config().replace('            cancelled: { state: closed, reason: not_planned }\n', '');

		const error = (() => {
			try {
				open(text);
			} catch (caught) {
				return caught as StrategyConfigError;
			}
			throw new Error('expected a refusal');
		})();

		expect(error).toBeInstanceOf(StrategyConfigError);
		expect(error.message).toBe(
			`${path.join(root, 'config', 'config.yml')}: strategy.options.statusMap.cancelled: the status "cancelled" of the project has no entry; add it, for example: cancelled: { state: closed, reason: not_planned }`
		);
	});

	it('an unknown option, a bad repo, a literal token', () => {
		expect(() => open(config('        colour: red\n'))).toThrow(
			/strategy\.options\.colour: unknown option for strategy "github"/
		);
		expect(() => open(config().replace('repo: acme/shop', 'repo: shop'))).toThrow(
			/strategy\.options\.repo: "shop" is not of the form owner\/name/
		);
		expect(() => open(config('        token: ghp_abcdefghijklmnopqrstuvwxyz0123456789\n'))).toThrow(
			/a credential must not be written in the config file/
		);
	});

	it('both token sources, or none', () => {
		expect(() => open(config('        tokenFile: /tmp/t\n'))).toThrow(/give tokenEnv or tokenFile, not both/);
		expect(() => open(config().replace('        tokenEnv: GH_TOKEN_FOR_TESTS\n', ''))).toThrow(
			/tokenEnv: required/
		);
	});

	it('a fill the plugin does not implement is refused with what it implements', () => {
		expect(() => open(config('        fills:\n            status: label\n'))).toThrow(
			/does not implement the fill "label" for status \(it implements no fill for status; its fills: /
		);
	});

	it('an approximate fill needs fidelity: degrade, an exact one does not', () => {
		expect(() => open(config('        fills:\n            delete: tombstone\n'))).toThrow(
			/"tombstone" is approximate and fidelity is strict/
		);
		expect(() => open(config('        fills:\n            delete: hard\n'))).not.toThrow();
		expect(() => open(config('        fills:\n            meta: body-block\n'))).toThrow(
			/"body-block" is approximate and fidelity is strict/
		);
		expect(() =>
			open(config('        fills:\n            meta: { use: body-block, fidelity: degrade }\n'))
		).not.toThrow();
	});
});

describe('the token', () => {
	it('a missing variable fails the first read with the project, the file, the key and the way to set it', async () => {
		const ctx = open(config(), {});

		const error = await ctx.store.list().catch((caught: unknown) => caught as Error);
		const described = describeError(error);

		expect(described.kind).toBe('unavailable');
		expect(described.message).toContain('No GitHub token: the environment variable GH_TOKEN_FOR_TESTS is not set');
		expect(described.message).toContain('project "shop"');
		expect(described.message).toContain(path.join(root, 'config', 'config.yml'));
		expect(described.hint).toContain('export GH_TOKEN_FOR_TESTS=<token>');
		expect(fake.requests).toEqual([]);
	});

	it('a token the server refuses is a 401 with the permissions to give, and never shows the token', async () => {
		const ctx = open(config(), { GH_TOKEN_FOR_TESTS: 'not-the-right-token' });

		const error = await ctx.store.list().catch((caught: unknown) => caught as Error);
		const described = describeError(error);

		expect(described.kind).toBe('unavailable');
		expect(described.message).toContain('GitHub refused the token (401');
		expect(described.hint).toContain('Issues: Read and Metadata: Read');
		expect(`${described.message} ${described.hint}`).not.toContain('not-the-right-token');
	});

	it('a token file is read', async () => {
		const tokenFile = path.join(root, 'gh-token');
		fs.writeFileSync(tokenFile, `${fake.token}\n`);
		const text = config().replace('tokenEnv: GH_TOKEN_FOR_TESTS', `tokenFile: ${tokenFile.replace(/\\/g, '/')}`);
		fake.addIssue({ title: 'From a file' });
		// The file permission check is POSIX only: on the machines that run this, Windows or a 0600 file, it passes.
		if (process.platform !== 'win32') fs.chmodSync(tokenFile, 0o600);

		const ctx = open(text, {});

		expect((await ctx.store.list()).map(task => task.title)).toEqual(['From a file']);
	});
});

describe('a project on the github strategy, through the use cases', () => {
	it('lists, shows and reads like any project: the same use cases, the issue number as id', async () => {
		fake.addIssue({ title: 'First', labels: ['status:in-progress', 'billing'] });
		fake.addIssue({ title: 'Second', state: 'closed' });
		const ctx = open(config());

		const open_ = await listTasks(ctx, {});
		const all = await listTasks(ctx, { showAll: true });

		expect(open_.map(task => [task.id, task.status])).toEqual([['1', 'in-progress']]);
		expect(all.map(task => [task.id, task.status])).toEqual([
			['1', 'in-progress'],
			['2', 'done'],
		]);
		expect(ctx.store.kind).toBe('github');
		await ctx.dispose?.();
	});

	it('writes reach GitHub through the same use cases and answer with the events of a local project', async () => {
		fake.addIssue({ title: 'First' });
		fake.addIssue({ title: 'Second' });
		const ctx = open(config());

		const created = await createTask(ctx, { title: 'New' });
		const moved = await setStatus(ctx, { id: '1', status: 'in-progress' });
		const text = await setTaskText(ctx, { id: '1', title: 'Changed' });
		const labelled = await addLabel(ctx, { id: '1', label: 'urgent' });
		const typed = await setType(ctx, { id: '1', type: 'bug' });
		const parented = await setParent(ctx, { id: '2', parent: '1' });
		const linked = await linkTasks(ctx, { id: '1', type: 'blockedBy', target: '2' });
		const commented = await addComment(ctx, { id: '1', text: 'hi' });

		expect(created.task).toMatchObject({ id: '3', title: 'New', status: 'backlog' });
		expect(created.events.map(event => event.name)).toEqual(['onTaskCreated']);
		expect(moved.events.map(event => event.name)).toEqual(['onStatusChange']);
		expect(moved.events[0]!.payload).toMatchObject({ taskId: '1', oldStatus: 'backlog', newStatus: 'in-progress' });
		expect(text.task.title).toBe('Changed');
		expect(labelled.events.map(event => event.name)).toEqual(['onTaskLabelAdded']);
		expect(typed.events.map(event => event.name)).toEqual(['onTaskTypeChanged']);
		expect(parented.events.map(event => event.name)).toEqual(['onTaskParentChanged']);
		expect(linked.events.map(event => event.name)).toEqual(['onTaskLinked']);
		expect(commented.events.map(event => event.name)).toEqual(['onTaskCommentAdded']);
		for (const result of [created, moved, labelled, typed, parented, linked, commented]) {
			for (const event of result.events) {
				expect(event.payload).toMatchObject({
					taskProjectId: 'a1b2c3d4',
					taskProjectName: 'shop',
					taskProjectPath: root,
				});
			}
		}
		expect(fake.issues.get(1)).toMatchObject({
			title: 'Changed',
			labels: ['status:in-progress', 'urgent', 'type:bug'],
		});
		expect(fake.issues.get(2)!.parent).toBe(1);
		expect(fake.issues.get(1)!.blockedBy).toEqual([2]);
		await ctx.dispose?.();
	});

	it('an event is built only after the write succeeded: a refused write yields none and changes nothing', async () => {
		fake.addIssue({ title: 'First' });
		const ctx = open(config());
		fake.failNext({ status: 422, method: 'PATCH', body: { message: 'Validation Failed' } });

		const error = await setStatus(ctx, { id: '1', status: 'done' }).catch((caught: unknown) => caught as Error);

		expect(describeError(error).kind).toBe('invalid');
		expect(fake.issues.get(1)!.state).toBe('open');
		await ctx.dispose?.();
	});

	it('what needs a fill is refused with the key to write, through the use cases, before any write', async () => {
		fake.addIssue({ title: 'First' });
		const ctx = open(config());
		const attempts: Array<[string, () => Promise<unknown>]> = [
			['setMeta', () => setMeta(ctx, { id: '1', key: 'k', value: 'v' })],
			[
				'executeDelete',
				async () => executeDelete(ctx, await planDelete(ctx, { selector: { kind: 'ids', ids: ['1'] } })),
			],
			['linkTasks duplicateOf', () => linkTasks(ctx, { id: '1', type: 'duplicateOf', target: '1' })],
		];

		for (const [name, attempt] of attempts) {
			const error = await attempt().catch((caught: unknown) => caught as Error);

			expect(error, name).toBeInstanceOf(UnsupportedByBackendError);
			const described = describeError(error);
			expect(described.kind, name).toBe('unsupported');
			expect(described.hint, name).toContain('fills');
		}
		expect(fake.writes()).toEqual([]);
	});
});

describe('the cache lives in the project data folder', () => {
	it('opening and a failed first read create nothing; a read leaves the answers, never the token', async () => {
		fake.addIssue({ title: 'Cached' });
		const ctx = open(config());
		expect(fs.existsSync(path.join(root, 'data'))).toBe(false);

		await ctx.store.list();

		const cacheDir = path.join(root, 'data', 'cache', 'github');
		const files = fs.readdirSync(cacheDir);
		expect(files.length).toBeGreaterThan(0);
		for (const file of files) {
			const text = fs.readFileSync(path.join(cacheDir, file), 'utf8');
			expect(text).not.toContain(fake.token);
			expect(JSON.parse(text)).toMatchObject({ url: expect.stringContaining('/repos/acme/shop/issues') });
		}
	});

	it('the next command revalidates with If-None-Match instead of downloading again', async () => {
		fake.addIssue({ title: 'Cached' });
		await open(config()).store.list();

		await open(config()).store.list();

		expect(fake.requestsTo('/repos/acme/shop/issues').map(request => request.status)).toEqual([200, 304]);
	});

	it('when GitHub cannot be reached the cached list is shown and the context says so', async () => {
		fake.addIssue({ title: 'Remembered' });
		await open(config()).store.list();
		fake.dropNext(10);
		const ctx = open(config());

		const tasks = await ctx.store.list();

		expect(tasks.map(task => task.title)).toEqual(['Remembered']);
		const notices = ctx.takeNotices?.() ?? [];
		expect(notices).toHaveLength(1);
		expect(notices[0]).toMatchObject({ kind: 'stale' });
		expect(notices[0]!.text).toContain('Cannot reach');
		expect(ctx.takeNotices?.()).toEqual([]);
	});
});

describe('strategy show', () => {
	it('lists the capabilities as the plugin declares them: writes native, meta and delete unsupported without their fill', () => {
		const report = showStrategy(target(config()));

		expect(report).toMatchObject({ type: 'github', kind: 'github', declared: true });
		const states = Object.fromEntries(report.capabilities.map(row => [row.capability, row.state]));
		expect(states).toMatchObject({
			writes: 'native',
			meta: 'unsupported',
			delete: 'unsupported',
			hierarchy: 'partial',
			history: 'partial',
			activity: 'partial',
			'linkTypes.blockedBy': 'native',
			'linkTypes.duplicateOf': 'partial',
			'linkTypes.causedBy': 'unsupported',
			search: 'partial',
			comments: 'native',
		});
		expect(report.tokens).toEqual([
			{ key: 'strategy.options.tokenEnv', source: 'env', name: 'GH_TOKEN_FOR_TESTS', present: true },
		]);
	});

	it('with fills.meta: labels the meta row is emulated', () => {
		const report = showStrategy(target(config('        fills:\n            meta: labels\n')));

		const meta = report.capabilities.find(row => row.capability === 'meta')!;
		expect(meta).toMatchObject({ state: 'emulated' });
		expect(meta.detail).toContain('via labels');
	});

	it('the fills of stage 2 are listed as emulated, with their quality and the fidelity the project accepted', () => {
		const report = showStrategy(
			target(
				config(
					'        fills:\n            meta: { use: body-block, fidelity: degrade }\n            delete: hard\n            linkTypes.duplicateOf: { use: duplicate-marker, fidelity: degrade }\n'
				)
			)
		);

		const row = (name: string) => report.capabilities.find(candidate => candidate.capability === name)!;
		expect(row('meta')).toMatchObject({
			state: 'emulated',
			detail: 'via body-block (approximate, fidelity degrade)',
		});
		expect(row('delete')).toMatchObject({ state: 'emulated', detail: 'via hard (exact, fidelity strict)' });
		expect(row('linkTypes.duplicateOf')).toMatchObject({
			state: 'emulated',
			detail: 'via duplicate-marker (approximate, fidelity degrade)',
		});
	});

	it('with fills.meta: labels the meta is read from the labels', async () => {
		fake.addIssue({ title: 'M', labels: ['meta:owner=ann', 'billing'] });
		const ctx = open(config('        fills:\n            meta: labels\n'));

		const record = await ctx.store.get('1');

		expect(record.meta).toEqual({ owner: 'ann' });
		expect(record.labels).toEqual(['billing']);
	});
});

describe('strategy check', () => {
	it('a healthy project: reachable, token, repository, issues, limits, statuses, labels, hierarchy, writes', async () => {
		fake.addIssue({ title: 'Probe me' });
		fake.addRepoLabel('status:in-progress');

		const result = await checkStrategy(target(config()));

		expect(result.ok).toBe(true);
		expect(result.errors).toBe(0);
		expect(result.lines.map(l => [l.name, l.status])).toEqual([
			['config', 'ok'],
			['strategy', 'ok'],
			['token', 'ok'],
			['reachable', 'ok'],
			['auth', 'ok'],
			['repo', 'ok'],
			['expiry', 'ok'],
			['issues', 'ok'],
			['limits', 'ok'],
			['statuses', 'ok'],
			['labels', 'ok'],
			['hierarchy', 'ok'],
			['dependencies', 'ok'],
			['search', 'ok'],
			['writes', 'ok'],
		]);
		const writes = line(result.lines, 'writes')!;
		expect(writes.text).toContain('one at a time');
		expect(writes.text).toContain('not atomic');
		expect(writes.text).toContain('5000');
		expect(line(result.lines, 'repo')?.text).toBe('acme/shop (private)');
		expect(line(result.lines, 'limits')?.text).toMatch(
			/^\d+ of 5000 requests left this hour \(resets .*\); search 30 of 30 per minute$/
		);
		expect(line(result.lines, 'statuses')?.text).toBe(
			'4 statuses mapped: backlog = open; in-progress = open + status:in-progress; done = closed; cancelled = closed (not_planned)'
		);
		expect(fake.writes()).toEqual([]);
	});

	it.each([
		['http://ghe.example.com/api/v3', true],
		['http://192.168.1.20:8080', true],
		['https://ghe.example.com/api/v3', false],
		['http://localhost:3000', false],
		['http://127.0.0.1:3000', false],
		['http://[::1]:3000', false],
	])('the token travels in clear on %s: %s', (baseUrl, expected) => {
		expect(sendsTokenInClear(baseUrl)).toBe(expected);
	});

	it('a missing label is a warning that lists it and says where to create it', async () => {
		fake.addIssue({ title: 'x' });

		const result = await checkStrategy(target(config()));

		expect(result.ok).toBe(true);
		const labels = line(result.lines, 'labels')!;
		expect(labels.status).toBe('warn');
		expect(labels.text).toBe('1 of the 1 labels the mapping uses do not exist yet: status:in-progress');
		expect(labels.fix).toContain('task labels sync -p shop');
		expect(labels.fix).toContain('status:in-progress');
	});

	it('a token that cannot write issues is a warning on writes with the permission to give', async () => {
		await fake.stop();
		fake = await FakeGitHub.start({ repo: 'acme/shop', readOnlyToken: true });
		fake.addIssue({ title: 'x' });

		const result = await checkStrategy(target(config(), { GH_TOKEN_FOR_TESTS: fake.token }));

		const writes = line(result.lines, 'writes')!;
		expect(writes.status).toBe('warn');
		expect(writes.text).toContain('cannot write');
		expect(writes.fix).toContain('Issues: Read and write');
		expect(result.ok).toBe(true);
	});

	it('fills.delete: hard on a token whose user does not administer the repository is a warning', async () => {
		await fake.stop();
		fake = await FakeGitHub.start({ repo: 'acme/shop', admin: false });
		fake.addIssue({ title: 'x' });

		const result = await checkStrategy(
			target(config('        fills:\n            delete: hard\n'), { GH_TOKEN_FOR_TESTS: fake.token })
		);

		const writes = line(result.lines, 'writes')!;
		expect(writes.status).toBe('warn');
		expect(writes.text).toContain('delete: hard');
		expect(writes.fix).toContain('use: tombstone');
	});

	it('the labels a tombstone delete needs are counted with the others', async () => {
		fake.addIssue({ title: 'x' });

		const result = await checkStrategy(
			target(config('        fills:\n            delete: { use: tombstone, fidelity: degrade }\n'))
		);

		expect(line(result.lines, 'labels')!.text).toContain('task:deleted');
	});

	it('a wrong token fails with the 401 and the fix, and stops there', async () => {
		const result = await checkStrategy(target(config(), { GH_TOKEN_FOR_TESTS: 'nope' }));

		expect(result.ok).toBe(false);
		const auth = line(result.lines, 'auth')!;
		expect(auth.status).toBe('error');
		expect(auth.text).toContain('401');
		expect(auth.fix).toContain('GH_TOKEN_FOR_TESTS');
		expect(line(result.lines, 'issues')).toBeUndefined();
	});

	it('a missing variable is the token line, and the backend line says the same with the project and file', async () => {
		const result = await checkStrategy(target(config(), {}));

		expect(result.ok).toBe(false);
		expect(line(result.lines, 'token')).toMatchObject({ status: 'error' });
		expect(line(result.lines, 'backend')?.text).toContain('No GitHub token');
		expect(fake.requests).toEqual([]);
	});

	it('an unknown repository is "not found or not visible" with the two things to check', async () => {
		const result = await checkStrategy(target(config().replace('repo: acme/shop', 'repo: acme/other')));

		const repo = line(result.lines, 'repo')!;
		expect(repo.status).toBe('error');
		expect(repo.text).toBe('acme/other was not found, or this token cannot see it');
		expect(repo.fix).toContain('strategy.options.repo');
		expect(repo.fix).toContain('GH_TOKEN_FOR_TESTS');
	});

	it('Issues disabled on the repository is an error with the settings page', async () => {
		await fake.stop();
		fake = await FakeGitHub.start({ repo: 'acme/shop', hasIssues: false });

		const result = await checkStrategy(target(config()));

		expect(line(result.lines, 'issues')).toMatchObject({
			status: 'error',
			text: 'Issues are disabled on acme/shop',
		});
		expect(line(result.lines, 'issues')!.fix).toContain('/settings');
	});

	it('a token without the Issues permission names what GitHub says is needed', async () => {
		await fake.stop();
		fake = await FakeGitHub.start({ repo: 'acme/shop', denyIssues: true });

		const result = await checkStrategy(target(config()));

		const issues = line(result.lines, 'issues')!;
		expect(issues.status).toBe('error');
		expect(issues.fix).toContain('issues=read');
	});

	it('an expiring token is a warning with the date, an expired one an error', async () => {
		const stamp = (days: number): string =>
			new Date(Date.now() + days * 86_400_000)
				.toISOString()
				.replace('T', ' ')
				.replace(/\.\d+Z$/, ' UTC');
		await fake.stop();
		fake = await FakeGitHub.start({ repo: 'acme/shop', tokenExpiration: stamp(3) });
		const soon = await checkStrategy(target(config()));
		await fake.stop();
		fake = await FakeGitHub.start({ repo: 'acme/shop', tokenExpiration: stamp(-1) });
		const past = await checkStrategy(target(config()));

		expect(line(soon.lines, 'expiry')).toMatchObject({ status: 'warn' });
		expect(line(soon.lines, 'expiry')!.text).toMatch(/expires in [34] days/);
		expect(line(past.lines, 'expiry')).toMatchObject({ status: 'error' });
		expect(past.ok).toBe(false);
	});

	it('a low quota is a warning that says when it resets', async () => {
		fake.setRateLimit('core', { limit: 5000, remaining: 20, resetAt: Math.floor(Date.now() / 1000) + 900 });

		const result = await checkStrategy(target(config()));

		const limits = line(result.lines, 'limits')!;
		expect(limits.status).toBe('warn');
		expect(limits.fix).toContain('Wait until');
	});

	it('an exhausted quota is an error line with the retry instant', async () => {
		fake.setRateLimit('core', { remaining: 0, resetAt: Math.floor(Date.now() / 1000) + 900 });

		const result = await checkStrategy(target(config()));

		expect(result.ok).toBe(false);
		expect(line(result.lines, 'limits')?.fix).toContain('Retry after');
	});

	it('an unreachable server is a reachable error with the network fix', async () => {
		const port = new URL(fake.baseUrl).port;
		await fake.stop();

		const result = await checkStrategy(target(config().replace(fake.baseUrl, `http://127.0.0.1:${port}`)));

		expect(line(result.lines, 'reachable')).toMatchObject({ status: 'error' });
		expect(line(result.lines, 'reachable')!.fix).toContain('baseUrl');
		fake = await FakeGitHub.start({ repo: 'acme/shop' });
	});

	it('probes sub-issues and dependencies on an existing issue, and warns where the server lacks them', async () => {
		fake.addIssue({ title: 'Probe me' });
		fake.failNext({
			status: 404,
			body: { message: 'Not Found' },
			pathPrefix: '/repos/acme/shop/issues/1/sub_issues',
		});

		const result = await checkStrategy(target(config()));

		const hierarchy = line(result.lines, 'hierarchy')!;
		expect(hierarchy.status).toBe('warn');
		expect(hierarchy.text).toContain('every task reads as a root task');
		expect(line(result.lines, 'dependencies')?.status).toBe('ok');
	});
});

describe('the request lines of TASK_DEBUG=1 go to the task log, without any secret', () => {
	it('logs what was asked and the quota, and not the token', async () => {
		fake.addIssue({ title: 'Debug' });
		const logged: string[] = [];
		const context: StrategyContext = {
			source: path.join(root, 'config', 'config.yml'),
			statuses: [
				{ name: 'backlog', terminal: false, default: true, outcome: undefined },
				{ name: 'in-progress', terminal: false, default: false, outcome: undefined },
				{ name: 'done', terminal: true, default: false, outcome: 'positive' },
				{ name: 'cancelled', terminal: true, default: false, outcome: 'negative' },
			],
			types: [],
			project: { name: 'shop' },
			dataDir: path.join(root, 'data'),
			tasksDir: path.join(root, 'data', 'tasks'),
			writeFile: (file, content) => fs.writeFileSync(file, content),
			env: { GH_TOKEN_FOR_TESTS: fake.token, TASK_DEBUG: '1' },
			fidelity: 'strict',
			fills: {},
			log: (level, message) => logged.push(`${level} ${message}`),
		};
		const instance = await githubPlugin.create(
			{
				repo: 'acme/shop',
				baseUrl: fake.baseUrl,
				tokenEnv: 'GH_TOKEN_FOR_TESTS',
				statusMap: {
					backlog: { state: 'open' },
					'in-progress': { state: 'open', label: 'status:in-progress' },
					done: { state: 'closed' },
					cancelled: { state: 'closed', reason: 'not_planned' },
				},
			},
			context
		);

		await instance.backend.list();

		expect(logged.length).toBeGreaterThan(0);
		expect(logged[0]).toMatch(
			/^info github: GET \/repos\/acme\/shop\/issues\?.* -> 200 \(\d+ ms, rate limit remaining \d+\)$/
		);
		expect(logged.join('\n')).not.toContain(fake.token);
		expect(instance.describe().join('\n')).not.toContain(fake.token);
		expect(instance.describe().join('\n')).toContain('GH_TOKEN_FOR_TESTS');
	});
});
