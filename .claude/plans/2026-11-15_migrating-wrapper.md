# Wrapper strategy `migrating` (meta-plugin)

Owner answers: see `.claude/session/principles.md` (2026-11-15). Status: plan, nothing built. Decisions D13-D17 in `.claude/session/decisions.md`.

## Goal

A built-in strategy plugin `migrating` that provides the normal storage contract (`TaskBackend`) by COMPOSING two other strategies: `current` (A, where the tasks are) and `new` (B, where they go). New tasks go to B; existing tasks move A -> B incrementally in the background while every command keeps working; at the end `finalize` makes B the project's only strategy. `remote` and `encrypting` will be meta-plugins of the same kind later: OUT OF SCOPE now, but the seam must not preclude them (a meta-plugin only opens other strategies through the host).

```yaml
strategy:
    type: migrating
    options:
        current: { type: local } # a full strategy block each
        new: { type: github, options: { repo: o/r, tokenEnv: GITHUB_TOKEN, ... } }
        budget: { requestsPerMinute: 30 } # share the background worker may use
```

## Agnostic rule (user, 2026-11-15, D13)

The wrapper works for ANY pair (A, B) of strategies and knows none by name: it reads only `TaskBackend`, `BackendCapabilities`, `BackendTraits`, `locationOf` and the plugin hooks. Everything a backend needs from the wrapper (a metadata carrier for the identity block, a write cap, hierarchy limits, lag after a write) comes through traits/capabilities; a missing one is a loud error at load or `start`, never a guess. An architecture rule forbids `github|gitlab|remote|local` identifiers in the wrapper's folder. Tests run the SAME suite over several pairs: local+local, local->fake GitHub, fake GitHub->fake GitLab, local->remote (loopback), and a restricted-capability fake. The examples below name backends only as illustrations.

## Design

1. Host seam: `StrategyContext.openStrategy(block)` (like `openTransport`): the host resolves, validates (secrets rules, no `migrating` inside `migrating` in v1) and creates the sub-instance; the meta-plugin never imports another plugin (architecture rule `plugin-imports-outside-seam` stays). `capabilities` of the wrapper = the intersection of A and B (never promise what one side cannot do); `traitsFor` / `locationOf` combine both.
2. Routing index (local file `<data>/migrating/index.json`, atomic write, covered by the project write lock): one row per task `{publicId, a?: id, b?: id, state, since, version}`. States: `in-a`, `moving` (in A AND B, A authoritative), `in-b` (B authoritative, A copy kept until finalize), `deleted`. The index is the source of routing; it can be REBUILT from the stores (see 4).
3. Transactions (closest to a database): a per-task state machine with a write-ahead log. Move = `in-a` -> `moving` (create copy in B with the identity block, verify by read-back) -> switch authority in ONE index write -> `in-b`. A modification during `moving` is applied to A (authoritative) then mirrored to B; a failed mirror marks the copy stale and the worker re-copies. Every transition is logged before it happens; recovery after a crash replays the log (idempotent steps, like `migrate`). A deletion during `moving` deletes both. A is never deleted before `finalize` (it is the backup).
4. Identity and other cross-store facts (the id is not the only one): each task copy in B carries an identity block (metadata `migrating.publicId`, `migrating.fromId`, plus a content hash), so the index is rebuildable and `task show <old id>` keeps working. Needs a meta carrier on B (GitHub: `fills.meta`; validated at load with the exact fix). Other cross-store facts to handle explicitly, each with tests: parent/children and links between a task in A and one in B (ids translated through the index; a hierarchy limit of B refused at move time, not at the end); revisions (wrapper revision = A's or B's per authority + state); comments/author/createdAt losses (the `migrate` loss ledger, accepted at `start`); events (one `onTaskCreated` per task, no replay at move time: `suppressEvents`); claims/leases (a claimed task is not moved until released or lease over); status/type/priority existing in A but not representable in B (blocked at `start`, never at move time); ids references in texts (counted, not rewritten); ordering and merged listing (dedup by publicId, A and B pages merged, then sorted by the use case); rate limits of either side (RateLimitedError pauses the worker, never fails a command).
5. Background worker: task has no daemon, so `task strategy migrate start` spawns a detached worker (Windows: hidden, see docs/windows-hidden-process.md) with pid + lock file, incremental, honouring `budget` and `retryAt`; it stops cleanly on `pause`, crash, or end. A foreground command never waits for it.
6. Commands (under `task strategy migrate`, reversible naming): `start [--dry-run] [--allow-loss ...]`, `status [--json]` (counts per state, rate, ETA, last errors, worker pid), `pause`, `resume`, `finalize` (all tasks `in-b` and verified; rewrites config.yml with the `new` block, backup `config.yml.before-migration`, same safeties as in-place switch), `abort` (A stays authoritative, B copies listed for manual cleanup, never deleted silently), `log [--follow]`. Log: `<data>/migrating/log.ndjson`, one line per transition/request error/rate pause, plus the task log.
7. Reuse: the copy of one task is the `migrate` engine's per-task code (`mapTask`, loss ledger, `createMigrated`, verify); do not fork it.

## Phases (TDD, mocks only: local+local, fake GitHub, fake GitLab; fault injection wrappers)

| Phase                            | Content                                                                                                        | Done when                                                                    |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| P0                               | host seam `openStrategy`, plugin registration, option validation, intersected capabilities, architecture rules | contract suite passes with the wrapper over local+local in state `in-a` only |
| P1 (DONE 2026-11-15, reads only) | index + states + merged reads (list, get, tree, links across stores), identity block, index rebuild            | reads correct in every state, rebuild test                                   |
| P2 (DONE 2026-11-15)             | writes in every state, move state machine, WAL, crash/fault-injection matrix, deletion during move             | contract suite passes with tasks in every state; crash at each step recovers |
| P3 (DONE 2026-11-15)             | background worker, budget, rate pause, `status/pause/resume/log`                                               | worker moves N tasks under the fake with rate limits; status exact           |
| P4 (DONE 2026-11-15)             | `finalize` / `abort`, config switch, backup                                                                    | end-to-end local -> fake GitHub, finalize, normal project afterwards         |
| P5 (script + docs DONE, NOT RUN) | live smoke script (not CI), docs, CLAUDE.md digest                                                             | run by the owner with a throwaway repo: UNVERIFIED until then                |

P2 leftovers: trait enforcement on writes (depth, text limits, comment authors); a trait for write lag of a side; claim semantics in `new`; `prepare` forwarding; cross-process lock; docs of the `task strategy migrate` commands (P3). Fault tests of P2 ran on fakes only.

P3 leftovers: `abort`/`finalize` (P4); refine the per-move cost from measured requests; cross-process lock stronger than a pid file; `pause` race right after launch; progress ETA with the hourly cap shown as a range; `log --follow` by offset; live Windows/macOS launch check beyond one spawn.

P4 leftovers: old ids do not resolve after finalize (id map file only, D19); finalize refuses a `new` that keeps task files in the project folder (relocating them was judged too large: needs a crash-safe rename plan); a new migration over a finished/aborted one needs the `migrating` files moved aside by hand; `abort --keep-moved` leaves tasks of `new` out of the project; YAML comments of config.yml are lost on the switch (backup keeps them); identity hash not compared with content at finalize; `scripts/live-migrating-smoke.mjs` (with `--mock`) written, not run.

Risks: cross-store hierarchy; GitHub write cap (500 content writes/hour) makes moves slow by nature (status shows the ETA); a task edited ON GitHub during the move is not seen (R7).
