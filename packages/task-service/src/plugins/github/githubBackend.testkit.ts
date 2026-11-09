// Builds a GitHubBackend over a FakeGitHub for tests, with the pieces exposed (client, notices, settings). Test-only.
import type { DeclaredFills, ProjectStatus, ReadNotice } from '../kinds.js';
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

/** The statuses of the write tests: two open ones with a label, and three ways to end. */
export const WRITE_STATUSES: ProjectStatus[] = [
	{ name: 'backlog', terminal: false, default: true, outcome: undefined },
	{ name: 'in-progress', terminal: false, default: false, outcome: undefined },
	{ name: 'review', terminal: false, default: false, outcome: undefined },
	{ name: 'done', terminal: true, default: false, outcome: 'positive' },
	{ name: 'cancelled', terminal: true, default: false, outcome: 'negative' },
	{ name: 'duplicate', terminal: true, default: false, outcome: 'negative' },
];

export const WRITE_STATUS_MAP = {
	backlog: { state: 'open' },
	'in-progress': { state: 'open', label: 'status:in-progress' },
	review: { state: 'open', label: 'status:review' },
	done: { state: 'closed' },
	cancelled: { state: 'closed', reason: 'not_planned' },
	duplicate: { state: 'closed', reason: 'duplicate' },
};

export interface TestBackend {
	backend: GitHubBackend;
	client: GitHubClient;
	settings: GitHubSettings;
	notices: ReadNotice[];
	clock: { ms: number };
	/** The waits the client asked for (spacing between writes, retry-after), instead of really waiting. */
	waits: number[];
}

export function makeGitHubBackend(
	fake: FakeGitHub,
	options: {
		options?: Record<string, unknown>;
		statuses?: ProjectStatus[];
		projectTypes?: string[];
		metaFromLabels?: boolean;
		fills?: DeclaredFills;
		/** What the test says the project accepted; the config loader enforces it, the backend only follows the fills. */
		fidelity?: 'strict' | 'degrade';
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
	const fills = options.fills ?? {};
	const notices: ReadNotice[] = [];
	const waits: number[] = [];
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
	const backend = new GitHubBackend({
		settings,
		client,
		issueUrl,
		newIssueUrl: `https://github.com/${settings.repo.full}/issues/new`,
		fills,
		map: {
			settings,
			mapper: new StatusMapper(settings.statusMap, statuses, issueUrl),
			metaFromLabels: options.metaFromLabels === true || fills['meta']?.use === 'labels',
			metaFromBlock: fills['meta']?.use === 'body-block',
			projectTypes: options.projectTypes ?? [],
			notice,
			issueUrl,
		},
	});
	return { backend, client, settings, notices, clock, waits };
}
