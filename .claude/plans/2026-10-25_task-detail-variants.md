# Task detail page: 10 design variants in A/B mode

Status: design only, nothing implemented. Page: `/modules/task/tasks/p/:project/:id` (`packages/app-module-task/src/dsl-views/task-page.yaml`).
Evidence screenshots (agent-browser, read-only, not copied into the repo): `C:\Users\Wadeck\.agent-browser\tmp\screenshots\screenshot-1792919132667.png` (current page, 1440 px, full), `...-1792919142756.png` (dashboard), `...-1792919145068.png` (Tasks list).

## 1. Findings on the current page

- Seven stacked `Section`s, 14 form fields, ~2800 px tall at 1440 px. Every `DataTable` is shown even when empty ("No labels", "No metadata", "No links", "No children" take 130 px each).
- `task.description` is returned by `GET /tasks/:id` and shown NOWHERE. This is the largest gap against every reference app.
- Created/updated times, parent chain (ancestors), children progress and blockers are not shown. History is a separate page (status changes only: `{status, timestamp}`; there are no comments, no assignee, no priority, no due date in the model).
- Shell look: white page on light grey, 240 px left menu, purple accent, small grey headings, bordered tables, `PageContent` max width xl.

## 2. A/B mechanism: decision

**Works from YAML, no new component, no app-core change.** The `AbTest` node of dsl-ui (docs: `dsl-view/.claude/docs/dsl-renderer-consumer-reference.md`, section "A/B experiments in views"; source `dsl-view/packages/dsl-ui/src/components/dev/AbTest.tsx`).

```yaml
$type: AbTest
id: task-design            # letters, digits, _ -; names localStorage key `ab.task-design` and URL param `?ab.task-design=<variant>`
label: Task page           # row name in the dock
initial: current           # MUST be a key of variants; rendered whenever experiments are off
variants:
    current: { label: Current, hint: 'The page as shipped.', view: { $type: VerticalStack, items: [ ... ] } }
    github-a: { label: GitHub A, hint: '...', view: { ... } }
```

Evidence for each requirement of the standing rule:

| Requirement | Result | Evidence |
|---|---|---|
| Variant declared by a module view | Yes, `AbTest` node, usable "wherever a node is" (page root, inside a section) | `AbTest.tsx` doc comment; real example `agent-fleet/packages/app-module-flow/src/dsl-views/execution-logs-page.yaml` (`flow-logs-design`, uses `$sources` inside the variant views) |
| Floating switcher, bottom center | Yes, one shared dock `fixed bottom-6 left-1/2 z-[9999]`, one row per test, foldable to an `A/B (N)` pill | `AbDock.tsx` line 16; `app-core/CLAUDE.md` section "A/B testing UI variants"; `App.tsx` of frontend-shell mounts `<AbExperiments>` once |
| Persisted choice | Yes, `localStorage ab.<id>`, synced across tabs; `?ab.<id>=<variant>` forces it for one load; fold state in `ab.collapsed` | doc table "enabled true" |
| Dev-only gating | Yes, `enabled` defaults to `isDev()` = `process.env.NODE_ENV === 'development'` (Vite dev server). Otherwise every `AbTest` renders `initial`, never reads storage or URL, no dock | `isDev.ts`, `AbExperiments.tsx` |
| Options per variant | Yes, as NESTED `AbTest` nodes with their own id: "allowed, its row exists while its variant is shown". Each option = one more dock row with 2-3 choices | doc table "AbTest inside a variant"; precedent `LogStreamChoices.ts` (5 extra rows shown only while `stream` is chosen) |
| Installed shell (app-core-cli 2026.10.24-094, dsl-ui 175) | `AbTest` is present in its bundle (`dist/public/assets/index.js`: `AbExperiments`, `AbTest`, `A/B (`, `ab.collapsed`); production build => `isDev()` false => only `initial` renders, no dock | grep of the bundle |
| Dev shell on 5173 | app-core working tree, dsl-ui 2026.10.24-250 (`app-core/node_modules/@wadeck-app/dsl-ui`), Vite => dock visible | package.json of the dep, `app-core/CLAUDE.md` |

Consequences:

