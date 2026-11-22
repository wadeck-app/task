import { VERSION } from '../version.js';

/** `task --help`. */
export function taskHelp(): string {
	return `task ${VERSION} - task tracker CLI

Concepts:
  task        A work item with id, title, status, type, labels, and metadata; its description is stored only when it differs from the title
              (a text longer than 90 characters given to 'task new' becomes a headline as title plus the full text as description)
  parent      Optional parentId on a task; hierarchy depth is unlimited (delete a parent: children become roots, or --cascade-delete)
  link        Typed, directional, acyclic relation between two tasks: blockedBy, duplicateOf, causedBy (inverses blocks, duplicates, causes are derived)
  project     A project of the shared project registry (managed by the 'project' CLI): id (8 hex), name, aliases, paths. Selected with -p, TASK_PROJECT or the cwd.
              Its tasks live in the registry (<registry>/projects/<id>/task/data), not in the project folder; a project may have no folder (virtual)
  config      Project config: <registry>/projects/<id>/task/config/config.yml, merged along the parent chain of the project (statuses, types, fields,
              strategy: the project's own; defaults: inherited). Defines valid statuses (default: backlog, in-progress, done). An unknown key is an error naming the file
              ('hooks' too: task runs no commands from the config, react to task events with queue subscribers: <project>/.queue/subscribers.yml).
              The global config (~/.task/config.yml: defaults) stays task's own file
  strategy    Where the tasks of a project are stored: the 'strategy' section of the project config ({type, fidelity, options}). Without it the project uses
              the local files of the registry (type: local), silently. type: github keeps the tasks as the issues of a GitHub repository, read and written through
              the official REST API; type: gitlab keeps them as the issues of a GitLab project (REST API v4, Free tier; verified live on gitlab.com Free only); type: remote keeps
              them on another computer, behind a 'task serve' there. See: task strategy --help, task serve --help
  id          Short prefix of the task UUID - any unambiguous prefix is accepted

Usage:
  task new <text> [--description <text> | --description-file <path|->] [--parent <id>]
                                             Create a new task (optionally under a parent); prints full task JSON. <text> is the title;
                                             over 90 characters (and without a description) it is cut to a headline (first line, else first
                                             sentence, else a word boundary + "...") and the full text becomes the description.
                                             --description-file reads the body from a file, or from standard input with -
  task set-title <id> <text>                 Change the title (the index and 'task list' follow)
  task set-description <id> <text>           Change the description; an empty text clears it (the body is the title again)
  task comment <id> <text...> [--file <path|->] [--author <name>] [--attach <file>[#alt]]... [--json]
                                             Add a comment (plain text, 1 to 10000 characters; words are joined with a space, -- before a text
                                             starting with --; --file reads it from a file or from standard input with -). No author unless
                                             --author is given. Prints the new comment id.
                                             --attach (repeatable, github strategy only): GitHub stores the image itself, nothing is committed.
                                             png, jpg, jpeg, gif or webp, at most 10 MB each and 10 per comment; uploaded BEFORE the comment, so
                                             a refused upload posts nothing. #alt = alternative text (the file name by default). An image the text
                                             does not reference is added after it as ![alt](url); ![alt](./file.png) in the text is replaced by
                                             the url. The text may be left out with an image. --json adds attachments: [{name, alt, url}]
  task comments <id> [--json]                List the comments of a task, oldest first (id, UTC minute, author, "(edited)", the text indented);
                                             --json: [{id, at, text, author?, editedAt?}]
  task comment-edit <id> <comment-id> <text...> [--file <path|->]
                                             Replace the text of a comment (an identical text changes nothing); ids: task comments <id>
  task comment-rm <id> <comment-id>          Remove a comment
  task set-priority <id> <priority>          Set the priority; it must be one of the project's priorities (config 'priorities', highest first; default
                                             urgent, high, medium, low). Prints the task
  task unset-priority <id>                   Remove the priority (the project default applies again)
  task set-assignee <id> <name...>           Give the task to a name by hand (free text, at most 100 characters; words are joined with a space, --
                                             before a name starting with --). Drops the lease of a previous claim
  task unset-assignee <id>                   Remove the assignee and its lease
  task claim <id> --as <name> [--lease <n>m|<n>h|<n>d] [--renew] [--force] [--json]
                                             Take a task under a lease (atomic on the local strategy). --as can be left out when the TASK_WORKER
                                             environment variable holds the worker name (blank = unset). --lease: a whole number and m, h or d
                                             (30m, 2h, 1d; seconds are refused); default defaults.leaseMinutes of the config (30). Free task or
                                             expired lease: claimed (an expired lease of someone else is a takeover). Live lease of another name:
                                             conflict naming the holder and the time left, unless --force. The same name needs --renew to extend its
                                             lease. Text: "claimed|renewed <id> as <name> until <iso> (30m)" or "took over <id> from <name> as <name> ...";
                                             --json: {taskId, outcome (claimed|renewed|takeover), assignee, claimedAt, leaseUntil, previousAssignee?,
                                             revision, task}. github, gitlab and remote projects refuse it, saying what to use
  task release <id> [--as <name>] [--force] [--json]
                                             Give a claimed task up (assignee, claimedAt and leaseUntil are cleared). With --as, another holder needs
                                             --force; TASK_WORKER is not read here. Text: "released <id> (was held by <name>)";
                                             --json: {taskId, previousAssignee, task}
  task next --as <name> [--status a,b] [--priority a,b] [--order <name>] [--lease <n>m|<n>h|<n>d] [--include-blocked] [--fresh] [--json]
                                             Claim the first available task (held by nobody or lease over) in order: default statuses = every
                                             non-terminal status, default order priority-then-oldest, TASK_WORKER stands in for --as. When another
                                             worker takes the candidate first it tries the next one (10 attempts at most, then an error naming the
                                             count). A task with an open blockedBy link is skipped (not an attempt) unless --include-blocked. Same output as claim (--json adds
                                             skippedBlocked); nothing available: exit 0 and "no available task", or "no available task: N candidate(s) were claimed
                                             by other workers meanwhile, retry" after lost races (--json: {"task": null, "lost": N, "skippedBlocked": M})
  task find <query> [--limit N] [--json]     Find tasks by id prefix or title text, best match first (id prefix, title word prefix, substring);
                                             N from 1 to 20 (default 8); text lines "id  headline  [status]", --json: [{id, headline, status}]
  task labels [--json]                       Labels in use with the number of tasks carrying each, most used first
  task labels sync [--dry-run] [--json]      github or gitlab strategy: create the status and type labels the config uses in the repository (colour
                                             and description included); never deletes or changes a label. --dry-run lists what it would create
  task list [--json] [--all] [--follow|-f]   List tasks as JSON array (hides terminal statuses unless --all)
  task list --parent <id>                    List only the direct children of a task
  task list [--status a,b] [--assignee <name> | --unassigned | --available] [--priority a,b] [--order <name>] [--limit <n>] [--fresh]
                                             A dispatcher's list in one call (JSON array; works with --parent and --all, not with --tree, --follow or
                                             --all-projects). --status: only these statuses (replaces the hiding of terminal ones); --assignee: held by
                                             that name; --unassigned: held by nobody; --available: held by nobody or lease over (these three exclude
                                             each other); --priority: only these priorities (a task without one has the project default); --order:
                                             an ordering plugin, priority-then-oldest = highest priority first, then oldest, then id (without --order the
                                             order of the storage is kept); --limit: the first n (1 to 1000) AFTER filter and order; --fresh: github and
                                             gitlab read from the server, not from the cache (no effect on local and remote). With any of the filters,
                                             --order or --limit each row also has priority (the effective one, never absent) and, when a lease is set,
                                             leaseUntil and leaseExpired (a stored leaseUntil that is not a date gives leaseProblem instead and a warning on stderr; the task is never available), next to id, title, status, createdAt, assignee, links, parentId
  task list --tree                           List tasks as a nested forest (kept: matching tasks + the ancestors leading to them)
  task list --all-projects [--all] [--json]  List the tasks of every registered project (Project column; text table, --json: tasks tagged with their project);
                                             needs no project; unreadable projects on stderr; exit 1 only if none can be read;
                                             cannot be combined with --follow, --tree, --parent, -p or TASK_PROJECT
                                             (a single project contradicts all of them)
  task show <id> [--json] [--with-parent] [--with-children]   Show task detail (always incl. parentId, childrenIds); flags add parent/children summaries
  task history <id> [--json] [--follow|-f]   Show status-change history for a task
  task history <id> [--all] [--json]         Show the whole activity of a task, newest first (status changes, type, labels, metadata, parent, links, title and
                                             description edits); text lines, or --json rows {at, kind, icon, tone, text, details?}. Tasks changed before the
                                             log existed show their status changes only. Cannot be combined with --follow
  task set-status <id> <status>              Update task status (valid values: task status list)
  task status list [--json]                  List the valid statuses of the project in order, marking the default (initial status of a new task) and the terminal ones
  task set-type <id> <type>                  Update task type (validated if types configured)
  task unset-type <id>                       Clear the task type
  task type list                             List valid types for this project
  task type add <name>                       Add a valid type
  task type remove <name>                    Remove a valid type
  task set-parent <id> <parent-id>           Attach a task under a parent (cycles are rejected)
  task remove-parent <id>                    Detach a task from its parent (it becomes a root task)
  task children <id> [--recursive]           List direct children (--recursive: nested subtree, any depth)
  task link <id> <type> <target-id>          Link a task to another (blockedBy, duplicateOf, causedBy; inverse names blocks, duplicates, causes also accepted)
  task unlink <id> <type> <target-id>        Remove a link
  task links <id>                            Show a task's links and their derived inverses
  task parents <id>                          List all ancestors, from the direct parent up to the root
  task tree <id>                             Complete tree containing the task (from its topmost ancestor); the task is flagged "selected"
  task add-label <id> <label>               Add a label to a task
  task remove-label <id> <label>            Remove a label from a task
  task set-meta <id> <key> <value>          Set a metadata key/value on a task
  task unset-meta <id> <key>                 Remove a metadata key (an absent key changes nothing)
  task delete <id>[,<id2>,...]              Delete task(s) by ID (comma-separated)
  task delete --all                          Delete all tasks
  task delete --filter <field>=<value>       Delete tasks matching a filter (fields: id, title, status, parentId; glob * allowed)
  task delete --dry-run ...                  Show what would be deleted without deleting
  task delete ... --cascade-delete           Also delete all descendants of the matched tasks (default: children become root tasks)
  task strategy show [--json]                Strategy of the project (type, fidelity, fills, tokens, capabilities native/emulated/unsupported); opens nothing
  task strategy check [--json]               Validate the strategy: config, tokens, backend; exit 1 with the fix of each problem
  task serve [--port N] [--host H] [--allow-lan] [--token-env NAME | --token-file PATH] [--json]
                                             Serve this project's tasks to other computers (HTTP/JSON, protocol 2, bearer token, single writer), in the
                                             foreground until Ctrl+C. Loopback only unless --allow-lan. Another computer reaches it with strategy type remote.
                                             See: task serve --help
  task cli self-check                        Validate installation
  task cli update [--check] [--log]         Update to latest version
  task cli logs [--follow]                   Print today's invocation log
  task cli register [--json]                 Tell app-core where the task app-module is (also done by task cli update)
  task cli unregister [--json]               Remove the task app-module from app-core
  task cli declare-events [--json]           Tell the queue which events task pushes, now (normally automatic, see Events below)
  task projects summary [--json]             Open/total tasks per registered project and in total (unreadable projects listed with their reason)
  task migrate --from <project> --to <project> [--dry-run] [--allow-loss <kinds>] [--resume] [--history-comment] [--emit-events] [--json]
                                             Copy every task of one registered project into another, between any two storages (local files, github):
                                             plan and loss table first (--dry-run stops there), then create, link, comment and read back; resumable and
                                             idempotent, never changes the source. Needs no project of its own: see task migrate --help
  task migrate --in-place --to-config <file> [-p <project>] [--dry-run] [--allow-loss <kinds>] [--resume] [--history-comment] [--emit-events] [--json]
                                             Move THIS project to another storage: copy its tasks to the strategy of a draft config.yml, read them back,
                                             then replace config.yml by the draft (the old one is kept as config.yml.before-migration). See task migrate --help

Global flags:
  --config <dir>       Global config directory (default: ~/.task)
  --json               Force JSON output; errors become {"error":"...","hint":"..."} (no "hint" key when there is none)
  -p, --project <ref>  Project of the shared registry: name, alias, id or unique id prefix (min 4), case-insensitive; never a path. Also: TASK_PROJECT env var.
                       Order: -p, then TASK_PROJECT, then the registered project that contains the cwd (deepest registered folder wins). A reference that
                       does not resolve is an error (suggestions listed), never a fallback; so is a folder that is in no registered project (the error gives: project add "<dir>").
                       Refused with 'task list --all-projects'. Register a project with the project CLI: project add "<dir>"

How the project was resolved is in 'task cli logs'.

Events (pushed to queue through @wadeck-app/queue-sdk after the change is saved, with the project directory as cwd so its .queue/subscribers.yml is used):
  onTaskCreated        new                              taskId, status, description (the full text), parentId, type, labels
  onStatusChange       set-status                       taskId, oldStatus, newStatus, status (= newStatus), type, labels
  onTaskLinked         link                             taskId, linkType, targetId
  onTaskUnlinked       unlink                           taskId, linkType, targetId
  onTaskUnblocked      set-status, last blocker closed  taskId (the unblocked task), blockerId, status, type, labels
  onTaskTypeChanged    set-type, unset-type             taskId, oldType, newType (absent after unset-type)
  onTaskLabelAdded     add-label                        taskId, label
  onTaskLabelRemoved   remove-label                     taskId, label
  onTaskMetaChanged    set-meta, unset-meta             taskId, key, oldValue, newValue (absent after unset-meta)
  onTaskTextChanged    set-title, set-description       taskId, field (title|description), oldValue, newValue (empty when the description was cleared)
  onTaskCommentAdded   comment                          taskId, commentId, text (the full text), author (absent without one)
  onTaskCommentEdited  comment-edit                     taskId, commentId, oldText, newText (both full)
  onTaskCommentRemoved comment-rm                       taskId, commentId
  onTaskParentChanged  set-parent, remove-parent        taskId, oldParentId, newParentId
  onTaskPriorityChanged set-priority, unset-priority    taskId, oldPriority, newPriority (each absent when the task had none / has none)
  onTaskAssigneeChanged set-assignee, unset-assignee,   taskId, oldAssignee, newAssignee, outcome (claim and release only: claimed, renewed
                       claim, release                   with old = new, takeover, released)
  onTaskDeleted        delete                           taskId, description (the full text), status, parentId, orphanedChildIds, removedLinkCount, commentCount (only when the task had comments)
  onTasksMigrated      migrate                          fromProjectId, fromProjectName, toProjectId, toProjectName, created, resumed, skipped, failed, remaining, complete (one per run, after
                                                        the last write; its project fields are the target's; migrate raises no per-task event unless --emit-events)
  Absent fields are omitted (no oldType for a first type, no oldValue for a new key or a description the task did not have, no oldParentId / newParentId for a root task).
  Nothing fires when nothing changed (same type, label already there or absent, same meta value, same parent) or when the command fails.
  delete fires one onTaskDeleted per deleted task, after the deletion; never for --dry-run. With --cascade-delete the order is
  leaves before parents (deepest first).
  Every payload also has taskProjectName and taskProjectPath (the main path of the project: the cwd of the push), and taskProjectId (the id in the shared
  project registry) when the project is registered there (absent otherwise; taskProjectName is then the registry name). A virtual project (registered, no
  folder) has no taskProjectPath: the change is saved and its events are reported undelivered, naming the project; give it a folder to receive them. Subscriber filter example: when: payload.newStatus=done
  The events are declared to the queue (name, when it fires, payload schema, example; 'queue events list' shows them, source: task):
  once per declaration, just before the first event after an install or update, never at every command, recorded in
  <config dir>/queue-events.json. A failed declaration never fails the command and is retried by the next event; see it in 'task cli logs'.
  After updating queue-cli or losing the queue's catalog, force it: task cli declare-events
  A failed push never fails the command: it goes to stderr and to the log with how to replay it; read it with: task cli logs
    not recorded (dropped): cd '<project dir>' && queue push <event> '<json>'
    sent, then the connection broke or timed out: the event MAY be recorded and is never retried; check 'queue history'
    first, then 'queue replay <eventId>' if it is listed (or the push above if it is absent)

Output: commands output JSON (tasks are JSON objects with id, title, status, type, labels, meta; "description" only when stored),
  except 'find' and 'labels', which print text lines unless --json is given

Exit codes:
  0  success
  1  error

Environment variables:
  TASK_CONFIG       Override global config directory (default: ~/.task)
  TASK_PROJECT      Project of the shared registry (name, alias or id), below -p; refused by 'task list --all-projects'
  TASK_WORKER       Name of the worker for 'task claim' and 'task next' when --as is not given (a blank value counts as unset); not read by any other command`;
}

