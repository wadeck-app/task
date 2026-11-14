# Out of Scope - task

Raising an item here is a change-of-scope conversation, not a design question. Each row cites where the decision is recorded; "(to validate)" marks a reading not stated as a decision in a source.

## Platforms and tiers

| Item                                                                                        | Decision                                                                                                                                                        | Source                                    |
| ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| Intel Macs (`darwin-x64`), `linux-arm64`, any other platform                                | Unsupported, no partial support. Supported: win32-x64, darwin-arm64, linux-x64                                                                                  | `CLAUDE.md` "Updater" (owner, 2026-11-13) |
| GitLab paid tiers (blocking links, epics, weight, scoped-label exclusivity, tier detection) | Free tier only; no `tier` option; fails with "requires a paid GitLab tier"                                                                                      | `CLAUDE.md` gitlab section (owner)        |
| GitLab classic tokens, self-managed instances                                               | NOT SUPPORTED (owner decision 2026-11-14): only a fine-grained token on gitlab.com; the `baseUrl` option accepts another host but nothing is tested or promised | `CLAUDE.md` gitlab section                |

## Plugins, credentials, forges

| Item                                                                                    | Decision                                                                                 | Source                                           |
| --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------ |
| External / third-party plugins, `pluginsDir`, npm plugin distribution, dynamic loading  | Built-ins only; no loader is written; `strategy.pluginsDir` is a schema error            | storage plan R11; plugin spec `out-of-scope.md`  |
| Plugin contract versioning, plugin manifests                                            | None in v1                                                                               | storage plan R13                                 |
| Vendor CLIs (`gh`, `glab`), `tokenCommand`, keychain                                    | Official APIs through `fetch` only; token = `tokenEnv` or `tokenFile`                    | storage plan decision 9, R12                     |
| Literal credentials in config                                                           | Hard error at load, with the `tokenEnv` / `tokenFile` fix                                | storage plan R12; `CLAUDE.md` "Storage strategy" |
| Silent emulation of what a forge cannot hold (`causedBy`, delete on GitHub, custom ids) | Fail loudly; emulate only through a declared `fills` key                                 | storage plan R4, R5, R9, R10                     |
| Webhooks from forges                                                                    | Not before "later"; whether the relay can receive them is a question for the queue owner | storage plan R8                                  |
| `task doctor` alias                                                                     | None; `task strategy check` is the only diagnostic                                       | storage plan R16                                 |
| `task import`                                                                           | None; `task migrate` covers it                                                           | `CLAUDE.md` "Migration"                          |

## Registry and process model

| Item                                                                            | Decision                                                                                                                                  | Source                                                                        |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Writing the project registry; registering, moving, removing projects            | Owned by the `project` CLI. `task init`, `task projects add\|remove\|move\|prune\|list`, `task plugins` do not exist; `NO_REGISTRY_WRITE` | `CLAUDE.md` "Shared project registry", "app-core registration" (Decision #20) |
| A path as project reference, `--project-dir`, `TASK_PROJECT_DIR`, `PROJECT_DIR` | Unknown option / not read; a reference is an id, name or alias                                                                            | `CLAUDE.md` "Shared project registry"                                         |
| A lock on task data                                                             | None by design (Q30); atomic writes only                                                                                                  | `CLAUDE.md` "Shared project registry"                                         |
| A daemon                                                                        | None: nothing registers at start; `task serve` runs in the foreground, no daemonizing                                                     | `CLAUDE.md` "app-core registration", "Storage strategy: remote"               |

## Remote and distribution of data

| Item                                                                                                                               | Decision                                                   | Source                                                             |
| ---------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------ |
| Multi-master, network share or git sync of live task data                                                                          | Unsupported: one writer machine (`task serve`)             | storage plan R6                                                    |
| Events for changes made on the forge or on the server machine by someone else                                                      | None in v1 (polling diff is v2)                            | storage plan R7                                                    |
| TLS, tunnels, per-token project scope, several users, request signing, rate limiting beyond the failure delay, multi-project serve | Deferred; a wrapper plugs in later as a `transport` plugin | `docs/threat-model-task-serve.md` "Deferred"; storage plan #7, #8c |
| Refusing cleartext non-loopback `task serve` (fail closed like flow / machine)                                                     | Not decided; today it warns                                | `docs/threat-model-task-serve.md` "Cleartext policy"               |

## Product surface

| Item                                                                              | Decision                                                        | Source                                         |
| --------------------------------------------------------------------------------- | --------------------------------------------------------------- | ---------------------------------------------- |
| Back links in the module pages ("All tasks", "Back to the task")                  | None; the breadcrumb carries the context                        | `CLAUDE.md` "app-module-task routes and pages" |
| Registry project management in the module (register, move, remove, edit)          | None; the Projects page is a read-only list                     | same                                           |
| A user / author model for comments                                                | None; `author` is a free string, never defaulted to the OS user | `CLAUDE.md` "Comments"                         |
| Markdown, auto-links or HTML in comments                                          | Plain text only                                                 | `CLAUDE.md` "Comments"                         |
| Links across projects                                                             | Not supported; listed as an open question                       | `CLAUDE.md` "Task links"                       |
| Virtual projects in cross-project views and the module                            | Not listed; `?project=<virtual>` answers 409                    | `CLAUDE.md` "Shared project registry"          |
| Silent fallbacks, in general (default version, null, skip when a file is missing) | Never; fail loudly with the fix                                 | owner rule (user CLAUDE.md); storage plan R3   |

## How to challenge scope

Open a discussion with the rationale; do not edit this file silently. A change of an owner decision above is recorded as a new dated decision.