1. `initial: current` keeps the installed app and any production build on today's page. Shipping the experiment in the module is safe; the other variants ship inside the YAML (nothing confidential in them, per the docs).
2. The dock only exists on the Vite dev shell. The 4850 app-core serves the installed (production) shell: no dock there, by design.
3. For the dev shell to show the new variants on the REAL route, the module served behind it must be the new build. Two ways: (a) isolated: `app-core-cli dev <packaged module> --port <free>` + Vite dev with `APP_CORE_API=<that url>` (documented in `app-core/CLAUDE.md` and in task `CLAUDE.md` "Test against a real shell"), real data from a sandbox registry; (b) register the build into the app-core on 4850 (`task cli register`), which changes the user's live module. Recommendation: (a) for my verification, (b) only on the user's go.
4. The dock's size and position are dsl-ui's (`AbDock`), not configurable from a module. "LARGE" cannot be met from the module; see open question 4.
5. The manifest does not need `dslLib` for `AbTest`: the doc asks modules using it to declare a `dslLib.shared` range on dsl-ui, but `app-core-cli check` then demands `src/dsl-components/index.ts` (module-authoring.md, "Shipping components"). The installed 094 shell already has `AbTest` and the module already requires >= 063, so skip it. Risk accepted: an older shell shows "Unknown component type".
6. Not expressible from YAML (and not needed): a switcher built from `ButtonGroup`/`Tabs` fixed at the bottom. There is no `ButtonGroup`, no fixed/sticky positioning, no `className`/`style` (dsl-ui schemas), so the closest in-module fallback would be a custom dsl-components component, which is unnecessary since `AbTest` exists.

## 3. DSL building blocks (installed 175 vs dev 250)

From the inventory of dsl-ui sources and the installed bundle (tables in the sub-agent report; paths: `dsl-ui/src/schemas/generated-node-schemas.ts`, bundle `index.js`).

| Need | Available | Notes / limits |
|---|---|---|
| Page frame | `PageContent` (`maxWidth` sm..full), `PageHeader` (`title`, `icon`, `headerActions`; a header with actions drops `subtitle`), `Section`, `PageSection` (title + actions), `Card` (`header`, `footer`, `padding`, `border`) | 175 and 250 |
| Two columns | `HorizontalStack` with `itemSizes: [flex, fixed]` (`fixed` = 20 rem, `flex` = `flex-1 min-w-0`), `gap`, `align`, `justify` | The ONLY sidebar mechanism. No Grid/columns/span, no wrap, no breakpoint: on a narrow window it does not stack (the shell menu already breaks tables at 390 px, see CLAUDE.md) |
| Tabs | `Tabs` (`tabs[{key,label,children}]`), `PageTabs` (`urlParam` keeps the tab in the URL) | DSL nodes as tab `children`: 250 only (rendered from dsl-ui -227; 175 reads `tabs` as plain data, would crash). No `Accordion` node |
| Collapsing | `Collapsible` (`title`, `defaultOpen`, `items`) | 175 and 250. Whether its open state survives `reloadSources` is untested |
| Chips | `Badge` (`variant`, `tone: solid\|subtle`, `size`, `href`), `Tag` (`color` blue/green/red/yellow/purple, `onRemove` not wirable), `ChipButton` | `Badge href` makes a link chip (parent, project) |
| Properties | `FieldReadOnly` (`label`, `value`, `mono`, `copyable`) | No `PropertyList`/`DescriptionList`; the agent listed it as the closest, I did not confirm it is in the 175 registry (spike S3). Dynamic key/value lists need route-built nodes |
| Text | `Markdown` (`text`, `maxHeight`, `collapsed`; GFM tables and task lists; raw HTML shown as text; images off) | Shows the description. Lazy chunk |
| Time | `RelativeDate` (`date`, `live`, `tooltip`) | "3 days ago" with the exact time as tooltip |
| Progress | `Progress` (`value`, `max`, `variant`, `label`, `showValue`), `StatTile` | For the children progress bar |
| Overlays | `Popover` (`trigger[]`, `items[]`), `Dialog` (`trigger`, `open`, `items`, `actions`), `Drawer` (`open`, `side`) | Content is any DSL node. A `Form` inside them is untested (spike S4) |
| Lists | `DataTable` (`navigateTo`, `expansion`, `emptyMessage`, no row styling, always a header) | Only data-driven list. No repeat directive (`$each` does not exist) |
| Dynamic nodes | `ExtensionSlot items: $sources.x` renders an array of DSL node objects built by the route | Already used by the Tree page (`dslNodes.ts`). Works in 175. The route is the only "loop" |
| Timeline / activity feed, Avatar-as-user, StatusDot, ButtonGroup, Grid, Icon node, Dropdown with actions | Not found | `ContextMenu` items have no authorable handler. Compose with `HorizontalStack` + `Badge` |
| Mutation UI | `Form` + `$actions` + `onSubmit: $ctx.<action>` (175). `ButtonAction onClick: $ctx.<action>` sends NO body | A select cannot fire an action on change. 175: every change = field + Save button |
| One-click action with a body | `ActionButton action:, params:, body:` | 250 ONLY (since -240). Allows "Move to Done" buttons, built per status by the route |
| Expressions | `!`, `==`, `!=`, `&&`, `\|\|` in `$if` and bindings; `$vars` seeded from a source; `bind` outside a Form | 250 ONLY. 175: `$if` has no negation, use boolean flags from the route (as today) |
| Known limits kept | `FieldSelect` crashes before its options load (guard with `$if`), `[]` is truthy, selects that act on an existing item need a `placeholder`, sources need `inlineErrors=true`, no query may be empty (`projectQuery`), Form `initialData` does not clear after success (needs dsl >= 177) | task `CLAUDE.md` "View conventions" |