/** `task migrate --help`. */
export const MIGRATE_HELP = `task migrate - copy the tasks of one registered project into another, or move one project to another storage

Usage:
  task migrate --from <project> --to <project> [--dry-run] [--allow-loss <kind>[,<kind>...]] [--resume] [--history-comment] [subset] [--comments each|digest|none] [--emit-events] [--json]
  task migrate --in-place --to-config <file> [-p <project>] [--dry-run] [--allow-loss <kind>[,<kind>...]] [--resume] [--history-comment] [subset] [--comments each|digest|none] [--emit-events] [--json]
  subset = [--only-open | --status <s>[,<s>...]] [--ids <id>[,<id>...]] [--limit <n>]

  --from <project>      The source: a registered project (id, unique id prefix of 4 or more, name or alias; never a path). Only read.
  --to <project>        The target: another registered project. Its own strategy (config.yml) decides where its tasks go: local files or
                        github. The same project on both sides, or two projects on the same repository, is refused. TASK_PROJECT and -p
                        are not read: the two sides are these options. To move ONE project to GitHub without a second project, use
                        --in-place (below); the alternative is to register a second project with the project CLI (project add <dir>),
                        give it a strategy section (task strategy show/check) and migrate into it.
  --in-place            The project in scope (-p, TASK_PROJECT, else the registered folder you are in) changes storage, and stays the same
                        registered project (id, name, aliases, paths unchanged). Source = its current config.yml (usually local files).
                        Target = the strategy of --to-config. Does not take --from / --to.
  --to-config <file>    The draft: the WHOLE new config.yml of the project (it replaces the current file entirely: statuses, types, priorities,
                        defaults... must be in it; the keys it lacks are listed as a warning and are gone after the switch, the old file is
                        kept). Checked like a project config (schema, no secrets in it: tokenEnv / tokenFile, strategy section; it must hold
                        a strategy). It is read ONCE; what is migrated and written is that text, even if the file changes meanwhile (said in
                        the output). A status or type the draft lacks is a loss, reported before anything is written. Source and target on
                        the same storage (a draft still local, the same repository, a task server that serves this project) are refused.
  --accept-differences  (in place) Switch even when the read-back finds differences that can never clear (a forge normalising a text), or when
                        the source changed or lost a task that was already copied. They are printed in full and stored in the journal
                        (acceptedDifferences) and in --json. A task ADDED to the source is never accepted (--resume copies it). Without it the
                        run stops before the switch. Never copied into the commands the output prints: type it each time you mean it.
  --accept-draft-change (in place, with --resume) Continue an unfinished run with a draft whose target definition changed (strategy type,
                        fidelity, fills and every option that changes the stored data; the statuses with their flags, the types, the priorities
                        and defaults.priority), when the storage location is the same. Connection-only options (tokenEnv, tokenFile,
                        timeoutSeconds, cache, pageSize, maxPages, writeSpacingSeconds, rateLimit) and comments never need it. Another
                        location is always refused. Never copied into printed commands either.
  --fail-on-blocked     (with --dry-run) Exit 1 when a real run would be refused (a loss not allowed, a target that is not empty, a read served
                        from a cache). Without it a dry run exits 0 whatever it finds; the --json answer always carries blocked and
                        blockers (the kinds), and the text says BLOCKED: a real run will be refused.
  --allow-non-empty-target
                        (in place) Go on although the target already holds tasks that nothing of this migration claims (no journal entry,
                        no marker): a copy of an earlier migration that was rolled back, the old local files still in the data folder, an
                        existing repository. Without it a real run refuses before writing anything (the count, the ids, what to check) and a
                        dry run reports it as BLOCKED. The ids accepted are recorded in the journal: a resume needs nothing for them, a task that appears later is a new blocker. Never copied into printed
                        commands.
  --dry-run             Read both sides, print the plan, the loss table and the estimate, and stop: nothing is written (no task, no journal,
                        no lock, no request that changes anything); exit 0 even when the plan is blocked.
  --allow-loss <kinds>  Accept losses by kind (comma separated, repeatable). Without it a plan that loses anything is BLOCKED (exit 1,
                        nothing written). A group covers its kinds (links, hierarchy); all covers everything. The dry run prints the kinds
                        that apply and the exact command to accept them.
  --resume              Continue a run that stopped (rate limit, network, crash): the journal says what was done, nothing is created twice.
                        Without it, an unfinished journal is refused with this hint.
  --history-comment     Write one note comment per task with its original creation instant and status history, so those are not lost
                        (resolves the history and created-at kinds when the target has comments).
  --only-open           Copy only the tasks in a status of the SOURCE project that does not end a task. The others stay in the source.
  --status <s>,<s>      Copy only the tasks in these statuses of the source project (an unknown one lists the valid ones). Not with --only-open.
  --ids <id>,<id>       Copy only these source tasks (exact ids). Combines with the others: a task must match every one given.
  --limit <n>           Copy at most n tasks per run (1 to 1000): the first ones in plan order (parents before children), the ones an earlier
                        run left unfinished counting first. Run the same command again for the next n: what is already copied is never copied
                        twice (the journal knows it).
                        A subset leaves tasks out. A link, or a parent, that points to one of them is a loss (links:excluded, hierarchy:excluded:
                        blocking until allowed with --allow-loss, the dry run lists the tasks); the task is copied without it, the journal keeps
                        the relation, and the run that copies the other end writes it on the task copied earlier (once, nothing is duplicated).
                        In place, a subset NEVER switches config.yml (the source would lose the tasks left out): the run ends PARTIAL (exit 0,
                        inPlace.switched false) and prints the next command; the switch comes with the run that covers every task of the source,
                        after reading all of them back. Do not change the --comments mode between the runs of one migration.
  --comments <mode>     each (default): one comment per source comment, as always. digest: ONE comment per task with all its comments in order
                        (each keeps its Originally posted <instant> [by <author>] line; the author is always in the text; split in several comments
                        only when the target limits the length of a comment); with --history-comment the note joins it. Far fewer writes into
                        GitHub (a content write is capped at 80 a minute and 500 an hour). none: write no comment (a loss of the kind comments,
                        blocking until allowed; not with --history-comment). The dry run prints the writes saved.
  --emit-events         Also deliver the events the same writes raise in an ordinary session (onTaskCreated, onTaskLabelAdded, ...). By default
                        a migration raises ONE summary event (onTasksMigrated) after the last write: a bulk copy is not a user changing tasks
                        one by one, and a subscriber that reacts to onTaskCreated would otherwise run once per task.
  --json                The result as JSON (plan, counts, losses, id map, verification, journal); progress lines stay on stderr.

What is copied (through the storage port, never by touching files or the API): title, description, status, type, labels, metadata, parent,
links, comments. Tasks are created parents first; fields, then links (once both ends exist), then comments in order; then every task written
to is read back and compared with the plan (a difference is reported, never repaired). Ids change: the target gets its own, the id map is in
the result and the marker meta migratedFrom=<source project id>/<source task id> is written on each task (when the target has metadata).
Texts are not rewritten: a reference to an old id stays as it was (counted in the notes). A comment is written by the migrating user: its first
line carries the original time (and the author when the target cannot store one) and a marker; a migration never writes a comment twice.
Statuses are kept by name; one the target project lacks is a loss. The source is never changed, and a task already on the target is never
overwritten (a field a person set is left alone). updatedAt is the migration time.

Loss kinds (--dry-run lists the ones that apply):
  status, status-outcome   a status the target lacks (task gets its default) / ends a task differently there
  type, labels, meta       a type the target does not list, a label it refuses (length, reserved), metadata it cannot store
  priority, assignee       a priority the target does not list, or no priority / assignee support on the target
  lease                    a claim lease is never migrated (reported for each task that holds one)
  comments                 the target has no comments, or --comments none
  history, created-at     the status history and activity log cannot be replayed through the port; the target assigns the creation instant
                           (--history-comment keeps both in a note comment)
  marker                   the target has no metadata, so migrated tasks are recognised by the journal only
  text-length              a text longer than the target accepts is cut with a note
  hierarchy:unsupported, hierarchy:depth, hierarchy:children, hierarchy:orphan, hierarchy:cycle, hierarchy:excluded
                           parents the target cannot keep, or the source does not hold together; the task becomes a root. excluded: the parent is
                           outside the subset (--only-open, --status, --ids, --limit); it is attached when a later run copies it
  links:blockedBy, links:duplicateOf, links:causedBy, links:dangling, links:excluded
                           link types the target cannot store (causedBy on GitHub), links to tasks that are not in the source, links to a task
                           outside the subset (written when a later run copies it)

In place: the copy is the one above (journal, marker meta migratedFrom=<project id>/<old id>, loss table, read-back), with these additions.
  - Id map: <data folder>/migrate-idmap-<project id>.json, a list of {from, to}, saved after every task is created and before the switch; it is
    printed as 'old id -> new id' (and as idMap in --json). References to old ids in texts are not rewritten: use the map.
  - The SWITCH comes last: only when every task is written AND read back with no difference, config.yml (the project's own layer) is replaced by
    the draft, atomically, and the old one is kept as config.yml.before-migration next to it. If that file already exists the run stops before
    anything is written (--dry-run too): it is your rollback copy, move it away first. A run that stops or fails leaves config.yml untouched;
    --resume continues it. If only the switch failed, or the process died right after replacing config.yml, --resume does just what is left
    (the journal says every task was verified: nothing is read or created). A config.yml edited during the run is never overwritten: the switch
    stops and --resume re-takes the snapshot. If the source gets a task added, removed or changed after the plan, the run stops (status stopped)
    before the switch, says which ids and which parts changed (title, description, status, type, labels, meta, parent, links, priority,
    assignee, comments), and --resume copies the added ones. A changed task keeps the version that was copied and a removed one keeps its copy;
    the next runs stop on them again until you fix the target by hand or add --accept-differences.
  - Afterwards the local task files are NOT deleted. Rollback = copy config.yml.before-migration back over config.yml.
  - A finished migration's journal and id map are ARCHIVED (renamed <name>.archived-<time>.json, never deleted) when a new in-place migration of
    the project is about to write its first task (a refused or blocked run leaves both files). An unfinished run is resumed only with the same target (see --accept-draft-change): another
    option at the same location needs --resume --accept-draft-change, another location is refused; a dry run only prints a note.
  - --dry-run also prints the strategy checks that need no write (token readable, repository reachable, statuses mapped); a check that cannot
    run without a write is listed as not checked. It writes nothing: no journal, lock, id map or config, and no response cache under the data folder
    (the caches of the dry run live in memory).
  - Events: unchanged (none per task unless --emit-events). The one summary event onTasksMigrated (from and to project are the same) is raised
    after the switch.
  - The journal records the storage the tasks are read from: a --resume while config.yml points to another source is refused. The read-back and the
    last source check read fresh; a read answered from a cache (the system was unreachable) stops the run (step stale-read), never a switch. An
    archive a crash interrupted is completed at the start of the next run. If the journal cannot be saved after the switch, the answer says so and
    the exit code is 1: run the same command with --resume.

Journal and idempotence: <target data folder>/migrate-journal-<source id>-<target id>.json (migrate-journal-<project id>-inplace.json for --in-place; atomic writes; a damaged file is a loud error, never
replaced). A second run recognises the tasks it already migrated by the journal, else by the marker in the target, and creates nothing. A lock
file (migrate.lock) keeps two runs from writing the same target. Only one run at a time; a lock left by a dead process is taken over.
Rate limits: the run stops cleanly, prints when the limit lifts and the exact command to continue. Any other failure stops at the first one,
with the journal saved and the command to continue; the dry run prints an estimate of the writes, requests and time first.

Exit codes:
  0  done, or a dry run
  1  blocked by a loss, stopped (rate limit, failure), differences found on the read-back, or an error (nothing was changed)

Examples:
  task migrate --from shop --to shop-github --dry-run
  task migrate --from shop --to shop-github --allow-loss history,created-at,marker
  task migrate --from shop --to shop-github --allow-loss history,created-at,marker --resume
  task migrate --in-place --to-config ./github-config.yml -p shop --dry-run
  task migrate --in-place --to-config ./github-config.yml -p shop --allow-loss history,created-at,marker`;

