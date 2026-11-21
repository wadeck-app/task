# Board: sort and visual groups inside a column (todo #21, from project-owner, user request)

## Scope and what is NOT delivered

- Delivered: optional `sort` per column, drawn with separators where the key forms groups; settable on the board and in Configure columns; persisted in `board.columns[i].sort` of config.yml; 5 A/B variants of the controls and separators.
- Sort keys: `status` (statuses in the column order, today's order plus separators), `priority`, `assignee`, `oldest`, `newest`. Groups (separators): status, priority, assignee. No separators: oldest, newest.
- NOT delivered: sort by task `type` and by "time in the column". The board reads ONE index list; `TaskSummary` has no `type`, no `updatedAt`, no status-since. Adding them means an index mirror change in task-core (all backends) or a per-task read (breaks the one-read rule on github/gitlab). Needs the user's go.
- Default = no `sort` key = today's order, no separator.

## Slices (each: tests first, then code, then verify)

1. task-core `BoardColumnConfig.sort?`; task-service `validateBoard` (unknown value = error naming the allowed ones), `saveBoardColumns` keeps it.
2. app-module-task `boardView.buildColumn`: order by the sort; cards carry `group` (label) when the key groups; column answers `sort`; `PUT /board/config` accepts `sort`.
3. dsl-lib-task: separators in every board variant; editor field per column; board control; 5 A/B variants behind the dev switcher (`TASK_KANBAN_AB=1`), wired into the real board page.
4. Real shell at 1440 and 390, screenshots read, docs (`docs/claude/views-task-kanban-tree.md`, CLAUDE.md digest), CI, update.

## The 5 variants (control placement and separator style)

| id | Control | Separator |
|----|---------|-----------|
| A | per-column header menu "Sort" | thin rule with label |
| B | one toolbar select applying to every column | rule with label |
| C | chips under each column header | band with count |
| D | editor only; board shows a read-only badge | rule with label |
| E | toolbar segmented control (Status / Priority / Assignee / Age) | band with count |