**Two feature tiers, stated per variant below:** `T175` = renders and works on the installed shell; `T250` = needs dsl >= 250 (only the dev shell today). Open question 1 decides whether T250 variants are allowed. `app-core-cli check` (dsl 175) will probably reject unknown node types such as `ActionButton` and children in `Tabs` at build time ("static checks: unknown `$type`" per the consumer reference); this is unverified (spike S6) and would make a T250 variant impossible to package with the installed CLI.

## 4. Data and mutations mapped to the reference UIs

Per task today (`GET /tasks/:id` + `/links` + `/tree?id=`): `title`, `description`, `status`, `type`, `labels`, `meta`, `parent` (null when dangling) + `canDetach`, `children`, `links` (stored + derived inverses: blockedBy/blocks, duplicates, causes ...), `createdAt`, `updatedAt`, `history` (status changes), `warnings`, `forms.*`, options, `taskHrefs`, project text.

| Datum / mutation (action) | GitHub | GitLab | Jira | Linear | Notion |
|---|---|---|---|---|---|
| title | H1 + `#id` | H1 + `#id` | H1 under breadcrumb | H1, identifier mono | Page title |
| description | Main comment body | Main description | Left "Description" | Under title | Page body |
| status (`setStatus`) | Open/Closed badge, "Close" button | Open/Closed badge | Workflow transition buttons | Status icon + popover | Select property |
| type (`setType`) | Issue type in sidebar | Type badge | Issue type icon in breadcrumb | n/a (label) | Select property |
| labels (`addLabel`/`removeLabel`) | Sidebar "Labels" colored chips | Sidebar "Labels" | "Labels" in Details | chips in property bar | Multi-select property |
| meta (`setMeta`) | "Projects"/custom fields | "Health/Weight"-like | "More fields" | custom properties | Extra properties |
| parent (`setParent`/`removeParent`) | "Parent" sub-issue link | Parent | Breadcrumb "Parent > Child" | Parent issue | Relation property |
| children | Sub-issues with progress | Child items | "Child issues" | Sub-issues | Sub-items (inline db) |
| links (`addLink`/`removeLink`) | "Linked" | Linked items | Linked issues grouped by relation | Relations | Relation properties |
| history | Timeline events | Activity | Activity "History" tab | Activity feed | (none) |
| delete | `Delete issue` (sidebar bottom) | `...` menu | `...` menu | `...` menu | `...` menu |

No equivalent exists in the data for: assignee/"People", priority, comments, reactions, attachments, dates other than created/updated, cycles/milestones. The variants omit them; none is faked (no empty "Assignee: Unassigned" rows). Metadata plays the role of custom fields.

## 5. Shared data contract and action handlers (one for all variants)

Rule: logic in `task-service`, view models in the module, YAML only binds. Variants never add a source or an action.

**Sources (unchanged): `projects`, `detail`.** `tree` and `links` stay as sources (hierarchy and link rows). `$actions`: the nine existing ones, unchanged, declared once at page level; each variant binds the same `$ctx.<action>`. Only `current` plus variants use `detail`.

**New fields of the `GET /tasks/:id` answer (built in `taskViews.ts` `taskDetailBody`, presentation only):**

| Field | Content | Used by |
|---|---|---|
| `createdText`, `updatedText` | `shortUtcTime` of the dates; `createdAt` / `updatedAt` raw for `RelativeDate` | all |
| `descriptionText` | description or null; `hasDescription` flag (no negation in 175) plus `noDescription` | all |
| `statusTone` | `Badge` variant from config: terminal -> `success`, default -> `info`, other -> `warning`; `isTerminal` | github, gitlab, linear |
| `statusButtons` | route-built nodes, one per status other than the current (`ActionButton` body `{status}` on T250; `Badge`-less fallback absent on T175, the Form stays) | jira-b |
| `ancestorNodes` | route-built `Badge href` chips of the ancestors, root first (from `listAncestors`, same service function as `GET /tasks/:id/ancestors`) | jira, linear, github |
| `labelNodes` | route-built `Tag` nodes, color from a stable hash of the label | all with chips |
| `metaNodes` | route-built `FieldReadOnly` nodes (key, value), empty list when none | notion, jira, gitlab |
| `activityNodes` | route-built vertical feed: "Created <time>" then one line per history entry "moved from X to Y <time>" (derived from consecutive `history` entries) | github, gitlab, jira, linear |
| `childrenSummary` | `{ total, done, open, value, max, text }` ("2 of 5 done") | github-b, gitlab, linear |
| `blockedText` | "Blocked by N open task(s)" from `links.blockedBy` whose status is not terminal, null otherwise | jira, linear |
| `taskHrefs.deleteTasks` | `pageHrefs(project).deleteTasks` | all (danger `ButtonLink`) |
| `showEmpty*` flags | `hasLabels`, `hasMeta`, `hasChildren`, `hasLinks`, `hasAncestors` (booleans; empty sections are not rendered) | all |

