## Packages

| Package | Role |
|---|---|
| `task-core` | Storage: `TaskStore`, config loading, domain errors. |
| `task-service` | Use cases shared by the CLI and the app-module. Pure: no console, no `process.exit`; returns results and events. |
| `task-cli` | `task` binary: arg parsing and output over task-service, updater, app-core registration. |
| `app-module-task` | app-core module (id `task`): routes `/api/modules/task/*` and dsl-views over task-service. |

## app-core registration

- `task cli register [--json]` / `task cli unregister [--json]`; `task cli update` registers by itself when the shipped app-module version changed. Task has no daemon, so nothing registers at start.
- Exit 0 when app-core took it or is absent/not running (deferred, skipped); exit 1 with app-core's reason when it refuses.
- Manifest: `app-module/manifest.json` next to `task.cjs`, else `packages/app-module-task/dist-module/manifest.json` (source checkout: `BUNDLE_VERSION=0.0.0-local npm run bundle --workspace=packages/app-module-task`). Neither found is an error naming both paths.
- The module has no cwd: projects come from `<config dir>/projects.json` (written by `task init`), routes take `?project=<dir>`.
- Testing against a real app-core: set `APP_CORE_PORT` and `APP_CORE_CONFIG_DIR`; without a free `APP_CORE_PORT` the SDK talks to the app-core running on 4850.

## Agent reference docs

| Doc | Description |
|---|---|
| `.claude/guiding-principles.md` | `--follow`/`-f` convention: list/snapshot diffing vs log tailing |
