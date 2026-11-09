// `task strategy check` for the gitlab strategy: what a person needs to know before relying on the project. Each finding is a line
// with its fix; a failed probe is a line, never a throw. Nothing is written: GET only, cache bypassed (a check must see the server).
//
// NOT VERIFIED AGAINST A REAL GITLAB: the list ALWAYS ends with the `verification` warning, also when an earlier line stopped the
// list (the failing line stays the one before it), so the limitation is never missing from the output.
import {
	BackendAuthError,
	BackendLimitError,
	BackendTimeoutError,
	BackendUnreachableError,
	RateLimitedError,
} from '@wadeck-app/task-core';

import type { CheckLine, DeclaredFills, ProjectFacts } from '../kinds.js';
import { GitLabHttpError } from './gitlabClient.js';
import type { GitLabClient } from './gitlabClient.js';
import { wantedLabels } from './gitlabLabels.js';
import type { GitLabSettings, GitLabTier } from './gitlabOptions.js';
import type { ApiProject, ApiProjectLabel } from './gitlabTypes.js';

export interface GitLabCheckInput {
	client: GitLabClient;
	settings: GitLabSettings;
	project: ProjectFacts;
	/** The page of the project on GitLab, for the fixes. */
	projectUrl: string;
	now: () => number;
	/** Where the token comes from, in words, for the fix. */
	tokenHint: string;
	/** The fills the project declared. */
	fills: DeclaredFills;
	/** The task project as `-p` takes it, for the commands the fixes name. */
	projectName: string;
}

interface TokenInfo {
	name?: string;
	scopes?: string[];
	expires_at?: string | null;
	active?: boolean;
	revoked?: boolean;
}

interface VersionInfo {
	version?: string;
}

interface PlanInfo {
	plan?: string | null;
}

const DAY_MS = 86_400_000;
const SLOW_MS = 500;

// The access levels of docs.gitlab.com/api/projects (`min_access_level`). That the same numbers apply to `permissions.project_access`
// is UNVERIFIED (the page does not say), so the label is only a hint next to the number.
const ACCESS_LEVELS: Readonly<Record<number, string>> = {
	10: 'Guest',
	15: 'Planner',
	20: 'Reporter',
	25: 'Security Manager',
	30: 'Developer',
	40: 'Maintainer',
	50: 'Owner',
};

const TIER_RANK: Record<GitLabTier, number> = { free: 0, premium: 1, ultimate: 2 };

/** The tier a `plan` word of GitLab means; undefined for a word this code does not know. */
export function tierOfPlan(plan: string): GitLabTier | undefined {
	switch (plan.trim().toLowerCase()) {
		case 'free':
		case 'default':
			return 'free';
		case 'premium':
		case 'silver':
			return 'premium';
		case 'ultimate':
		case 'gold':
			return 'ultimate';
		default:
			return undefined;
	}
}

export const VERIFICATION_TEXT =
	'this strategy has not been verified against a real GitLab instance: it was built from docs.gitlab.com and a fake server';

/** The line a failed probe becomes. */
function failureLine(name: string, error: unknown, input: GitLabCheckInput): CheckLine {
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
	if (error instanceof GitLabHttpError && error.status === 404) {
		return {
			name: 'project',
			status: 'error',
			text: `${input.settings.project.ref} was not found, or this token cannot see it`,
			fix: `Check strategy.options.project (the path group/project, or the numeric id) in the project config, and that the user of the token is a member of ${input.settings.project.ref} (GitLab answers 404 for a private project the user cannot see). It is read from ${input.tokenHint}.`,
		};
	}
	return {
		name,
		status: 'error',
		text: error instanceof Error ? error.message : String(error),
		fix: 'Run the command again; if it keeps failing, task cli logs shows the cause',
	};
}

function describeMap(settings: GitLabSettings): string {
	return Object.entries(settings.statusMap)
		.map(([status, rule]) => `${status} = ${rule.state}${rule.label === undefined ? '' : ` + ${rule.label}`}`)
		.join('; ');
}