`task-service` addition (shared with the CLI, tested there): `summarizeChildren(ctx, {id})` -> `{ total, terminal, open }` using `ctx.config.terminalStatuses` (same terminal rule as `countTasksByStatus` / `setStatus`). `task show` could print the same line: suggested, not part of this work. The blocker count reuses `getTaskLinks` plus the terminal rule; if the CLI should say "blocked by", it goes in `task-service` too (`describeBlockers`), otherwise it stays a view-model derivation. Recommendation: put both in `task-service`, one small file `taskProgress.ts`, so the CLI and the module never disagree on "done".

Error and notice blocks stay OUTSIDE the `AbTest` (shared header block of today: no projects, selected problem, unknown project, `detail.errorText`, `detail.warningText`), so the unmigrated/virtual/dangling/unknown-project cases hold in every variant by construction. Mutation feedback (error + `undeliveredText` per `resultKey`: `statusResult`, `typeResult`, `labelResult`, `metaResult`, `parentResult`, `linkResult`) is rendered by each variant next to its controls, or by one grouped block at the top of the variant for the compact ones (no scroll, so one block is enough).

## 6. The experiment layout

One top-level `AbTest` `task-design` (variants: `current`, `github-a`, `github-b`, `gitlab-a`, `gitlab-b`, `jira-a`, `jira-b`, `linear-a`, `linear-b`, `notion-a`, `notion-b`). Each variant view contains at most 3 nested `AbTest` options (ids `<variant>-<option>`, 2-3 choices), shown in the dock only while the variant is chosen. An option wraps ONLY the sub-tree it changes (a section, or the sidebar position), so options never multiply into combinations of full pages.

Honest limits of options:

- Density as a global switch is not expressible (no CSS, no `className`; `gap` is per stack). "Compact" is expressed as a different sub-tree (property list inline vs stacked, sections collapsed vs open), not as spacing.
- Each option choice is a full copy of its sub-tree in the YAML. Shared pieces (forms, feedback blocks) need YAML anchors/aliases or a generator; whether the compiler accepts anchors is untested (spike S5).

Sidebar sketch used below: `[main | side]` = `HorizontalStack itemSizes: [flex, fixed]`.

### github-a "Issue + metadata sidebar" (T175)

Concept: title with `#id` and a status badge, then the description as the main body and a right sidebar with Status, Type, Labels, Parent, Metadata, Delete. Activity (status history) sits under the description like a timeline.

```
 create a simple todo app...  #hp7vmruo
 [Done] test-flow created 3 weeks ago                   [History]
 +-----------------------------------+ +---------------------+
 | Description (Markdown)            | | Status    [form]    |
 +-----------------------------------+ | Type      [form]    |
 | o Created ...                     | | Labels    chips +   |
 | o Moved todo -> done ...          | | Parent    chip      |
 |                                   | | Metadata  rows      |
 +-----------------------------------+ | Delete task         |
                                       +---------------------+
```
Components: `HorizontalStack`, `Card`, `Markdown`, `Badge`, `Tag` (route nodes), `ExtensionSlot` (activity), `Form`, `Collapsible`, `RelativeDate`.
Options: `sidebar` (right / left / below main); `forms` (open / inside a closed "Edit" `Collapsible` per section); `activity` (timeline / hidden).
Faithful: sidebar structure, label chips, description-first. Impossible: assignee/projects pickers, comment box, reactions, sticky header, real colored label pills with edit-in-place (Tag `onRemove` not wirable: removal stays a select + button).

### github-b "Issue with sub-issues progress" (T175)

Concept: GitHub's sub-issues layout: a progress bar under the title and a "Sub-issues" list right under the description, with relations in a compact sidebar. Parent shown as a chip line above the title.
```
 parent > grandparent chip row
 Title  #id  [Done]
 [=====-----] 2 of 5 done
 Description
 Sub-issues  (table: id, title, status)
 Linked      (table)                       | sidebar: Status, Type, Labels
```
Components: `Progress`, `DataTable` (children, links), `Badge href` (ancestors), as above.
Options: `progress` (bar / text only / hidden); `lists` (sub-issues and links as tables / inside `Collapsible`); `sidebar` (right / hidden: edit forms move under the description).
Faithful: progress summary, sub-issue list. Impossible: drag-reorder, inline "create sub-issue" (create page is separate: a `ButtonLink` to New task with the parent is possible only if that page accepts a parent in the URL; today it does via `?parent`/project param, to verify).

### gitlab-a "Work item with collapsible sidebar" (T175)

