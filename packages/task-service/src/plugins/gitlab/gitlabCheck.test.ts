import { afterEach, describe, expect, it } from 'vitest';

import type { CheckLine, DeclaredFills, ProjectStatus } from '../kinds.js';
import { CREDENTIAL_REQUIREMENTS } from './credentialRequirements.js';
import { FakeGitLab, LIVE_TOKEN_PERMISSIONS } from './fakeGitLab.testkit.js';
import type { FakeGitLabOptions } from './fakeGitLab.testkit.js';
import { checkGitLab, VERIFICATION_TEXT } from './gitlabCheck.js';
import { GitLabClient } from './gitlabClient.js';
import type { GitLabClientOptions } from './gitlabClient.js';
import { parseGitLabOptions } from './gitlabOptions.js';

const STATUSES: ProjectStatus[] = [
	{ name: 'backlog', terminal: false, default: true, outcome: undefined },
	{ name: 'in-progress', terminal: false, default: false, outcome: undefined },
	{ name: 'done', terminal: true, default: false, outcome: 'positive' },
];

const BASE_TIME = Date.parse('2026-11-09T10:00:00Z');

let fake: FakeGitLab | undefined;

afterEach(async () => {
	await fake?.stop();
	fake = undefined;
});

interface Run {
	options?: Record<string, unknown>;
	fills?: DeclaredFills;
	fakeOptions?: FakeGitLabOptions;
	clientOptions?: Partial<GitLabClientOptions>;
	token?: string;
	now?: () => number;
	types?: string[];
	/** Issues in the project: the write and hierarchy probes need one. Default 1. */
	issues?: number;
	/** Called with the mock right after the issues are seeded. */
	prepare?: (server: FakeGitLab) => void;
}

