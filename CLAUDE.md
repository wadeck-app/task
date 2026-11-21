## CLI Development Workflow

`task-cli` is installed globally via CI (GitHub Packages). Source edits alone do nothing: the `task` on PATH is the published version. Never patch `node_modules`.

To deploy a change:

1. Verify locally: `npm test` (run it twice), `npm run lint`, `npm run check` in `packages/app-module-task`, `violations check` = 0. Windows-only green is not CI green: see "Tests, Linux CI" under Shared project registry (CI also runs `vitest run --bail=1`).
2. `git commit` + `git push` -> CI builds and publishes.
3. Wait for CI, never poll: `queue wait ci <sha> --name task.ci-<first 7 chars of sha> --cli-foreground`, with `run_in_background: true`, from this repository.
4. Check the registry, it is the proof of publish: `npm view @wadeck-app/task-cli versions --registry=https://npm.pkg.github.com`. A cancelled macOS smoke job (no runner) does not block publish; only a real smoke failure does (see Updater, incident).
5. `UPDATER_MANUAL=1 task cli update`, then `task -v` to confirm the version.

A source-checkout dev build (`BUNDLE_VERSION=0.0.0-local`, not CalVer) never updates the global install: `task cli update` refuses it (see Updater, dev build guard).

## Packages

| Package           | Role                                                                                                                |
| ----------------- | ------------------------------------------------------------------------------------------------------------------- |
| `task-core`       | Storage: `TaskBackend` port and `LocalFileBackend`, config loading, domain errors.                                  |
| `task-service`    | Use cases shared by the CLI and the app-module. Pure: no console, no `process.exit`; returns results and events.    |
| `task-cli`        | `task` binary: arg parsing and output over task-service, updater, app-core registration.                            |
| `app-module-task` | app-core module (id `task`): routes `/api/modules/task/*` and dsl-views over task-service.                          |
| `dsl-lib-task`    | Browser components (React) the module ships as `task:<Name>`; no storage, service or Node API. See Task components. |

Async port (stage 0 of `.claude/plans/2026-11-08_storage-strategies.md`; steps 0.1 to 0.6 done; 0.7, lifting the domain rules out of `TaskStore`, is closed without being done: the contract suite pins the rules on every backend, see the todo): `task-core/src/backend/` holds `TaskBackend`, `BackendCapabilities`, `UnsupportedByBackendError`, `StaleRevisionError` and `LocalFileBackend` (wraps the synchronous `TaskStore`, same bytes on disk: golden test). Every caller goes through it: `ctx.store` is a `TaskBackend` built by `createLocalBackend(tasksDir, options)`; the `TaskStore` class is not exported by task-core and no other package imports it (`NO_TASK_STORE_OUTSIDE_CORE`, tests included). Every backend must pass `runBackendContract` (`task-core/src/contract/`).

- Conventions: every use case that touches a task is `async` and returns the same answer as before. A write is awaited BEFORE its events are built, and events are delivered one by one after that (a forgotten `await` would emit early or never). Writes and the deletions of `executeDelete` are sequential awaits, never `Promise.all`; cross-project reads go project by project. The backend's `revision` never reaches an answer: use cases pass records through `plain()` (`plainRecord.ts`), so JSON and events carry no `revision`.
- Guards: `@typescript-eslint/no-floating-promises`, `no-misused-promises`, `await-thenable` (type-aware, `eslint.config.mjs`); the CLI entry installs an `unhandledRejection` handler (exit 1, actionable message). Architecture: `fsAllowlist` per package (`architecture/rules.ts`): a non-test file importing `fs` must be listed with its reason.
- `task list --follow` / `task history --follow` poll with a self-scheduling loop (`cli/follow.ts`): the next pause starts when the previous poll has ended; SIGINT stops it; a failing poll fails the command.
- Known: a use case is no longer atomic against other requests of the same process (the module); task data has no lock by design.

## Dependency direction

`task-core` <- `task-service` <- `task-cli` and `app-module-task`; `app-module-task` -> `dsl-lib-task` (loaded by its `src/dsl-components`, props only). The two adapters never import each other, and `task-service` knows no CLI, HTTP or app-core library, never prints or exits. `npm run test:architecture` (`architecture/`, part of `npm test`) enforces it on imports, `package.json` dependencies and source patterns.