Concept: GitLab work item: status badge ("Open"/"Closed") with created/updated text, description, then child items and linked items; the right sidebar is a list of collapsible sections whose titles carry counts ("Labels 2", "Linked 1").
```
 [Open] created 3 weeks ago, updated 2 days ago
 Title
 Description                       | v Status   [form]
 Child items (n)  table            | > Type
 Linked items (n) table            | v Labels (2)  chips + add/remove
 Activity                          | > Metadata (3)
                                   | > Parent
```
Components: `Collapsible` with a bound `title`, `DataTable`, `Tag`, `Badge`, `RelativeDate`.
Options: `sections` (all open / all closed except Status); `sidebar` (right / left); `tables` (shown / only when non-empty, via `has*` flags).
Faithful: collapsible sidebar with counts, linked items grouping. Impossible: the "Edit" link toggling edit mode inline (every Collapsible holds a permanent form), to-do, time tracking, confidential toggle.
Unverified: a bound `Collapsible.title` (spike S3).

### gitlab-b "Work item with tabs" (T250)

Concept: same sidebar, but the lower part of the main column is `PageTabs` "Child items | Linked items | Activity" instead of a stack; tab kept in the URL (`urlParam`).
Components: `PageTabs` (children = DSL nodes: 250 only), as gitlab-a.
Options: `tabs` (tabs / stacked, so the comparison is built in); `default-tab` (children / links / activity); `sidebar` (right / left).
Faithful: tabbed related items. Impossible on 175 (tabs with children crash). On 175 the variant is not offered; only the stacked option would remain, which equals gitlab-a.

### jira-a "Breadcrumb + Details panel" (T175)

Concept: Jira issue view: ancestors as a breadcrumb above the title, left column Description, Child issues, Linked issues, Activity; right "Details" panel with Status, Type, Labels, Parent and a "More fields" group (metadata), then a "Dates" group.
```
 Parent-chip > Grandparent-chip
 Title                                     [History] [Delete]
 Description                      | Details
 Child issues                     |  Status [form]  Type [form]
 Linked issues (grouped by rel.)  |  Labels  chips + forms
 Activity                         | > More fields (meta)
                                  | Created / Updated (RelativeDate)
```
Components: `Badge href` row, `Card` "Details" with `FieldReadOnly` rows and forms, `DataTable`, `Collapsible`.
Options: `ancestors` (breadcrumb row / hidden); `details` (groups open / collapsed); `activity` (list / hidden).
Faithful: layout, "Details" panel, breadcrumb parentage, grouped links. Impossible: `Breadcrumb` node takes a path string only (use route chips), "People" group (no assignee/reporter), inline-edit-on-click fields, `Create child issue` modal.

### jira-b "Workflow transition bar" (T250 for the real thing, T175 fallback)

Concept: the Jira header toolbar: one button per reachable status ("To Do", "In Progress", "Done"), the current one highlighted, so a status change is ONE click instead of select + Save. Rest as jira-a but a single column below the toolbar with a narrow Details side.
```
 Title
 [ todo ] [ in-progress ] [ DONE ]   [Blocked by 1 open task]
 Description ...                    | Details (read only + forms)
```
Components: route-built `ActionButton` nodes (`action: setStatus`, `body: {status}`) in `HorizontalStack`, `Badge` for `blockedText`.
Options: `transitions` (all statuses / only non-current / only the default next status); `bar` (top / next to the Details); `details` (open / collapsed).
Faithful: the transition bar. Impossible: workflow rules per transition (the model has none: any status to any status), transition screens. On 175 `ActionButton` does not exist: the fallback would be the select + Save form, i.e. the same as the others, so the variant only shows its value on the dev shell.
Needs `ActionButton` with `reloadSources` and `resultKey` on the same `setStatus` action (docs: "A button outside a table row"); spike S2.

### linear-a "Property bar, no sidebar" (T175, depends on S4)

Concept: Linear: big title, then a single row of property chips (Status, Type, Labels, Parent, Project) where each chip is a `Popover` holding the one-field form; description full width below; sub-issues and activity beneath. The page fits one screen for a typical task.
```
 Title                                              [...]
 [o Done v] [feature v] [label v] [^ parent] [+ link]
 Description (full width)
 Sub-issues  2/5   (rows)
 Activity (collapsed)
```
Components: `Popover` (trigger = `Badge`/`ChipButton`, items = `Form`), `Markdown`, `DataTable`, `Collapsible`.
Options: `chips` (popover forms / forms in one `Collapsible` "Edit properties"); `subissues` (table / hidden); `activity` (collapsed / open / hidden).
Faithful: compact property row, no sidebar. Impossible: keyboard shortcuts, command palette, inline title edit, pickers with search/emoji, instant change on select (still a Save button in each popover). If a `Form` in a `Popover` does not behave (spike S4) the popovers become `Collapsible` forms and the variant loses its point; stated as the main risk of this variant.

### linear-b "Properties rail on the left" (T175)

