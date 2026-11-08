// The built-in strategy `github` (plugins.github.default, alias github): the tasks of a project are the issues of a GitHub repository,
// read through the official REST API with Node fetch (no vendor CLI, no octokit). READ-ONLY in this version (stage 1 of the storage
// design, R3): every write is refused with UnsupportedByBackendError and a hint, never a no-op and never a local fallback.
import * as path from 'node:path';

import type { CheckLine, ReadNotice, StrategyContext, StrategyInstance, StrategyPlugin } from '../kinds.js';
import { GITHUB_CAPABILITIES, GitHubBackend } from './GitHubBackend.js';
import { checkGitHub } from './githubCheck.js';
import { GitHubClient } from './githubClient.js';
import { checkOptionsAgainstProject, parseGitHubOptions } from './githubOptions.js';
import type { GitHubSettings } from './githubOptions.js';
import { resolveToken } from './githubToken.js';
import { DiskResponseCache } from './responseCache.js';
import { StatusMapper } from './statusMapping.js';

/** The page of the repository on the web, derived from the API address: github.com, a GHES `https://HOST/api/v3`, or a test server. */
export function webBaseOf(baseUrl: string): string {
	const url = new URL(baseUrl);
	if (url.host === 'api.github.com') return 'https://github.com';
	return `${url.origin}${url.pathname.replace(/\/api\/v3\/?$/, '').replace(/\/$/, '')}`;
}

function tokenSentence(settings: GitHubSettings): string {
	return settings.token.kind === 'env'
		? `the environment variable ${settings.token.name} (strategy.options.tokenEnv)`
		: `the file ${settings.token.path} (strategy.options.tokenFile)`;
}

export const githubPlugin: StrategyPlugin = {
	extensionPoint: 'strategy',
	backendKind: 'github',
	capabilities: GITHUB_CAPABILITIES,
	// Status, type and hierarchy are mapped by the options themselves; meta has no native place on a GitHub issue.
	fillTechniques: { meta: ['labels'] },
	// What is only partly true, said once and printed by `task strategy show` as `partial`.
	capabilityNotes: {
		hierarchy: 'sub-issues: 8 levels, 100 per parent; a parent in another repository reads as no parent',
		history: 'derived from the timeline (labels, close, reopen), not stored',
		activity: 'the timeline mapped; edits of the description are not readable (GraphQL only)',
		search: 'Search API: 30 requests a minute, a new issue is searchable after a few seconds; find reads the full list',
		'linkTypes.duplicateOf':
			'read only from a managed task block in the body (GitHub keeps no readable target of a duplicate)',
	},

	validate(options) {
		const parsed = parseGitHubOptions(options);
		return 'problem' in parsed ? parsed.problem : undefined;
	},

	validateForProject(options, project) {
		const parsed = parseGitHubOptions(options);
		return 'problem' in parsed ? parsed.problem : checkOptionsAgainstProject(parsed.settings, project);
	},

	describe() {
		return {
			summary:
				'The issues of a GitHub repository, read through the official REST API. Read-only in this version (stage 1): writes are refused with a hint.',
			options: {
				repo: 'owner/name of the repository (required)',
				baseUrl: 'API address; default https://api.github.com, GitHub Enterprise Server: https://HOST/api/v3',
				tokenEnv:
					'NAME of the environment variable holding the token (required, or tokenFile); needs Issues: Read and Metadata: Read',
				tokenFile: 'path of a file holding the token (instead of tokenEnv); POSIX: readable by you only',
				statusMap:
					'task status -> { state: open|closed, label?, reason?: completed|not_planned|duplicate }; every status of the project, one open status without label (required)',
				typePrefix: 'label prefix of the task type; default "type:"',
				typeMap:
					'task type -> { issueType: <GitHub issue type> } or { label: <name> }; default: the label typePrefix + type',
				metaPrefix: 'label prefix of metadata with fills.meta: labels; default "meta:" (labels meta:key=value)',
				pageSize: 'items per request, 1 to 100; default 100',
				maxPages: 'pages one read may walk before failing loudly, 1 to 1000; default 50',
				cache: '{ ttlSeconds }: seconds a read is served without asking GitHub; default 60, 0 = always revalidate',
				timeoutSeconds: 'time limit of one request; default 15',
				fills: 'meta: labels (read meta from the labels meta:key=value)',
			},
			snippet: [
				'strategy:',
				'    type: github',
				'    options:',
				'        repo: owner/name',
				'        tokenEnv: GITHUB_TOKEN',
				'        statusMap:',
				'            todo: { state: open }',
				"            in-progress: { state: open, label: 'status:in-progress' }",
				'            done: { state: closed, reason: completed }',
				'            cancelled: { state: closed, reason: not_planned }',
			].join('\n'),
		};
	},

	async create(rawOptions, context: StrategyContext) {
		const parsed = parseGitHubOptions(rawOptions);
		if ('problem' in parsed) throw new Error(parsed.problem);
		const { settings } = parsed;
		const repoFull = settings.repo.full;
		const token = resolveToken(settings.token, context.env, {
			source: context.source,
			project: context.project.name,
			repo: repoFull,
		});

		const web = webBaseOf(settings.baseUrl);
		const repoUrl = `${web}/${repoFull}`;
		const issueUrl = (number: number): string => `${repoUrl}/issues/${number}`;
		const notices: ReadNotice[] = [];
		const seen = new Set<string>();
		const notice = (next: ReadNotice): void => {
			if (seen.has(next.text)) return;
			seen.add(next.text);
			notices.push(next);
		};
		const cacheDir = path.join(context.dataDir, 'cache', 'github');
		const cache = new DiskResponseCache(cacheDir, context.writeFile, (error, file) =>
			context.log(
				'warn',
				`github cache: ${file} could not be written (${error instanceof Error ? error.message : String(error)})`
			)
		);
		const debug = context.env['TASK_DEBUG'] === '1';
		const client = new GitHubClient({
			baseUrl: settings.baseUrl,
			token,
			repo: repoFull,
			tokenHint: tokenSentence(settings),
			timeoutMs: settings.timeoutSeconds * 1000,
			cacheTtlMs: settings.cacheTtlSeconds * 1000,
			maxPages: settings.maxPages,
			cache,
			onNotice: notice,
			...(debug ? { debug: (line: string) => context.log('info', `github: ${line}`) } : {}),
		});
		const backend = new GitHubBackend({
			settings,
			client,
			issueUrl,
			newIssueUrl: `${repoUrl}/issues/new`,
			map: {
				settings,
				mapper: new StatusMapper(settings.statusMap, context.statuses, issueUrl),
				metaFromLabels: context.fills['meta']?.use === 'labels',
				projectTypes: context.types,
				notice,
				issueUrl,
			},
		});
		const instance: StrategyInstance = {
			backend,
			describe: () => [
				`repository: ${repoFull} (${repoUrl})`,
				`api: ${settings.baseUrl}`,
				`token: ${tokenSentence(settings)}`,
				`cache: ${cacheDir} (served without asking for ${settings.cacheTtlSeconds} s, then revalidated)`,
				'mode: read-only (stage 1)',
			],
			check: (): Promise<CheckLine[]> =>
				checkGitHub({
					client,
					settings,
					project: { statuses: context.statuses, types: context.types },
					repoUrl,
					now: Date.now,
					tokenHint: tokenSentence(settings),
				}),
			takeNotices: () => notices.splice(0, notices.length),
			dispose: () => Promise.resolve(),
		};
		return instance;
	},
};
