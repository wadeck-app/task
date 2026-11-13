// What the remote strategy needs, per check, in ONE table: `task strategy check` prints one line per row (enabled, disabled with the
// fix, or not tested), and the "How to create the token" section of CLAUDE.md is written from the same rows. The credential is ONE
// shared bearer token (protocol v1): whoever holds it can read and write every task of the served project, so there is no
// per-capability permission to list, only the conditions below.
//
// Evidence: everything here was exercised on loopback only (task serve and the client on one computer; no second machine was
// available), through the real server and the real plain-http transport (`taskServer.test.ts`, `remotePlugin.test.ts`).

export type RemoteRequirementKey = 'reachable' | 'auth' | 'protocol' | 'project' | 'server-token';

export interface RemoteRequirement {
	key: RemoteRequirementKey;
	/** What it gives, in the words of the check line. */
	title: string;
	/** What must hold, on which machine. */
	needs: string;
	/** Without it nothing works. */
	required: boolean;
	/** `get` = answered by `GET /v1/info`; `none` = only the server can tell, the client cannot test it. */
	probe: { kind: 'get' | 'none'; request: string };
	/** What a failure of this row says to do. */
	fix: string;
	evidence: string;
}

export const REMOTE_REQUIREMENTS: readonly RemoteRequirement[] = Object.freeze([
	{
		key: 'reachable',
		title: 'the server answers',
		needs: 'server: task serve running (--host/--port, --allow-lan for another computer); client: transport.options.url points at it',
		required: true,
		probe: { kind: 'get', request: 'GET /v1/info' },
		fix: 'Start task serve -p <project> on the server computer, and check transport.options.url (and, for another computer, --allow-lan and the firewall)',
		evidence: 'verified on loopback',
	},
	{
		key: 'auth',
		title: 'the server accepts the token',
		needs: 'server: its token (TASK_SERVE_TOKEN, --token-env NAME or --token-file PATH); client: the SAME value in transport.options tokenEnv or tokenFile',
		required: true,
		probe: { kind: 'get', request: 'GET /v1/info with Authorization: Bearer <token> (401 = refused)' },
		fix: 'Give the same token to both machines: the variable or file named in transport.options here, and the one task serve was started with',
		evidence: 'verified on loopback (401 on a wrong token, a 500 ms delay per failure)',
	},
	{
		key: 'protocol',
		title: 'task and the server speak the same protocol',
		needs: 'both machines run a task version whose protocol ranges overlap',
		required: true,
		probe: {
			kind: 'get',
			request: 'GET /v1/info (protocol range) and the X-Task-Protocol header (426 = incompatible)',
		},
		fix: 'Update task on the older machine (task cli update)',
		evidence: 'verified on loopback with a scripted server (another range)',
	},
	{
		key: 'project',
		title: 'the server serves the expected project',
		needs: 'client: strategy.options.project (optional) equals the project the server serves',
		required: false,
		probe: { kind: 'get', request: 'GET /v1/info (project)' },
		fix: 'Point transport.options.url at the server of that project, or change or remove strategy.options.project',
		evidence: 'verified on loopback',
	},
	{
		key: 'server-token',
		title: 'the token of the server is strong enough',
		needs: 'server: at least 16 characters, no spaces; a token file is absolute and mode 600 on POSIX',
		required: false,
		probe: {
			kind: 'none',
			request: 'not asked: only task serve knows its token; it refuses to start with a short one',
		},
		fix: 'Make one with: openssl rand -hex 32 (any random text of 16 or more characters without spaces will do)',
		evidence: 'verified on loopback (the server refuses to start with a short or world-readable token)',
	},
]);

/** The row for a key (throws on an unknown key: the table is the single source). */
export function remoteRequirementFor(key: RemoteRequirementKey): RemoteRequirement {
	const row = REMOTE_REQUIREMENTS.find(candidate => candidate.key === key);
	if (row === undefined) throw new Error(`remote requirement "${key}" is not in the table`);
	return row;
}

/** Lines for "How to create the token" (the doc is written from them). */
export function remoteTokenHowTo(): string[] {
	return [
		'One shared token, no read-only token and no per-project or per-capability permission: whoever holds it reads and writes every task of the served project (protocol v1).',
		'Make it with: openssl rand -hex 32 (any random text of 16 or more characters without spaces will do).',
		'Server computer: export TASK_SERVE_TOKEN=<token> (or --token-env NAME, or --token-file <absolute path>, never on the command line), then task serve -p <project>. A token file must be mode 600 on POSIX: chmod 600 <file>.',
		'Client computer: give the SAME value in the variable named by transport.options.tokenEnv (or the file of tokenFile, absolute, chmod 600).',
	];
}
