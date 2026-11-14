# GitHub strategy: create and use the token

The github strategy keeps the tasks of a project as the issues of ONE repository, through the official REST API. It needs one fine-grained personal access token. This guide: create it, store it, check it, fix it.

## 1. Create the token

Each statement carries its evidence: [VERIFIED LIVE <date>] (seen on github.com with a fine-grained token), [DOCUMENTED-NOT-LIVE] (read on docs.github.com, never exercised by task) or [UNKNOWN] (no evidence in this repository: check the GitHub page, its wording may differ from what is written here).

- Open Settings > Developer settings > Personal access tokens > Fine-grained tokens > Generate new token. [DOCUMENTED-NOT-LIVE] https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens
- Token name: any. Expiration: pick a date, never "no expiry" (see Expiry below).
- Resource owner: for a repository of an ORGANIZATION choose the organization, not your user: a token can only reach resources owned by the owner you pick. [DOCUMENTED-NOT-LIVE]
- Repository access: "Only select repositories", then pick the ONE repository that holds the issues (strategy.options.repo). [DOCUMENTED-NOT-LIVE]
- Repository permissions: Issues: Read and write, Metadata: Read (GitHub grants Metadata to every fine-grained token). [VERIFIED LIVE 2026-11-08]
- Generate token, then copy the value: do not count on seeing it again; if it is lost, generate a new token. [UNKNOWN]

Organization policies (the owner of the organization sets them, a member cannot change them). [DOCUMENTED-NOT-LIVE] https://docs.github.com/en/organizations/managing-programmatic-access-to-your-organization/setting-a-personal-access-token-policy-for-your-organization

- Approval required (the default): the token stays "pending" until an organization owner approves it, and until then it reads public resources only. A token created by an owner is approved at once. You can type a justification under the resource owner when you create it; then ask an owner to approve it in the organization (Settings > Personal access tokens).
- Fine-grained tokens blocked: the organization is not in the Resource owner list. Ask an owner to allow fine-grained tokens (organization Settings > Personal access tokens > Settings), or use another credential.
- Maximum lifetime: the organization may cap the expiration you can choose (the documented default maximum for fine-grained tokens is 366 days).
- What task prints for a pending token: [UNKNOWN]. A pending token cannot see a private repository, so the likely result is the repo line "was not found, or this token cannot see it" (an inference, not a recording): check the token page for "pending" before changing anything else.

Does anything need more than Issues and Metadata?

- Sub-issues, issue dependencies and native issue types: the live smoke ran them with an Issues write token and no further permission, as recorded. [VERIFIED LIVE 2026-11-08] Not recorded for a token without Issues write: UNKNOWN.
- Native issue field Priority (strategy.options.priorityStorage auto or field, without priorityFieldId): reading the field definitions needs an ORGANIZATION permission, named issue_fields=read by the API (a 403 naming it was measured 2026-11-14). task prints it as "Issue fields: Read"; the wording of the token page is [UNKNOWN], and a successful read with it was never seen. Without it: set priorityFieldId (the numeric field id), or priorityStorage: label; in auto mode a refused read falls back to priority labels with a warning, never silently.
- Hard delete (fills.delete: hard): the user of the token must administer the repository. [VERIFIED LIVE 2026-11-08] (administrator case only; the refusal for another user is untested)

Expiry.

- task strategy check prints an "expiry" line from the header GitHub sends for a token with an expiry. [VERIFIED LIVE 2026-11-08]
- Within 7 days it is a warning ("the token expires in N days"), after the date an error ("the token expired on <date>"). Create the replacement before then and put it where the config points: every command on the project fails once it expires.
- A token that reports no expiry gives the line "GitHub reports no expiry date for this token".

## 2. Where to put the token

The config never holds the token: a literal token (ghp_..., github_pat_...) or a key named token/password/secret is refused. Give exactly one of tokenFile (a file) or tokenEnv (the NAME of an environment variable).

- tokenFile is the safe default: it works the same from your shell, from a script and from a daemon. A script or daemon started by another tool may receive only an allowlisted environment, so a tokenEnv variable can be missing there while it is set in your terminal.
- tokenEnv suits your own terminal: export GITHUB_TOKEN=<token> (Windows: setx GITHUB_TOKEN <token>, then open a new terminal). Typing it that way leaves it in your shell history: prefer the file.

Config (the path is a fictional example; use any absolute path or one starting with ~/ ; task does not create the folder):

```
strategy:
    type: github
    options:
        repo: acme/shop
        tokenFile: ~/.config/project/projects/a1b2c3d4/task/_secrets_/github-token
```

