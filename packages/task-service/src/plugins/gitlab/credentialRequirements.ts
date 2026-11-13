// What the gitlab strategy needs from the token, per capability, in ONE table. `task strategy check` prints one line per row (enabled, or
// disabled with the exact permission to add), the 403 mapping of the client names the permission a denied call needs, and the "How to
// create the token" section of CLAUDE.md is written from the same rows. A new GitLab call that needs a new permission adds a row here.
//
// Sources: VERIFIED-LIVE 2026-11-09 on gitlab.com Free with a fine-grained personal access token (storage plan, "2.3.1 Live GitLab
// findings"): a denied call answers 403 `{"error":"insufficient_granular_scope","error_description":"Access denied: This operation
// requires a fine-grained personal access token with the following <kind> permissions: [<Resource>: <Action>]."}`, which names the
// permission. The permissions of the calls that DID work could not be listed (the test token could not read its own permissions), so
// their names come from docs.gitlab.com/auth/tokens/fine_grained_access_tokens_rest (endpoint table, read 2026-11-09) and agree with
// every denial seen. A CLASSIC token (scopes `api`, `read_api`) is DOCUMENTED, NOT LIVE: docs.gitlab.com/api/rest/authentication.

export const FINE_GRAINED_TOKENS_DOC = 'https://docs.gitlab.com/auth/tokens/fine_grained_access_tokens/';
export const FINE_GRAINED_REST_DOC = 'https://docs.gitlab.com/auth/tokens/fine_grained_access_tokens_rest/';
export const FINE_GRAINED_GRAPHQL_DOC = 'https://docs.gitlab.com/auth/tokens/fine_grained_access_tokens_graphql/';
export const CLASSIC_TOKENS_DOC = 'https://docs.gitlab.com/user/profile/personal_access_tokens/';

export type CredentialKey =
	| 'read'
	| 'write'
	| 'delete'
	| 'labels-read'
	| 'labels-write'
	| 'hierarchy'
	| 'project-info'
	| 'token-info'
	| 'server-info';

export interface CredentialProbe {
	/**
	 * `get` = a read-only request; `noop-write` = a write that changes nothing (a PUT with the title the issue already has: no new
	 * `updated_at`, no event, no system note; VERIFIED-LIVE 2026-11-09); `graphql-read` = a work item read; `none` = cannot be tested
	 * without really changing something, the first real use reports the missing permission.
	 */
	kind: 'get' | 'noop-write' | 'graphql-read' | 'none';
	/** The request, for the doc and the check output (`GET /projects/:id/issues?per_page=1`). */
	request: string;
}

export interface CredentialRequirement {
	key: CredentialKey;
	/** What it gives, in the words of the check line. */
	title: string;
	/** Without it the strategy cannot work at all. Optional rows only enrich `strategy check`. */
	required: boolean;
	/** Fine-grained permissions, as GitLab prints them in a 403 (`Work Item: Read`). All are needed. */
	fineGrained: readonly string[];
	/** The boundary of the fine-grained permissions: the token must cover the project (`project`) or the instance/user. */
	access: 'project' | 'user' | 'instance';
	/** Classic token scope that covers it (DOCUMENTED, NOT LIVE). */
	classic: 'api' | 'read_api';
	probe: CredentialProbe;
	/** The commands and options that use it. */
	usedBy: string;
}

