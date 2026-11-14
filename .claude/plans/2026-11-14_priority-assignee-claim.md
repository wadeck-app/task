# Priority, assignee, sorted list and atomic claim

Status: DESIGN ONLY, nothing implemented. Origin: factory-test-owner relays the user's requirements (2026-11-14); to be confirmed by the user directly before stage 1 (see "Needs from the user"). Feasibility: yes, in four stages; the one hard limit is atomicity (below).

## Requirements (as relayed)

1. Priority is a first-class field of every task; the github and gitlab strategies map it (plugin code, not a user label convention).
2. `task list` sorts and filters inside task; one call returns what a dispatcher needs: order by default priority, no assignee, status in (backlog, ...), with `priority`, `assignee`, `createdAt` in each summary. No `task show` over the backlog.
3. The ordering is a plugin; the only implementation for now: highest priority first, then oldest.
4. `assignee` is a plain field (a worker name, no forge user); on github/gitlab it is stored as metadata. A claim writes the assignee with the expected revision; a concurrent claim fails with an explicit conflict.

## What exists today (facts, sources)

- `ListQuery` (task-core `backend/TaskBackend.ts:55`) already has `parentId`, `statusIn`, `text`, `limit`, `cursor`; no sort, no assignee, no priority. `listPage` is on every backend; the CLI `list` does not expose it.
- `TaskSummary` (`TaskStore.ts:43`): id, title, status, createdAt, links, parentId. No labels, meta, updatedAt.
- `expectedRevision` is honoured by local, github, gitlab, remote (`409/412 stale`); no use case or CLI flag sends it.
- `defaults.priority` exists in config only (`TaskConfigLoader.ts:183`), read by nothing.
- github/gitlab lists carry labels and body, so label-based or block-based fields can be read without one request per task.

## Design

### Model (task-core)

- `TaskRecord.priority?: string` and `assignee?: string`; both mirrored in `TaskSummary` and in `task-index.json` (absent = default priority / unassigned; old files and indexes stay valid, no migration).
- Priority scale: config key `priorities` (scope `local`, like `statuses`): an ordered list, highest first, one `default`. Built-in default when absent: `urgent, high, medium, low` with `medium` default (decision P1). `defaults.priority` is replaced by the entry flagged default (it was dead).
- `TaskBackend`: `setPriority`, `setAssignee` (both with `expectedRevision`), `ListQuery` gains `assignee?: string | null` (`null` = unassigned), `priorityIn?`, `order?: string` (name of an ordering plugin). Capability rows `priority` and `assignee`: `native | mapped | unsupported`, so `strategy show` says how each backend holds them.

### Ordering plugin (plugin host)

- New plugin kind `ordering` (extension point, same seam rules as `strategy`/`transport`): `compare(a, b, facts)`, `describe()`. Built-in `priority-then-oldest` (priority rank from the scale, then `createdAt` ascending, then id). Selected by `task list --order <name>` and by a `list.order` default in the project config. No external loader (R11).
- The sort runs in task-service over the filtered page set, for every backend (a backend cannot sort by our scale). Cursor paging with a sort needs the whole filtered set: limit applies after the sort.

### CLI and service

- `task list [--status a,b] [--unassigned | --assignee <name>] [--priority a,b] [--order <name>] [--limit N] [--json]`; `--json` rows add `priority`, `assignee` (absent when unset).
- `task set-priority <id> <priority>`, `task set-assignee <id> <name>` / `unset-assignee`, `task new --priority --assignee`.
- `task claim <id> --as <name> [--expect-revision <rev>] [--json]`: use case `claimTask` reads the task, refuses when assigned to someone else (explicit conflict naming the holder), writes the assignee with the revision it just read (or the given one), returns the record with the new `revision` exposed as an exception to `plain()` ONLY for this command (decision C1). `task next --as <name>` = list (order default, unassigned, non-terminal) + claim of the first, retrying the next candidate on conflict; deferred to stage 2.
- Events: `onTaskPriorityChanged {taskId, oldPriority, newPriority}`, `onTaskAssigneeChanged {taskId, oldAssignee, newAssignee}` (declaration file, schemas, parity tests as for the others). A claim fires `onTaskAssigneeChanged`.

### Strategy mapping

| Backend | priority                                                                                                                                                                                        | assignee                                                                                                                                                                                                                                                                                                                | In the list answer                                  |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| local   | field in the file                                                                                                                                                                               | field in the file                                                                                                                                                                                                                                                                                                       | index                                               |
| github  | label `priority:<name>` (option `priorityPrefix`, default `priority:`; `priorityMap` for other label names), checked at load like `typePrefix`; a second priority label is a `BackendDataError` | metadata: needs a meta fill (`labels` => `meta:assignee=<name>` exact; or `body-block` approximate, `degrade`). The plugin declares `assignee` as `mapped` only with a meta fill; without it `UnsupportedByBackendError` naming the fill to declare (R4). Native GitHub assignees are NOT used (would need forge users) | list already carries labels and body: one list read |
| gitlab  | label `priority:<name>` (`::` allowed)                                                                                                                                                          | same as github                                                                                                                                                                                                                                                                                                          | same                                                |
| remote  | passes through; protocol v2 adds the fields and routes (additive; server and client negotiate by the protocol range)                                                                            | same                                                                                                                                                                                                                                                                                                                    | same                                                |