`@wadeck-app/project-sdk` ("latest", lockfile pins it; zero dependencies) is imported by `task-service` only; the architecture test forbids it in the sources of the adapters and `task-core` (their tests may use its mutations for fixtures). Shared rules live in `task-service` (`resolveProject`, `resolveProjectReference`, `listKnownProjects`, `describeError` for the SDK errors), adapters only parse input and format output: `describeError` (error kind, message, hint; CLI maps to stderr, module to HTTP status), `selectDeleteTargets` / `describeDeleteEffects`, `openTaskContext`, `getTaskLogDir`, `countTasksByStatus`, `showTaskWithRelations`, the storage (`storage.ts`: `registryStorage`; `openResolvedProject`; `loadTaskConfig`), the per-project health (`inspectRegisteredProjects`), `listStatuses` (the valid statuses with `default` / `terminal`, from the same merged config as `setStatus`), and the cross-project reads `summarizeProjects` / `listTasksAcrossProjects` (per-project figures and tasks tagged with their project; unreadable projects reported, `NoReadableProjectsError` when none can be read; used by the app-module and by the CLI, see CLI parity below).

## Shared project registry

- The `project` CLI registry (`@wadeck-app/project-sdk`) is the single source of projects, data and config. Task reads it only: never write it (`NO_REGISTRY_WRITE`); never join `projects` and the id by hand (the SDK resolves the folder); registering/moving/removing belongs to `project add|remove|paths|list`.
- `task init`, `task projects add|remove|move|prune|list`, `task plugins` do not exist. `--project-dir` is an unknown option everywhere; `TASK_PROJECT_DIR` and `PROJECT_DIR` are not read.
- Resolution: `-p/--project <ref>` > `TASK_PROJECT` > cwd looked up in the registry. `<ref>` = id (or unique prefix >= 4), name or alias, never a path. Unresolved reference or cwd in no project is an error, never a fallback. The flag is parsed by the SDK only (task-cli never parses `-p`).
- Storage goes through `TaskStorage` (`dataDir`, `configFiles`); no source names `.task` as a path segment (`NO_PROJECT_DATA_DIR`); reading a fresh project creates nothing.
- Config layers (`projectConfig.ts`): chain root first, own last; `statuses|types|fields|strategy` are `local` (replace), `defaults` is inherit + deep; an unknown key is a `ConfigSchemaError` naming file and key; a `hooks` key is a `RemovedConfigKeyError` (task never runs commands from config).
- Writes: task files, `task-index.json`, `config.yml` go through the SDK `writeFileAtomic`. A virtual project (no path) works for data but its events are returned undelivered and the module does not list it.
- Tests: every `vitest.setup.ts` points `XDG_CONFIG_HOME`, `HOME`, `USERPROFILE` at a temp dir; fixtures use the SDK `addProject` (`createSharedRegistrySandbox`). Linux CI traps: token files need mode 0o600 + `chmodSync`, use `127.0.0.1` not `localhost`, never sort on `readdirSync` order, restore env with `delete`, CI runs `vitest run --bail=1`.
- Temp dirs: a new `mkdtemp` prefix must be added to `OWN_TEMP_PREFIXES` (`scripts/testTemp.ts`); sandboxes seed `autoUpdate: false` in `app-core-cli/config.yml`.
- Architecture rules (`architecture/rules.ts`): `NO_PROJECT_DATA_DIR`, `NO_REGISTRY_WRITE`, `NO_PROJECT_SDK_OUTSIDE_SERVICE` (project-sdk imported by `task-service` only).

Detail: `docs/claude/shared-registry.md`

## Storage strategy (stage 0b of `.claude/plans/2026-11-08_storage-strategies.md`)

