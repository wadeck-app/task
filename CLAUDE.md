## Packages

| Package           | Role                                                                                                             |
| ----------------- | ---------------------------------------------------------------------------------------------------------------- |
| `task-core`       | Storage: `TaskStore`, config loading, domain errors.                                                             |
| `task-service`    | Use cases shared by the CLI and the app-module. Pure: no console, no `process.exit`; returns results and events. |
| `task-cli`        | `task` binary: arg parsing and output over task-service, updater, app-core registration.                         |
| `app-module-task` | app-core module (id `task`): routes `/api/modules/task/*` and dsl-views over task-service.                       |

## Dependency direction

`task-core` <- `task-service` <- `task-cli` and `app-module-task`. The two adapters never import each other, and `task-service` knows no CLI, HTTP or app-core library, never prints or exits. `npm run test:architecture` (`architecture/`, part of `npm test`) enforces it on imports, `package.json` dependencies and source patterns.

Shared rules live in `task-service`, adapters only parse input and format output: `describeError` (error kind, message, hint; CLI maps to stderr, module to HTTP status), `selectDeleteTargets` / `describeDeleteEffects`, `openTaskContext`, `getTaskLogDir`, `countTasksByStatus`, `showTaskWithRelations`, the projects registry (`listRegisteredProjects`, `unregisterProject`, `inspectRegisteredProjects`, `pruneMissingProjects`, `registerInitializedProject`: shared by `task init` and `task projects add`), and the cross-project reads `summarizeProjects` / `listTasksAcrossProjects` (per-project figures and tasks tagged with their project; unreadable projects reported, `NoReadableProjectsError` when none can be read; only the app-module uses them today, see the TODO below).

## app-core registration