function authLine(token: TokenInfo | undefined, now: number): { line: CheckLine; canWrite: boolean | undefined } {
	if (token === undefined) {
		return {
			canWrite: undefined,
			line: {
				name: 'auth',
				status: 'ok',
				text: 'the token is accepted; it is not a personal access token (a project or group access token, or OAuth), so its scopes and expiry cannot be read',
			},
		};
	}
	const scopes = token.scopes ?? [];
	const shown = scopes.length === 0 ? 'no scope listed' : `scopes ${scopes.join(', ')}`;
	if (token.active === false || token.revoked === true) {
		return {
			canWrite: false,
			line: {
				name: 'auth',
				status: 'error',
				text: `the token is ${token.revoked === true ? 'revoked' : 'inactive'} (${shown})`,
				fix: 'Create a new access token with the scope api and put it where the config points',
			},
		};
	}
	const expires = token.expires_at ?? undefined;
	let days: number | undefined;
	if (expires !== undefined) {
		const at = Date.parse(expires.length === 10 ? `${expires}T23:59:59Z` : expires);
		if (!Number.isNaN(at)) days = Math.ceil((at - now) / DAY_MS);
	}
	if (days !== undefined && days <= 0) {
		return {
			canWrite: false,
			line: {
				name: 'auth',
				status: 'error',
				text: `the token expired on ${expires} (${shown})`,
				fix: 'Create a new access token with the scope api and put it where the config points',
			},
		};
	}
	const canWrite = scopes.includes('api');
	const expiry =
		expires === undefined ? 'no expiry date' : `expires ${expires}${days === undefined ? '' : ` (${days} days)`}`;
	if (days !== undefined && days <= 7) {
		return {
			canWrite,
			line: {
				name: 'auth',
				status: 'warn',
				text: `the token expires in ${days} day${days === 1 ? '' : 's'} (${expires}); ${shown}`,
				fix: 'Create its replacement before then: every command on this project fails once it expires',
			},
		};
	}
	if (!canWrite) {
		return {
			canWrite,
			line: {
				name: 'auth',
				status: 'warn',
				text: `the token is accepted (${shown}, ${expiry}) but lacks the scope api: it can only read, every write will be refused`,
				fix: 'Create an access token with the scope api (GitLab > Preferences > Access tokens) and put it where the config points',
			},
		};
	}
	return { canWrite, line: { name: 'auth', status: 'ok', text: `the token is accepted (${shown}, ${expiry})` } };
}

function levelOf(project: ApiProject): number | undefined {
	const levels = [project.permissions?.project_access?.access_level, project.permissions?.group_access?.access_level];
	const known = levels.filter((level): level is number => typeof level === 'number');
	return known.length === 0 ? undefined : Math.max(...known);
}

function projectLine(project: ApiProject, input: GitLabCheckInput): CheckLine {
	const level = levelOf(project);
	const access =
		level === undefined
			? 'access level not reported'
			: `access level ${level}${ACCESS_LEVELS[level] ? ` (${ACCESS_LEVELS[level]}?)` : ''}`;
	const text = `${project.path_with_namespace} (${access}${project.archived === true ? ', archived' : ''})`;
	if (project.issues_access_level === 'disabled' || project.issues_enabled === false) {
		return {
			name: 'project',
			status: 'error',
			text: `Issues are disabled on ${project.path_with_namespace}`,
			fix: `Enable Issues in the project settings (Settings > General > Visibility, project features, permissions): ${input.projectUrl}/edit`,
		};
	}
	if (project.archived === true) {
		return {
			name: 'project',
			status: 'warn',
			text,
			fix: 'An archived project is read-only on GitLab: reads work, every write will be refused',
		};
	}
	if (input.fills['delete']?.use === 'hard' && level !== undefined && level < 15) {
		return {
			name: 'project',
			status: 'warn',
			text,
			fix: 'fills.delete: hard needs the Planner or Owner role (or being the author of the issue, since GitLab 18.10): deleting a task will fail. Use a user with that role, or declare "delete: { use: tombstone, fidelity: degrade }" in strategy.options.fills',
		};
	}
	return { name: 'project', status: 'ok', text };
}