- A project picks its backend with the `strategy` section of its OWN `config.yml` (scope `local`, nothing inherited): `{ type, fidelity: strict|degrade, options }`. No section = `local`. Installed: `local`, `github`, `gitlab`, `remote`. A declared type with no plugin is an error, never a local fallback.
- Every caller goes through the async `TaskBackend` port (`ctx.store`, created lazily by the plugin); `TaskStore` is not exported from task-core (`NO_TASK_STORE_OUTSIDE_CORE`). Every backend must pass `runBackendContract`.
- `fills` (`options.fills`): nothing is emulated unless declared; a non-exact technique under `strict` needs its own `fidelity: degrade`; the plugin must implement the technique.
- Secrets: a literal token in config is a hard error with the fix `tokenEnv: <NAME>` / `tokenFile: <path>`; `strategy.pluginsDir` is an error (no external plugins).
- Plugin host (`task-service/src/plugin-host/`) imports only its own files and `node:`; `plugins/<id>/` imports the seam, `plugins/kinds`, task-core and `node:`; only `builtinPlugins.ts` imports a `plugins/<id>/` folder; no computed `import(...)`.
- Commands: `task strategy show|check [-p] [--json]` (every warning/error has a `fix`; exit 1 on any error). `task plugins` does not exist.
- Never use silent fallbacks: unsupported operations throw `UnsupportedByBackendError` naming the fill to declare.
- `migrating` strategy (`current` + `new` blocks, agnostic of storage kinds; capabilities = intersection): phases P0 to P4 done (background move, `finalize`, `abort`); never run live (P5 script `scripts/live-migrating-smoke.mjs` not executed). Plan `.claude/plans/2026-11-15_migrating-wrapper.md`.

Detail: `docs/claude/storage-strategy.md`

## Storage strategy: github (stage 2, read and write)

- Official REST (GraphQL only for `fills.delete: hard`) through Node `fetch`; no gh CLI, no octokit. Code in `task-service/src/plugins/github/`; shared forge code in `plugins/forge-common/`.
- Token step by step: `task strategy help github` = `docs/github-strategy-token.md`, both rendered from `plugins/githubTokenGuide.ts` (`githubTokenGuide.test.ts` fails on any difference; rewrite with `UPDATE_GUIDE_DOC=1`). The token errors end with the pointer `GITHUB_TOKEN_GUIDE_POINTER`.
- Credentials: single source `github/credentialRequirements.ts` (drives `strategy check`, 403 mapping, docs). A new call needing a new permission adds a row there.
- Required options: `repo`, one of `tokenEnv` / `tokenFile`, `statusMap` covering EVERY status (exactly one open status without label). Priority, assignee and claim need no fill.
- Never emulate silently: an operation GitHub cannot hold natively is an `UnsupportedByBackendError` naming the `fills` key. Writes are optimistic ("not atomic"); a multi-call write failing midway is a `PartialWriteError`.
- Reads are ETag-cached (disk + memory); stale served only on unreachable/timeout/rate limit and labelled (`ReadNotice`); never on a refused token. The token appears in no message, log or cache.
- Tests: fake server `fakeGitHub.testkit.ts` is checked against recorded live exchanges (`githubConformance.test.ts`, `MOCK_LEDGER`: no `ASSUMED` entry allowed). When it fails fix the FAKE, never the fixture. Live smoke scripts are never in CI.
- Request counts per command are pinned (`GitHubBackend.requestBudget.test.ts`); a change that adds requests must update it deliberately.

Detail: `docs/claude/storage-github.md` (mapping tables, fills, consistency, errors, live scripts)

## Storage strategy: gitlab (stage 5, read and write)

- FREE TIER ONLY and fine-grained token on gitlab.com only (classic tokens and self-managed are declared unsupported). Paid-tier features fail with `requires a paid GitLab tier, which task does not support`; there is no `tier` option.
- Code in `task-service/src/plugins/gitlab/`; REST v4 + GraphQL (hierarchy via work items, depth 2) through `fetch`; no glab CLI.
- Token: single source `gitlab/credentialRequirements.ts`; permissions `Work Item` and `Label` on the project; `strategy check` prints one line per row with the exact fix.
- Priority is always a label; assignee/claim live in the managed block of the description; blockedBy is refused; `duplicateOf` / `causedBy` only through `fills.linkTypes.<t>: relate-block`.
- QUICK ACTIONS: text with a line starting with `/word` is refused before any request (GitLab would run it).
- Rate limit: waits for `ratelimit-reset` up to `rateLimit.maxWaitSeconds`, then `RateLimitedError`.
- The mock (`fakeGitLab.testkit.ts`) is guarded by recorded live exchanges (`gitlabConformance.test.ts`, ledger, no `ASSUMED`); what it does not model answers 501 `mock: not modelled`. Live scripts are never in CI.
- Not verified against the real gitlab.com: priority/assignee/claim (fake only).