Filters on github/gitlab: priority and assignee are evaluated in task-service on the list answer (the API has no "label absent" filter); cost = the list read (1 request per 100 issues, 304 when unchanged), not one per task.

### Atomicity (the honest limit)

| Backend               | Two simultaneous claims                                                                                                                                                                                    |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| remote (`task serve`) | strictly one wins: the server queues writes and checks the revision                                                                                                                                        |
| local                 | check and write are one synchronous step inside a process; two processes can still interleave (no lock on task data, Q30). Decision C2: either document it, or add a per-task lock file for the claim only |
| github / gitlab       | optimistic check-then-write ("not atomic"): a race of the duration of one PATCH remains; `strategy check` already says so                                                                                  |

A dispatcher needing a strict guarantee should claim through ONE writer (`task serve`), or serialize claims itself.

## Stages

1. Core + local + CLI: model, config `priorities`, `setPriority/Assignee`, `claim`, events, contract suite cases (every backend must pass them or assert `unsupported`), migrate traits.
2. List: `ListQuery` fields, ordering plugin kind and built-in, CLI flags, `next`.
3. github + gitlab mapping: options, load-time checks, fills for assignee, fake servers and ledgers updated (LIVE-VERIFIED rows need a live recording: label priority is plain labels, so low risk), `strategy show/check` rows.
4. Remote protocol v2, module routes and views (priority pill, assignee, list columns), docs, threat model (assignee is free text, no authentication: any holder of access can claim as anyone).

## Decisions I take unless the user objects

- P1: scale `urgent, high, medium, low`, default `medium`, configurable per project.
- A1: `assignee` is free text, at most 100 characters, no validation against users.
- C1: `claim` exposes the revision; other commands keep hiding it.

## Needs from the user

1. Confirm the requirements directly (they reached me through a peer session).
2. Priority scale and default (P1), or an open list.
3. github/gitlab `assignee` needs a meta fill declared in the project config (`fills.meta: labels`): acceptable, or should the plugin enable a dedicated mapping automatically (a label `assignee:<name>`)?
4. Claim of a task assigned to someone else: always a conflict (recommended), or `--force`?
5. Local atomicity (C2): document the window, or add a lock for claim.
6. Go for stage 1, and whether this changes `.claude/product-vision.md` ("task is a tracker, not a scheduler": a sorted, filtered list and a claim are tracker features; dispatching stays outside).

## Update: answers relayed by factory-test-owner (to confirm with the user in this session)

- Scale `urgent, high, medium, low`, default `medium` (P1 accepted).
- The three strategies must behave the same for the user: no declared fill for priority or assignee. The plugin stores them itself; if a config key is truly unavoidable it is derived automatically or the load fails loudly with the fix.
- Claim on a live lease held by someone else: conflict naming holder and remaining time; `--force` overrides.
- Lease (suggestion, to accept): `task claim <id> --as <name> [--lease 30m] [--renew] [--force]`; fields `assignee`, `claimedAt`, `leaseUntil` (default lease from config, e.g. 30m); a claim on an expired lease is allowed without `--force` and recorded as a takeover of the previous holder; `--renew` by the same name extends it; `task release <id>` unassigns; `list --json` rows carry `assignee`, `leaseUntil`; filter `--available` = unassigned OR lease expired.
- Atomic for local too (user's word): no documented window. Approach: a claim and every write of a task take a per-task lock (`<task file>.lock`, created with `wx`, pid and time inside, stale after the owner pid is dead) around read-compare-write; atomic rename already protects the bytes. This lifts "no lock on task data" (Q30) for the local backend: a decision for the user, with the cost (a crashed writer leaves a lock until its pid is seen dead).
- Fresh list: `task list --fresh` (and `ListQuery.fresh`) bypasses the github/gitlab read cache for that call (reuses the `freshReads` mechanism of `migrate`, `openContext.ts`); no cost in quota beyond the list read.

## Open: GitHub native issue fields (checked 2026-11-14, docs + MCP, nothing written)

- Issue fields are org/user-level (types single-select, text, number, date; defaults `Priority` urgent/high/medium/low, `Effort`, `Start date`, `Target date`; max 25). REST: `GET|POST|PUT /repos/{o}/{r}/issues/{n}/issue-field-values`, `DELETE .../{issue_field_id}` (write needs push access; API version 2026-03-10).
- NOT established: whether `GET /issues` returns the values (else one request per issue), filtering by field, the read permission of a fine-grained token, plan availability, GHES. A live probe on a throwaway repo is needed before choosing native field vs label `priority:<name>`.
- Likely shape: native field when the owner has the field, label as the fallback, chosen automatically and shown by `strategy show`; `Effort` becomes a candidate first-class field.