/** What GitLab says the plan is: the namespace first, then the instance metadata; undefined when neither tells. */
async function planFound(
	client: GitLabClient,
	project: ApiProject
): Promise<{ plan: string; from: string } | undefined> {
	const namespace = project.namespace?.id;
	if (namespace !== undefined) {
		try {
			const answer = await client.get<PlanInfo>(`/namespaces/${namespace}`, {
				cache: false,
				allowNotFound: true,
			});
			const plan = answer.status === 404 ? undefined : answer.body.plan;
			if (typeof plan === 'string' && plan !== '') return { plan, from: `namespace ${namespace}` };
		} catch {
			// hidden or refused: the instance metadata is tried next
		}
	}
	try {
		const answer = await client.get<PlanInfo>('/metadata', { cache: false, allowNotFound: true });
		const plan = answer.status === 404 ? undefined : answer.body.plan;
		if (typeof plan === 'string' && plan !== '') return { plan, from: 'the instance metadata' };
	} catch {
		// not readable
	}
	return undefined;
}

async function tierLine(client: GitLabClient, project: ApiProject, input: GitLabCheckInput): Promise<CheckLine> {
	const declared = input.settings.tier;
	const found = await planFound(client, project);
	if (found === undefined) {
		return {
			name: 'tier',
			status: 'ok',
			text: `tier: ${declared} (declared); GitLab does not tell the plan to this token, so it could not be probed and the declaration is trusted`,
		};
	}
	const actual = tierOfPlan(found.plan);
	if (actual === undefined) {
		return {
			name: 'tier',
			status: 'ok',
			text: `tier: ${declared} (declared); ${found.from} reports the plan "${found.plan}", which this version does not know: the declaration is trusted`,
		};
	}
	if (TIER_RANK[declared] > TIER_RANK[actual]) {
		return {
			name: 'tier',
			status: 'warn',
			text: `tier: ${declared} (declared) but ${found.from} reports the plan "${found.plan}" (${actual}): scoped labels and blocking links will be refused by GitLab`,
			fix: `Set strategy.options.tier to ${actual} in the project config, or upgrade the plan of ${input.settings.project.ref}`,
		};
	}
	if (TIER_RANK[declared] < TIER_RANK[actual]) {
		return {
			name: 'tier',
			status: 'ok',
			text: `tier: ${declared} (declared); ${found.from} reports the plan "${found.plan}" (${actual}): more exists than task uses, set tier: ${actual} to use scoped labels and blocking links`,
		};
	}
	return {
		name: 'tier',
		status: 'ok',
		text: `tier: ${declared} (declared), matches the plan "${found.plan}" (${found.from})`,
	};
}

function limitsLine(client: GitLabClient): CheckLine {
	const rate = client.rateLimit();
	if (rate === undefined) {
		return { name: 'limits', status: 'ok', text: 'the instance sends no RateLimit headers; no quota to report' };
	}
	const resets = new Date(rate.resetAt * 1000).toISOString();
	const low = rate.remaining <= rate.limit * 0.1;
	return {
		name: 'limits',
		status: low ? 'warn' : 'ok',
		text: `${rate.remaining} of ${rate.limit} requests left in this window (resets ${resets})`,
		...(low ? { fix: `Wait until ${resets}, or use a token of a user with a larger quota` } : {}),
	};
}

function writesLine(input: GitLabCheckInput, canWrite: boolean | undefined): CheckLine {
	const { settings } = input;
	const rate = input.client.rateLimit();
	const left = rate === undefined ? '' : ` (${rate.remaining} of ${rate.limit} requests left in this window)`;
	const budget = `a write is sent one at a time, ${settings.writeSpacingSeconds} s apart${left}; optimistic, not atomic: GitLab has no conditional write, so a change made on GitLab in the second between the read and the write can be overwritten`;
	if (canWrite === false) {
		return {
			name: 'writes',
			status: 'warn',
			text: `this token has no write scope (see auth): reads work, every write will fail; ${budget}`,
			fix: `Give the token the scope api, then run this check again. It is read from ${input.tokenHint}.`,
		};
	}
	return { name: 'writes', status: 'ok', text: budget };
}

