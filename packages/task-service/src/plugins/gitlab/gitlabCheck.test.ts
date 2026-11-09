import { afterEach, describe, expect, it } from 'vitest';

import type { CheckLine, DeclaredFills, ProjectStatus } from '../kinds.js';
import { FakeGitLab } from './fakeGitLab.testkit.js';
import type { FakeGitLabOptions } from './fakeGitLab.testkit.js';
import { checkGitLab, tierOfPlan, VERIFICATION_TEXT } from './gitlabCheck.js';
import { GitLabClient } from './gitlabClient.js';
import { parseGitLabOptions } from './gitlabOptions.js';

const STATUSES: ProjectStatus[] = [
	{ name: 'backlog', terminal: false, default: true, outcome: undefined },
	{ name: 'in-progress', terminal: false, default: false, outcome: undefined },
	{ name: 'done', terminal: true, default: false, outcome: 'positive' },
];

let fake: FakeGitLab | undefined;

afterEach(async () => {
	await fake?.stop();
	fake = undefined;
});

interface Run {
	options?: Record<string, unknown>;
	fills?: DeclaredFills;
	fakeOptions?: FakeGitLabOptions;
	token?: string;
	now?: () => number;
	types?: string[];
	seed?: (server: FakeGitLab) => void;
}

async function run(setup: Run = {}): Promise<{ lines: CheckLine[]; fake: FakeGitLab }> {
	fake = await FakeGitLab.start(setup.fakeOptions);
	setup.seed?.(fake);
	const parsed = parseGitLabOptions({
		project: fake.project,
		baseUrl: fake.baseUrl,
		tokenEnv: 'GITLAB_TOKEN',
		tier: fake.tier,
		statusMap: {
			backlog: { state: 'open' },
			'in-progress': { state: 'open', label: 'status:in-progress' },
			done: { state: 'closed' },
		},
		writeSpacingSeconds: 0,
		...setup.options,
	});
	if ('problem' in parsed) throw new Error(parsed.problem);
	const { settings } = parsed;
	const client = new GitLabClient({
		baseUrl: settings.baseUrl,
		token: setup.token ?? fake.token,
		project: settings.project.ref,
		tokenHint: 'the environment variable GITLAB_TOKEN (strategy.options.tokenEnv)',
		timeoutMs: 2000,
		cacheTtlMs: 0,
		writeSpacingMs: 0,
	});
	const lines = await checkGitLab({
		client,
		settings,
		project: { statuses: STATUSES, types: setup.types ?? [] },
		projectUrl: 'https://gitlab.example/group/project',
		now: setup.now ?? Date.now,
		tokenHint: 'the environment variable GITLAB_TOKEN (strategy.options.tokenEnv)',
		fills: setup.fills ?? {},
		projectName: 'shop',
	});
	return { lines, fake };
}

const line = (lines: CheckLine[], name: string): CheckLine | undefined => lines.find(l => l.name === name);
const names = (lines: CheckLine[]): string[] => lines.map(l => l.name);

describe('tierOfPlan', () => {
	it.each([
		['free', 'free'],
		['default', 'free'],
		['Premium', 'premium'],
		['silver', 'premium'],
		['ultimate', 'ultimate'],
		['gold', 'ultimate'],
		['bronze', undefined],
	])('%s -> %s', (plan, tier) => {
		expect(tierOfPlan(plan)).toBe(tier);
	});
});

describe('checkGitLab on a healthy project', () => {
	it('lists the lines in order, ends with the verification warning, and writes nothing', async () => {
		const { lines, fake: server } = await run();

		expect(lines.map(l => [l.name, l.status])).toEqual([
			['reachable', 'ok'],
			['auth', 'ok'],
			['project', 'ok'],
			['tier', 'ok'],
			['issues', 'ok'],
			['limits', 'ok'],
			['statuses', 'ok'],
			['labels', 'warn'],
			['links', 'ok'],
			['hierarchy', 'ok'],
			['writes', 'ok'],
			['verification', 'warn'],
		]);
		expect(server.writes()).toEqual([]);
		const verification = line(lines, 'verification')!;
		expect(verification.text).toBe(VERIFICATION_TEXT);
		expect(verification.text).toContain('not been verified against a real GitLab instance');
		expect(verification.fix).toContain('task migrate --dry-run');
		expect(line(lines, 'writes')!.text).toContain('not atomic');
		expect(line(lines, 'statuses')!.text).toBe(
			'3 statuses mapped: backlog = open; in-progress = open + status:in-progress; done = closed'
		);
	});

	it('reachable carries the version and the round trip', async () => {
		let t = 0;
		const { lines } = await run({ now: () => (t += 10) });

		expect(line(lines, 'reachable')!.text).toMatch(/answered \(GitLab .*, 10 ms\)$/);
	});

	it('a slow answer is a warning', async () => {
		let t = 0;
		const { lines } = await run({ now: () => (t += 700) });

		expect(line(lines, 'reachable')).toMatchObject({ status: 'warn' });
	});

	it('shows the access level with its label and says tier first', async () => {
		const { lines } = await run({ fakeOptions: { accessLevel: 50 } });

		expect(line(lines, 'project')!.text).toContain('access level 50 (Owner?)');
		expect(line(lines, 'tier')!.text).toContain('tier: free');
	});
});

