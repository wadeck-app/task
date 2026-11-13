// `task strategy check` for the gitlab strategy: what a person needs to know before relying on the project. Each finding is a line
// with its fix; a failed probe is a line, never a throw. GET only, cache bypassed (a check must see the server), with ONE documented
// exception: the `write` probe sends a PUT with the title the issue already has (VERIFIED-LIVE 2026-11-09: 200, no new `updated_at`,
// no event, no system note), and it needs an existing issue (the check never creates one).
//
// The probes depend only on what the live fine-grained test token could do (issues, notes, links, labels, GraphQL work items): the
// endpoints it could NOT read (`/version`, `/user`, `/personal_access_tokens/self`, `GET /projects/:id`) only add facts when the token
// may read them, and are never a failure. One line per row of CREDENTIAL_REQUIREMENTS says whether the capability is enabled.
import {
	BackendAuthError,
	BackendLimitError,
	BackendTimeoutError,
	BackendUnreachableError,
	RateLimitedError,
} from '@wadeck-app/task-core';

import type { CheckLine, DeclaredFills, ProjectFacts } from '../kinds.js';
import { CREDENTIAL_REQUIREMENTS } from './credentialRequirements.js';
import type { CredentialKey, CredentialRequirement } from './credentialRequirements.js';
import { GitLabPermissionError, GitLabProjectNotFoundError } from './gitlabClient.js';
import type { GitLabClient } from './gitlabClient.js';
import { wantedLabels } from './gitlabLabels.js';
import { GQL_READ } from './gitlabWorkItems.js';
import type { GitLabSettings } from './gitlabOptions.js';
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
	enterprise?: boolean;
}