async function probeLines(input: GitLabCheckInput, lines: CheckLine[]): Promise<void> {
	const { client, settings, project } = input;
	const projectPath = `/projects/${settings.project.apiId}`;
	const started = input.now();
	let version: VersionInfo;
	try {
		version = (await client.get<VersionInfo>('/version', { cache: false })).body;
	} catch (error) {
		lines.push(failureLine('reachable', error, input));
		return;
	}
	const ms = input.now() - started;
	lines.push({
		name: 'reachable',
		status: ms > SLOW_MS ? 'warn' : 'ok',
		text: `${new URL(settings.baseUrl).host} answered (GitLab ${version.version ?? 'version not reported'}, ${ms} ms)`,
		...(ms > SLOW_MS
			? {
					fix: 'Every task command makes several requests: a slow network makes them slow; raise timeoutSeconds if they time out',
				}
			: {}),
	});

	let token: TokenInfo | undefined;
	try {
		const answer = await client.get<TokenInfo>('/personal_access_tokens/self', {
			cache: false,
			allowNotFound: true,
		});
		token = answer.status === 404 ? undefined : answer.body;
	} catch (error) {
		lines.push(failureLine('auth', error, input));
		return;
	}
	const auth = authLine(token, input.now());
	lines.push(auth.line);
	if (auth.line.status === 'error') return;

	let found: ApiProject;
	try {
		found = (await client.get<ApiProject>(projectPath, { cache: false })).body;
	} catch (error) {
		lines.push(failureLine('project', error, input));
		return;
	}
	const projectLineResult = projectLine(found, input);
	lines.push(projectLineResult);
	if (projectLineResult.status === 'error') return;

	lines.push(await tierLine(client, found, input));

	let firstIid: number | undefined;
	try {
		const answer = await client.get<Array<{ iid: number }>>(`${projectPath}/issues`, {
			query: { per_page: 1 },
			cache: false,
		});
		firstIid = answer.body[0]?.iid;
		lines.push({ name: 'issues', status: 'ok', text: 'Issues are readable with this token' });
	} catch (error) {
		lines.push(failureLine('issues', error, input));
		return;
	}

	lines.push(limitsLine(client));
	lines.push({
		name: 'statuses',
		status: 'ok',
		text: `${Object.keys(settings.statusMap).length} statuses mapped: ${describeMap(settings)}`,
	});

	const wanted = wantedLabels(settings, project.types, input.fills).map(label => label.name);
	if (wanted.length > 0) {
		try {
			const present = await client.getAll<ApiProjectLabel>(`${projectPath}/labels`, {
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
							fix: `Reading works without them, and GitLab creates a label the first time a write names it (with a default colour). Create them all now, with a colour and a description, with: task labels sync -p ${input.projectName} (add --dry-run to see first). Missing: ${missing.join(', ')}`,
						}
			);
		} catch (error) {
			lines.push(failureLine('labels', error, input));
		}
	}

	if (settings.tier === 'free') {
		lines.push({
			name: 'links',
			status: 'ok',
			text: 'tier free: blockedBy links are refused (the blocks / is_blocked_by issue links are GitLab Premium and Ultimate); relates_to exists on every tier and backs the relate-block fills',
		});
	} else if (firstIid === undefined) {
		lines.push({
			name: 'links',
			status: 'ok',
			text: `tier ${settings.tier}: blocking links are used; they cannot be probed without writing (UNVERIFIED), and the project has no issue yet to read the link list of`,
		});
	} else {
		try {
			await client.get(`${projectPath}/issues/${firstIid}/links`, { query: { per_page: 1 }, cache: false });
			lines.push({
				name: 'links',
				status: 'ok',
				text: `tier ${settings.tier}: the issue links answer; blocking links (blocks / is_blocked_by) cannot be probed without writing (UNVERIFIED), GitLab refuses them at the first write if the plan lacks them`,
			});
		} catch (error) {
			lines.push(failureLine('links', error, input));
		}
	}

	lines.push({
		name: 'hierarchy',
		status: 'ok',
		text: 'the GitLab REST API has no parent of an issue: set-parent and children are refused, every task reads as a root task',
	});
	lines.push(
		writesLine(input, auth.line.status === 'warn' && /lacks the scope api/.test(auth.line.text) ? false : undefined)
	);
}

/** The lines of `task strategy check` for a gitlab project. */
export async function checkGitLab(input: GitLabCheckInput): Promise<CheckLine[]> {
	const lines: CheckLine[] = [];
	await probeLines(input, lines);
	lines.push({
		name: 'verification',
		status: 'warn',
		text: VERIFICATION_TEXT,
		fix: 'try it on a scratch project first: task strategy check, task migrate --dry-run; report any difference',
	});
	return lines;
}
