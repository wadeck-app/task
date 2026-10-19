## Packages

| Package           | Role                                                                                                             |
| ----------------- | ---------------------------------------------------------------------------------------------------------------- |
| `task-core`       | Storage: `TaskStore`, config loading, domain errors.                                                             |
| `task-service`    | Use cases shared by the CLI and the app-module. Pure: no console, no `process.exit`; returns results and events. |
| `task-cli`        | `task` binary: arg parsing and output over task-service, updater, app-core registration.                         |
| `app-module-task` | app-core module (id `task`): routes `/api/modules/task/*` and dsl-views over task-service.                       |

## app-core registration

- `task cli register [--json]` / `task cli unregister [--json]`; `task cli update` registers by itself when the shipped app-module version changed. Task has no daemon, so nothing registers at start.
- Exit 0 when app-core took it or is absent/not running (deferred, skipped); exit 1 with app-core's reason when it refuses.
- Manifest: `app-module/manifest.json` next to `task.cjs`, else `packages/app-module-task/dist-module/manifest.json` (source checkout: `BUNDLE_VERSION=0.0.0-local npm run bundle --workspace=packages/app-module-task`). Neither found is an error naming both paths.
- The module has no cwd: projects come from `<config dir>/projects.json` (written by `task init`), routes take `?project=<dir>`.
- Testing against a real app-core: set `APP_CORE_PORT` and `APP_CORE_CONFIG_DIR`; without a free `APP_CORE_PORT` the SDK talks to the app-core running on 4850.

## app-module-task routes and pages

Routes (`/api/modules/task/...`, all take `?project=<dir>`, typed errors mapped in `errors.ts`): GET `/projects` `/summary` `/tasks` `/tasks/:id` `/tasks/:id/{history,children,ancestors,links}` `/tree` `/types`; POST `/tasks` `/tasks/:id/{status,labels,links,parent,type,meta}` `/types` `/tasks/delete/plan` `/tasks/delete` (needs `confirm: true`, else 400 with the plan); DELETE `/tasks/:id/{labels/:label,links,parent}` `/types/:name`. Only create/status/links produce queue events (`undelivered`, `undeliveredText`).

Pages: nav `/tasks` `/tree` `/projects` `/types`; routes `/tasks/:id`, `/tasks/:id/history`, `/new`, `/delete`; dashboard widget.

View conventions (app-core DSL, checked against the real shell):

- Mutations: Form + `$actions` + `onSubmit: $ctx.<action>`; the form data is the body and fills `{placeholders}` of the action URL. Placeholders are not URL-encoded: forms carry `projectParam` (encoded by the route) and use `?project={projectParam}`.
- A failing action shows nothing (no error channel); a failing source blanks the whole page. Sources therefore use `?{query}` with `$source.projects.selectedQuery`: empty while no project is selected, which skips the source.
- `FieldSelect` crashes the page until its options load: guard with `$if`. `$if` has no negation and `[]` is truthy: routes give boolean flags (`hasLabels`, `noTypes`...).
- Not expressible: row actions (the shell fetcher does not substitute `{id}`), URL-writing filters, TreeView navigation.
- Test against a real shell: `app-core-cli dev packages/app-module-task --watch` with `APP_CORE_PORT`, `XDG_CONFIG_HOME` and a PATH without `queue` (events end up undelivered instead of pushed).

## Agent reference docs

| Doc                             | Description                                                      |
| ------------------------------- | ---------------------------------------------------------------- |
| `.claude/guiding-principles.md` | `--follow`/`-f` convention: list/snapshot diffing vs log tailing |