- `task cli register [--json]` / `task cli unregister [--json]`; `task cli update` registers by itself when the shipped app-module version changed. Task has no daemon, so nothing registers at start.
- Exit 0 when app-core took it or is absent/not running (deferred, skipped); exit 1 with app-core's reason when it refuses.
- Manifest: `app-module/manifest.json` next to `task.cjs`, else `packages/app-module-task/dist-module/manifest.json` (source checkout: `BUNDLE_VERSION=0.0.0-local npm run bundle --workspace=packages/app-module-task`). Neither found is an error naming both paths.
- The module has no cwd: projects come from `<config dir>/projects.json` (written by `task init` and `task projects add`), routes take `?project=<dir>`.
- Registry upkeep, no project needed: `task projects add [dir] [--json]` (default cwd; needs a `.task` there, else error with the `task init` hint; idempotent: `Already registered`; registers projects initialized before the registry existed), `task projects list [--json]` (path, `[ok]` / `[missing]` / `[not initialized]` / `[unreadable: reason]`), `task projects remove <dir>` (relative to cwd, case-insensitive on Windows; unknown dir is an error), `task projects prune [--dry-run]` (drops entries whose directory is gone; a directory that cannot be stat'ed, e.g. permissions, is kept).
- `deferred` from the SDK means only "the POST failed" (refused, reset, or no answer within 3 s) and the config dir exists, not proof that app-core is down; the message says "not running" regardless. If app-core is up, run `task cli register`.
- Testing against a real app-core: set `APP_CORE_PORT` and `APP_CORE_CONFIG_DIR`; without a free `APP_CORE_PORT` the SDK talks to the app-core running on 4850.

## app-module-task routes and pages

Routes (`/api/modules/task/...`, all take `?project=<dir>`, typed errors mapped in `errors.ts`): GET `/projects` `/summary` `/tasks` `/tasks/:id` `/tasks/:id/{history,children,ancestors,links}` `/tree` `/types`; POST `/tasks` `/tasks/:id/{status,labels,links,parent,type,meta}` `/types` `/tasks/delete/plan` `/tasks/delete` (needs `confirm: true`, else 400 with the plan); DELETE `/tasks/:id/{labels/:label,links,parent}` `/types/:name`. Only create/status/links produce queue events (`undelivered`, `undeliveredText`).

Pages: nav `/tasks` `/tree` `/projects` `/types`; routes `/tasks/:id`, `/tasks/:id/history`, `/new`, `/delete`; dashboard widget.

Global view (all registered projects): the widget (`GET /summary` without `?project`: open/total plus `projectRows`, one row per project with its tasks link or its error; nothing registered is a 200 with `noProjects`, not an error) and the Tasks page without `?project` while several projects are registered (`GET /tasks?allProjects=true`, Project column, rows keep `?project`; `/projects` gives `globalQuery`, `allProjectsHref`, `unknownProjectText`). With `?project`, or a single registered project, the Tasks page is the per-project page. The other pages (tree, types, new, delete) still ask for a project choice.

> **TODO(cli-parity)**: the global view exists only in the app-module. The CLI needs, over the same `summarizeProjects` / `listTasksAcrossProjects` (no new logic, only parsing and output):
>
> - `task list --all-projects [--all] [--json]`: Project column, unreadable projects on stderr, exit 1 when none can be read.
> - `task projects summary [--json]`: per-project open/total and the totals.
> - Output tests in `task-cli`, then drop this TODO.

View conventions (app-core DSL, checked against the real shell):

- Mutations: Form + `$actions` + `onSubmit: $ctx.<action>`; the form data is the body and fills `{placeholders}` of the action URL. Placeholders are not URL-encoded: forms carry `projectParam` (encoded by the route) and use `?project={projectParam}`.
- The shell drops the answer of a failed action and discards ALL source answers when one source fails (blank page). Every request of a view therefore adds `inlineErrors=true`: the route answers a failure as 200 with `failed`, `httpStatus` and `errorText` (message, plus the hint unless it explains the JSON API), and the view shows `errorText` in a `variant: danger` Badge. Actions publish with `resultKey` per section, so the message sits next to its form.
- Zero registered projects: `/projects` answers `noProjects` + `noProjectsText` (the next step: `task init` / `task projects add <dir>`) and `forms: null`; every page shows that text in an info Badge (a page with only a bound title and no badge renders blank). `forms` is also null when the selected project is unreadable. The widget shows its figures only `$if: summary.projectCount`, so a failure leaves the error alone. A registered directory that vanished is told apart (`exists: false`; fix: `task projects remove <dir>` / `prune`).
- Sources use `?{query}` with `$source.projects.selectedQuery`: empty while no project is selected (or the selected one is unreadable, see `selectedProblem`), which skips the source.
- The shell reloads on a URL change only the sources naming a `$urlParam.*`/`$route.*`: a source waiting for `projects` also takes `reload: $urlParam.reload` (always empty, so never sent), else filter links and project choice leave the page stale or blank until F5.
- DataTable columns lose `format`, `mono`, `width`, `truncate` (the shell rebuilds them from `key`/`label`) and a `PageHeader` with `headerActions` drops its `subtitle`: routes give display texts (`titleText`, `created`, `time`, `projectText`).
- A `FieldSelect` showing its first option while the form holds `''` makes picking that option a no-change (Save stays off): selects that act on an existing item (remove label/type) need a `placeholder`.
- `FieldSelect` crashes the page until its options load: guard with `$if`. `$if` has no negation and `[]` is truthy: routes give boolean flags (`hasLabels`, `noTypes`...).
- Not expressible: row actions (the shell fetcher does not substitute `{id}`), URL-writing filters, TreeView navigation.
- Test against a real shell: `app-core-cli dev packages/app-module-task --watch` with `APP_CORE_PORT`, `XDG_CONFIG_HOME` and a PATH without `queue` (events end up undelivered instead of pushed).

## Agent reference docs

| Doc                             | Description                                                      |
| ------------------------------- | ---------------------------------------------------------------- |
| `.claude/guiding-principles.md` | `--follow`/`-f` convention: list/snapshot diffing vs log tailing |
