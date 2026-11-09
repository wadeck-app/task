import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { BackendAuthError } from '@wadeck-app/task-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { describeError } from '../../describeError.js';
import { openTaskContext } from '../../openContext.js';
import { StrategyConfigError } from '../../strategyConfig.js';
import { checkStrategy } from '../../strategyCheck.js';
import { showStrategy } from '../../strategyReport.js';
import type { StrategyTarget } from '../../strategyReport.js';
import { createPluginRegistry } from '../../plugin-host/index.js';
import type { StrategyContext, TaskPluginKinds } from '../kinds.js';
import { localPlugin } from '../local/localPlugin.js';
import { plainHttpPlugin } from '../plain-http/plainHttpPlugin.js';
import { FakeGitLab } from './fakeGitLab.testkit.js';
import { gitlabCapabilities } from './GitLabBackend.js';
import { gitlabPlugin, issueUrlOf } from './gitlabPlugin.js';
import { parseGitLabOptions } from './gitlabOptions.js';

// The built-in list is not ours to edit from here: a private registry holds the plugins this file needs.
const registry = () =>
	createPluginRegistry<TaskPluginKinds>([
		{ ref: 'plugins.local.default', plugin: localPlugin, aliases: ['local'] },
		{ ref: 'plugins.gitlab.default', plugin: gitlabPlugin, aliases: ['gitlab'] },
		{ ref: 'plugins.plain-http.default', plugin: plainHttpPlugin, aliases: ['plain-http'] },
	]);

const STATUS_MAP = {
	backlog: { state: 'open' },
	'in-progress': { state: 'open', label: 'status:in-progress' },
	done: { state: 'closed' },
};
const STATUS_FACTS = [
	{ name: 'backlog', terminal: false, default: true, outcome: undefined },
	{ name: 'in-progress', terminal: false, default: false, outcome: undefined },
	{ name: 'done', terminal: true, default: false, outcome: 'positive' as const },
];

let root: string;
let fake: FakeGitLab;

beforeEach(async () => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-service-open-'));
	fake = await FakeGitLab.start();
});

afterEach(async () => {
	await fake.stop();
	fs.rmSync(root, { recursive: true, force: true });
});

const CONFIG_STATUSES = `statuses:
    - backlog
    - in-progress
    - { name: done, terminal: true }
`;

function config(extraOptions = ''): string {
	return `${CONFIG_STATUSES}strategy:
    type: gitlab
    options:
        project: ${fake.project}
        baseUrl: ${fake.baseUrl}
        tier: free
        tokenEnv: GL_TOKEN_FOR_TESTS
        cache: { ttlSeconds: 0 }
        writeSpacingSeconds: 0
        statusMap:
            backlog: { state: open }
            in-progress: { state: open, label: 'status:in-progress' }
            done: { state: closed }
${extraOptions}`;
}

function storage(configYml: string) {
	const configFile = path.join(root, 'config', 'config.yml');
	fs.mkdirSync(path.dirname(configFile), { recursive: true });
	fs.writeFileSync(configFile, configYml, 'utf8');
	return { dataDir: path.join(root, 'data'), configFiles: [configFile] };
}

function open(configYml: string, env: NodeJS.ProcessEnv = { GL_TOKEN_FOR_TESTS: fake.token }) {
	return openTaskContext({
		storage: storage(configYml),
		globalConfigDir: path.join(root, 'global'),
		project: { id: 'a1b2c3d4', name: 'shop', path: root },
		env,
		registry: registry(),
	});
}

function target(configYml: string, env: NodeJS.ProcessEnv = { GL_TOKEN_FOR_TESTS: fake.token }): StrategyTarget {
	return {
		storage: storage(configYml),
		project: { id: 'a1b2c3d4', name: 'shop', path: root },
		globalConfigDir: path.join(root, 'global'),
		env,
		registry: registry(),
	};
}

