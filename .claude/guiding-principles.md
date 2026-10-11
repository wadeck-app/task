# Guiding Principles — task

## `--follow`/`-f` means tail-style diffing, not periodic redraw

Two unrelated things both use the name `--follow`/`-f` across the CLI family — do not conflate them:

| Family | Behavior | Example | Underlying mechanism |
|---|---|---|---|
| List/snapshot diffing | Print initial state once, then only new/changed items each poll | `task list -f`, `task history -f`, `queue history -f`, `flow worker list -f` | `diffSnapshot` (`@wadeck-app/shared-cli`'s `FollowSnapshot.ts`) |
| Log tailing | File-offset tail of an append-only log file | `queue cli logs --follow`, `orch logs --follow` | `CliMetaCommands.cliLogsCommand`'s pattern |

`task`'s own `--follow` support (`list`, `history`) is **list/snapshot diffing only** — it does not tail any log file. It polls `TaskStore` every `FOLLOW_POLL_INTERVAL_MS` (500ms), diffs the result against the previous poll, and prints only what changed — never a full redraw.

Implementation: `packages/task-cli/src/commands/HistoryFollower.ts` (`diffTaskListSnapshot`, `diffHistoryEntries`). This is a local, bespoke copy of the same pattern `@wadeck-app/shared-cli`'s `diffSnapshot<T>(previous, current, keyOf)` now generalizes (published `2026.10.11-037-aa0ba3e8`, after queue-cli and task-cli had independently reimplemented it). Migrating to `diffSnapshot` is a drop-in replacement — not urgent, but preferred over keeping a third bespoke copy alive.

See `@wadeck-app/shared-cli`'s own `.claude/guiding-principles.md` for the full `--follow` convention (poll interval, stderr banner, `SIGINT` handling) shared across the CLI family.