Concept: identifier (mono, copyable) and title on top, properties as a narrow rail on the LEFT (fixed 20 rem), content (description, sub-issues with progress, relations, activity) to the right; blocker warning chip near the title.
Components: `HorizontalStack itemSizes: [fixed, flex]`, `FieldReadOnly copyable mono`, `Progress`, `Badge`.
Options: `rail` (left / right); `relations` (inline under sub-issues / in the rail); `activity` (inline / hidden).
Faithful: identifier + properties rail, blocked chip. Impossible: issue peek/overlay, cycles/estimates, the status icon set (a colored `Badge` replaces it).
Honesty note: structurally close to github-a (rail vs sidebar); kept because the option `rail: left` makes the comparison cheap. Candidate to merge or drop (question 5 if the user wants fewer).

### notion-a "Page with a property table" (T175)

Concept: Notion database item: title, a bordered property table (Status, Type, Labels, Parent, Project, Created, Updated, then each metadata key as a property), a divider, then the page body (description), then sub-items as an inline table and relations (links).
```
 Title
 +--------------------------------------------+
 | Status    Done        | Created  3 weeks ago|
 | Type      feature     | Updated  2 days ago |
 | Labels    a  b        | Parent   chip       |
 | + N more properties (Collapsible)           |
 +--------------------------------------------+
 ----------------------------------------------
 Description (Markdown)
 Sub-items (table)    Relations (table)
```
Components: `Card`, two `VerticalStack`s of `FieldReadOnly` in a `HorizontalStack`, `Collapsible`, `Markdown`, `DataTable`, route nodes for metadata.
Options: `properties` (all shown / collapsed to "N properties" toggle); `order` (properties first / body first); `subitems` (table / hidden).
Faithful: property table on top, body below, "N more properties" fold. Impossible: click-to-edit cells (each property edited in a `Collapsible` form under the table), block editor, slash menu, comments.

### notion-b "Peek with only non-empty properties" (T175, drawer option unverified)

Concept: Notion's "hide empty properties" and "side peek": only properties that have a value are listed; empty ones are reachable through "Add a property" (the forms). Optionally the whole page body opens in a right `Drawer`.
Components: `has*` flags from the route, `Drawer` (open by default), `FieldReadOnly`, `Tag`.
Options: `empty` (hide / show empty properties); `peek` (page / drawer); `layout` (single column / properties as two columns).
Faithful: empty-property hiding, peek feel. Impossible: Drawer open by default needs `open: true` plus a way to close and still keep the breadcrumb sane (spike S4); no "peek from list" (the list page is another view). If the drawer is not workable the option is dropped and notion-b keeps two options.

## 7. Feasibility verdicts

| Variant | Verdict |
|---|---|
| github-a | Feasible on 175 |
| github-b | Feasible on 175 |
| gitlab-a | Feasible on 175 (bound `Collapsible.title` to verify, fallback: static titles without counts) |
| gitlab-b | 250 only (tabs with children); not packageable with the installed CLI if `check` rejects it |
| jira-a | Feasible on 175 |
| jira-b | Full value on 250 only (`ActionButton`); on 175 degrades to a form |
| linear-a | Feasible on 175 if a Form works inside a Popover (S4); risky |
| linear-b | Feasible on 175 (close to github-a) |
| notion-a | Feasible on 175 |
| notion-b | Feasible on 175; `peek: drawer` option unverified |

## 8. Test strategy

All in `app-module-task` (yaml structure tests, same style as `manifest.test.ts`), plus route tests. No browser in unit tests.

1. Parametrized over `Object.keys(designTest.variants)` (found by walking the parsed `task-page.yaml` for `AbTest id: task-design`) and, for each variant, over the cartesian product of its nested option choices (at most 3 options x 3 choices = 27 combos): collect the node tree of that combination.
   - Every `$actions` name appears as an `onSubmit`/`onClick`/`action` reference in every combination (setStatus, setType, addLabel, removeLabel, setMeta, setParent, removeParent, addLink, removeLink). An option that hides a form must be a choice whose variant is declared "view only" in a test table (explicit allowlist, justified), never a silent loss.
   - Every `resultKey` has an `errorText` badge and an `undeliveredText` badge in the combination (extends the current `manifest.test.ts` rule, which checks one file).
   - The shared notice badges (`noProjects`, `selectedProblem`, `unknownProjectText`, `detail.errorText`, `detail.warningText`) are children of the page root, NOT inside any `AbTest`.
   - `initial` is `current`, a key of `variants`; nested ids are unique and prefixed with the variant; every variant and option has `label` and `hint`; hints non-empty.
   - Conventions already tested keep holding on every combination: `FieldSelect` behind `$if`, selects that remove an item have a `placeholder`, tables with short codes have `nowrap`, title columns truncate, no back link, sources through `projectQuery`.
   - T175 variants contain no T250-only node (`ActionButton`, `Tabs`/`PageTabs` with `children`, `!` expressions, `bind` outside a Form): a denylist test, so the installed shell is never given a node it crashes on in a variant tagged `T175`.
