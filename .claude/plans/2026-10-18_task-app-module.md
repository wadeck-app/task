# task app-module

Goal: expose task to app-core/server as an app-module, mirroring `queue` (`app-module-queue` + `queue-core`).

## Decisions

- New package `packages/task-service` (`@wadeck-app/task-service`, private): use-case layer shared by CLI and app-module. Depends on `task-core` (storage). Pure: no console, no `process.exit`, no arg parsing; returns structured results and domain errors.
- Queue events are returned by operations (`events: TaskEvent[]`), delivered through an injected `EventSink`. The queue-spawn sink (`pushToQueue`, undelivered-event log) moves into task-service as the default Node sink.
- New package `packages/app-module-task` (id `task`), same layout as `app-module-queue`: `manifest.json`, `src/backend`, `src/dsl-views`.
- Project selection: app-module has no cwd. Backend reads a list of project dirs from `<configDir>/projects.json`; routes take `?project=<dir>`. Registered by `task init`.
- Registration: no daemon, so `task cli register|unregister` plus auto-register after `task cli update`.

## Phases (TDD: failing test first, then code)

1. task-service: scaffold, extract operations from `TaskIndex.ts` one command at a time; CLI keeps arg parsing/output only. Existing CLI tests stay green throughout.
2. app-module-task: manifest test, route tests (fake `ModuleContext`), routes over task-service.
3. CLI registration (`AppCoreRegistration.ts`, bundle copy of `dist-module`, CI), `task cli register`.
4. Docs: CLAUDE.md package table, stale `guiding-principles.md` reference.

## Out of scope

- Write routes beyond status/labels/meta/links/parent in the first iteration.
- Task-specific dsl-lib React components (dsl-views only).
