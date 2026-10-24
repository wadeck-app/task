import { VERSION } from '../version.js';

/** `task --help`. */
export function taskHelp(): string {
	return `task ${VERSION} - task tracker CLI

Concepts:
  task        A work item with id, description, status, type, labels, and metadata
  parent      Optional parentId on a task; hierarchy depth is unlimited (delete a parent: children become roots, or --cascade-delete)
  link        Typed, directional, acyclic relation between two tasks: blockedBy, duplicateOf, causedBy (inverses blocks, duplicates, causes are derived)
  config      Project config at .task/config.yml (defines valid statuses; default: backlog, in-progress, done)
  init        Creates .task/ directory and config.yml in the current working directory
  id          Short prefix of the task UUID - any unambiguous prefix is accepted

Usage:
  task init                                  Initialize task project in current directory
  task new <description> [--parent <id>]     Create a new task (optionally under a parent); prints full task JSON
  task list [--json] [--all] [--follow|-f]   List tasks as JSON array (hides terminal statuses unless --all)
  task list --parent <id>                    List only the direct children of a task
  task list --tree                           List tasks as a nested forest (kept: matching tasks + the ancestors leading to them)
  task list --all-projects [--all] [--json]  List the tasks of every registered project (Project column; text table, --json: tasks tagged with their project);
                                             needs no project; unreadable projects on stderr; exit 1 only if none can be read;
                                             cannot be combined with --follow, --tree, --parent, --project-dir or TASK_PROJECT_DIR
                                             (a single project contradicts all of them); PROJECT_DIR is ignored (stderr note)
  task show <id> [--json] [--with-parent] [--with-children]   Show task detail (always incl. parentId, childrenIds); flags add parent/children summaries
  task history <id> [--json] [--follow|-f]   Show status-change history for a task
  task set-status <id> <status>              Update task status (valid values from .task/config.yml)
  task set-type <id> <type>                  Update task type (validated if types configured)
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
  task delete <id>[,<id2>,...]              Delete task(s) by ID (comma-separated)
  task delete --all                          Delete all tasks
  task delete --filter <field>=<value>       Delete tasks matching a filter (fields: id, title, status, parentId; glob * allowed)
  task delete --dry-run ...                  Show what would be deleted without deleting
  task delete ... --cascade-delete           Also delete all descendants of the matched tasks (default: children become root tasks)
  task plugins list [--json]                 List available built-in flow plugins
  task plugins config <id> [--json]         Show config snippet for a plugin
  task cli self-check                        Validate installation
  task cli update [--check] [--log]         Update to latest version
  task cli logs [--follow]                   Print today's invocation log
  task cli register [--json]                 Tell app-core where the task app-module is (also done by task cli update)
  task cli unregister [--json]               Remove the task app-module from app-core
  task cli declare-events [--json]           Tell the queue which events task pushes, now (normally automatic, see Events below)
  task projects list [--json]                List the projects registered with the app-module (flags missing/uninitialized/unreadable ones)
  task projects add [dir] [--json]           Register an initialized project (default: the cwd) with the app-module
  task projects remove <dir> [--json]        Unregister a project directory (its .task is left untouched)
  task projects move <old-dir> <new-dir> [--json]  Replace a registered directory by the one the project moved to (nothing on disk is touched)
  task projects prune [--dry-run] [--json]   Unregister the projects whose directory no longer exists
  task projects summary [--json]             Open/total tasks per registered project and in total (unreadable projects listed with their reason)

Global flags:
  --config <dir>       Global config directory (default: ~/.task)
  --json               Force JSON output; errors become {"error":"...","hint":"..."} (no "hint" key when there is none)
  --project-dir <dir>  Override project directory (also: TASK_PROJECT_DIR env var, then PROJECT_DIR)
                       Refused by 'task list --all-projects' (as is TASK_PROJECT_DIR) and by 'task projects add' (task projects add cannot use --project-dir)

Events (pushed to queue through @wadeck-app/queue-sdk after the change is saved, with the project directory as cwd so its .queue/subscribers.yml is used):
  onTaskCreated        new                              taskId, status, description, parentId, type, labels
  onStatusChange       set-status                       taskId, oldStatus, newStatus, status (= newStatus), type, labels
  onTaskLinked         link                             taskId, linkType, targetId
  onTaskUnlinked       unlink                           taskId, linkType, targetId
  onTaskUnblocked      set-status, last blocker closed  taskId (the unblocked task), blockerId, status, type, labels
  onTaskTypeChanged    set-type                         taskId, oldType, newType
  onTaskLabelAdded     add-label                        taskId, label
  onTaskLabelRemoved   remove-label                     taskId, label
  onTaskMetaChanged    set-meta                         taskId, key, oldValue, newValue
  onTaskParentChanged  set-parent, remove-parent        taskId, oldParentId, newParentId
  onTaskDeleted        delete                           taskId, description, status, parentId, orphanedChildIds, removedLinkCount
  Absent fields are omitted (no oldType for a first type, no oldValue for a new key, no oldParentId / newParentId for a root task).
  Nothing fires when nothing changed (same type, label already there or absent, same meta value, same parent) or when the command fails.
  delete fires one onTaskDeleted per deleted task, after the deletion; never for --dry-run. With --cascade-delete the order is
  leaves before parents (deepest first).
  Every payload also has taskProjectName and taskProjectPath. Subscriber filter example: when: payload.newStatus=done
  The events are declared to the queue (name, when it fires, payload schema, example; 'queue events list' shows them, source: task):
  once per declaration, just before the first event after an install or update, never at every command, recorded in
  <config dir>/queue-events.json. A failed declaration never fails the command and is retried by the next event; see it in 'task cli logs'.
  After updating queue-cli or losing the queue's catalog, force it: task cli declare-events
  A failed push never fails the command: it goes to stderr and to the log with how to replay it; read it with: task cli logs
    not recorded (dropped): cd '<project dir>' && queue push <event> '<json>'
    sent, then the connection broke or timed out: the event MAY be recorded and is never retried; check 'queue history'
    first, then 'queue replay <eventId>' if it is listed (or the push above if it is absent)

Output: all commands output JSON (tasks are JSON objects with id, description, status, type, labels, meta)

Exit codes:
  0  success
  1  error

Environment variables:
  TASK_CONFIG       Override global config directory (default: ~/.task)
  TASK_PROJECT_DIR  Override project directory
  PROJECT_DIR       Fallback project directory when TASK_PROJECT_DIR is not set (ignored, with a stderr note, by 'task list --all-projects')`;
}