Detail: `docs/claude/storage-gitlab.md`

## Storage strategy: remote (`task serve`, stage 4)

- The tasks live behind `task serve -p <project>` on another computer (the project there must be `local`); the client project has `strategy.type: remote` with `transport` (`plain-http`: `url`, `tokenEnv` or `tokenFile`, `timeoutSeconds`). The server is the single writer and the only emitter of events for those tasks.
- Plain HTTP, one shared bearer token (>= 16 characters, never on the command line), loopback by default; another host needs `--allow-lan` and prints a loud warning. Verified on loopback only.
- The protocol lives in `task-core/src/remote/` (`protocol.ts` route table, single source for both ends; protocol 1 and 2, v2 only adds routes); server in `task-service/src/server/`, client in `plugins/remote/` over `plugins/plain-http/`. They meet only through task-core (architecture rules `server-*`, `node-network-outside-server`).
- The server decides the time for claims (client sends `leaseMs`, never an instant). A v2 client against a v1 server fails priority/assignee/claim with `RemoteIncompatibleError` naming the fix.
- A client never retries automatically (a create is not idempotent); a write timeout MAY have been applied.
- Token single source: `plugins/remote/remoteRequirements.ts`. Threats: `docs/threat-model-task-serve.md`.
- Events: derived on the server from before/after records; `serverEvents.parity.test.ts` must keep local, client and server events equal.

Detail: `docs/claude/storage-remote.md`

## Migration (`task migrate`, stage 3 of the storage design)

- `task migrate --from <project> --to <project> [--dry-run] [--allow-loss <kind>] [--resume] [--history-comment] [--emit-events] [--json]` copies tasks between any two backends through the async port; both sides are registered projects; `-p` is refused, there is no `task import`.
- Subsets (phase 2, both forms): `--only-open`, `--status a,b`, `--ids a,b`, `--limit n` pick NEW tasks (journal-known ones always stay); relations to tasks left out are losses `links:excluded` / `hierarchy:excluded`, kept in the journal (`deferred`) and written by the later run that copies the other end; `--comments each|digest|none` (digest = one comment per task, none = loss `comments`). In place with a subset: status `partial`, config never switched until a run covers every task. See `docs/claude/migration.md`.
- In place: `task migrate --in-place --to-config <file> [-p]`: the same project switches storage; `config.yml` is replaced only after every task is read back with no difference; backup `config.yml.before-migration`.
- Losses are explicit (`--allow-loss <kind>|all`); a blocked plan writes nothing; a dry run writes nothing (no journal, no lock).
- Idempotent through the journal (`<data>/migrate-journal-*.json`) then the `migratedFrom` marker; an unfinished journal needs `--resume`; a damaged journal is never replaced (`MigrationStateError`).
- Events: none per task by default; one `onTasksMigrated` summary after the last write; `--emit-events` adds the per-task events.
- Engine in `task-service/src/migrate/`, CLI in `task-cli/src/commands/MigrateCommand.ts`. New `mkdtemp` prefixes go to `OWN_TEMP_PREFIXES`.
- Not verified: no real GitHub run (fake server only).

Detail: `docs/claude/migration.md`

## app-core registration

- `task cli register|unregister [--json]`; `task cli update` registers by itself when the shipped module version changed. Task has no daemon.
- Exit 0 when app-core took it, is absent, or `unconfirmed`; exit 1 only on refusal. A script needing certainty tests `status === 'registered'`.
- An installed module is copied to `<config dir>/app-module/<manifest version>/` and the STAGED manifest is registered (npm replaces the package folder on update). `appModuleStaging.ts` imports only fs/path and `registerAfterUpdate.ts` (the updater bundle must stay under 500 KB).
- The module has no cwd: projects come from the registry; routes take `?project=<id|name|alias>`.
- Tests against a real app-core: set `APP_CORE_PORT` and `APP_CORE_CONFIG_DIR`, else the SDK talks to the app-core on 4850.