The file holds the token alone (surrounding whitespace is trimmed; spaces or line breaks inside it are refused). A relative path is refused ("is not an absolute path"). On Linux and macOS the file must be readable by you only: any group or other permission bit is an error ("is readable by other users (mode 644)", fix: chmod 600 <file>). On Windows task cannot read permissions: strategy check only warns ("its permissions cannot be checked on Windows", fix: make sure only your account can read the file), so restrict it yourself as below.

Create the file without leaving the token in your shell history or a chat transcript: never echo it, never pass it as an argument, never paste it into a conversation. Both recipes read it with a hidden prompt (not run against a real token by the author of this guide).

bash or zsh (Linux, macOS, Git Bash):

```
F=~/.config/project/projects/a1b2c3d4/task/_secrets_/github-token
mkdir -p "$(dirname "$F")"
(umask 077; read -rs -p "GitHub token: " T; echo; printf "%s" "$T" > "$F")
chmod 600 "$F"
```

(zsh: replace read -rs -p "GitHub token: " T with read -rs "T?GitHub token: ".) The variable T lives only in the subshell. chmod covers a file that already existed.

Windows PowerShell (use a full path in the config, in single quotes: tokenFile: C:\Users\<you>\...):

```
$f = "$env:USERPROFILE\.config\project\projects\a1b2c3d4\task\_secrets_\github-token"
New-Item -ItemType Directory -Force (Split-Path $f) | Out-Null
$s = Read-Host "GitHub token" -AsSecureString
$t = [System.Net.NetworkCredential]::new("", $s).Password
Set-Content -Path $f -Value $t -NoNewline -Encoding ascii
Remove-Variable t, s
icacls $f /inheritance:r /grant:r "${env:USERNAME}:(R,W)"
```

icacls removes the inherited access and leaves read/write to your account only.

## 3. Next commands

In this order, from a folder of the registered project:

```
task strategy check            # token accepted, repository found, expiry, permissions, statuses
task labels sync --dry-run     # lists the status and type labels the config needs
task labels sync               # creates them with a colour and a description
```

Every line of the check has a fix. Reads work without the labels (a write creates the one it needs on first use); the check says "task labels sync -p <project>" when some are missing. strategy.options.statusMap must map every status of the project: the config is refused at load otherwise, naming the file and the key (see CLAUDE.md, "Storage strategy: github").

To move the existing local tasks onto GitHub, register a SECOND project (the project CLI owns the registry; task never writes it), give it the github strategy, then migrate. Nothing is written until the dry run is accepted:

```
project add "<other-dir>"      # registers the second project; see: project add --help
# edit the new project config.yml: the strategy block of part 2 plus a statusMap
task -p <new-project> strategy check
task -p <new-project> labels sync
task migrate --from <local-project> --to <new-project> --dry-run
task migrate --from <local-project> --to <new-project> --allow-loss history,created-at,marker
```

The dry run prints the plan, the loss table (what GitHub cannot keep: history, creation instants, ...) and the cost estimate; a run that stops can be resumed with --resume. Details: task migrate --help. The Priority option names of the organization are unknown at plan time, so a project priority with no matching option fails at the first affected task.

## 4. When the token is refused

task strategy check prints the first problem and stops at the line that explains it. Each case below quotes the real text.

- "No GitHub token: the environment variable <NAME> is not set" (or the token file is missing, empty, unreadable): nothing was found where the config points. Fix: set the variable in the shell that runs task, or create the file (part 2). There is no anonymous fallback.
- "GitHub refused the token (401 ...)" - not authorised: the token is wrong, expired or revoked. An expired or revoked token gives this answer. Fix: generate a new token (part 1), replace the value, run task strategy check.
- "... was not found, or this token cannot see it" (line repo): GitHub answers 404 for a private repository the token cannot see. Check, in order: strategy.options.repo is owner/name; the token's Resource owner is the organization that owns it; Repository access includes this repository; the token is not still pending approval by an organization owner.
- "GitHub refused the request (403 ...)" with "The token needs Issues: Read and write ... (GitHub says: issues=write)": the token lacks a permission. GitHub names it in the header x-accepted-github-permissions; task prints it as the token page does and keeps the raw header. Fix: edit the token (Repository permissions), no new token needed. Permission table: https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens
- "the repository reports push: false" (line write): reads work, every write will fail. Fix: give the token Issues: Read and write on the repository, or use a user who can write there.
- "the token expired on <date>" (line expiry): create the replacement (part 1). "the token expires in N days" is the warning before.
- A 403 on a classic token of an organization that disabled classic tokens: use a fine-grained token. [DOCUMENTED-NOT-LIVE]

Anything else: task cli logs shows the cause; TASK_DEBUG=1 logs one line per request (never a header or the token).

Same text as `task strategy help github` (generated from `packages/task-service/src/plugins/githubTokenGuide.ts`: edit it there, then run the guide test with `UPDATE_GUIDE_DOC=1`).