/** `task projects --help`. */
export const PROJECTS_HELP = `task projects - projects registered with the task app-module (by 'task init' or 'task projects add')

Usage:
  task projects list [--json]                List registered projects: path and [ok], [missing], [not initialized] or [unreadable: <reason>]
  task projects add [dir] [--json]           Register a directory holding a .task (default: the cwd); idempotent; not initialized: run 'task init' there
  task projects remove <dir> [--json]        Unregister a directory (relative paths resolve against the cwd); .task is left untouched
  task projects move <old-dir> <new-dir> [--json]
                                             Replace a registered directory by the one the project moved to (the new one must hold a .task;
                                             the old one may be gone); the registry entry only, no data is moved or deleted
  task projects prune [--dry-run] [--json]   Unregister every project whose directory no longer exists; --dry-run only prints them
  task projects summary [--json]             Open/total tasks per project and in total; an unreadable project shows its reason and is not counted;
                                             exit 1 only when registered projects exist and none can be read
  task projects --help                       Show this help

The registry is <config dir>/projects.json. These commands need no initialized project:
--project-dir, TASK_PROJECT_DIR and PROJECT_DIR select no project here (the registry is global); add refuses --project-dir
(it would register the cwd instead), pass the directory: task projects add <dir>.`;

/** `task type --help`. */
export const TYPE_HELP = `task type - manage valid task types for this project

Usage:
  task type list              List valid types configured for this project
  task type add <name>        Add a valid type
  task type remove <name>     Remove a valid type
  task type --help            Show this help

Types are stored in .task/config.yml under the 'types' key.
When types are configured, 'task set-type' validates against this list.
When no types are configured, any string is accepted (backwards compatible).`;