async function run(setup: Run = {}): Promise<{ lines: CheckLine[]; fake: FakeGitLab }> {
	fake = await FakeGitLab.start(setup.fakeOptions);
	for (let index = 0; index < (setup.issues ?? 1); index++) fake.seedIssue({ title: `Issue ${index + 1}` });
	setup.prepare?.(fake);
	const parsed = parseGitLabOptions({
		project: fake.project,
		baseUrl: fake.baseUrl,
		tokenEnv: 'GITLAB_TOKEN',
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
		...setup.clientOptions,
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

const line = (lines: CheckLine[], name: string): CheckLine => {
	const found = lines.find(l => l.name === name);
	if (found === undefined) throw new Error(`no line "${name}" in: ${lines.map(l => l.name).join(', ')}`);
	return found;
};
const names = (lines: CheckLine[]): string[] => lines.map(l => l.name);
const without = (...denied: string[]): string[] => LIVE_TOKEN_PERMISSIONS.filter(name => !denied.includes(name));

const ROW_ORDER = [
	'reachable',
	'auth',
	'read',
	'write',
	'delete',
	'labels-read',
	'labels-write',
	'hierarchy',
	'project-info',
	'token-info',
	'server-info',
	'limits',
	'statuses',
	'labels',
	'links',
	'writes',
	'verification',
];

describe('checkGitLab with the permissions of the live test token', () => {
	it('lists one line per credential row in order, the optional information as "not readable", and ends with the verification line', async () => {
		const { lines } = await run();

		expect(names(lines)).toEqual(ROW_ORDER);
		expect(lines.map(l => [l.name, l.status])).toEqual([
			['reachable', 'ok'],
			['auth', 'ok'],
			['read', 'ok'],
			['write', 'ok'],
			['delete', 'ok'],
			['labels-read', 'ok'],
			['labels-write', 'ok'],
			['hierarchy', 'ok'],
			['project-info', 'ok'],
			['token-info', 'ok'],
			['server-info', 'ok'],
			['limits', 'ok'],
			['statuses', 'ok'],
			['labels', 'warn'],
			['links', 'ok'],
			['writes', 'ok'],
			['verification', 'ok'],
		]);
		expect(line(lines, 'read').text).toBe('enabled: read tasks, comments, history and links');
		expect(line(lines, 'write').text).toMatch(/^enabled: create and change tasks/);
		expect(line(lines, 'delete').text).toBe(
			'not tested (cannot be probed without changing data); needs Work Item: Delete: delete tasks and comments (fills.delete: hard)'
		);
		expect(line(lines, 'labels-write').text).toContain('not tested');
		expect(line(lines, 'hierarchy').text).toMatch(/^enabled: parent and children/);
		expect(line(lines, 'project-info').text).toBe(
			'not readable with this token (needs Project: Read); optional, only used for information'
		);
		expect(line(lines, 'token-info').text).toBe(
			'not readable with this token (needs Personal Access Token: Read); optional, only used for information'
		);
		expect(line(lines, 'server-info').text).toBe(
			'not readable with this token (needs Metadata: Read); optional, only used for information'
		);
		expect(lines.some(l => l.status === 'error' || (l.status === 'warn' && l.name !== 'labels'))).toBe(false);
	});

	it('the verification line says what was and was not verified, and no line says the strategy is unverified', async () => {
		const { lines } = await run();

		const verification = line(lines, 'verification');
		expect(verification.status).toBe('ok');
		expect(verification.text).toBe(VERIFICATION_TEXT);
		expect(verification.text).toContain('gitlab.com Free on 2026-11-09');
		expect(verification.text).toContain('fine-grained');
		expect(verification.text).toContain('NOT verified: classic tokens');
		expect(verification.text).toContain('self-managed');
		expect(verification.text).toContain('Premium or Ultimate');
		expect(JSON.stringify(lines)).not.toContain('has not been verified');
	});

	it('sends one no-op PUT (the title the first issue already has, the newest) and one GraphQL read, nothing else, and changes nothing in the issue', async () => {
		let before = '';
		const { fake: server } = await run({
			issues: 2,
			prepare: seeded => void (before = seeded.issue(2)!.updatedAt),
		});

		// GitLab lists the newest issue first: #2 is the first issue found.
		expect(server.writes().map(w => [w.method, w.path])).toEqual([
			['PUT', '/projects/42/issues/2'],
			['POST', '/api/graphql'],
		]);
		expect(server.writes()[0]!.body).toEqual({ title: 'Issue 2' });
		// LIVE-VERIFIED (step "updated order after the same title on a fresh issue"): the first PUT of an issue never edited since its
		// creation refreshes updated_at even with nothing changed; the content stays and no note is written.
		expect(Date.parse(server.issue(2)!.updatedAt)).toBeGreaterThanOrEqual(Date.parse(before));
		expect(server.issue(2)!.title).toBe('Issue 2');
		expect(server.systemNotes(2)).toEqual([]);
	});

	it('statuses and the exact-case labels the mapping uses', async () => {
		const { lines } = await run();

		expect(line(lines, 'statuses').text).toBe(
			'3 statuses mapped: backlog = open; in-progress = open + status:in-progress; done = closed'
		);
		expect(line(lines, 'labels').text).toBe(
			'1 of the 1 labels the mapping uses do not exist yet: status:in-progress'
		);
		expect(line(lines, 'labels').fix).toContain('task labels sync -p shop');
	});

	it('a label that exists only with another case is missing; a GROUP label counts as present', async () => {
		const wrongCase = await run({ prepare: server => void server.seedLabel('Status:In-Progress') });
		expect(line(wrongCase.lines, 'labels')).toMatchObject({ status: 'warn' });
		expect(line(wrongCase.lines, 'labels').fix).toContain('case sensitive');
		await fake?.stop();

		const group = await run({ prepare: server => void server.seedGroupLabel('status:in-progress') });
		expect(line(group.lines, 'labels')).toMatchObject({ status: 'ok' });
	});

	it('blockedBy is refused (paid tier), relates_to exists, and there is no separate hierarchy line', async () => {
		const { lines } = await run();

		expect(line(lines, 'links').text).toContain('blockedBy links are refused');
		expect(line(lines, 'links').text).toContain('paid GitLab tier');
		expect(line(lines, 'links').text).toContain('relates_to');
		expect(lines.filter(l => l.name === 'hierarchy')).toHaveLength(1);
		expect(line(lines, 'writes').text).toContain('not atomic');
	});

	it('a project without any issue says so for write and hierarchy, and creates nothing', async () => {
		const { lines, fake: server } = await run({ issues: 0 });

		expect(line(lines, 'write')).toMatchObject({ status: 'ok' });
		expect(line(lines, 'write').text).toContain('the project has no issue to rewrite');
		expect(line(lines, 'write').text).toContain('never creates one');
		expect(line(lines, 'hierarchy').text).toContain('the project has no issue to read as a work item');
		expect(server.writes()).toEqual([]);
	});
});

describe('checkGitLab with a fully permitted token', () => {
	it('shows the project facts, the token expiry and the GitLab version', async () => {
		const now = Date.parse('2026-11-09T10:00:00Z');
		const { lines } = await run({
			fakeOptions: { permissions: 'all', accessLevel: 50, tokenScopes: ['api'], tokenExpiresAt: '2026-12-31' },
			now: () => now,
		});

		expect(line(lines, 'project-info')).toMatchObject({ status: 'ok' });
		expect(line(lines, 'project-info').text).toContain('access level 50 (Owner?)');
		expect(line(lines, 'token-info')).toMatchObject({ status: 'ok' });
		expect(line(lines, 'token-info').text).toContain('scopes api');
		expect(line(lines, 'token-info').text).toContain('expires 2026-12-31');
		expect(line(lines, 'server-info').text).toMatch(/^GitLab \d+\./);
		expect(lines.filter(l => l.status === 'error')).toEqual([]);
	});

	it('an expiry within seven days is a warning with the date; an expired token is an error', async () => {
		const now = Date.parse('2026-11-09T10:00:00Z');
		const soon = await run({ fakeOptions: { permissions: 'all', tokenExpiresAt: '2026-11-12' }, now: () => now });
		expect(line(soon.lines, 'token-info')).toMatchObject({ status: 'warn' });
		expect(line(soon.lines, 'token-info').text).toContain('2026-11-12');
		await fake?.stop();

		const expired = await run({
			fakeOptions: { permissions: 'all', tokenExpiresAt: '2026-11-01' },
			now: () => now,
		});
		expect(line(expired.lines, 'token-info')).toMatchObject({ status: 'error' });
		expect(line(expired.lines, 'token-info').text).toContain('expired on 2026-11-01');
	});

	it('archived and disabled Issues come from the project facts', async () => {
		const archived = await run({ fakeOptions: { permissions: 'all', archived: true } });
		expect(line(archived.lines, 'project-info')).toMatchObject({ status: 'warn' });
		expect(line(archived.lines, 'project-info').text).toContain('archived');
		await fake?.stop();

		const disabledIssues = await run({ fakeOptions: { permissions: 'all', issuesEnabled: false } });
		// With Issues disabled the issue endpoints are 403: that is the read error; the project facts say why.
		expect(line(disabledIssues.lines, 'read').status).toBe('error');
	});

	it('fills.delete hard below Planner is a warning naming the role', async () => {
		const { lines } = await run({
			fakeOptions: { permissions: 'all', accessLevel: 10 },
			fills: { delete: { use: 'hard', fidelity: 'strict' } },
		});

		expect(line(lines, 'project-info')).toMatchObject({ status: 'warn' });
		expect(line(lines, 'project-info').fix).toContain('Planner or Owner');
	});

	it('a classic read_api token: the write probe is refused with the scope, as a warning', async () => {
		const { lines } = await run({ fakeOptions: { classicToken: true, readOnlyToken: true } });

		expect(line(lines, 'read')).toMatchObject({ status: 'ok' });
		expect(line(lines, 'write')).toMatchObject({ status: 'warn' });
		expect(line(lines, 'write').text).toMatch(/^disabled \(.*scope/);
		expect(line(lines, 'write').fix).toContain('scope api');
	});
});

describe('checkGitLab with a token lacking one permission', () => {
	it('without Work Item: Update, write and hierarchy are disabled lines naming the permission and the fix, the rest still runs', async () => {
		const { lines } = await run({ fakeOptions: { permissions: without('Work Item: Update') } });

		const write = line(lines, 'write');
		expect(write.status).toBe('warn');
		expect(write.text).toMatch(/^disabled \(missing Work Item: Update\): create and change tasks/);
		expect(write.fix).toContain('Add the permission Work Item: Update on group/project');
		expect(write.fix).toContain('GITLAB_TOKEN');
		expect(write.fix).toContain('docs.gitlab.com');
		expect(line(lines, 'hierarchy')).toMatchObject({ status: 'warn' });
		expect(line(lines, 'hierarchy').text).toContain('missing Work Item: Update');
		expect(line(lines, 'read')).toMatchObject({ status: 'ok' });
		expect(line(lines, 'labels-read')).toMatchObject({ status: 'ok' });
		expect(lines.filter(l => l.status === 'error')).toEqual([]);
		expect(names(lines).at(-1)).toBe('verification');
	});

	it('without Label: Read, labels-read is an ERROR line and the labels line is left out', async () => {
		const { lines } = await run({ fakeOptions: { permissions: without('Label: Read') } });

		const labels = line(lines, 'labels-read');
		expect(labels.status).toBe('error');
		expect(labels.text).toMatch(/^disabled \(missing Label: Read\)/);
		expect(labels.fix).toContain('Label: Read');
		expect(names(lines)).not.toContain('labels');
		expect(line(lines, 'read')).toMatchObject({ status: 'ok' });
	});

	it('without Work Item: Read the first probe is the read error, with the fix, and the list stops there', async () => {
		const { lines } = await run({ fakeOptions: { permissions: without('Work Item: Read') } });

		expect(names(lines)).toEqual(['reachable', 'auth', 'read', 'verification']);
		expect(line(lines, 'read')).toMatchObject({ status: 'error' });
		expect(line(lines, 'read').text).toContain('missing Work Item: Read');
		expect(line(lines, 'read').fix).toContain('Add the permission Work Item: Read');
	});
});

describe('checkGitLab: auth, project, network', () => {
	it('a refused token (401) is the auth error naming the variable; the list ends with the verification line', async () => {
		const { lines } = await run({ token: 'wrong-token' });

		const failing = lines.filter(l => l.status === 'error');
		expect(failing).toHaveLength(1);
		expect(failing[0]!.name).toBe('auth');
		expect(failing[0]!.fix).toContain('GITLAB_TOKEN');
		expect(names(lines).at(-1)).toBe('verification');
	});

	it('an unknown project (404) is the project error: does not exist OR the token cannot see it, with the two things to check', async () => {
		const { lines } = await run({ options: { project: 'nobody/nothing' } });

		const project = line(lines, 'project');
		expect(project.status).toBe('error');
		expect(project.text).toBe(
			'GitLab does not know the project nobody/nothing, or the token cannot see it (404 Project Not Found)'
		);
		expect(project.fix).toContain('strategy.options.project');
		expect(project.fix).toContain('member');
		expect(project.fix).toContain('group/project');
		expect(names(lines)).toEqual(['reachable', 'auth', 'project', 'verification']);
	});

	it('an unreachable server is one error on reachable, then the verification line', async () => {
		const { lines } = await run({ options: { baseUrl: 'http://127.0.0.1:1/api/v4' } });

		expect(lines.filter(l => l.status === 'error').map(l => l.name)).toEqual(['reachable']);
		expect(names(lines).at(-1)).toBe('verification');
	});

	it('a slow answer is a warning; the reachable line shows the round trip', async () => {
		let t = 0;
		const fast = await run({ now: () => (t += 10) });
		expect(line(fast.lines, 'reachable').text).toMatch(/^127\.0\.0\.1:\d+ answered \(10 ms\)$/);
		await fake?.stop();

		t = 0;
		const slow = await run({ now: () => (t += 700) });
		expect(line(slow.lines, 'reachable')).toMatchObject({ status: 'warn' });
	});

	it('the token never appears in a line', async () => {
		const { lines, fake: server } = await run({ token: 'secret-value-123' });

		expect(JSON.stringify(lines)).not.toContain('secret-value-123');
		expect(JSON.stringify(lines)).not.toContain(server.token);
	});
});

describe('checkGitLab: rate limit', () => {
	it('warns below ten percent of the quota', async () => {
		const { lines } = await run({
			fakeOptions: { rateLimit: { limit: 2000, remaining: 100, resetAt: Math.floor(Date.now() / 1000) + 600 } },
		});

		expect(line(lines, 'limits')).toMatchObject({ status: 'warn' });
		expect(line(lines, 'limits').text).toMatch(/^\d+ of 2000 requests left/);
		expect(line(lines, 'limits').fix).toContain('maxWaitSeconds');
	});

	it('a quota that runs out during the check is waited out (one notice), and the list is complete', async () => {
		let now = BASE_TIME;
		const waits: number[] = [];
		const notices: string[] = [];
		const { lines } = await run({
			fakeOptions: { clock: () => now, rateLimit: { limit: 4, windowSeconds: 60 } },
			clientOptions: {
				now: () => now,
				sleep: ms => {
					waits.push(ms);
					now += ms;
					return Promise.resolve();
				},
				notice: text => notices.push(text),
			},
		});

		expect(waits.length).toBeGreaterThan(0);
		expect(notices.length).toBe(waits.length);
		expect(notices[0]).toMatch(
			/^GitLab rate limit reached \(4 requests per window\): waiting \d+ s for the window to reopen$/
		);
		expect(names(lines)).toEqual(ROW_ORDER);
		expect(lines.filter(l => l.status === 'error')).toEqual([]);
	});

	it('a window that reopens later than maxWaitSeconds is an error on limits with the instant and the option', async () => {
		const now = BASE_TIME;
		const { lines } = await run({
			fakeOptions: {
				clock: () => now,
				rateLimit: { limit: 1, windowSeconds: 600, remaining: 0, resetAt: now / 1000 + 600 },
			},
			clientOptions: { now: () => now, maxWaitMs: 5000 },
		});

		expect(lines.map(l => l.name)).toEqual(['limits', 'verification']);
		expect(line(lines, 'limits').status).toBe('error');
		expect(line(lines, 'limits').fix).toContain('maxWaitSeconds');
		expect(line(lines, 'limits').fix).toContain('2026-11-09T10:10:00.000Z');
	});
});

describe('checkGitLab: every credential row, granted and denied', () => {
	const probed = CREDENTIAL_REQUIREMENTS.filter(requirement => requirement.probe.kind !== 'none');

	it('the table and the check agree: one line per row, in table order', async () => {
		const { lines } = await run();

		const rows = names(lines).filter(name => CREDENTIAL_REQUIREMENTS.some(requirement => requirement.key === name));
		expect(rows).toEqual(CREDENTIAL_REQUIREMENTS.map(requirement => requirement.key));
	});

	for (const requirement of CREDENTIAL_REQUIREMENTS) {
		if (requirement.probe.kind === 'none') {
			it(`${requirement.key}: cannot be probed, says so and names ${requirement.fineGrained.join(' + ')}`, async () => {
				const { lines } = await run();

				expect(line(lines, requirement.key)).toMatchObject({ status: 'ok' });
				expect(line(lines, requirement.key).text).toContain('not tested');
				for (const permission of requirement.fineGrained)
					expect(line(lines, requirement.key).text).toContain(permission);
			});
		}
	}

	for (const requirement of probed) {
		// The permission whose absence the probe of this row reports. `hierarchy` is the work item read plus the update that follows.
		const denied: Record<string, string> = {
			read: 'Work Item: Read',
			write: 'Work Item: Update',
			'labels-read': 'Label: Read',
			hierarchy: 'Work Item: Update',
			'project-info': 'Project: Read',
			'token-info': 'Personal Access Token: Read',
			'server-info': 'Metadata: Read',
		};
		const permission = denied[requirement.key]!;
		const optional = ['project-info', 'token-info', 'server-info'].includes(requirement.key);

		it(`${requirement.key}: granted gives an "enabled" or facts line`, async () => {
			const { lines } = await run({ fakeOptions: { permissions: 'all' } });

			expect(line(lines, requirement.key).status).toBe('ok');
			if (!optional) expect(line(lines, requirement.key).text).toMatch(/^enabled: /);
		});

		it(`${requirement.key}: without ${permission} it is ${
			optional ? 'a plain "not readable" ok line' : requirement.required ? 'an error' : 'a warning'
		} naming the permission`, async () => {
			const permissions = LIVE_TOKEN_PERMISSIONS.filter(name => name !== permission);
			const { lines } = await run({ fakeOptions: { permissions } });

			const found = line(lines, requirement.key);
			if (optional) {
				expect(found.status).toBe('ok');
				expect(found.text).toContain(`not readable with this token (needs ${permission})`);
				expect(found.fix).toBeUndefined();
			} else {
				expect(found.status).toBe(requirement.required ? 'error' : 'warn');
				expect(found.text).toContain(permission);
				expect(found.fix).toContain(permission);
			}
		});
	}
});