2. Route tests (`backend.test.ts` style, fixtures from `createTestWorld`): the new fields for a plain task, a task with children and mixed terminal/open statuses (`childrenSummary`), a blocked task, a root task, a dangling parent (`parent: null`, `canDetach`, no `ancestorNodes`, the warning kept), an unmigrated project (notice path unchanged), a virtual project (409 as today), an unknown project (blank answer), empty labels/meta/links (`has*` false).
3. `task-service`: tests for `summarizeChildren` / `describeBlockers` (terminal rule, no children, all closed).
4. Real-shell check (manual, with agent-browser, on the real route in the dev shell): for each of the 10 variants and each option choice, screenshot, `errors`/`console`, the five fixtures (plain, unmigrated, virtual, dangling parent, unknown project, plus a task with children and links). Also one mutation per action on the sandbox data to see feedback and the `undeliveredText` badge (QUEUE_SDK_OFF=1 leaves events undelivered).

## 9. Implementation plan (ordered)

0. Spikes in a scratch folder outside the repo, packaged module + isolated shell (no repo file changed):
   - S1 `$actions` forms and `$sources` inside an `AbTest` variant view and inside a nested one (the `renderNode` ctx is merged by the caller, to confirm with a real submit).
   - S2 `ActionButton` with `body` + `resultKey` + `reloadSources` on 250; behavior of the same YAML on the installed 175 (error box? does `check` pass?).
   - S3 `FieldReadOnly` in 175, bound `Collapsible.title`, `Collapsible` state after `reloadSources`, `Markdown` of a long description.
   - S4 `Form` inside `Popover`, `Dialog`, `Drawer open: true`: submit, close, reload.
   - S5 YAML anchors/aliases through the compiler (`app-core-cli check` and `package`).
   - S6 `app-core-cli check` on a 250-only node.
   Output: the verdict table of section 7 corrected. Stop and report if S1 fails: the whole approach changes (then variants become separate pages is NOT acceptable per the rule; the fallback would be a dsl-components wrapper, which needs a cost estimate first).
