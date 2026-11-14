# Product Vision - task

Facts come from `CLAUDE.md` and `.claude/plans/` (cited). Anything inferred is marked "(to validate)".

## Purpose

A per-project task tracker for a developer machine: the `task` CLI and an app-core dashboard module over one shared service layer. Tasks belong to projects of the `project` registry; where they are stored is a per-project choice (`local` files, `github`, `gitlab`, or `remote` behind `task serve`). Tasks emit queue events after each saved change. (Single-user, developer-machine positioning: to validate.)

## Architecture

`task-core` <- `task-service` <- `task-cli` and `app-module-task` -> `dsl-lib-task`. Package roles, dependency direction and the architecture rules that enforce it: `CLAUDE.md` "Packages", "Dependency direction". Every storage backend goes through the async `TaskBackend` port and must pass `runBackendContract` (`CLAUDE.md` "Packages").

## Contracts that define the product

| Contract                                                                                                                      | Source                                                       |
| ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| The `project` CLI registry is the single source of projects, data and config; task reads it and never writes it               | `CLAUDE.md` "Shared project registry"                        |
| A folder in no registered project is not a project: an error, never a fallback                                                | same                                                         |
| Strict fidelity by default: what a backend cannot hold natively fails loudly, and is emulated only through a declared `fills` | `CLAUDE.md` "Storage strategy"; storage plan R4, R5, R9, R17 |
| Official forge APIs only: no `gh`/`glab`, no `tokenCommand`, no keychain; token = `tokenEnv` or `tokenFile`                   | storage plan decision 9, R12                                 |
| Remote = one writer (`task serve`); the server is the only emitter of the events of those tasks                               | storage plan R6, R7; `CLAUDE.md` "Storage strategy: remote"  |
| Events are built after the awaited write and delivered one by one through queue-sdk; failure never fails the command          | `CLAUDE.md` "Queue events"                                   |
| No silent fallback, no silent no-op: every refusal is an actionable error (`{error, hint}` with `--json`)                     | `CLAUDE.md` (throughout); storage plan R3                    |
| `--follow` is list/snapshot diffing, never log tailing                                                                        | `.claude/guiding-principles.md`                              |
| Supported platforms: win32-x64, darwin-arm64, linux-x64                                                                       | `CLAUDE.md` "Updater" (owner decision 2026-11-13)            |

What is excluded: `.claude/out-of-scope.md`. Security: `.claude/threat-model.md`.

## Intended direction

From `.claude/plans/2026-10-25_todo.md` (2026-11-14) and `2026-11-13_remaining-work.md`:

- Credentials and scopes per plugin: generalize `credentialRequirements.ts` to github and remote, one `task strategy check` line per capability, one token doc per plugin, a GitHub fake-server ledger like GitLab's.
- Remote on a second real machine, then TLS and tunnels as `transport` plugins.
- GitHub strategy gaps: page-level `expectedRevision`, `GET /projects` exposing `strategy` and `capabilities`, events for changes made on GitHub (R7: polling in v2).
- Stage 0.7 (shared domain-rules layer) closed without doing it; reopen if two backends disagree (todo section 1).

## Known gaps

| Gap                                                                                                               | Source                 |
| ----------------------------------------------------------------------------------------------------------------- | ---------------------- |
| Unverified: GHES, personal-account repos, `delete: hard` by a non-admin token, secondary rate limits, GitHub caps | todo section 5         |
| Unverified: GitLab classic tokens, self-managed, a token weaker than the test token, roles                        | `CLAUDE.md` gitlab     |
| `remote` verified on loopback only                                                                                | `CLAUDE.md` remote     |
| Virtual projects (no path): undelivered events, absent from cross-project views and the module                    | `CLAUDE.md` registry   |
| `listLabels` and `/meta-keys` read every task file (128-190 ms at 1000 tasks); Tree "last added" = creation date  | todo section 1         |
| No `--follow` for `--all-projects`                                                                                | `CLAUDE.md` CLI parity |
| shared-updater swap window: `task` unusable for a few seconds during a background self-update; no owner           | todo sections 1 and 3  |