export const CREDENTIAL_REQUIREMENTS: readonly CredentialRequirement[] = Object.freeze([
	{
		key: 'read',
		title: 'read tasks, comments, history and links',
		required: true,
		fineGrained: ['Work Item: Read'],
		access: 'project',
		classic: 'read_api',
		probe: { kind: 'get', request: 'GET /projects/:id/issues?per_page=1' },
		usedBy: 'every command (list, show, history, search, comments)',
	},
	{
		key: 'write',
		title: 'create and change tasks (status, title, description, type, labels, comments, links)',
		required: false,
		fineGrained: ['Work Item: Create', 'Work Item: Update'],
		access: 'project',
		classic: 'api',
		probe: { kind: 'noop-write', request: 'PUT /projects/:id/issues/:iid with the title the issue already has' },
		usedBy: 'new, set-status, set-title, set-description, set-type, add-label, set-meta, link, comment, migrate (target)',
	},
	{
		key: 'delete',
		title: 'delete tasks and comments (fills.delete: hard)',
		required: false,
		fineGrained: ['Work Item: Delete'],
		access: 'project',
		classic: 'api',
		probe: { kind: 'none', request: 'DELETE /projects/:id/issues/:iid (not probed: it would delete)' },
		usedBy: 'delete, comment delete',
	},
	{
		key: 'labels-read',
		title: 'read the project labels',
		required: true,
		fineGrained: ['Label: Read'],
		access: 'project',
		classic: 'read_api',
		probe: { kind: 'get', request: 'GET /projects/:id/labels?per_page=1' },
		usedBy: 'strategy check, labels sync',
	},
	{
		key: 'labels-write',
		title: 'create the labels of the mapping with a colour (labels sync)',
		required: false,
		fineGrained: ['Label: Create'],
		access: 'project',
		classic: 'api',
		probe: { kind: 'none', request: 'POST /projects/:id/labels (not probed: it would create a label)' },
		usedBy: 'labels sync',
	},
	{
		key: 'hierarchy',
		title: 'parent and children of a task (GraphQL work items)',
		required: false,
		fineGrained: ['Work Item: Read', 'Work Item: Update'],
		access: 'project',
		classic: 'api',
		probe: { kind: 'graphql-read', request: 'POST /api/graphql workItem(id:) of the first issue' },
		usedBy: 'set-parent, remove-parent, show (children), tree',
	},
	{
		key: 'project-info',
		title: 'project facts (access level, archived, issues enabled)',
		required: false,
		fineGrained: ['Project: Read'],
		access: 'project',
		classic: 'read_api',
		probe: { kind: 'get', request: 'GET /projects/:id' },
		usedBy: 'strategy check (information only)',
	},
	{
		key: 'token-info',
		title: 'expiry date of the token',
		required: false,
		fineGrained: ['Personal Access Token: Read'],
		access: 'user',
		classic: 'read_api',
		probe: { kind: 'get', request: 'GET /personal_access_tokens/self' },
		usedBy: 'strategy check (information only)',
	},
	{
		key: 'server-info',
		title: 'GitLab version',
		required: false,
		fineGrained: ['Metadata: Read'],
		access: 'instance',
		classic: 'read_api',
		probe: { kind: 'get', request: 'GET /version' },
		usedBy: 'strategy check (information only)',
	},
]);

/** The row for a key (throws on an unknown key: the table is the single source). */
export function requirementFor(key: CredentialKey): CredentialRequirement {
	const row = CREDENTIAL_REQUIREMENTS.find(candidate => candidate.key === key);
	if (row === undefined) throw new Error(`gitlab credential requirement "${key}" is not in the table`);
	return row;
}

export interface DeniedPermission {
	/** `project`, `instance`, `user` or `group`. */
	kind: string;
	/** `Work Item: Update`... as GitLab wrote them. */
	permissions: string[];
}

/**
 * Reads the permissions a fine-grained token lacks from the body of a 403 (`error: insufficient_granular_scope`). Undefined when the
 * body is anything else (a role problem, a classic-token scope problem), so the caller falls back to its generic hint.
 */
export function parseDeniedPermissions(body: unknown): DeniedPermission | undefined {
	if (typeof body !== 'object' || body === null) return undefined;
	const record = body as { error?: unknown; error_description?: unknown };
	if (record.error !== 'insufficient_granular_scope' || typeof record.error_description !== 'string')
		return undefined;
	const match = /following (\w+) permissions?: \[([^\]]+)\]/.exec(record.error_description);
	if (match === null) return undefined;
	const permissions = match[2]!
		.split(',')
		.map(part => part.trim())
		.filter(part => part !== '');
	return permissions.length === 0 ? undefined : { kind: match[1]!, permissions };
}

/** The fix for a denied call: which permission to add to the fine-grained token (or the scope for a classic one). */
export function deniedPermissionHint(denied: DeniedPermission, tokenHint: string, project: string): string {
	const list = denied.permissions.join(', ');
	const where =
		denied.kind === 'project'
			? `on ${project} (token page: Group and project access, then Add resource permissions)`
			: `in the ${denied.kind} tab of Add resource permissions`;
	return `Add the permission ${list} ${where} to the fine-grained token read from ${tokenHint}, or use a classic token with the scope api. Details: ${FINE_GRAINED_REST_DOC}`;
}

/** Lines for "How to create the token" (the doc and `strategy check --help` text are written from them). */
export function tokenHowTo(): string[] {
	const needed = CREDENTIAL_REQUIREMENTS.filter(row => row.access === 'project');
	const unique = (names: readonly string[]): string[] => [...new Set(names)];
	return [
		`Fine-grained token (recommended, ${FINE_GRAINED_TOKENS_DOC}): Edit profile > Access > Personal access tokens > Generate token > Fine-grained token; group and project access limited to the project; permissions: ${unique(
			needed.flatMap(row => row.fineGrained)
		).join(', ')}.`,
		`Classic token (${CLASSIC_TOKENS_DOC}): scope api (read_api = read only).`,
	];
}