describe('the plugin is registered', () => {
	it('under its ref and its alias, as a strategy', () => {
		const reg = registry();

		expect(reg.lookup('gitlab', 'strategy')).toBe(gitlabPlugin);
		expect(reg.lookup('plugins.gitlab.default', 'strategy')).toBe(gitlabPlugin);
	});

	it('declares its kind, its floor of capabilities and the fills it implements', () => {
		expect(gitlabPlugin.backendKind).toBe('gitlab');
		expect(gitlabPlugin.capabilities).toMatchObject({
			writes: 'full',
			ids: 'assigned',
			search: 'native',
			hierarchy: 'none',
			meta: false,
			delete: 'no',
			linkTypes: [],
		});
		expect(gitlabPlugin.fillTechniques).toEqual({
			meta: ['labels', 'body-block'],
			delete: ['tombstone', 'hard'],
			'linkTypes.duplicateOf': ['relate-block'],
			'linkTypes.causedBy': ['relate-block'],
		});
	});

	it('documents itself: every option, the not-verified warning, and a snippet that is a working config', () => {
		const { summary, options, snippet } = gitlabPlugin.describe();

		expect(summary).toMatch(/NOT verified against a real GitLab/);
		expect(Object.keys(options)).toEqual(
			expect.arrayContaining([
				'project',
				'baseUrl',
				'tokenEnv',
				'tokenFile',
				'tier',
				'statusMap',
				'typeMap',
				'cache',
				'writeSpacingSeconds',
				'fills',
			])
		);
		expect(snippet).toContain('type: gitlab');
		expect(snippet).toContain('tier: free');
		expect(snippet).toContain('tokenEnv: GITLAB_TOKEN');
		// The snippet parses with the plugin's own options parser.
		const lines = snippet.split('\n').slice(3);
		expect(lines.length).toBeGreaterThan(3);
	});
});

describe('capabilitiesFor: the tier and the fills decide', () => {
	const options = (tier: string) => ({ project: 'g/p', tokenEnv: 'T', tier, statusMap: STATUS_MAP });

	it('free has no link type; premium and ultimate have blockedBy', () => {
		expect(gitlabPlugin.capabilitiesFor?.({}, options('free')).linkTypes).toEqual([]);
		expect(gitlabPlugin.capabilitiesFor?.({}, options('premium')).linkTypes).toEqual(['blockedBy']);
		expect(gitlabPlugin.capabilitiesFor?.({}, options('ultimate')).linkTypes).toEqual(['blockedBy']);
	});

	it('the fills add duplicateOf, causedBy, meta and delete', () => {
		const fills = {
			meta: { use: 'labels', fidelity: 'strict' as const },
			delete: { use: 'hard', fidelity: 'strict' as const },
			'linkTypes.duplicateOf': { use: 'relate-block', fidelity: 'degrade' as const },
			'linkTypes.causedBy': { use: 'relate-block', fidelity: 'degrade' as const },
		};

		const caps = gitlabPlugin.capabilitiesFor?.(fills, options('premium'));

		expect(caps).toMatchObject({ meta: true, delete: 'yes', hierarchy: 'none' });
		expect(caps?.linkTypes).toEqual(['blockedBy', 'duplicateOf', 'causedBy']);
		expect(
			gitlabPlugin.capabilitiesFor?.({ delete: { use: 'tombstone', fidelity: 'degrade' } }, options('free'))
		).toMatchObject({
			delete: 'close-only',
		});
		expect(caps).toEqual(gitlabCapabilities('premium', fills));
	});
});