interface FirstIssue {
	iid: number;
	id?: number;
	title: string;
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

export const VERIFICATION_TEXT =
	'verified live on gitlab.com Free on 2026-11-09 with a fine-grained personal access token (issues, notes, links, labels, resource events, work items); NOT verified: classic tokens (api, read_api), self-managed instances, and GitLab Premium or Ultimate (which task does not support)';

function row(key: CredentialKey): CredentialRequirement {
	const found = CREDENTIAL_REQUIREMENTS.find(candidate => candidate.key === key);
	if (found === undefined) throw new Error(`gitlab credential requirement "${key}" is not in the table`);
	return found;
}

const needs = (requirement: CredentialRequirement): string => requirement.fineGrained.join(', ');

function enabled(requirement: CredentialRequirement, note = ''): CheckLine {
	return { name: requirement.key, status: 'ok', text: `enabled: ${requirement.title}${note}` };
}

function notTested(requirement: CredentialRequirement): CheckLine {
	return {
		name: requirement.key,
		status: 'ok',
		text: `not tested (cannot be probed without changing data); needs ${needs(requirement)}: ${requirement.title}`,
	};
}

/** The line a refused capability probe becomes: a warning, an error for a row without which nothing works. */
function disabled(requirement: CredentialRequirement, error: unknown, input: GitLabCheckInput): CheckLine {
	const status = requirement.required ? 'error' : 'warn';
	if (error instanceof GitLabPermissionError) {
		return {
			name: requirement.key,
			status,
			text: `disabled (missing ${error.denied.permissions.join(', ')}): ${requirement.title}`,
			fix: error.hint,
		};
	}
	if (error instanceof BackendAuthError) {
		return {
			name: requirement.key,
			status,
			text: `disabled (${error.message}): ${requirement.title}`,
			fix: error.hint,
		};
	}
	return {
		name: requirement.key,
		status,
		text: `could not be tested: ${error instanceof Error ? error.message : String(error)}`,
		fix: `Run the command again; if it keeps failing, task cli logs shows the cause. Needs ${needs(requirement)} (token read from ${input.tokenHint}).`,
	};
}

/** An optional information row that the token cannot read: never a warning, never a failure. */
function notReadable(requirement: CredentialRequirement): CheckLine {
	return {
		name: requirement.key,
		status: 'ok',
		text: `not readable with this token (needs ${needs(requirement)}); optional, only used for information`,
	};
}

const isDenied = (error: unknown): boolean => error instanceof BackendAuthError && error.reason === 'forbidden';

/** The line a failed first probe becomes (the server did not give the issues). */
function firstProbeFailure(error: unknown, input: GitLabCheckInput): CheckLine[] {
	if (error instanceof BackendUnreachableError || error instanceof BackendTimeoutError) {
		return [{ name: 'reachable', status: 'error', text: error.message, fix: error.hint }];
	}
	if (error instanceof BackendAuthError && error.reason !== 'forbidden') {
		return [
			{ name: 'reachable', status: 'ok', text: `${new URL(input.settings.baseUrl).host} answered` },
			{ name: 'auth', status: 'error', text: error.message, fix: error.hint },
		];
	}
	const answered: CheckLine = {
		name: 'reachable',
		status: 'ok',
		text: `${new URL(input.settings.baseUrl).host} answered`,
	};
	if (error instanceof GitLabProjectNotFoundError) {
		return [
			answered,
			{ name: 'auth', status: 'ok', text: 'the token is accepted' },
			{ name: 'project', status: 'error', text: error.message, fix: error.hint },
		];
	}
	if (error instanceof GitLabPermissionError || isDenied(error)) {
		return [
			answered,
			{ name: 'auth', status: 'ok', text: 'the token is accepted' },
			disabled(row('read'), error, input),
		];
	}
	if (error instanceof RateLimitedError) {
		return [{ name: 'limits', status: 'error', text: error.message, fix: error.hint }];
	}
	if (error instanceof BackendLimitError) {
		return [{ name: 'read', status: 'error', text: error.message, fix: error.hint }];
	}
	return [
		{
			name: 'read',
			status: 'error',
			text: error instanceof Error ? error.message : String(error),
			fix: 'Run the command again; if it keeps failing, task cli logs shows the cause',
		},
	];
}

function describeMap(settings: GitLabSettings): string {
	return Object.entries(settings.statusMap)
		.map(([status, rule]) => `${status} = ${rule.state}${rule.label === undefined ? '' : ` + ${rule.label}`}`)
		.join('; ');
}

/** The `token-info` line from `GET /personal_access_tokens/self` (readable only with `Personal Access Token: Read`). */
function tokenLine(token: TokenInfo | undefined, now: number): CheckLine {
	const requirement = row('token-info');
	if (token === undefined) {
		return {
			name: requirement.key,
			status: 'ok',
			text: 'the token is not a personal access token (a project or group access token, or OAuth), so its scopes and expiry cannot be read',
		};
	}
	const scopes = token.scopes ?? [];
	const shown = scopes.length === 0 ? 'no scope listed' : `scopes ${scopes.join(', ')}`;
	if (token.active === false || token.revoked === true) {
		return {
			name: requirement.key,
			status: 'error',
			text: `the token is ${token.revoked === true ? 'revoked' : 'inactive'} (${shown})`,
			fix: 'Create a new access token and put it where the config points',
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
			name: requirement.key,
			status: 'error',
			text: `the token expired on ${expires} (${shown})`,
			fix: 'Create a new access token and put it where the config points',
		};
	}
	if (days !== undefined && days <= 7) {
		return {
			name: requirement.key,
			status: 'warn',
			text: `the token expires in ${days} day${days === 1 ? '' : 's'} (${expires}); ${shown}`,
			fix: 'Create its replacement before then: every command on this project fails once it expires',
		};
	}
	const expiry =
		expires === undefined ? 'no expiry date' : `expires ${expires}${days === undefined ? '' : ` (${days} days)`}`;
	return { name: requirement.key, status: 'ok', text: `${shown}, ${expiry}` };
}

function levelOf(project: ApiProject): number | undefined {
	const levels = [project.permissions?.project_access?.access_level, project.permissions?.group_access?.access_level];
	const known = levels.filter((level): level is number => typeof level === 'number');
	return known.length === 0 ? undefined : Math.max(...known);
}

/** The `project-info` line from `GET /projects/:id` (readable only with `Project: Read`). */
function projectLine(project: ApiProject, input: GitLabCheckInput): CheckLine {
	const name = row('project-info').key;
	const level = levelOf(project);
	const access =
		level === undefined
			? 'access level not reported'
			: `access level ${level}${ACCESS_LEVELS[level] ? ` (${ACCESS_LEVELS[level]}?)` : ''}`;
	const text = `${project.path_with_namespace} (${access}${project.archived === true ? ', archived' : ''})`;
	if (project.issues_access_level === 'disabled' || project.issues_enabled === false) {
		return {
			name,
			status: 'error',
			text: `Issues are disabled on ${project.path_with_namespace}`,
			fix: `Enable Issues in the project settings (Settings > General > Visibility, project features, permissions): ${input.projectUrl}/edit`,
		};
	}
	if (project.archived === true) {
		return {
			name,
			status: 'warn',
			text,
			fix: 'An archived project is read-only on GitLab: reads work, every write will be refused',
		};
	}
	if (input.fills['delete']?.use === 'hard' && level !== undefined && level < 15) {
		return {
			name,
			status: 'warn',
			text,
			fix: 'fills.delete: hard needs the Planner or Owner role (or being the author of the issue, since GitLab 18.10): deleting a task will fail. Use a user with that role, or declare "delete: { use: tombstone, fidelity: degrade }" in strategy.options.fills',
		};
	}
	return { name, status: 'ok', text };
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
		...(low
			? {
					fix: `Wait until ${resets}, or use a token of a user with a larger quota. A command that meets the limit waits for the window to reopen (strategy.options.rateLimit.maxWaitSeconds)`,
				}
			: {}),
	};
}

