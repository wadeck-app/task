// Builds a GitHubBackend over a FakeGitHub for tests, with the pieces exposed (client, notices, settings). Test-only.
import type { ProjectStatus, ReadNotice } from '../kinds.js';
import type { FakeGitHub } from './fakeGitHub.testkit.js';
import { GitHubBackend } from './GitHubBackend.js';
import { GitHubClient } from './githubClient.js';
import type { GitHubClientOptions } from './githubClient.js';
import { parseGitHubOptions } from './githubOptions.js';
import type { GitHubSettings } from './githubOptions.js';
import { MemoryResponseCache } from './responseCache.js';
import { StatusMapper } from './statusMapping.js';

export const TEST_STATUSES: ProjectStatus[] = [
	{ name: 'backlog', terminal: false, default: true, outcome: undefined },
	{ name: 'in-progress', terminal: false, default: false, outcome: undefined },
	{ name: 'done', terminal: true, default: false, outcome: 'positive' },
];

export const TEST_STATUS_MAP = {
	backlog: { state: 'open' },
	'in-progress': { state: 'open', label: 'status:in-progress' },
	done: { state: 'closed' },
};

export interface TestBackend {
	backend: GitHubBackend;
	client: GitHubClient;
	settings: GitHubSettings;
	notices: ReadNotice[];
	clock: { ms: number };
}

export function makeGitHubBackend(
	fake: FakeGitHub,
	options: {
		options?: Record<string, unknown>;
		statuses?: ProjectStatus[];
		projectTypes?: string[];
		metaFromLabels?: boolean;
		client?: Partial<GitHubClientOptions>;
	} = {}
): TestBackend {
	const parsed = parseGitHubOptions({
		repo: fake.repo,
		baseUrl: fake.baseUrl,
		tokenEnv: 'GITHUB_TOKEN',
		statusMap: TEST_STATUS_MAP,
		// A TTL of zero: every read revalidates, which exercises the 304 path too.
		cache: { ttlSeconds: 0 },
		timeoutSeconds: 2,
		...options.options,
	});
	if ('problem' in parsed) throw new Error(`test options are invalid: ${parsed.problem}`);
	const { settings } = parsed;
	const notices: ReadNotice[] = [];
	const clock = { ms: Date.parse('2026-11-08T12:00:00Z') };
	const issueUrl = (number: number): string => `https://github.com/${settings.repo.full}/issues/${number}`;
	const client = new GitHubClient({
		baseUrl: settings.baseUrl,
		token: fake.token,
		repo: settings.repo.full,
		tokenHint: 'the environment variable GITHUB_TOKEN (strategy.options.tokenEnv)',
		timeoutMs: settings.timeoutSeconds * 1000,
		cacheTtlMs: settings.cacheTtlSeconds * 1000,
		maxPages: settings.maxPages,
		cache: new MemoryResponseCache(),
		now: () => clock.ms,
		onNotice: notice => notices.push(notice),
		...options.client,
	});
	const statuses = options.statuses ?? TEST_STATUSES;
	const backend = new GitHubBackend({
		settings,
		client,
		issueUrl,
		newIssueUrl: `https://github.com/${settings.repo.full}/issues/new`,
		map: {
			settings,
			mapper: new StatusMapper(settings.statusMap, statuses, issueUrl),
			metaFromLabels: options.metaFromLabels === true,
			projectTypes: options.projectTypes ?? [],
			notice: notice => notices.push(notice),
			issueUrl,
		},
	});
	return { backend, client, settings, notices, clock };
}
