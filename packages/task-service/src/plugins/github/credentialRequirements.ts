// What the github strategy needs from the token, per capability, in ONE table. `task strategy check` prints one line per row (enabled,
// disabled with the exact permission to add, or not tested), the 403 mapping of the client names the permission a denied call needs, and
// the "How to create the token" section of CLAUDE.md is written from the same rows. A new GitHub call that needs a new permission adds
// a row here.
//
// Evidence of each row (field `evidence`):
//   live 2026-11-08  VERIFIED-LIVE on github.com with a fine-grained token (storage plan, verification log row 23 and the live smoke)
//   documented       docs.github.com only (permissions-required-for-fine-grained-personal-access-tokens), not exercised
//   unverified       a reading of the API that no probe confirmed
// Classic tokens (scopes `repo`, `public_repo`) are DOCUMENTED, NOT LIVE: no classic token was ever used against the strategy.

export const FINE_GRAINED_PERMISSIONS_DOC =
	'https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens';
export const MANAGING_TOKENS_DOC =
	'https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens';

export type GitHubCredentialKey = 'metadata' | 'read' | 'labels' | 'labels-write' | 'write' | 'delete' | 'expiry';

export interface GitHubCredentialProbe {
	/**
	 * `get` = a read-only request; `repo-flag` = a flag of the repository answer already read (no request of its own); `header` = a
	 * header of an answer already read; `none` = cannot be tested without changing something, the first real use reports it.
	 */
	kind: 'get' | 'repo-flag' | 'header' | 'none';
	/** What is asked or read, for the doc and the check output. */
	request: string;
}

export interface GitHubCredentialRequirement {
	key: GitHubCredentialKey;
	/** What it gives, in the words of the check line. */
	title: string;
	/** Without it the strategy cannot work at all. Optional rows only enrich `strategy check`. */
	required: boolean;
	/** Repository permissions of a fine-grained token, as the token page prints them. All are needed. Empty: none (a role or a header). */
	fineGrained: readonly string[];
	/** A role the USER of the token needs on the repository, which no token permission can grant. */
	role?: string;
	/** Classic token scope that covers it (DOCUMENTED, NOT LIVE). */
	classic: string;
	probe: GitHubCredentialProbe;
	/** The commands and options that use it. */
	usedBy: string;
	evidence: string;
}

export const CREDENTIAL_REQUIREMENTS: readonly GitHubCredentialRequirement[] = Object.freeze([
	{
		key: 'metadata',
		title: 'find the repository',
		required: true,
		fineGrained: ['Metadata: Read'],
		classic: 'public_repo (public) or repo (private)',
		probe: { kind: 'get', request: 'GET /repos/:owner/:repo' },
		usedBy: 'every command; GitHub grants it to every fine-grained token',
		evidence: 'live 2026-11-08 (every call carried it); that it cannot be removed is documented',
	},
	{
		key: 'read',
		title: 'read tasks, comments, history, sub-issues and dependencies',
		required: true,
		fineGrained: ['Issues: Read'],
		classic: 'public_repo (public) or repo (private)',
		probe: { kind: 'get', request: 'GET /repos/:owner/:repo/issues?per_page=5&state=all' },
		usedBy: 'every command (list, show, history, search, comments)',
		evidence: 'live 2026-11-08',
	},
	{
		key: 'labels',
		title: 'read the repository labels (no permission of its own: Issues: Read covers them)',
		required: false,
		fineGrained: ['Issues: Read'],
		classic: 'public_repo (public) or repo (private)',
		probe: { kind: 'get', request: 'GET /repos/:owner/:repo/labels' },
		usedBy: 'strategy check, labels sync',
		evidence: 'live 2026-11-08 (labels accept Issues or Pull requests)',
	},
	{
		key: 'labels-write',
		title: 'create the labels of the mapping with a colour (no permission of its own: Issues: Read and write covers them)',
		required: false,
		fineGrained: ['Issues: Read and write'],
		classic: 'public_repo (public) or repo (private)',
		probe: { kind: 'none', request: 'POST /repos/:owner/:repo/labels (not probed: it would create a label)' },
		usedBy: 'labels sync, and every write that uses a label that does not exist yet',
		evidence: 'live 2026-11-08 (labels created and deleted with an Issues write token)',
	},
	{
		key: 'write',
		title: 'create and change tasks (status, title, description, type, labels, comments, parent, links)',
		required: false,
		fineGrained: ['Issues: Read and write'],
		classic: 'public_repo (public) or repo (private)',
		probe: {
			kind: 'repo-flag',
			request: 'permissions.push of GET /repos/:owner/:repo (the role of the user; no write is sent)',
		},
		usedBy: 'new, set-status, set-title, set-description, set-type, add-label, set-meta, link, comment, migrate (target)',
		evidence:
			'live 2026-11-08 for the permission itself; documented for the push flag as a sign of it (a fine-grained token weaker than its user is not seen by that flag: only a real write proves it)',
	},
	{
		key: 'delete',
		title: 'delete tasks for good (fills.delete: hard, GraphQL deleteIssue)',
		required: false,
		fineGrained: ['Issues: Read and write'],
		role: 'repository administrator',
		classic: 'repo, with the token of an administrator',
		probe: {
			kind: 'repo-flag',
			request: 'permissions.admin of GET /repos/:owner/:repo (nothing is deleted to find out)',
		},
		usedBy: 'delete (only with fills.delete: hard)',
		evidence:
			'live 2026-11-08 (deleteIssue worked for an administrator with an Issues write token); the refusal for a non-administrator is untested',
	},
	{
		key: 'expiry',
		title: 'expiry date of the token',
		required: false,
		fineGrained: [],
		classic: 'none (a classic token reports no expiry unless it has one)',
		probe: { kind: 'header', request: 'github-authentication-token-expiration of any answer' },
		usedBy: 'strategy check (information only)',
		evidence: 'live 2026-11-08 (the header is sent by github.com for fine-grained tokens with an expiry)',
	},
]);