describe('auth', () => {
	it('a personal token with scope api is ok and shows scopes and expiry', async () => {
		const now = Date.parse('2026-11-09T10:00:00Z');
		const { lines } = await run({
			fakeOptions: { tokenScopes: ['api'], tokenExpiresAt: '2026-12-31' },
			now: () => now,
		});

		expect(line(lines, 'auth')).toMatchObject({ status: 'ok' });
		expect(line(lines, 'auth')!.text).toContain('scopes api');
		expect(line(lines, 'auth')!.text).toContain('expires 2026-12-31');
	});

	it('a read_api token warns that every write is refused, and writes repeats it', async () => {
		const { lines } = await run({ fakeOptions: { tokenScopes: ['read_api'] } });

		expect(line(lines, 'auth')).toMatchObject({ status: 'warn' });
		expect(line(lines, 'auth')!.text).toContain('lacks the scope api');
		expect(line(lines, 'auth')!.fix).toContain('scope api');
		expect(line(lines, 'writes')).toMatchObject({ status: 'warn' });
	});

	it('an expiry within seven days is a warning with the date', async () => {
		const now = Date.parse('2026-11-09T10:00:00Z');
		const { lines } = await run({ fakeOptions: { tokenExpiresAt: '2026-11-12' }, now: () => now });

		expect(line(lines, 'auth')).toMatchObject({ status: 'warn' });
		expect(line(lines, 'auth')!.text).toContain('2026-11-12');
	});

	it('an expired token is an error and stops the list before the project', async () => {
		const now = Date.parse('2026-11-09T10:00:00Z');
		const { lines } = await run({ fakeOptions: { tokenExpiresAt: '2026-11-01' }, now: () => now });

		expect(line(lines, 'auth')).toMatchObject({ status: 'error' });
		expect(line(lines, 'project')).toBeUndefined();
		expect(names(lines).at(-1)).toBe('verification');
		expect(names(lines).at(-2)).toBe('auth');
	});

	it('a refused token is an error naming the variable, and the verification line is still last', async () => {
		const { lines } = await run({ token: 'wrong-token' });

		const failing = lines.filter(l => l.status === 'error');
		expect(failing).toHaveLength(1);
		expect(failing[0]!.name).toBe('auth');
		expect(failing[0]!.fix).toContain('GITLAB_TOKEN');
		expect(names(lines).at(-1)).toBe('verification');
	});
});

describe('project', () => {
	it('an unknown project is "not found or not visible" with the two things to check', async () => {
		const { lines } = await run({ options: { project: 'nobody/nothing' } });

		const project = line(lines, 'project')!;
		expect(project.status).toBe('error');
		expect(project.text).toBe('nobody/nothing was not found, or this token cannot see it');
		expect(project.fix).toContain('strategy.options.project');
		expect(project.fix).toContain('member');
		expect(line(lines, 'issues')).toBeUndefined();
	});

	it('an archived project is a warning', async () => {
		const { lines } = await run({ fakeOptions: { archived: true } });

		expect(line(lines, 'project')).toMatchObject({ status: 'warn' });
		expect(line(lines, 'project')!.text).toContain('archived');
	});

	it('disabled Issues is an error with the fix', async () => {
		const { lines } = await run({ fakeOptions: { issuesEnabled: false } });

		const project = line(lines, 'project')!;
		expect(project.status).toBe('error');
		expect(project.text).toContain('Issues are disabled');
		expect(project.fix).toContain('Enable Issues');
	});

	it('fills.delete hard below Planner is a warning naming the role', async () => {
		const { lines } = await run({
			fakeOptions: { accessLevel: 10 },
			fills: { delete: { use: 'hard', fidelity: 'strict' } },
		});

		expect(line(lines, 'project')).toMatchObject({ status: 'warn' });
		expect(line(lines, 'project')!.fix).toContain('Planner or Owner');
	});
});

