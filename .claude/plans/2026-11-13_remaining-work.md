# Remaining work (written 2026-11-13, before /clear)

Read first: CLAUDE.md, `2026-10-25_todo.md`, `2026-10-25_resume-prompt.md` (rules: no restore, ASCII only, secrets via env var, TDD, delegate then verify myself, `violations check` = 0).

## 1. Land the uncommitted GitLab work (first)

State: HEAD 62a8f92, 65 modified/untracked paths, none committed. They come from a sub-agent that died on an expired AWS SSO session; nothing was verified after it.

- Untracked: `plugins/gitlab/{credentialRequirements,gitlabWorkItems,fakeGitLabGraphql.testkit,fakeGitLabLedger.testkit,gitlabMockServer.testkit,gitlabConformance.*}`, `plugins/gitlab/fixtures/live-conformance.json`, `scripts/{live-gitlab-probe,live-gitlab-smoke,live-gitlab-smoke-diff,gitlab-mock-server,gitlab-conformance-scenario,gitlab-ledger-md}.*`, `.claude/lessons-*.md` (not mine: check before adding).
- Steps: `npm run build`; `npm test` twice; `npm run lint`; eslint + prettier on touched files; `npm run check` in `packages/app-module-task`; `violations check` = 0; temp-dir count unchanged.
- Known suspect: TS error `etags` at `fakeGitLab.test.ts(558,16)`.
- Secret grep over the repo and docs: `glpat-`, `.01.160a`, `GL_TEST_TOKEN=` followed by a value. Token must appear nowhere.
- Check CLAUDE.md gitlab section matches the code: Free tier only, no `tier` option, `::` labels allowed, hierarchy via GraphQL depth 2, fine-grained token needs `Work Item` + `Label`.
- Commit, push (request `git-commit-push` bypass myself, two-step protocol), `queue wait ci <sha> --cli-foreground` in background. A "cancelled" macos-smoke is expected; proof of publish = `npm view @wadeck-app/task-cli versions --registry=https://npm.pkg.github.com`. Then `UPDATER_MANUAL=1 task cli update`.
- If the code is incomplete: relaunch an agent with the rules above and this scope. Live re-verification needs a NEW token (the 2-day token of 2026-11-09 is expired); ask the user only for that.

## 2. GitLab bilan for the user (promised, never delivered)

Report in French, from files read, not from memory: what was verified live (614 recorded requests, ledger lines LIVE-VERIFIED / DOCUMENTED-NOT-LIVE / UNVERIFIABLE, zero ASSUMED), what is not (classic tokens, self-managed, token weaker than the test token, roles). Source: plan doc section "2.3.1 Live GitLab findings" and `fakeGitLabLedger.testkit.ts`.

## 3. Credentials and scopes for every plugin

- Generalize `credentialRequirements.ts` to github (fine-grained: Issues read+write, Metadata read; admin for `delete: hard`) and remote (server token, 16+ chars).
- `task strategy check`: one line per capability, `enabled` / `disabled (missing <permission>)` / `not tested`, each with exact fix + doc link.
- One doc per plugin: how to create the token (single source = the requirements table).
- GitHub fake-server ledger like GitLab's (zero ASSUMED, recorded conformance fixtures from the live smoke). Needs a GitHub token (the 7-day one expires about 2026-11-15).

## 4. Waiting on the user

- Task page: pick a winner per A/B row (description-style, subtask-add, subtask-list, link-add, link-group, activity-filter, activity-composer). Then bake, delete losing options/fragments/tests, delete `.claude/screenshots/`.
- Go to take `shared-updater` (swap-window MODULE_NOT_FOUND during self-update; recommendation: task-owner, staging prefix + rename).
- macos-smoke: task used `macos-14` (cancelled, no runner). project uses `macos-latest` and gets one. Next: try `macos-latest` in `publish.yml` + `publishWorkflow.test.ts` (it pins `macos-14`), keep informative until one run passes, then gate `publish` on it.
- Linux support for the task CLI (project-owner proposal, ci-templates c3bec19 pushed, project 0759319 published linux-x64): CONTRADICTS the recorded owner decision in CLAUDE.md "Updater" (win32-x64 and darwin-arm64 ONLY, no partial support). Not applied: needs the user's explicit go. If yes, the patch list is: bump `@wadeck-app/singleton-daemon-kit` (>= 2026.10.31-103), `copy-binaries.sh` linux-x64, `publish.yml` PLATFORMS/loops/calls, re-sync `generate-platform-packages.sh` + `smoke-packed.sh` from c3bec19 (keep the extra `cli version` check with COMBINE=1), `binShim.unit.test.ts` + `publishWorkflow.test.ts` + CLAUDE.md. Heads-up: the first Linux publish makes the update check fail once (previous version refuses Linux).
- DONE by project-owner: `ci-templates` 0099d00 is pushed to origin/main; project 272a2d9 published 2026.11.13-028 with the hardened shim on a real macOS runner (`macos-latest`, registry install OK, darwin binary 0755).

## 5. Peers

- `-v`: done in task, orch, flow, app-core-cli, queue (queue-owner a7a02ee, CI green, also keeps output without TTY, darwin-x64 dropped). Pending: project, wdrive. queue keeps its own shim (not the ci-templates one): fine.
- project-owner: `task:project-header` contribution still to come from their side.

## 6. Design debts (todo section 1 for details)

Stage 0.7 (lift domain rules out of `TaskStore`), `forge-common` extraction, GitHub `findByPrefix` cost and page-level `expectedRevision`, `GET /projects` exposing capabilities, remote on a second machine + TLS, virtual-project events, Tree "last added".

## 7. Cleanup

`%TEMP%/gl-labels-check.mjs` (mine, read-only GET script: delete with rm, request bypass if blocked), sub-agent scratch in `%TEMP%` (not attributable, leave), `.claude/screenshots/` after the design pick.