/** The row for a key (throws on an unknown key: the table is the single source). */
export function requirementFor(key: GitHubCredentialKey): GitHubCredentialRequirement {
	const row = CREDENTIAL_REQUIREMENTS.find(candidate => candidate.key === key);
	if (row === undefined) throw new Error(`github credential requirement "${key}" is not in the table`);
	return row;
}

/**
 * The permissions of an `x-accepted-github-permissions` header (`issues=write; metadata=read`), as the token page prints them
 * (`Issues: Read and write`). Pairs may be separated by `;` or `,`. What is not understood is kept as written, never dropped. That
 * several names mean "all" or "any of" is not stated by GitHub's documentation as far as read: the names are only listed.
 */
export function namePermissions(header: string): string[] {
	const names: string[] = [];
	for (const part of header.split(/[;,]/)) {
		const text = part.trim();
		if (text === '') continue;
		const match = /^([a-z_]+)=([a-z]+)$/.exec(text);
		if (match === null) {
			names.push(text);
			continue;
		}
		const resource = match[1]!.replace(/_/g, ' ');
		const label = resource.charAt(0).toUpperCase() + resource.slice(1);
		const level = match[2]!;
		if (level === 'read') names.push(`${label}: Read`);
		else if (level === 'write') names.push(`${label}: Read and write`);
		else names.push(`${label}: ${level}`);
	}
	return names;
}

/** The fix for a denied call (403 without a rate limit): the permission to add to the fine-grained token. */
export function deniedPermissionHint(
	accepted: string | undefined,
	repo: string,
	tokenHint: string,
	writing = false
): string {
	const named = accepted === undefined ? [] : namePermissions(accepted);
	const needs =
		named.length === 0
			? writing
				? 'Issues: Read and write, Metadata: Read'
				: 'Issues: Read, Metadata: Read'
			: `${named.join(', ')} (GitHub says: ${accepted})`;
	return `The token needs ${needs} on ${repo}. Edit the token in GitHub (Settings > Developer settings > Personal access tokens > Fine-grained tokens > the token > Repository permissions), or use one that has it; a classic token needs the scope repo (public_repo for a public repository). It is read from ${tokenHint}. Details: ${FINE_GRAINED_PERMISSIONS_DOC}`;
}

/** Lines for "How to create the token" (the doc is written from them). */
export function tokenHowTo(): string[] {
	const unique = (names: readonly string[]): string[] => [...new Set(names)];
	const permissions = unique(CREDENTIAL_REQUIREMENTS.flatMap(row => row.fineGrained)).sort((a, b) =>
		a.localeCompare(b)
	);
	return [
		`Fine-grained token (recommended, ${MANAGING_TOKENS_DOC}): Settings > Developer settings > Personal access tokens > Fine-grained tokens > Generate new token; Repository access: only select repositories, the one of the project; Repository permissions: ${permissions.join(', ')}; set an expiration date.`,
		'Hard delete (fills.delete: hard) also needs the user of the token to administer the repository.',
		'Classic token: scope repo (public_repo for a public repository). DOCUMENTED, NOT LIVE.',
	];
}
