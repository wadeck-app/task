// `task strategy check` for the github strategy: what a person needs to know before relying on the project. Each finding is a line
// with its fix; a failed probe is a line, never a throw. Nothing is written: GET only, cache bypassed (a check must see the server).
import {
	BackendAuthError,
	BackendLimitError,
	BackendTimeoutError,
	BackendUnreachableError,
	RateLimitedError,
} from '@wadeck-app/task-core';

import type { CheckLine, DeclaredFills, ProjectFacts } from '../kinds.js';
import { wantedLabels } from './githubLabels.js';
import { GitHubHttpError } from './githubClient.js';
import type { GitHubClient } from './githubClient.js';
import type { GitHubSettings } from './githubOptions.js';

export interface CheckInput {
	client: GitHubClient;
	settings: GitHubSettings;
	project: ProjectFacts;
	/** The page of the repository on GitHub (`https://github.com/acme/shop`), for the fixes. */
	repoUrl: string;
	now: () => number;
	/** Where the token comes from, in words, for the fix. */
	tokenHint: string;
	/** The fills the project declared. */
	fills: DeclaredFills;
	/** The project as `-p` takes it, for the commands the fixes name. */
	projectName: string;
}

interface RepoInfo {
	full_name: string;
	private?: boolean;
	has_issues?: boolean;
	archived?: boolean;
	/** What the token's user may do on the repository (absent for some tokens). */
	permissions?: { admin?: boolean; push?: boolean };
}

interface LabelInfo {
	name: string;
}

interface RateLimits {
	resources?: Record<string, { limit: number; remaining: number; reset: number }>;
}

const DAY_MS = 86_400_000;

function isLoopback(host: string): boolean {
	return host === 'localhost' || host === '[::1]' || /^127(\.\d{1,3}){3}$/.test(host);
}

/** True when the token would travel in clear text over a network: `http://` to anything but this machine. */
export function sendsTokenInClear(baseUrl: string): boolean {
	const url = new URL(baseUrl);
	return url.protocol === 'http:' && !isLoopback(url.hostname);
}

/** The line a failed probe becomes. */
function failureLine(name: string, error: unknown, input: CheckInput): CheckLine {
	if (error instanceof BackendUnreachableError || error instanceof BackendTimeoutError) {
		return { name: 'reachable', status: 'error', text: error.message, fix: error.hint };
	}
	if (error instanceof BackendAuthError) {
		// A refused token is the `auth` finding; a missing permission belongs to the probe that needed it.
		return {
			name: error.reason === 'forbidden' ? name : 'auth',
			status: 'error',
			text: error.message,
			fix: error.hint,
		};
	}
	if (error instanceof RateLimitedError) {
		return { name: 'limits', status: 'error', text: error.message, fix: error.hint };
	}
	if (error instanceof BackendLimitError) {
		return { name, status: 'error', text: error.message, fix: error.hint };
	}
	if (error instanceof GitHubHttpError && error.status === 404) {
		return {
			name: 'repo',
			status: 'error',
			text: `${input.settings.repo.full} was not found, or this token cannot see it`,
			fix: `Check strategy.options.repo (owner/name) in the project config, and that the token's repository access includes ${input.settings.repo.full} (GitHub answers 404 for a private repository the token cannot see). It is read from ${input.tokenHint}.`,
		};
	}
	if (error instanceof GitHubHttpError && error.status === 410) {
		return {
			name: 'issues',
			status: 'error',
			text: `Issues are disabled on ${input.settings.repo.full}`,
			fix: `Enable Issues in the repository settings: ${input.repoUrl}/settings`,
		};
	}
	return {
		name,
		status: 'error',
		text: error instanceof Error ? error.message : String(error),
		fix: 'Run the command again; if it keeps failing, task cli logs shows the cause',
	};
}