/** `task projects --help`. */
export const PROJECTS_HELP = `task projects - figures over the projects of the shared project registry

Usage:
  task projects summary [--json]             Open/total tasks per project and in total; an unreadable project shows its reason and is not counted;
                                             exit 1 only when registered projects exist and none can be read
  task projects --help                       Show this help

These commands need no project: the registry is global (-p and TASK_PROJECT are not used here).`;

/** `task strategy --help`. */
export const MIGRATE_STRATEGY_HELP = `task strategy migrate - move the tasks of a project to another strategy, in the background

The project's strategy must be of type migrating (config.yml, section 'strategy'): two full strategy blocks, "current" (where the tasks are)
and "new" (where they go), and an optional budget. New tasks are created in "new" at once; the tasks of "current" move one at a time, parents
first, while every other command keeps working. A task is copied, verified, and only then switched to "new"; its copy in "current" is kept.

Usage:
  task strategy migrate start [-p <project>] [--allow-loss <kinds>] [--dry-run] [--json]
      Plans the move of EVERY task of "current": what each side keeps and loses (the same ledger as 'task migrate'), the number of requests,
      the time at the pace of the budget. --dry-run stops there and writes nothing. Without it the start is refused while a loss is not
      accepted (--allow-loss history,comments, or all); otherwise it routes every task as in "current", stores the accepted losses, and
      launches the worker (a background process, no window on Windows). The "new" strategy must be able to store metadata (a meta fill).
  task strategy migrate status [-p <project>] [--json]
      Where it stands: tasks moved of the total, per state (in current, moving, stale copies, deleted, made in new), the worker (pid, alive,
      what it does, heartbeat), the pace used and its limits, the time left, the last errors, tasks set aside, and the next thing to do.
      Reads files only: it opens neither strategy, so it works when a token is missing or a server is down.
  task strategy migrate pause [-p <project>] [--json]
      The worker finishes the task it is moving and stops. Nothing is lost: the migration continues with resume.
  task strategy migrate resume [-p <project>] [--json]
      Relaunches the worker after a pause, a stop, or a crash (status says which); cancels a pause that was asked and not yet seen.
  task strategy migrate log [-p <project>] [--follow] [--tail <n>] [--json]
      The migration log (<data>/migrating/log.ndjson): every move, step, rate pause and error. Last 50 lines by default; --follow keeps printing
      what is added until Ctrl+C; --json prints a list (one JSON object a line with --follow).
  task strategy migrate finalize [-p <project>] [--json]
      Ends the migration on "new": the project then uses the new strategy ALONE. Allowed only when status says ready-to-finalize (every task
      is in "new", no unfinished transaction, no worker, no stale copy); each refusal names the blocker and the command that fixes it. It
      re-reads both stores (not the index): every task has its copy in "new" with an identity block that says "new" holds the truth, "new"
      holds no task the index does not know, and "current" holds no task created there meanwhile (it would be lost). Then it writes
      <data>/migrating/idmap.json (old id -> new id), keeps the config as config.yml.before-migration (refused when that file exists with
      other content), replaces the strategy section of config.yml by the "new" block (every other key is kept; comments are not), and raises
      the onTasksMigrated summary event once. NO task, copy or file is deleted: the copies in "current" stay. After it the OLD ids of the moved
      tasks no longer resolve (task show <old id> says not found): look them up in idmap.json. A run that died right after the config write is
      completed by running finalize again (it opens no store). A "new" strategy that keeps its task files in the project folder is refused:
      use task migrate --in-place for that move.
  task strategy migrate abort [-p <project>] [--keep-moved] [--json]
      Goes back to "current": stops the worker (control file, waits up to 60 s), replaces the strategy section of config.yml by the "current"
      block (the migrating config is kept as config.yml.before-abort). It opens no store, so it works when a token is missing or a server is
      down. NOTHING is deleted: the copies in "new" of tasks that were being moved are listed as leftovers (in the answer and under "abort" in
      state.json). Tasks whose truth is already in "new" (moved, or created there) are NOT copied back: abort is refused while there are
      any, unless --keep-moved, which leaves them in "new", lists them with their ids and warns that they are no longer part of the project
      (a moved one shows its older copy kept in "current", without what changed in "new" since). A finished or aborted migration cannot be
      aborted again; to migrate again later, move the files of <data>/migrating aside first.
  task strategy migrate worker -p <project>    INTERNAL: what the background process runs; run it in a terminal to move the tasks in the foreground.

The pace: strategy.options.budget.requestsPerMinute is the share of requests the worker may use; a cap on writes that "new" documents is kept
too. A side that answers "rate limited until <time>" makes the worker sleep until then (a line in the log), never fail. A claimed task is
skipped and retried when its lease ends. After 5 failures in a row the worker stops with a status and the fix (task strategy migrate status).

Files (<data>/migrating/): index.json (which side holds which task), state.json (accepted losses, counters, status, and what finalize or
abort recorded before touching config.yml), control.json (pause and stop asks), worker.json (heartbeat), worker.lock (one worker per project),
worker.out.log (the process's own output), wal.ndjson, log.ndjson (every step of finalize and abort too), idmap.json (written by finalize).
`;