Detail: `docs/claude/app-core-registration.md`

## app-module-task routes and pages

- Deleting tasks is REST: `DELETE /tasks` (selection `ids|all|filter`, `cascade`, `confirm=true` in the query string or a JSON body; `effect: 'sensitive'`, the host asks for the PIN); the preview is `POST /tasks/deletion-plans`. No verb in a path.
- Routes `/api/modules/task/...` take `?project=<id|name|alias>`; typed errors are mapped in `errors.ts`; every route that changes a task produces queue events and answers `undelivered` / `undeliveredText`. `manifest.test.ts` fails when a mutating action has no such badge.
- Page addresses carry the project as the PATH segment `:project` (the registry id; `?project=` on a page address is ignored); build addresses with `hrefs.ts`. No page has a back link (the breadcrumb carries the context).
- View conventions (app-core DSL): mutations use Form + `$actions` + `onSubmit`; every request of a view adds `inlineErrors=true` and shows `errorText` in a danger Badge; no source query may be empty (use `scopeQuery` / `projectQuery`, `?blank=true`); a source waiting for `projects` also takes `reload: $urlParam.reload`.
- A view cannot loop, cascade selects or read form state; route-built nodes live in `dslNodes.ts`. `FieldSelect` needs an `$if` guard and a `placeholder` when acting on an existing item; `$if` has no negation and `[]` is truthy (routes give boolean flags).
- Row actions with a url leave `{id}` unsubstituted in the installed shell; a table with row actions has no `navigateTo`.
- Title/description: `description` is stored only when it differs from `title`; use `taskDescription` (`description ?? title`); a single long text is split by `splitHeadline` (90 characters).
- CLI parity: `task list --all-projects`, `task projects summary` (read-only figures, need no project); JSON errors are `{error, hint}`.
- Registry upkeep belongs to the project CLI: no route, form or command to register/move/remove projects.
- Test against a real shell: package to a temp folder and `app-core-cli dev <tmp>` with temp `APP_CORE_PORT`, `XDG_CONFIG_HOME`, `HOME`, `USERPROFILE` and `QUEUE_SDK_OFF=1`.

Detail: `docs/claude/module-routes-pages.md` (route list, page table, shell measurements, live figures, widget sizing)

## Extension points (module <-> project module)

- Provider route `GET /api/modules/task/related/project/<projectId>` (read only, no event) and slot `task:project-header` (rendered on list and tree pages, NOT on the task page).

## Task links, Activity log, Comments

- Links: stored types `blockedBy`, `duplicateOf` (one target), `causedBy`, acyclic, same project only; inverses `blocks`, `duplicates`, `causes` are derived. Deleting a task removes links pointing to it. A dangling link: `getTaskLinks` throws `DanglingLinkError`; the module and CLI use `readTaskLinks`.
- Activity: optional `activity?` in the task file, appended in the SAME write as the change; status changes stay in `history`; link and parent changes also write a mirror entry (`inverse: true`) on the other task in a second, non-atomic write. `getTaskActivity` merges history and activity, newest first.
- Comments: optional `comments?`, plain text 1..10000 characters, `author` free string never defaulted to the OS user; an add writes no activity entry; edit/remove do.
- Components: `task:CommentThread`, `task:CommentComposer`; `ActivityFeed` filters `all|comments|history`.

Detail: `docs/claude/links-activity-comments.md`

## Priority, assignee and claim (stages 1 to 4a: local, github, gitlab and remote)

