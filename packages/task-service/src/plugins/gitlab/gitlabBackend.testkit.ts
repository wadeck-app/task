// Builds a GitLabBackend over a FakeGitLab for tests, with the pieces exposed (client, notices, settings). Test-only.
import type { DeclaredFills, ProjectStatus, ReadNotice } from '../kinds.js';
import type { FakeGitLab } from './fakeGitLab.testkit.js';
import { GitLabBackend } from './GitLabBackend.js';
import { GitLabClient } from './gitlabClient.js';
import type { GitLabClientOptions } from './gitlabClient.js';
import { parseGitLabOptions } from './gitlabOptions.js';
import type { GitLabSettings, GitLabTier } from './gitlabOptions.js';
import { StatusMapper } from './gitlabStatusMapping.js';

/** The statuses of the read tests: one open without label, one open with, one terminal. */
export const TEST_STATUSES: ProjectStatus[] = [
	{ name: 'backlog', terminal: false, default: true, outcome: undefined },
	{ name: 'in-progress', terminal: false, default: false, outcome: undefined },
	{ name: 'done', terminal: true, default: false, outcome: 'positive' },
];

/** The separator of a status label: one colon on the free tier, the scoped `::` on Premium and Ultimate. */
const sep = (tier: GitLabTier): string => (tier === 'free' ? ':' : '::');

export function testStatusMap(tier: GitLabTier): Record<string, unknown> {
	return {
		backlog: { state: 'open' },
		'in-progress': { state: 'open', label: `status${sep(tier)}in-progress` },
		done: { state: 'closed' },
	};
}

/** The statuses of the write tests: two open ones with a label, and three ways to end (GitLab has no close reason: labels tell them apart). */
export const WRITE_STATUSES: ProjectStatus[] = [
	{ name: 'backlog', terminal: false, default: true, outcome: undefined },
	{ name: 'in-progress', terminal: false, default: false, outcome: undefined },
	{ name: 'review', terminal: false, default: false, outcome: undefined },
	{ name: 'done', terminal: true, default: false, outcome: 'positive' },
	{ name: 'cancelled', terminal: true, default: false, outcome: 'negative' },
	{ name: 'duplicate', terminal: true, default: false, outcome: 'negative' },
];

export function writeStatusMap(tier: GitLabTier): Record<string, unknown> {
	return {
		backlog: { state: 'open' },
		'in-progress': { state: 'open', label: `status${sep(tier)}in-progress` },
		review: { state: 'open', label: `status${sep(tier)}review` },
		done: { state: 'closed' },
		cancelled: { state: 'closed', label: `status${sep(tier)}cancelled` },
		duplicate: { state: 'closed', label: `status${sep(tier)}duplicate` },
	};
}

export interface TestBackend {
	backend: GitLabBackend;
	client: GitLabClient;
	settings: GitLabSettings;
	notices: ReadNotice[];
	clock: { ms: number };
	/** The waits the client asked for (spacing between writes, Retry-After), instead of really waiting. */
	waits: number[];
}

export function makeGitLabBackend(
	fake: FakeGitLab,
	options: {
		tier?: GitLabTier;
		options?: Record<string, unknown>;
		statuses?: ProjectStatus[];
		projectTypes?: string[];
		fills?: DeclaredFills;
		client?: Partial<GitLabClientOptions>;
	} = {}
): TestBackend {
	const tier = options.tier ?? fake.tier;
	const parsed = parseGitLabOptions({
		project: fake.project,
		baseUrl: fake.baseUrl,
		tokenEnv: 'GITLAB_TOKEN',
		tier,
		statusMap: testStatusMap(tier),
		// A TTL of zero: every read asks the server.
		cache: { ttlSeconds: 0 },
		timeoutSeconds: 2,
		...options.options,
	});
	if ('problem' in parsed) throw new Error(`test options are invalid: ${parsed.problem}`);
	const { settings } = parsed;
	const fills = options.fills ?? {};
	const notices: ReadNotice[] = [];
	const waits: number[] = [];
	const clock = { ms: Date.parse('2026-11-09T12:00:00Z') };
	const issueUrl = (iid: number): string => `https://gitlab.example/${settings.project.ref}/-/issues/${iid}`;
	const client = new GitLabClient({
		baseUrl: settings.baseUrl,
		token: fake.token,
		project: settings.project.ref,
		tokenHint: 'the environment variable GITLAB_TOKEN (strategy.options.tokenEnv)',
		timeoutMs: settings.timeoutSeconds * 1000,
		cacheTtlMs: settings.cacheTtlSeconds * 1000,
		maxPages: settings.maxPages,
		now: () => clock.ms,
		onNotice: notice => notices.push(notice),
		// The tests do not wait: what the client would have waited for is in `waits`.
		writeSpacingMs: 0,
		sleep: ms => {
			waits.push(ms);
			return Promise.resolve();
		},
		...options.client,
	});
	const statuses = options.statuses ?? TEST_STATUSES;
	const seen = new Set<string>();
	const notice = (next: ReadNotice): void => {
		if (seen.has(next.text)) return;
		seen.add(next.text);
		notices.push(next);
	};
	const backend = new GitLabBackend({
		settings,
		client,
		issueUrl,
		newIssueUrl: `https://gitlab.example/${settings.project.ref}/-/issues/new`,
		fills,
		map: {
			settings,
			mapper: new StatusMapper(settings.statusMap, statuses, issueUrl),
			metaFromLabels: fills['meta']?.use === 'labels',
			metaFromBlock: fills['meta']?.use === 'body-block',
			projectTypes: options.projectTypes ?? [],
			notice,
			issueUrl,
		},
	});
	return { backend, client, settings, notices, clock, waits };
}