function expiryLine(expires: string | undefined, now: number): CheckLine {
	if (expires === undefined) {
		return {
			name: 'expiry',
			status: 'ok',
			text: 'GitHub reports no expiry date for this token (a classic token, or one that does not expire)',
		};
	}
	const at = Date.parse(expires.replace(' UTC', 'Z').replace(' ', 'T'));
	if (Number.isNaN(at)) return { name: 'expiry', status: 'ok', text: `the token expires ${expires}` };
	const days = Math.ceil((at - now) / DAY_MS);
	if (days <= 0) {
		return {
			name: 'expiry',
			status: 'error',
			text: `the token expired on ${expires}`,
			fix: 'Create a new fine-grained token with the same permissions and put it where the config points',
		};
	}
	if (days <= 7) {
		return {
			name: 'expiry',
			status: 'warn',
			text: `the token expires in ${days} day${days === 1 ? '' : 's'} (${expires})`,
			fix: 'Create its replacement before then: every command on this project fails once it expires',
		};
	}
	return { name: 'expiry', status: 'ok', text: `the token expires ${expires} (${days} days)` };
}

function describeMap(settings: GitHubSettings): string {
	return Object.entries(settings.statusMap)
		.map(([status, rule]) => {
			const reason = rule.reason === undefined ? '' : ` (${rule.reason})`;
			return `${status} = ${rule.state}${reason}${rule.label === undefined ? '' : ` + ${rule.label}`}`;
		})
		.join('; ');
}

/**
 * What a write costs and risks, and whether this token can make one. Writes go one at a time, at least writeSpacingSeconds apart;
 * GitHub has no conditional write, so a change made by someone else in the second between our read and our write can be overwritten.
 */
function writesLine(repo: RepoInfo, input: CheckInput): CheckLine {
	const { settings, fills } = input;
	const quota = input.client.rateLimit('core');
	const left = quota === undefined ? '' : ` (${quota.remaining} of ${quota.limit} requests left this hour)`;
	const budget = `a write is sent one at a time, ${settings.writeSpacingSeconds} s apart, and costs one request of the hourly quota${left}; optimistic, not atomic: GitHub has no conditional write, so a change made on GitHub in the second between the read and the write can be overwritten`;
	if (repo.permissions?.push === false) {
		return {
			name: 'writes',
			status: 'warn',
			text: `this token cannot write issues on ${settings.repo.full} (the repository reports push: false); reads work, every write will fail`,
			fix: `Give the token Issues: Read and write on ${settings.repo.full} (Settings > Developer settings > Fine-grained tokens), then run this check again. It is read from ${input.tokenHint}.`,
		};
	}
	if (fills['delete']?.use === 'hard' && repo.permissions?.admin === false) {
		return {
			name: 'writes',
			status: 'warn',
			text: `fills.delete: hard needs a repository administrator, and the user of this token is not one: deleting a task will fail; ${budget}`,
			fix: 'Use the token of an administrator, or declare "delete: { use: tombstone, fidelity: degrade }" in strategy.options.fills (the issue is closed and hidden instead of deleted)',
		};
	}
	return { name: 'writes', status: 'ok', text: budget };
}