function writesLine(input: GitLabCheckInput): CheckLine {
	const { settings } = input;
	const rate = input.client.rateLimit();
	const left = rate === undefined ? '' : ` (${rate.remaining} of ${rate.limit} requests left in this window)`;
	return {
		name: 'writes',
		status: 'ok',
		text: `a write is sent one at a time, ${settings.writeSpacingSeconds} s apart${left}; optimistic, not atomic: GitLab has no conditional write, so a change made on GitLab in the second between the read and the write can be overwritten`,
	};
}

/** `GET /projects/:id/labels` (the project's labels and its groups'), exact case: `bug` and `Bug` are two labels. */
function labelsLine(present: readonly ApiProjectLabel[], input: GitLabCheckInput): CheckLine | undefined {
	const wanted = wantedLabels(input.settings, input.project.types, input.fills).map(label => label.name);
	if (wanted.length === 0) return undefined;
	const known = new Set(present.map(label => label.name));
	const missing = wanted.filter(label => !known.has(label));
	if (missing.length === 0) {
		return {
			name: 'labels',
			status: 'ok',
			text: `the ${wanted.length} labels the mapping uses exist (${wanted.join(', ')})`,
		};
	}
	return {
		name: 'labels',
		status: 'warn',
		text: `${missing.length} of the ${wanted.length} labels the mapping uses do not exist yet: ${missing.join(', ')}`,
		fix: `Reading works without them, and GitLab creates a label the first time a write names it (with a default colour). Create them all now, with a colour and a description, with: task labels sync -p ${input.projectName} (add --dry-run to see first). Names are case sensitive. Missing: ${missing.join(', ')}`,
	};
}

interface WorkItemAnswer {
	data?: { workItem?: { id?: string } | null } | null;
	errors?: Array<{ message?: string }>;
}