describe('validate, validateForProject, traitsFor, locationOf', () => {
	const good = { project: 'g/p', tokenEnv: 'T', tier: 'free', statusMap: STATUS_MAP };

	it('validate returns the raw "key: problem" sentence of the first problem', () => {
		expect(gitlabPlugin.validate(good, { slot: 'strategy' })).toBeUndefined();
		expect(gitlabPlugin.validate({ ...good, colour: 'red' }, { slot: 'strategy' })).toMatch(
			/^colour: unknown option for strategy "gitlab"/
		);
		expect(gitlabPlugin.validate({ ...good, tier: undefined }, { slot: 'strategy' })).toMatch(/^tier: required/);
		expect(gitlabPlugin.validate({ ...good, project: 'shop' }, { slot: 'strategy' })).toMatch(/^project: "shop"/);
	});

	it('validateForProject checks the map against the statuses', () => {
		expect(gitlabPlugin.validateForProject?.(good, { statuses: STATUS_FACTS, types: [] })).toBeUndefined();
		const missing = { ...good, statusMap: { backlog: { state: 'open' }, done: { state: 'closed' } } };

		expect(gitlabPlugin.validateForProject?.(missing, { statuses: STATUS_FACTS, types: [] })).toMatch(
			/^statusMap\.in-progress: the status "in-progress" of the project has no entry/
		);
	});

	it('traitsFor hands out the traits, locationOf the instance and the project', () => {
		expect(gitlabPlugin.traitsFor?.(good, {}, { statuses: STATUS_FACTS, types: [] })).toMatchObject({
			keepsCreatedAt: false,
			authoredComments: false,
		});
		expect(gitlabPlugin.locationOf?.({ ...good, project: 'Group/Proj' })).toBe(
			'gitlab https://gitlab.com/api/v4 group/proj'
		);
		expect(gitlabPlugin.locationOf?.({ project: 'x' })).toBeUndefined();
	});
});

describe('issueUrlOf', () => {
	it('a path project has a page, a numeric one only the API address', () => {
		const path_ = parseGitLabOptions({ project: 'g/sub/p', tokenEnv: 'T', tier: 'free', statusMap: STATUS_MAP });
		const numeric = parseGitLabOptions({
			project: 42,
			baseUrl: 'https://git.example.com/api/v4',
			tokenEnv: 'T',
			tier: 'free',
			statusMap: STATUS_MAP,
		});
		if ('problem' in path_ || 'problem' in numeric) throw new Error('options');

		expect(issueUrlOf(path_.settings)(7)).toBe('https://gitlab.com/g/sub/p/-/issues/7');
		expect(issueUrlOf(numeric.settings)(7)).toBe('https://git.example.com/api/v4/projects/42/issues/7');
	});
});

describe('configuration errors name the file and the key, at load', () => {
	it('the tier is required, with what it decides', () => {
		const text = config().replace('        tier: free\n', '');

		expect(() => open(text)).toThrow(StrategyConfigError);
		expect(() => open(text)).toThrow(/strategy\.options\.tier: tier: required|strategy\.options\.tier: required/);
	});

	it('a status without an entry in the map', () => {
		const text = config().replace("            in-progress: { state: open, label: 'status:in-progress' }\n", '');

		expect(() => open(text)).toThrow(
			`${path.join(root, 'config', 'config.yml')}: strategy.options.statusMap.in-progress: the status "in-progress" of the project has no entry`
		);
	});

	it('a literal token is refused', () => {
		expect(() => open(config('        token: glpat-abcdefghijklmnopqrstuvwxyz\n'))).toThrow(
			/a credential must not be written in the config file/
		);
	});
});

