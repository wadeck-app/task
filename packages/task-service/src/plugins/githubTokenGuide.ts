// The step-by-step guide to the token of the github strategy: ONE source for `task strategy help github` and
// docs/github-strategy-token.md (a test fails when the file differs from `renderGuideMarkdown()`). Every message the guide quotes is
// listed in GUIDE_QUOTES with the file that holds it; a test checks that file still contains it, so the guide cannot drift.
// Evidence tags: VERIFIED LIVE <date> (CLAUDE.md / the live recordings), DOCUMENTED-NOT-LIVE (docs.github.com, not exercised), UNKNOWN.
import {
	FINE_GRAINED_PERMISSIONS_DOC,
	GITHUB_TOKEN_GUIDE_POINTER,
	MANAGING_TOKENS_DOC,
} from './github/credentialRequirements.js';

export { GITHUB_TOKEN_GUIDE_POINTER };

/** Where the markdown copy lives, relative to the repository root. */
export const DOC_FILE = 'docs/github-strategy-token.md';

const ORG_POLICY_DOC =
	'https://docs.github.com/en/organizations/managing-programmatic-access-to-your-organization/setting-a-personal-access-token-policy-for-your-organization';

const LIVE = '[VERIFIED LIVE 2026-11-08]';
const DOC = '[DOCUMENTED-NOT-LIVE]';
const UNKNOWN = '[UNKNOWN]';

/** A message quoted by the guide, and the file (relative to plugins/) that must still contain it. */
export interface GuideQuote {
	text: string;
	source: string;
}

const quote = (text: string, source: string): GuideQuote => ({ text, source });

const Q = {
	refused401: quote('GitHub refused the token (401', 'github/githubClient.ts'),
	expiredOrRevoked: quote('An expired or revoked token gives this answer', 'github/githubClient.ts'),
	refused403: quote('GitHub refused the request (403', 'github/githubClient.ts'),
	tokenNeeds: quote('The token needs', 'github/credentialRequirements.ts'),
	notFound: quote('was not found, or this token cannot see it', 'github/githubCheck.ts'),
	expired: quote('the token expired on', 'github/githubCheck.ts'),
	expiresSoon: quote('the token expires in', 'github/githubCheck.ts'),
	pushFalse: quote('the repository reports push: false', 'github/githubCheck.ts'),
	issueFields: quote('Issue fields: Read', 'github/githubCheck.ts'),
	labelsSync: quote('task labels sync -p', 'github/githubCheck.ts'),
	notAbsolute: quote('is not an absolute path', 'forge-common/forgeToken.ts'),
	otherUsers: quote('is readable by other users (mode', 'forge-common/forgeToken.ts'),
	windowsWarn: quote('its permissions cannot be checked on Windows', '../tokenCheck.ts'),
};

export const GUIDE_QUOTES: readonly GuideQuote[] = Object.freeze(Object.values(Q));

type Block =
	| { kind: 'p'; text: string }
	| { kind: 'list'; items: readonly string[] }
	| { kind: 'code'; lines: readonly string[] };

interface Section {
	title: string;
	blocks: readonly Block[];
}

const p = (text: string): Block => ({ kind: 'p', text });
const list = (...items: string[]): Block => ({ kind: 'list', items });
const code = (...lines: string[]): Block => ({ kind: 'code', lines });

const SECRET_DIR = '~/.config/project/projects/a1b2c3d4/task/_secrets_';