async function probeLines(input: GitLabCheckInput, lines: CheckLine[]): Promise<void> {
	const { client, settings } = input;
	const projectPath = `/projects/${settings.project.apiId}`;
	const host = new URL(settings.baseUrl).host;

	// 1. One read of the issues gives reachable, auth and the read permission.
	const started = input.now();
	let issues: FirstIssue[];
	try {
		issues = (await client.get<FirstIssue[]>(`${projectPath}/issues`, { query: { per_page: 1 }, cache: false }))
			.body;
	} catch (error) {
		lines.push(...firstProbeFailure(error, input));
		return;
	}
	const ms = input.now() - started;
	lines.push({
		name: 'reachable',
		status: ms > SLOW_MS ? 'warn' : 'ok',
		text: `${host} answered (${ms} ms)`,
		...(ms > SLOW_MS
			? {
					fix: 'Every task command makes several requests: a slow network makes them slow; raise timeoutSeconds if they time out',
				}
			: {}),
	});
	lines.push({
		name: 'auth',
		status: 'ok',
		text: 'the token is accepted (its expiry cannot be read without Personal Access Token: Read, see token-info)',
	});
	lines.push(enabled(row('read')));
	const first = issues[0];

	// 2. write: the no-op PUT, on the first issue found.
	const write = row('write');
	let writeLine: CheckLine;
	let updateDenied = false;
	if (first === undefined) {
		writeLine = {
			name: write.key,
			status: 'ok',
			text: `not tested: the project has no issue to rewrite without changing it (the check never creates one); needs ${needs(write)}: ${write.title}`,
		};
	} else {
		try {
			await client.write('PUT', `${projectPath}/issues/${first.iid}`, { title: first.title });
			writeLine = enabled(
				write,
				' (Work Item: Update tested with a rewrite of the title of the first issue; nothing in the issue changes, but an issue never edited since its creation gets its updated_at refreshed once; Work Item: Create cannot be tested without creating a task)'
			);
		} catch (error) {
			updateDenied = error instanceof BackendAuthError;
			writeLine = disabled(write, error, input);
		}
	}
	lines.push(writeLine);
	lines.push(notTested(row('delete')));

	// 3. labels: read (also gives the labels of the mapping) and write.
	const labelsRead = row('labels-read');
	let present: ApiProjectLabel[] | undefined;
	try {
		present = (
			await client.getAll<ApiProjectLabel>(`${projectPath}/labels`, {
				query: { per_page: settings.pageSize },
				cache: false,
			})
		).items;
		lines.push(enabled(labelsRead));
	} catch (error) {
		lines.push(disabled(labelsRead, error, input));
	}
	lines.push(notTested(row('labels-write')));

	// 4. hierarchy: the work item of the first issue, read through GraphQL.
	const hierarchy = row('hierarchy');
	if (first === undefined || first.id === undefined) {
		lines.push({
			name: hierarchy.key,
			status: 'ok',
			text: `not tested: the project has no issue to read as a work item; needs ${needs(hierarchy)}: ${hierarchy.title}`,
		});
	} else {
		try {
			const answer = (
				await client.graphql<WorkItemAnswer>({
					query: GQL_READ,
					variables: { id: `gid://gitlab/WorkItem/${first.id}` },
				})
			).body;
			const error = answer.errors?.[0]?.message;
			if (error !== undefined || answer.data?.workItem === null || answer.data?.workItem === undefined) {
				lines.push({
					name: hierarchy.key,
					status: 'warn',
					text: `disabled (GraphQL did not return the work item${error === undefined ? '' : `: ${error}`}): ${hierarchy.title}`,
					fix: `Needs ${needs(hierarchy)} (token read from ${input.tokenHint}); run this check again`,
				});
			} else if (updateDenied) {
				lines.push({
					name: hierarchy.key,
					status: 'warn',
					text: `disabled (missing Work Item: Update, see write): ${hierarchy.title}`,
					fix: lines.find(line => line.name === 'write')?.fix ?? `Add the permission Work Item: Update`,
				});
			} else {
				lines.push(enabled(hierarchy, ' (Work Item: Read tested)'));
			}
		} catch (error) {
			lines.push(disabled(hierarchy, error, input));
		}
	}

	// 5. Optional information: only shown when the token may read it, never a failure.
	const projectInfo = row('project-info');
	try {
		const found = (await client.get<ApiProject>(projectPath, { cache: false })).body;
		lines.push(projectLine(found, input));
	} catch (error) {
		lines.push(
			isDenied(error) ? notReadable(projectInfo) : disabled({ ...projectInfo, required: false }, error, input)
		);
	}
	const tokenInfo = row('token-info');
	try {
		const answer = await client.get<TokenInfo>('/personal_access_tokens/self', {
			cache: false,
			allowNotFound: true,
		});
		lines.push(tokenLine(answer.status === 404 ? undefined : answer.body, input.now()));
	} catch (error) {
		lines.push(isDenied(error) ? notReadable(tokenInfo) : disabled(tokenInfo, error, input));
	}
	const serverInfo = row('server-info');
	try {
		const version = (await client.get<VersionInfo>('/version', { cache: false })).body;
		lines.push({
			name: serverInfo.key,
			status: 'ok',
			text: `GitLab ${version.version ?? 'version not reported'}`,
		});
	} catch (error) {
		lines.push(isDenied(error) ? notReadable(serverInfo) : disabled(serverInfo, error, input));
	}

	// 6. What the mapping needs.
	lines.push(limitsLine(client));
	lines.push({
		name: 'statuses',
		status: 'ok',
		text: `${Object.keys(settings.statusMap).length} statuses mapped: ${describeMap(settings)}`,
	});
	if (present !== undefined) {
		const labels = labelsLine(present, input);
		if (labels !== undefined) lines.push(labels);
	}
	// Blocking links cannot exist on the Free tier: nothing to probe, the refusal is stated.
	lines.push({
		name: 'links',
		status: 'ok',
		text: 'blockedBy links are refused (the blocks / is_blocked_by issue links need a paid GitLab tier, which task does not support); relates_to exists on the Free tier and backs the relate-block fills',
	});
	lines.push(writesLine(input));
}

/** The lines of `task strategy check` for a gitlab project. */
export async function checkGitLab(input: GitLabCheckInput): Promise<CheckLine[]> {
	const lines: CheckLine[] = [];
	try {
		await probeLines(input, lines);
	} catch (error) {
		// A probe turns its own failure into a line; this is the net for what nobody expected, so the check never throws.
		lines.push({
			name: 'check',
			status: 'error',
			text: error instanceof Error ? error.message : String(error),
			fix: 'Run the command again; if it keeps failing, task cli logs shows the cause',
		});
	}
	lines.push({ name: 'verification', status: 'ok', text: VERIFICATION_TEXT });
	return lines;
}