- Fields on `TaskRecord`: `priority` (one of the project `priorities`, absent = `defaults.priority`), `assignee` (free text), `claimedAt`, `leaseUntil`. Commands `set-priority`, `unset-priority`, `set-assignee`, `unset-assignee`, `claim`, `release`, `next`; `list` filters `--status --assignee --unassigned --available --priority --order --limit --fresh`.
- Claim rules are decided by `decideClaim` / `normalizeClaimRequest` for every backend: a live lease held by another worker is `TaskClaimedError`; `--renew` extends; `--force` overrides; a terminal-status task is `TaskClosedError`.
- The local backend takes the project write lock `<data>/.write-lock` around every mutation (10 s wait, then `WriteLockTimeoutError`); forges have no conditional write: optimistic, the last write wins, the loser is told when reading back.
- `task next` skips blocked tasks, retries lost races up to 10 times; ordering is the `ordering` plugin kind (`priority-then-oldest`).
- Migrate: loss kinds `priority`, `assignee`, `lease`; `claimedAt` / `leaseUntil` are never migrated.
- Module (stage 4b): routes in `routes/fieldRoutes.ts`, Priority and Assignee rows on the task page, columns in the list; not yet seen in a real shell.

Detail: `docs/claude/priority-claim.md`

## Queue events (current contract)

- Operations in `task-service` return events; the caller hands them to the `EventSink` AFTER the change is saved; the default sink publishes through `@wadeck-app/queue-sdk` one event at a time. Failure never fails the command: stderr line, error line in the task log (`task cli logs`), module answers carry `undelivered` / `undeliveredText`.
- Events: `onTaskCreated`, `onStatusChange` (payload also has `status` = `newStatus`), `onTaskLinked`, `onTaskUnlinked`, `onTaskUnblocked`, `onTaskTypeChanged`, `onTaskLabelAdded`, `onTaskLabelRemoved`, `onTaskMetaChanged`, `onTaskTextChanged`, `onTaskParentChanged`, `onTaskCommentAdded|Edited|Removed`, `onTaskPriorityChanged`, `onTaskAssigneeChanged`, `onTaskDeleted`, `onTasksMigrated`. Payloads carry `taskProjectName`, `taskProjectPath` and `taskProjectId`; `taskFile` is in no payload. Nothing fires when nothing changed; undefined fields are absent.
- Single source of the declarations: `task-service/queueEventDeclarations.ts` (one per `TaskEvent`, schema, example). Adding or changing an event means editing it; its hash triggers a new declaration by the CLI (`task cli declare-events` forces it).
- Subscriber filters (`<project>/.queue/subscribers.yml`, `when:`): `payload.newStatus=done` (dot path, `=`, string/number compare) or a JSONPath starting with `$` that must return a truthy value (`$.payload.newStatus`). `$.status == 'x'` is NOT valid (no operators; the status is under `payload`).
- The queue cwd is `payload.taskProjectPath`; a payload without it is undelivered with an explicit reason, never published with the current cwd.
- Outcome mapping: `queued`/`dispatched` delivered; `dropped` and `unknown` are undelivered with a replay text (`cd '<path>' && queue push <event> '<json>'`, or `queue replay <eventId>`); `unknown` is never retried.
- Tests: `QUEUE_SDK_OFF=1` is set by every `vitest.setup.ts` (never set it outside tests/dev); inject the publisher or use `startFakeQueueDaemon()` from `@wadeck-app/queue-sdk/testing`; the real queue daemon is never started by a test. A test starting the default module backend must set `XDG_CONFIG_HOME`.
- Flush: `EventSink.flush()` is called at the end of `runTaskCommand` and by `lifecycle.teardown`.

Detail: `docs/claude/queue-events.md` (payload table, declaration, outcome mapping)

## Task components (to be transferred to dsl-view)

- `packages/dsl-lib-task` holds React components loaded as `task:<Name>` (`createTaskLibEntries({ apiBase, routeBase })`, manifest `dslLib.shared`). Browser code only: react, react-dom, dsl-ui, dsl-renderer, lucide-react and relative imports; never task-service, task-core or a `node:` module.
- Entries are GENERATED (`npm run entries --workspace=packages/dsl-lib-task`, committed, freshness-tested); the stylesheet by `npm run css`. Object props holding expressions need `@resolveDeep` in their JSDoc.
- Actions: controls call `onAction(name, params, { body })` (body needs dsl-ui >= 318); the default handler is `pageActionHandler` (publishes `resultKey`). A label or key with `/` or `%` travels as base64url (`label-keys`, `meta-keys`).
- Visual tokens in `src/ui/tokens.ts` (control height `h-8`, `gap-2` / `gap-4`); `controlTokens.test.tsx` fails on another height or gap. A row of several chips is a `ChipRow`; feedback texts are `task:Notice`, never a Badge; pickers keep the input on top and results below.
- Navigation uses plain `<a href>`.