/** The lines of `task strategy check` for a github project. */
export async function checkGitHub(input: CheckInput): Promise<CheckLine[]> {
	const { client, settings, project } = input;
	const repoPath = `/repos/${settings.repo.full}`;
	const lines: CheckLine[] = [];
	const host = new URL(settings.baseUrl).host;

	let repo: RepoInfo;
	try {
		repo = (await client.get<RepoInfo>(repoPath, { cache: false })).body;
	} catch (error) {
		return [failureLine('repo', error, input)];
	}
	lines.push(
		{ name: 'reachable', status: 'ok', text: `${host} answered` },
		{ name: 'auth', status: 'ok', text: 'the token is accepted' },
		{
			name: 'repo',
			status: repo.archived === true ? 'warn' : 'ok',
			text: `${repo.full_name} (${repo.private === true ? 'private' : 'public'}${repo.archived === true ? ', archived' : ''})`,
			...(repo.archived === true
				? { fix: 'An archived repository is read-only on GitHub too; nothing to do for reads' }
				: {}),
		},
		expiryLine(client.tokenExpiresAt(), input.now())
	);
	if (sendsTokenInClear(settings.baseUrl)) {
		lines.push({
			name: 'security',
			status: 'warn',
			text: `plain HTTP to ${host}: the token travels in clear`,
			fix: 'Use an https:// baseUrl',
		});
	}

	if (repo.has_issues === false) {
		lines.push(failureLine('issues', new GitHubHttpError(410, repoPath, 'disabled', 'disabled'), input));
		return lines;
	}
	let first: number | undefined;
	try {
		const answer = await client.get<Array<{ number: number; pull_request?: unknown }>>(`${repoPath}/issues`, {
			query: { per_page: 5, state: 'all' },
			cache: false,
		});
		first = answer.body.find(issue => issue.pull_request === undefined || issue.pull_request === null)?.number;
		lines.push({ name: 'issues', status: 'ok', text: 'Issues are readable with this token' });
	} catch (error) {
		lines.push(failureLine('issues', error, input));
		return lines;
	}

	try {
		const limits = (await client.get<RateLimits>('/rate_limit', { cache: false })).body.resources ?? {};
		const core = limits['core'];
		const search = limits['search'];
		if (core !== undefined) {
			const resets = new Date(core.reset * 1000).toISOString();
			const low = core.remaining <= Math.max(50, core.limit * 0.05);
			lines.push({
				name: 'limits',
				status: low ? 'warn' : 'ok',
				text: `${core.remaining} of ${core.limit} requests left this hour (resets ${resets})${
					search === undefined ? '' : `; search ${search.remaining} of ${search.limit} per minute`
				}`,
				...(low
					? {
							fix: `Wait until ${resets}, or use a token with a larger quota; every read is cached and revalidated (a 304 costs nothing)`,
						}
					: {}),
			});
		}
	} catch (error) {
		lines.push(failureLine('limits', error, input));
	}

	lines.push({
		name: 'statuses',
		status: 'ok',
		text: `${Object.keys(settings.statusMap).length} statuses mapped: ${describeMap(settings)}`,
	});

	const wanted = wantedLabels(settings, project.types, input.fills).map(label => label.name);
	if (wanted.length > 0) {
		try {
			const present = await client.getAll<LabelInfo>(`${repoPath}/labels`, {
				query: { per_page: settings.pageSize },
				cache: false,
			});
			const known = new Set(present.items.map(label => label.name.toLowerCase()));
			const missing = wanted.filter(label => !known.has(label.toLowerCase()));
			lines.push(
				missing.length === 0
					? {
							name: 'labels',
							status: 'ok',
							text: `the ${wanted.length} labels the mapping uses exist (${wanted.join(', ')})`,
						}
					: {
							name: 'labels',
							status: 'warn',
							text: `${missing.length} of the ${wanted.length} labels the mapping uses do not exist yet: ${missing.join(', ')}`,
							fix: `Reading works without them, and a write creates the label it needs the first time it uses it. Create them all now, with a colour and a description, with: task labels sync -p ${input.projectName} (add --dry-run to see first). Missing: ${missing.join(', ')}`,
						}
			);
		} catch (error) {
			lines.push(failureLine('labels', error, input));
		}
	}

	if (first === undefined) {
		lines.push({
			name: 'hierarchy',
			status: 'ok',
			text: 'no issue yet to probe sub-issues and dependencies with; they are probed once the repository has one',
		});
	} else {
		for (const [name, path, what, effect] of [
			['hierarchy', 'sub_issues', 'sub-issues', 'every task reads as a root task'],
			['dependencies', 'dependencies/blocked_by', 'issue dependencies', 'blockedBy links read as none'],
		] as const) {
			try {
				const probe = await client.get(`${repoPath}/issues/${first}/${path}`, {
					query: { per_page: 1 },
					cache: false,
					allowNotFound: true,
				});
				lines.push(
					probe.status === 404
						? {
								name,
								status: 'warn',
								text: `${what} are not available on ${host}: ${effect}`,
								fix: `${what} need github.com or a GitHub Enterprise Server version that has them; nothing to configure`,
							}
						: {
								name,
								status: 'ok',
								text: `${what} are readable${name === 'hierarchy' ? ' (GitHub allows 8 levels, 100 per parent)' : ''}`,
							}
				);
			} catch (error) {
				lines.push(failureLine(name, error, input));
			}
		}
	}

	lines.push(
		{
			name: 'search',
			status: 'ok',
			text: 'native Search API: 30 requests a minute, a new issue is searchable after a few seconds (not read-your-writes); find and tree read the full list, which is exact',
		},
		writesLine(repo, input)
	);
	return lines;
}