1. `task-service`: `taskProgress.ts` (`summarizeChildren`, `describeBlockers`) + tests + index export. Touches `packages/task-service/src/`.
2. Module view models: `taskViews.ts` (new fields), new `taskPageNodes.ts` (`activityNodes`, `labelNodes`, `metaNodes`, `ancestorNodes`, `statusButtons`; uses `dslNodes.ts` `literal`), `hrefs.ts` (nothing new expected), tests next to them.
3. Route: `routes/taskReadRoutes.ts` `GET /tasks/:id` calls `listAncestors`, `summarizeChildren`, `describeBlockers` and passes them to `taskDetailBody`. Same `inlineErrors` behavior. No new route, no new source.
4. YAML: `dsl-views/task-page.yaml`: keep the header block and `$actions`, wrap the body in `AbTest task-design` with `current` (today's sections moved unchanged) first, then add the variants one by one in the order github-a, jira-a, notion-a, gitlab-a, linear-b, github-b, linear-a, notion-b, jira-b, gitlab-b (T175 first, risky last). One variant per commit; after each, run the structure tests and a browser check.
5. Tests of section 8 (grow with step 4). `manifest.test.ts`'s task-page rules are rewritten to iterate over variants.
6. Sandbox and browser: package (`app-core-cli package packages/app-module-task --out <tmp> --version 0.0.0-ui`), `app-core-cli dev <tmp> --port <free> --no-tray` with sandbox registry and `QUEUE_SDK_OFF=1`, Vite dev shell (`npm run dev` in app-core `packages/frontend-shell`, `APP_CORE_API=<url>`), agent-browser pass over every variant/option with console check; then, only on the user's go, register the build to the 4850 app-core (`task cli register`) so the user finds the dock on the real page.
7. After the user picks: bake the winner (delete `AbTest`, losing variants, unused view-model fields and nodes helpers, tests of the losers); update `CLAUDE.md` (page description, new fields, 175/250 notes).

Side effects to consider when this lands: the same description/progress/ancestors presentation fits the tasks list, the history page (shows `task.title` only) and the tree page; the CLI `task show` could print the children progress and blockers from the same `task-service` functions; `new-task-page` could accept `parent` from a "Create sub-task" link on the detail page (check first that it does).

## 10. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Forms/actions do not work inside `AbTest` variants (S1) | Approach invalid | Spike first; no YAML before |
| Variants ship in the production bundle (non-initial variants "ship in the view") | ~10x YAML size in the module (est. 2500-4000 lines), no leak but heavier compile | Temporary; bake step 7; keep fragments minimal with anchors if S5 passes |
| T250 nodes crash or break `check` on the installed CLI | Cannot package or breaks installed shell if a non-initial variant is ever picked (it cannot be: no dock, `initial` only) | Denylist test; S6; keep T250 variants in a separate commit |
| No responsive layout (`HorizontalStack` never stacks) | Sidebar variants poor under ~900 px; the shell menu already clips tables at 390 px | State it in the dock hints; do not promise mobile; ask app-core for a stacking layout |
| "Large" dock | Not configurable | question 4 |
| Form fields do not clear after success (dsl < 177) | Add-label/meta forms keep their text in every variant | Known from `CLAUDE.md`; unchanged |
| Option explosion | Hard to test and review | Max 3 options, each wrapping one sub-tree; tests enumerate combos |
| Per-label Tag removal not wirable | Labels edited through select + button, less slick than references | Say so in the hint of the variants |
| Virtual/unreadable project: `forms` null | Variants render controls that do nothing | Controls stay behind `$if forms` as today; covered by tests |

## 11. Open questions (owner)

1. Allow T250 variants (gitlab-b, jira-b full)? Recommendation: yes, in a separate commit, dev shell only, after spike S6 shows whether the installed CLI can still package the module.
2. Variants in one YAML file (temporary, anchors if S5 passes) or fragments plus a generator script? Recommendation: one file; the experiment is temporary and step 7 deletes most of it.
3. Verify in an isolated app-core plus Vite dev (free ports), and register into the live 4850 app-core only on your go? Recommendation: yes.
4. The dock is dsl-ui's `AbDock` (fixed bottom center, size not configurable by a module): accept it, or ask the dsl owner for a larger style? Recommendation: accept, judge it in the browser first.
5. Keep all 10 variants? linear-b is structurally close to github-a. Recommendation: keep, cheap to build once the shared contract exists.

## 12. Phase A spike results (2026-10-25)

Setup: isolated app-core (`app-core-cli dev`, ports 4961-4963) with a temp registry, plus a Vite dev shell of the app-core working tree (dsl-ui 250, port 5183, Vite cache kept outside app-core). Scripts and fixtures: `tmp/ab/` (git-ignored: `seed.mjs`, `serve.mjs`, `vite.mjs`). Installed shell = app-core-cli 094 (dsl-ui 175), checked in a browser.

| Spike | Result | Evidence |
|---|---|---|
| i. Form / `$actions` / `resultKey` / `undeliveredText` inside an `AbTest` variant (and a nested one) | WORKS on 175 | Real status change saved on disk, form reloaded, undelivered badge shown |
| ii. Form in `Popover` | WORKS (175), submit persisted, popover stays open | |
| ii. Form in `Dialog` | Opens and renders the form (175); submit not exercised | |
| ii. `Drawer` | Form submits, BUT a literal `open: true` cannot be closed (close button does nothing). Unusable as "open by default" on 175 | notion-b `peek: drawer` dropped unless a bound `open` is found |
| iii. `FieldReadOnly` (label, mono, copyable) | WORKS on 175 | screenshot |
| iii. `Collapsible` with bound `title`, `Markdown`, GFM table | WORK on 175 | |
| iv. YAML anchors/aliases | WORK: compiler expands them (4 `Form` copies in the packaged JSON); `check` and `package` pass | |
| v. `app-core-cli check`/`package` 094 on 250-only nodes (`ActionButton`, `PageTabs` with children, `!` expression) | ACCEPTED, and even an unknown `$type` passes: `check` validates the layout and the manifest, never node types | no safety net: only the denylist test protects the 175 shell |
| v'. Same YAML on the 175 shell with the 250-only nodes in NON-initial variants | Page renders `initial` only, no error | |
| vi. `Collapsible` state | Survives `reloadSources` (stays open after a mutation); resets to its default on F5 | |
| vii. Dock (250) | Bottom center, label in small caps, one row per test; nested option row appears above while its variant is chosen; variant buttons truncate long labels; fold button; `localStorage ab.task-design` persisted and kept after reload; hints are tooltips only | screenshots in `tmp/ab/dock*.png` |
| 250 `ActionButton` | Renders (full width in a vertical stack), `PageTabs` children render | |

Not possible from YAML alone (confirmed): close a literal `open` Drawer, bigger dock, two-column responsive layout, sticky positions.

### Direction change: module-owned components (`task:<Name>`)

Mechanism exists in the installed shell 094 (`dslLib`, shared singletons react 19.3, dsl-ui/renderer 175, `__APP_CORE_SHARED__`; precedent: orchestrator `dsl-lib-orch`). NOT started: `task/node_modules` holds none of `react`, `react-dom`, `@types/react`, `@testing-library/*`, `jsdom`, `@vitejs/plugin-react`, `tailwindcss`, `postcss`, `@wadeck-app/dsl-ui`, `@wadeck-app/dsl-renderer` (only `esbuild`, `vite`, `vitest`, `tsx` are there). Installing them is a decision for the owner (new dependencies, GitHub Packages auth for the `@wadeck-app` scope).