describe('tier', () => {
	it('declared higher than the plan found: a warning with the fix', async () => {
		const { lines } = await run({
			options: { tier: 'premium' },
			fakeOptions: { tier: 'premium', namespacePlan: 'free' },
		});

		const tier = line(lines, 'tier')!;
		expect(tier.status).toBe('warn');
		expect(tier.text).toContain('tier: premium (declared)');
		expect(tier.fix).toContain('strategy.options.tier to free');
	});

	it('declared lower: ok, and says more exists', async () => {
		const { lines } = await run({ options: { tier: 'free' }, fakeOptions: { tier: 'premium' } });

		expect(line(lines, 'tier')).toMatchObject({ status: 'ok' });
		expect(line(lines, 'tier')!.text).toContain('more exists');
	});

	it('equal: ok', async () => {
		const { lines } = await run({ options: { tier: 'ultimate' }, fakeOptions: { tier: 'ultimate' } });

		expect(line(lines, 'tier')!.text).toContain('matches the plan');
	});

	it('an unknown plan word is trusted, not a failure', async () => {
		const { lines } = await run({ fakeOptions: { namespacePlan: 'bronze' } });

		expect(line(lines, 'tier')).toMatchObject({ status: 'ok' });
		expect(line(lines, 'tier')!.text).toContain('"bronze"');
	});
});

describe('labels, links, hierarchy', () => {
	it('lists the missing labels and the exact command; none missing is ok', async () => {
		const missing = await run();
		expect(line(missing.lines, 'labels')!.text).toBe(
			'1 of the 1 labels the mapping uses do not exist yet: status:in-progress'
		);
		expect(line(missing.lines, 'labels')!.fix).toContain('task labels sync -p shop');
		await fake?.stop();

		fake = await FakeGitLab.start();
		fake.seedLabel('status:in-progress');
		const parsed = parseGitLabOptions({
			project: fake.project,
			baseUrl: fake.baseUrl,
			tokenEnv: 'GITLAB_TOKEN',
			tier: 'free',
			statusMap: {
				backlog: { state: 'open' },
				'in-progress': { state: 'open', label: 'status:in-progress' },
				done: { state: 'closed' },
			},
		});
		if ('problem' in parsed) throw new Error(parsed.problem);
		const client = new GitLabClient({
			baseUrl: parsed.settings.baseUrl,
			token: fake.token,
			project: 'p',
			tokenHint: 'x',
			timeoutMs: 2000,
			cacheTtlMs: 0,
		});
		const lines = await checkGitLab({
			client,
			settings: parsed.settings,
			project: { statuses: STATUSES, types: [] },
			projectUrl: 'u',
			now: Date.now,
			tokenHint: 'x',
			fills: {},
			projectName: 'shop',
		});
		expect(line(lines, 'labels')).toMatchObject({ status: 'ok' });
	});

	it('free: blockedBy is refused, relates_to exists', async () => {
		const { lines } = await run();

		expect(line(lines, 'links')!.text).toContain('blockedBy links are refused');
		expect(line(lines, 'links')!.text).toContain('relates_to');
	});

	it('premium without an issue: blocking links cannot be probed without writing', async () => {
		const { lines } = await run({ options: { tier: 'premium' }, fakeOptions: { tier: 'premium' } });

		expect(line(lines, 'links')!.text).toContain('UNVERIFIED');
		expect(line(lines, 'links')!.text).toContain('no issue yet');
	});

	it('premium with an issue: the link list is read (GET) and the limit stays said', async () => {
		const { lines, fake: server } = await run({
			options: { tier: 'premium' },
			fakeOptions: { tier: 'premium' },
			seed: s => void s.seedIssue({ title: 'Probe me' }),
		});

		expect(line(lines, 'links')!.text).toContain('the issue links answer');
		expect(line(lines, 'links')!.text).toContain('UNVERIFIED');
		expect(server.requests.some(r => r.method === 'GET' && r.path.endsWith('/issues/1/links'))).toBe(true);
		expect(server.writes()).toEqual([]);
	});

	it('says there is no parent of an issue', async () => {
		const { lines } = await run();

		expect(line(lines, 'hierarchy')!.text).toContain('no parent of an issue');
	});
});

describe('limits and failures', () => {
	it('warns below ten percent of the quota', async () => {
		const { lines } = await run({
			fakeOptions: { rateLimit: { limit: 2000, remaining: 100, resetAt: Math.floor(Date.now() / 1000) + 600 } },
		});

		expect(line(lines, 'limits')).toMatchObject({ status: 'warn' });
		expect(line(lines, 'limits')!.text).toMatch(/^\d+ of 2000 requests left/);
	});

	it('an unreachable server is one error on reachable, then the verification line', async () => {
		const { lines } = await run({ options: { baseUrl: 'http://127.0.0.1:1/api/v4' } });

		expect(lines.filter(l => l.status === 'error').map(l => l.name)).toEqual(['reachable']);
		expect(names(lines).at(-1)).toBe('verification');
	});

	it('the token never appears in a line', async () => {
		const { lines, fake: server } = await run({ token: 'secret-value-123' });

		expect(JSON.stringify(lines)).not.toContain('secret-value-123');
		expect(JSON.stringify(lines)).not.toContain(server.token);
	});
});