export const STRATEGY_HELP = `task strategy - where the tasks of this project are stored

Usage:
  task strategy show [-p <project>] [--json]    The strategy the project's config selects: type and plugin, fidelity, declared fills, the token
                                                variables (name and whether set, never the value), and a table of the capabilities of the
                                                backend: native, emulated (by a declared fill) or unsupported. Reads the config only: opens no
                                                backend, creates nothing.
  task strategy check [-p <project>] [--json]   show, plus the checks: the config is valid, each token is there (variable set, file readable by
                                                you only), the transport warns on plain http:// to a non-loopback host, the backend opens
                                                (local: data folder, writable, task counts; github: it contacts GitHub: token accepted and its
                                                expiry, repository and Issues readable, quota left, statuses mapped, labels that exist,
                                                sub-issues and dependencies available; gitlab: one line per capability the token gives or lacks (read, write, labels, hierarchy: the missing fine-grained permission and how to add it), quota, statuses and labels, and what was verified live). Each problem prints its fix; exit 1 on any error
                                                (warnings do not fail it).
  task strategy help github                     Step-by-step guide to the github token: create it, store it, check it, fix a refusal
                                                (also in docs/github-strategy-token.md); 'task strategy help' lists the topics
  task strategy migrate <sub>                   Move the tasks of a project from one strategy to another in the background (strategy type
                                                migrating): start, status, pause, resume, log. 'task strategy migrate --help' says how.
  task strategy --help                          Show this help

Configuration (the project's config.yml, section 'strategy'; no section = type: local, silently):
  strategy:
      type: local            # local, github, gitlab or remote; a type with no plugin is a loud error, never a fallback
      fidelity: strict       # strict (default) | degrade: whether an approximate or lossy fill is accepted
      options: {}            # read by the strategy plugin only; local takes none. fills: <capability>: <technique> | { use, fidelity }
                             # secrets: tokenEnv: <NAME of an environment variable> or tokenFile: <path>; a literal token is refused

The github strategy (the issues of one repository, through the official REST API; the token needs Issues: Read and write, Metadata: Read):
  strategy:
      type: github
      options:
          repo: owner/name                       # required
          tokenEnv: GITHUB_TOKEN                 # the NAME of the variable (or tokenFile: <path>); required
          baseUrl: https://api.github.com        # GitHub Enterprise Server: https://HOST/api/v3
          statusMap:                             # every status of the project; exactly one open status has no label
              backlog: { state: open }
              in-progress: { state: open, label: 'status:in-progress' }
              done: { state: closed }            # a positive terminal status closes as completed (reason: completed)
              cancelled: { state: closed, reason: not_planned }   # a negative one as not_planned (or duplicate)
          # typePrefix: 'type:'  typeMap: { bug: { issueType: Bug } }  metaPrefix: 'meta:'  pageSize: 100  maxPages: 50
          # cache: { ttlSeconds: 60 }  timeoutSeconds: 15  writeSpacingSeconds: 1
          # fills:                               # what GitHub cannot hold natively; nothing is emulated unless declared here
          #     meta: labels                     # metadata as labels meta:key=value (50 characters at most each), exact
          #     meta: { use: body-block, fidelity: degrade }   # or in a hidden block of the issue body, approximate
          #     delete: hard                     # GraphQL deleteIssue (repository administrator), or
          #     delete: { use: tombstone, fidelity: degrade }  # close as not planned + label task:deleted, hidden from task
          #     linkTypes.duplicateOf: { use: duplicate-marker, fidelity: degrade }  # marker in the body + closed as duplicate
  Task ids are the issue numbers. A read that GitHub cannot answer (offline, rate limited) shows the cached answer with a warning on stderr.
  A write goes to GitHub at once (one at a time, at least 1 s apart); a change made of several calls that stops halfway says what GitHub holds and
  how to finish it. causedBy links, comment authors and anything a fill would emulate but the config does not declare fail with the key to write.
  Create the labels once with: task labels sync. Changes made on GitHub itself raise no task event (only changes made through task do).

The gitlab strategy (the issues of one GitLab project, through the official REST API v4; a fine-grained token with the permissions Work Item: Read, Create, Update, Delete and Label: Read, Create, or a classic token with the scope api, read_api to read only).
Verified live on gitlab.com Free with a fine-grained token (not on self-managed instances, not with classic tokens); 'task strategy check' says what each token can do:
  strategy:
      type: gitlab
      options:
          project: group/subgroup/project        # required: the path, or the numeric project id
          tokenEnv: GITLAB_TOKEN                 # the NAME of the variable (or tokenFile: <path>); required
          baseUrl: https://gitlab.com/api/v4     # self-managed: https://HOST/api/v4
          statusMap:                             # every status of the project; one open and one closed status have no label (GitLab has no close reason)
              backlog: { state: open }
              in-progress: { state: open, label: 'status:in-progress' }
              done: { state: closed }
              cancelled: { state: closed, label: 'status:cancelled' }
          # typePrefix, typeMap: { bug: { issueType: incident } }, metaPrefix, pageSize: 100, maxPages: 50, cache: { ttlSeconds: 30 }, timeoutSeconds: 15, writeSpacingSeconds: 1, rateLimit: { maxWaitSeconds: 70 }
          # fills:                               # what GitLab cannot hold natively; nothing is emulated unless declared here
          #     meta: labels                     # metadata as labels meta:key=value, exact
          #     meta: { use: body-block, fidelity: degrade }
          #     delete: hard                     # DELETE the issue (Planner or Owner), or
          #     delete: { use: tombstone, fidelity: degrade }  # close + label task:deleted, hidden from task
          #     linkTypes.duplicateOf: { use: relate-block, fidelity: degrade }   # managed block in the description + a relates_to link (same for causedBy)
  Task ids are the issue numbers (iid). Free tier only: blockedBy links are refused (GitLab's blocks / is_blocked_by need a paid tier). A label like status::x is a plain label here (no exclusivity). When the quota (100 requests per minute on gitlab.com) is used up, a command waits for the window to reopen (up to rateLimit.maxWaitSeconds) and says so on stderr.
  Create the labels once with: task labels sync. Changes made on GitLab itself raise no task event (only changes made through task do).

The remote strategy (the tasks are stored by a 'task serve' on another computer, which is the single writer and raises the queue events;
this computer raises none for the project; see: task serve --help):
  strategy:
      type: remote
      options:
          project: shop                          # optional: the id (or name) of the project the server serves; checked before the first call
          transport:                             # how to reach the server (plugin plain-http: plain HTTP, trusted LAN only)
              type: plain-http
              options:
                  url: http://nas.lan:7788       # required; no credentials in it
                  tokenEnv: TASK_REMOTE_TOKEN    # the NAME of the variable (or tokenFile: <absolute path>); the token task serve was started with
                  timeoutSeconds: 10             # per request (default 10); a write that times out may still have been applied
  The statuses and types of this project should equal those of the served project (strategy check compares them; the server refuses a status it
  does not know). A server that cannot be reached, a refused token and another protocol version are errors with their fix; strategy check names them.

A 'strategy' key in the global ~/.task/config.yml, a literal credential, and 'pluginsDir' (external plugins) are errors naming the file and the key.`;

