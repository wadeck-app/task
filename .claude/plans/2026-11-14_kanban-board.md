# Kanban board: 5 variants, project-module embed, live cards

Request (owner, 2026-11-14): 5 kanban variants in the task module and inside the project module (optional dependency, scope = one project), cards update live when a task changes status.

## Facts (investigated, file refs in the session transcript)

- The shell has NO push bus. A module backend may open its own SSE route (`app-core/.../app-module-example/src/backend/index.ts:32`, client `LiveTicks.tsx:10`); CSP allows `connect-src 'self'`; `EventSource` reconnects by itself.
- Page-level refresh is `$sources.<key>.poll` plus `ctx.unchanged` / `ctx.fileVersion` (ETag); `refreshSeconds` only drives menu/tab counts.
- No drag and drop exists in dsl-ui; native HTML5 drag events fit the dsl-lib import rule (no new dependency).
- Project module (`C:\Workspace_Tooling\project`, `optionalRequires: task`) exposes slots `project-panels` (accepts Section, Collapsible, Badge, ButtonLink) and `project-links`. A contribution renders with the host page context (`$route.project`); the root `$type` is checked, children are not. Contributions of an absent provider are dropped per request. So task can contribute a `Section` holding `task:KanbanBoard` to `project:project-panels` with only its own manifest (`optionalRequires: {project}`): no edit in the project repo.
- Project module owner session: not named anywhere; inform it by message once the contribution exists.

## Design

- Data: `GET /tasks/board?project=` -> `{ columns: [{status, label, tone, terminal, outcome?, count, hiddenCount, cards: [{id, headline, href, priority?, priorityText?, assignee?, type?, labels, tone, updatedAt}]}], version, hasCards, emptyText, readNotices }`. Columns follow the project config order (`listStatuses`). At most 100 cards per column.
- Move: the existing `POST /tasks/:id/status` (body `{status}`), page action `moveCard`; no new write route. Events and `undeliveredText` as for every status change.
- Live: `GET /board/events?project=` (SSE, event `version`). Local strategy: stat of the data folder every 2 s; github/gitlab/remote: 30 s over the cached read. The component refetches the board when the version changes; fallback poll `pollSeconds` (20 s) when SSE fails; a visible "live / reconnecting" state.
- Component `task:KanbanBoard` (dsl-lib-task), props: `columns`, `version`, `projectParam`, `moveAction`, `boardPath`, `eventsPath`, `variantSwitcher`, `defaultVariant`, `readOnly`, `emptyText`, `pollSeconds`, `params`.
- Variants (`variant` prop): `columns` (classic), `swimlanes` (rows by priority), `compact` (dense cards), `rails` (one expanded column, others collapsed rails), `tabs` (status tabs + list + "Move to" menu, no drag). Every variant has a keyboard move (menu on the card), not only drag.
- A/B switcher: large, bottom-center, floating, on the real page; only when the module runs with `TASK_KANBAN_AB=1` (dev server), choice persisted in localStorage; absent otherwise. Winner is baked later (same procedure as the task page).
- Pages: per project `/tasks/p/:project/board` (tab "Board" in the `project` group) and, global, none (a board is per project). Project module: the panel on its project page.

## Steps

1. Backend + page + manifest + project contribution (`app-module-task`), tests first.
2. Component with five variants + switcher (`dsl-lib-task`), tests first, entries regenerated.
3. Integration, real-shell check with agent-browser (task page, project page, drag, live update from the CLI, switcher, 1440 and 390 px).
4. CLAUDE.md section, commit, CI, update.