const SECTIONS: readonly Section[] = [
	{
		title: '1. Create the token',
		blocks: [
			p(
				`Each statement carries its evidence: [VERIFIED LIVE <date>] (seen on github.com with a fine-grained token), ${DOC} (read on docs.github.com, never exercised by task) or ${UNKNOWN} (no evidence in this repository: check the GitHub page, its wording may differ from what is written here).`
			),
			list(
				`Open Settings > Developer settings > Personal access tokens > Fine-grained tokens > Generate new token. ${DOC} ${MANAGING_TOKENS_DOC}`,
				`Token name: any. Expiration: pick a date, never "no expiry" (see Expiry below).`,
				`Resource owner: for a repository of an ORGANIZATION choose the organization, not your user: a token can only reach resources owned by the owner you pick. ${DOC}`,
				`Repository access: "Only select repositories", then pick the ONE repository that holds the issues (strategy.options.repo). ${DOC}`,
				`Repository permissions: Issues: Read and write, Metadata: Read (GitHub grants Metadata to every fine-grained token). ${LIVE}`,
				`Generate token, then copy the value: do not count on seeing it again; if it is lost, generate a new token. ${UNKNOWN}`
			),
			p(
				'Organization policies (the owner of the organization sets them, a member cannot change them). ' +
					DOC +
					` ${ORG_POLICY_DOC}`
			),
			list(
				'Approval required (the default): the token stays "pending" until an organization owner approves it, and until then it reads public resources only. A token created by an owner is approved at once. You can type a justification under the resource owner when you create it; then ask an owner to approve it in the organization (Settings > Personal access tokens).',
				'Fine-grained tokens blocked: the organization is not in the Resource owner list. Ask an owner to allow fine-grained tokens (organization Settings > Personal access tokens > Settings), or use another credential.',
				'Maximum lifetime: the organization may cap the expiration you can choose (the documented default maximum for fine-grained tokens is 366 days).',
				`What task prints for a pending token: ${UNKNOWN}. A pending token cannot see a private repository, so the likely result is the repo line "${Q.notFound.text}" (an inference, not a recording): check the token page for "pending" before changing anything else.`
			),
			p('Does anything need more than Issues and Metadata?'),
			list(
				`Sub-issues, issue dependencies and native issue types: the live smoke ran them with an Issues write token and no further permission, as recorded. ${LIVE} Not recorded for a token without Issues write: UNKNOWN.`,
				`Native issue field Priority (strategy.options.priorityStorage auto or field, without priorityFieldId): reading the field definitions needs an ORGANIZATION permission, named issue_fields=read by the API (a 403 naming it was measured 2026-11-14). task prints it as "${Q.issueFields.text}"; the wording of the token page is ${UNKNOWN}, and a successful read with it was never seen. Without it: set priorityFieldId (the numeric field id), or priorityStorage: label; in auto mode a refused read falls back to priority labels with a warning, never silently.`,
				`Hard delete (fills.delete: hard): the user of the token must administer the repository. ${LIVE} (administrator case only; the refusal for another user is untested)`
			),
			p('Expiry.'),
			list(
				`task strategy check prints an "expiry" line from the header GitHub sends for a token with an expiry. ${LIVE}`,
				`Within 7 days it is a warning ("${Q.expiresSoon.text} N days"), after the date an error ("${Q.expired.text} <date>"). Create the replacement before then and put it where the config points: every command on the project fails once it expires.`,
				'A token that reports no expiry gives the line "GitHub reports no expiry date for this token".'
			),
		],
	},
	{
		title: '2. Where to put the token',
		blocks: [
			p(
				'The config never holds the token: a literal token (ghp_..., github_pat_...) or a key named token/password/secret is refused. Give exactly one of tokenFile (a file) or tokenEnv (the NAME of an environment variable).'
			),
			list(
				'tokenFile is the safe default: it works the same from your shell, from a script and from a daemon. A script or daemon started by another tool may receive only an allowlisted environment, so a tokenEnv variable can be missing there while it is set in your terminal.',
				'tokenEnv suits your own terminal: export GITHUB_TOKEN=<token> (Windows: setx GITHUB_TOKEN <token>, then open a new terminal). Typing it that way leaves it in your shell history: prefer the file.'
			),
			p(
				'Config (the path is a fictional example; use any absolute path or one starting with ~/ ; task does not create the folder):'
			),
			code(
				'strategy:',
				'    type: github',
				'    options:',
				'        repo: acme/shop',
				`        tokenFile: ${SECRET_DIR}/github-token`
			),
			p(
				`The file holds the token alone (surrounding whitespace is trimmed; spaces or line breaks inside it are refused). A relative path is refused ("${Q.notAbsolute.text}"). On Linux and macOS the file must be readable by you only: any group or other permission bit is an error ("${Q.otherUsers.text} 644)", fix: chmod 600 <file>). On Windows task cannot read permissions: strategy check only warns ("${Q.windowsWarn.text}", fix: make sure only your account can read the file), so restrict it yourself as below.`
			),
			p(
				'Create the file without leaving the token in your shell history or a chat transcript: never echo it, never pass it as an argument, never paste it into a conversation. Both recipes read it with a hidden prompt (not run against a real token by the author of this guide).'
			),
			p('bash or zsh (Linux, macOS, Git Bash):'),
			code(
				`F=${SECRET_DIR}/github-token`,
				'mkdir -p "$(dirname "$F")"',
				'(umask 077; read -rs -p "GitHub token: " T; echo; printf "%s" "$T" > "$F")',
				'chmod 600 "$F"'
			),
			p(
				'(zsh: replace read -rs -p "GitHub token: " T with read -rs "T?GitHub token: ".) The variable T lives only in the subshell. chmod covers a file that already existed.'
			),
			p(
				'Windows PowerShell (use a full path in the config, in single quotes: tokenFile: C:\\Users\\<you>\\...):'
			),
			code(
				'$f = "$env:USERPROFILE\\.config\\project\\projects\\a1b2c3d4\\task\\_secrets_\\github-token"',
				'New-Item -ItemType Directory -Force (Split-Path $f) | Out-Null',
				'$s = Read-Host "GitHub token" -AsSecureString',
				'$t = [System.Net.NetworkCredential]::new("", $s).Password',
				'Set-Content -Path $f -Value $t -NoNewline -Encoding ascii',
				'Remove-Variable t, s',
				'icacls $f /inheritance:r /grant:r "${env:USERNAME}:(R,W)"'
			),
			p('icacls removes the inherited access and leaves read/write to your account only.'),
		],
	},
	{
		title: '3. Next commands',
		blocks: [
			p('In this order, from a folder of the registered project:'),
			code(
				'task strategy check            # token accepted, repository found, expiry, permissions, statuses',
				'task labels sync --dry-run     # lists the status and type labels the config needs',
				'task labels sync               # creates them with a colour and a description'
			),
			p(
				`Every line of the check has a fix. Reads work without the labels (a write creates the one it needs on first use); the check says "${Q.labelsSync.text} <project>" when some are missing. strategy.options.statusMap must map every status of the project: the config is refused at load otherwise, naming the file and the key (see CLAUDE.md, "Storage strategy: github").`
			),
			p(
				'To move the existing local tasks onto GitHub, register a SECOND project (the project CLI owns the registry; task never writes it), give it the github strategy, then migrate. Nothing is written until the dry run is accepted:'
			),
			code(
				'project add "<other-dir>"      # registers the second project; see: project add --help',
				'# edit the new project config.yml: the strategy block of part 2 plus a statusMap',
				'task -p <new-project> strategy check',
				'task -p <new-project> labels sync',
				'task migrate --from <local-project> --to <new-project> --dry-run',
				'task migrate --from <local-project> --to <new-project> --allow-loss history,created-at,marker'
			),
			p(
				'The dry run prints the plan, the loss table (what GitHub cannot keep: history, creation instants, ...) and the cost estimate; a run that stops can be resumed with --resume. Details: task migrate --help. The Priority option names of the organization are unknown at plan time, so a project priority with no matching option fails at the first affected task.'
			),
		],
	},
	{
		title: '4. When the token is refused',
		blocks: [
			p(
				'task strategy check prints the first problem and stops at the line that explains it. Each case below quotes the real text.'
			),
			list(
				`"No GitHub token: the environment variable <NAME> is not set" (or the token file is missing, empty, unreadable): nothing was found where the config points. Fix: set the variable in the shell that runs task, or create the file (part 2). There is no anonymous fallback.`,
				`"${Q.refused401.text} ...)" - not authorised: the token is wrong, expired or revoked. ${Q.expiredOrRevoked.text}. Fix: generate a new token (part 1), replace the value, run task strategy check.`,
				`"... ${Q.notFound.text}" (line repo): GitHub answers 404 for a private repository the token cannot see. Check, in order: strategy.options.repo is owner/name; the token's Resource owner is the organization that owns it; Repository access includes this repository; the token is not still pending approval by an organization owner.`,
				`"${Q.refused403.text} ...)" with "${Q.tokenNeeds.text} Issues: Read and write ... (GitHub says: issues=write)": the token lacks a permission. GitHub names it in the header x-accepted-github-permissions; task prints it as the token page does and keeps the raw header. Fix: edit the token (Repository permissions), no new token needed. Permission table: ${FINE_GRAINED_PERMISSIONS_DOC}`,
				`"${Q.pushFalse.text}" (line write): reads work, every write will fail. Fix: give the token Issues: Read and write on the repository, or use a user who can write there.`,
				`"${Q.expired.text} <date>" (line expiry): create the replacement (part 1). "${Q.expiresSoon.text} N days" is the warning before.`,
				'A 403 on a classic token of an organization that disabled classic tokens: use a fine-grained token. ' +
					DOC
			),
			p(
				'Anything else: task cli logs shows the cause; TASK_DEBUG=1 logs one line per request (never a header or the token).'
			),
		],
	},
];