Detail: `docs/claude/task-components.md` (component table, props, transfer checklist)

## Task page, Kanban board, Tree page

- Task page `/tasks/p/:project/:id` is ONE design (A/B rows baked). Source `src/dsl-views/variants/` (`_page`, `_shared`, `_sections`); `task-page.yaml` is GENERATED (`npm run views --workspace=packages/app-module-task`, freshness-tested). Each fact is bound by ONE node (`taskPageVariants.test.ts`); no `AbTest` is left; no "terminal" word in any text (colour says it); no `project-header` slot on this page.
- Sub-task detach action uses the placeholder `{childId}`, not `{id}` (a body-less action fills `{id}` from the page).
- Kanban `/tasks/p/:project/board`: data `GET /tasks/board`, live through the module SSE `GET /board/events`; component `task:KanbanBoard` with 5 variants and a dev-only A/B switcher (`TASK_KANBAN_AB=1`); moving a card is the existing `POST /tasks/:id/status`. Columns are configurable and can group statuses (`board` key of config.yml, D18; `PUT|DELETE /board/config`; one drop area per status while dragging; "Configure columns" editor).
- Tree page (global, several projects): `task:ProjectAccordion` over `GET /tree?allProjects=true`; rows capped at `ROW_CAP` 60 per project; `warning` is one line.
- Verified in a real shell: see the detail file for versions; any visual change must be checked in a real shell at 1440 and 390 px.

Detail: `docs/claude/views-task-kanban-tree.md`

## Updater

- Supported platforms ONLY `win32-x64`, `darwin-arm64`, `linux-x64`; the bin shim refuses every other one for every command. The supported list is passed explicitly at every call site of the CI scripts (`publishWorkflow.test.ts` pins them).
- Canonical shim and CI scripts come from the sibling repo `ci-templates`; `packages/task-cli/ci/{templates,scripts}` are synchronized copies (re-sync procedure in the detail file).
- Version pins: `package-lock.json` must resolve `@wadeck-app/shared-updater` >= `2026.11.14-022` and `@wadeck-app/shared-cli` >= `2026.10.25-044`; `package.json` keeps `latest`.
- A bundle whose version is not CalVer (dev build, `BUNDLE_VERSION=0.0.0-local`) never updates the global install: `task cli update` refuses (exit 1).
- Test isolation: every spawn of `task.cjs`, `task-updater.cjs` or the CLI goes through `spawnIsolated` (`src/isolatedCliEnv.ts`); never spawn a bundle with `process.env`.
- `task cli update --log [--json]` shows the update log; `task cli logs` is the raw dump of today.
- A cancelled macOS smoke job does not block publish; a real smoke failure does.

Detail: `docs/claude/updater.md`

## Agent reference docs

| Doc                               | Description                                                                                                 |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `.claude/guiding-principles.md`   | `--follow`/`-f` convention: list/snapshot diffing vs log tailing                                            |
| `.claude/product-vision.md`       | Purpose, contracts that define the product, intended direction, known gaps                                  |
| `.claude/out-of-scope.md`         | What task explicitly does not cover (platforms, tiers, plugins, registry, remote), with the decision source |
| `.claude/threat-model.md`         | Repo-level threats: files, registry, tokens, events, module routes, updater, plugin host                    |
| `docs/threat-model-task-serve.md` | `task serve` and the `remote` strategy: protocol v1 and v2, T1 to T17, deferred items                       |
| `docs/claude/*.md`                | Detail of each CLAUDE.md section above (moved verbatim, one file per section; each `Detail:` line names it) |
| `docs/github-strategy-token.md`   | GitHub token step by step (rendered from `githubTokenGuide.ts`)                                             |