describe('the token', () => {
	it('a missing variable fails the first call naming the project, the file, the key and how to set it', async () => {
		const ctx = open(config(), {});

		const error = await ctx.store.list().catch((caught: unknown) => caught as Error);

		expect((error as Error).cause).toBeInstanceOf(BackendAuthError);
		const described = describeError(error);
		expect(described.message).toContain('No GitLab token: the environment variable GL_TOKEN_FOR_TESTS is not set');
		expect(described.message).toContain('project "shop"');
		expect(described.message).toContain(path.join(root, 'config', 'config.yml'));
		expect(described.hint).toContain('export GL_TOKEN_FOR_TESTS=<token>');
		expect(fake.requests).toEqual([]);
	});

	it('a token from the environment is used (PRIVATE-TOKEN) and the tasks are the issues', async () => {
		fake.seedIssue({ title: 'First', labels: ['status:in-progress'] });
		const ctx = open(config());

		const tasks = await ctx.store.list();

		expect(tasks.map(task => [task.id, task.title, task.status])).toEqual([['1', 'First', 'in-progress']]);
		expect(ctx.store.kind).toBe('gitlab');
		await ctx.dispose?.();
	});

	it('a refused token never shows in the message', async () => {
		const ctx = open(config(), { GL_TOKEN_FOR_TESTS: 'not-the-right-token' });

		const error = await ctx.store.list().catch((caught: unknown) => caught as Error);
		const described = describeError(error);

		expect(`${described.message} ${described.hint}`).not.toContain('not-the-right-token');
		expect(described.message).toContain('GitLab refused the token (401');
	});
});

describe('the instance', () => {
	async function instance() {
		const parsed = parseGitLabOptions({
			project: fake.project,
			baseUrl: fake.baseUrl,
			tier: 'premium',
			tokenEnv: 'GL_TOKEN_FOR_TESTS',
			statusMap: STATUS_MAP,
		});
		if ('problem' in parsed) throw new Error(parsed.problem);
		const context: StrategyContext = {
			source: path.join(root, 'config.yml'),
			statuses: STATUS_FACTS,
			types: [],
			project: { id: 'a1b2c3d4', name: 'shop', path: root },
			tasksDir: path.join(root, 'tasks'),
			dataDir: path.join(root, 'data'),
			writeFile: () => undefined,
			env: { GL_TOKEN_FOR_TESTS: fake.token },
			fidelity: 'strict',
			fills: {},
			log: () => undefined,
		};
		return gitlabPlugin.create(
			{
				project: fake.project,
				baseUrl: fake.baseUrl,
				tier: 'premium',
				tokenEnv: 'GL_TOKEN_FOR_TESTS',
				statusMap: STATUS_MAP,
			},
			context
		);
	}

	it('describes the tier and says it is not verified against a real GitLab', async () => {
		const lines = (await instance()).describe();

		expect(lines.some(l => l.startsWith('tier: premium (declared'))).toBe(true);
		expect(lines.some(l => l.includes('NOT verified against a real GitLab instance'))).toBe(true);
		expect(lines.join('\n')).not.toContain(fake.token);
	});

	it('has no notices before a read, hands them out once, and disposes', async () => {
		const created = await instance();

		expect(created.takeNotices?.()).toEqual([]);
		await expect(created.dispose()).resolves.toBeUndefined();
	});
});

describe('task strategy show and check through the host', () => {
	it('show prints the capability table of the tier (blockedBy unsupported on free)', () => {
		const report = showStrategy(target(config()));

		expect(report.kind).toBe('gitlab');
		expect(report.capabilities.find(row => row.capability === 'linkTypes.blockedBy')).toMatchObject({
			state: 'unsupported',
		});
		expect(report.capabilities.find(row => row.capability === 'hierarchy')).toMatchObject({ state: 'unsupported' });
		expect(report.options['tier']).toBe('free');
	});

	it('show on premium has blockedBy native', () => {
		const report = showStrategy(target(config().replace('tier: free', 'tier: premium')));

		expect(report.capabilities.find(row => row.capability === 'linkTypes.blockedBy')).toMatchObject({
			state: 'native',
		});
	});

	it('check runs the gitlab lines and always ends with the verification warning (exit stays ok)', async () => {
		const result = await checkStrategy(target(config()));

		const names = result.lines.map(l => l.name);
		expect(names).toEqual(
			expect.arrayContaining(['reachable', 'auth', 'project', 'tier', 'issues', 'verification'])
		);
		expect(names.at(-1)).toBe('verification');
		expect(result.lines.at(-1)).toMatchObject({ status: 'warn' });
		expect(result.errors).toBe(0);
		expect(result.ok).toBe(true);
	});
});