const TITLE = 'GitHub strategy: create and use the token';
const INTRO =
	'The github strategy keeps the tasks of a project as the issues of ONE repository, through the official REST API. It needs one fine-grained personal access token. This guide: create it, store it, check it, fix it.';

function wrap(text: string, width: number, firstPrefix: string, nextPrefix: string): string[] {
	const lines: string[] = [];
	let current = firstPrefix;
	let empty = true;
	for (const word of text.split(/\s+/).filter(w => w !== '')) {
		if (!empty && current.length + 1 + word.length > width) {
			lines.push(current);
			current = nextPrefix + word;
		} else {
			current += (empty ? '' : ' ') + word;
		}
		empty = false;
	}
	lines.push(current);
	return lines;
}

/** The guide as plain text, wrapped at 100 columns (a lone URL longer than that is not cut). */
export function renderGuideText(): string {
	const out: string[] = [TITLE, '', ...wrap(INTRO, 100, '', '')];
	for (const section of SECTIONS) {
		out.push('', section.title);
		for (const block of section.blocks) {
			out.push('');
			if (block.kind === 'p') out.push(...wrap(block.text, 100, '', ''));
			else if (block.kind === 'list')
				for (const item of block.items) out.push(...wrap(item, 100, '  - ', '    '));
			else out.push(...block.lines.map(line => `    ${line}`));
		}
	}
	out.push(
		'',
		...wrap(
			'Also in the repository: ' +
				DOC_FILE +
				'. gitlab and remote have their own token sections: task strategy --help.',
			100,
			'',
			''
		)
	);
	return out.join('\n');
}

/** The same guide as markdown (docs/github-strategy-token.md). */
export function renderGuideMarkdown(): string {
	const out: string[] = [`# ${TITLE}`, '', INTRO];
	for (const section of SECTIONS) {
		out.push('', `## ${section.title}`);
		for (const block of section.blocks) {
			out.push('');
			if (block.kind === 'p') out.push(block.text);
			else if (block.kind === 'list') out.push(...block.items.map(item => `- ${item}`));
			else out.push('```', ...block.lines, '```');
		}
	}
	out.push(
		'',
		'Same text as `task strategy help github` (generated from `packages/task-service/src/plugins/githubTokenGuide.ts`: edit it there, then run the guide test with `UPDATE_GUIDE_DOC=1`).'
	);
	return out.join('\n') + '\n';
}