/** `task serve --help`. */
export const SERVE_HELP = `task serve - serve this project's tasks to other computers

Usage:
  task serve [-p <project>] [--port <n>] [--host <address>] [--allow-lan] [--token-env <NAME> | --token-file <path>] [--json]
  task serve --help

What it does: serves the tasks of ONE project (the one -p, TASK_PROJECT or the cwd selects; its strategy must be local) over HTTP/JSON, protocol 2 (clients on protocol 1 keep working),
to computers whose project says 'strategy: type: remote' (task strategy --help). This server is the single writer of the project: it runs the
writes one at a time and raises the queue events of the changes itself (the computers that connect raise none). It runs in the foreground until
Ctrl+C or SIGTERM, finishing the writes in flight; task has no daemon manager and this does not detach: use the means of your shell or service manager.

Options:
  --port <n>            Port to listen on (default 7788); 0 lets the system pick a free one (the address is printed)
  --host <address>      Address to listen on (default 127.0.0.1: this computer only). Any other address needs --allow-lan
  --allow-lan           Accept a host that other computers can reach (for example 0.0.0.0 or 192.168.1.5). Prints a loud warning: plain HTTP,
                        the token and the tasks are readable by anyone on that network. Trusted LAN only
  --token-env <NAME>    NAME of the environment variable that holds the bearer token (default TASK_SERVE_TOKEN)
  --token-file <path>   Absolute path of a file that holds the token (POSIX: mode 600). Instead of --token-env
  --json                One JSON line on stdout when it listens: {listening, url, host, port, lan, protocol, project, auth, events}

The token: required (no anonymous mode), at least 16 characters, never on the command line. Make one, for example:
  node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))"
and give the same value to both computers: export TASK_SERVE_TOKEN=<token> here, and the variable named by tokenEnv in the transport options of the
client project there.

Security (v1): plain HTTP, no TLS: anyone who can read the network traffic reads the token and the tasks and can replay the token. Failed
authentications are counted, delayed by 500 ms each and logged (task cli logs); there is no lockout. Request bodies are limited to 1 MiB, every input
is validated, ids are never paths, there is no CORS. For anything beyond a trusted LAN put a TLS wrapper in front (the client accepts https:// addresses).

Example:
  export TASK_SERVE_TOKEN=$(node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))")
  task serve -p shop --host 0.0.0.0 --allow-lan --port 7788`;

/** `task type --help`. */
export const TYPE_HELP = `task type - manage valid task types for this project

Usage:
  task type list              List valid types configured for this project
  task type add <name>        Add a valid type
  task type remove <name>     Remove a valid type
  task type --help            Show this help

Types are stored in the project's own config.yml (see 'task --help', config) under the 'types' key.
When types are configured, 'task set-type' validates against this list.
When no types are configured, any string is accepted (backwards compatible).`;

/** `task status --help`. */
export const STATUS_HELP = `task status - the valid statuses of this project

Usage:
  task status list [--json]   The statuses 'task set-status' accepts, in config order, one per line: a status that is the
                              default (the initial status of a new task) is marked "(default)", a terminal one (hidden from
                              'task list' unless --all) "(terminal)", or "(terminal, negative)" when
                              its config says 'outcome: negative' (e.g. rejected; it still unblocks what it blocks).
                              --json: [{"name": "...", "default": false, "terminal": false}], plus "outcome":
                              "positive"|"negative" on terminal statuses
  task status --help          Show this help

The list is the statuses of the project's merged config.yml (see 'task --help', config); without any, backlog, in-progress, done.`;
