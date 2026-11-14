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
  task comment <id> <text...> [--file <path|->] [--author <name>] [--json]
                                             Add a comment (plain text, 1 to 10000 characters; words are joined with a space, -- before a text
                                             starting with --; --file reads it from a file or from standard input with -). No author unless
                                             --author is given. Prints the new comment id
  task comments <id> [--json]                List the comments of a task, oldest first (id, UTC minute, author, "(edited)", the text indented);
                                             --json: [{id, at, text, author?, editedAt?}]
  task comment-edit <id> <comment-id> <text...> [--file <path|->]
                                             Replace the text of a comment (an identical text changes nothing); ids: task comments <id>
  task comment-rm <id> <comment-id>          Remove a comment
  task find <query> [--limit N] [--json]     Find tasks by id prefix or title text, best match first (id prefix, title word prefix, substring);
                                             N from 1 to 20 (default 8); text lines "id  headline  [status]", --json: [{id, headline, status}]
  task labels [--json]                       Labels in use with the number of tasks carrying each, most used first
  task labels sync [--dry-run] [--json]      github or gitlab strategy: create the status and type labels the config uses in the repository (colour
                                             and description included); never deletes or changes a label. --dry-run lists what it would create
  task list [--json] [--all] [--follow|-f]   List tasks as JSON array (hides terminal statuses unless --all)
  task list --parent <id>                    List only the direct children of a task
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
                                             Serve this project's tasks to other computers (HTTP/JSON, protocol 1, bearer token, single writer), in the
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
  TASK_PROJECT      Project of the shared registry (name, alias or id), below -p; refused by 'task list --all-projects'`;
}

/** `task migrate --help`. */
export const MIGRATE_HELP = `task migrate - copy the tasks of one registered project into another

Usage:
  task migrate --from <project> --to <project> [--dry-run] [--allow-loss <kind>[,<kind>...]] [--resume] [--history-comment] [--emit-events] [--json]

  --from <project>      The source: a registered project (id, unique id prefix of 4 or more, name or alias; never a path). Only read.
  --to <project>        The target: another registered project. Its own strategy (config.yml) decides where its tasks go: local files or
                        github. To move a project onto GitHub, register a second project with the project CLI (project add <dir>), give it
                        a strategy section (task strategy show/check) and migrate into it. The same project on both sides, or two projects
                        on the same repository, is refused. TASK_PROJECT and -p are not read: the two sides are these options.
  --dry-run             Read both sides, print the plan, the loss table and the estimate, and stop: nothing is written (no task, no journal,
                        no lock, no request that changes anything); exit 0 even when the plan is blocked.
  --allow-loss <kinds>  Accept losses by kind (comma separated, repeatable). Without it a plan that loses anything is BLOCKED (exit 1,
                        nothing written). A group covers its kinds (links, hierarchy); all covers everything. The dry run prints the kinds
                        that apply and the exact command to accept them.
  --resume              Continue a run that stopped (rate limit, network, crash): the journal says what was done, nothing is created twice.
                        Without it, an unfinished journal is refused with this hint.
  --history-comment     Write one note comment per task with its original creation instant and status history, so those are not lost
                        (resolves the history and created-at kinds when the target has comments).
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
  comments                 the target has no comments
  history, created-at      the status history and activity log cannot be replayed through the port; the target assigns the creation instant
                           (--history-comment keeps both in a note comment)
  marker                   the target has no metadata, so migrated tasks are recognised by the journal only
  text-length              a text longer than the target accepts is cut with a note
  hierarchy:unsupported, hierarchy:depth, hierarchy:children, hierarchy:orphan, hierarchy:cycle
                           parents the target cannot keep, or the source does not hold together; the task becomes a root
  links:blockedBy, links:duplicateOf, links:causedBy, links:dangling
                           link types the target cannot store (causedBy on GitHub), links to tasks that are not in the source

Journal and idempotence: <target data folder>/migrate-journal-<source id>-<target id>.json (atomic writes; a damaged file is a loud error, never
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
  task migrate --from shop --to shop-github --allow-loss history,created-at,marker --resume`;

/** `task projects --help`. */
export const PROJECTS_HELP = `task projects - figures over the projects of the shared project registry

Usage:
  task projects summary [--json]             Open/total tasks per project and in total; an unreadable project shows its reason and is not counted;
                                             exit 1 only when registered projects exist and none can be read
  task projects --help                       Show this help

These commands need no project: the registry is global (-p and TASK_PROJECT are not used here).`;

/** `task strategy --help`. */
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

What it does: serves the tasks of ONE project (the one -p, TASK_PROJECT or the cwd selects; its strategy must be local) over HTTP/JSON, protocol 1,
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
