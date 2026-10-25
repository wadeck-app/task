import { VERSION } from '../version.js';

/** `task --help`. */
export function taskHelp(): string {
	return `task ${VERSION} - task tracker CLI

Concepts:
  task        A work item with id, description, status, type, labels, and metadata
  parent      Optional parentId on a task; hierarchy depth is unlimited (delete a parent: children become roots, or --cascade-delete)
  link        Typed, directional, acyclic relation between two tasks: blockedBy, duplicateOf, causedBy (inverses blocks, duplicates, causes are derived)
  project     A project of the shared project registry (managed by the 'project' CLI): id (8 hex), name, aliases, paths. Selected with -p, TASK_PROJECT or the cwd.
              Its tasks live in the registry (<registry>/projects/<id>/task/data), not in the project folder; a project may have no folder (virtual)
  config      Project config: <registry>/projects/<id>/task/config/config.yml, merged along the parent chain of the project (statuses, types, fields, hooks:
              the project's own; defaults: inherited). Defines valid statuses (default: backlog, in-progress, done). An unknown key is an error naming the file.
              The global config (~/.task/config.yml: defaults, hooks) stays task's own file
  id          Short prefix of the task UUID - any unambiguous prefix is accepted

Usage:
  task new <description> [--parent <id>]     Create a new task (optionally under a parent); prints full task JSON
  task list [--json] [--all] [--follow|-f]   List tasks as JSON array (hides terminal statuses unless --all)
  task list --parent <id>                    List only the direct children of a task
  task list --tree                           List tasks as a nested forest (kept: matching tasks + the ancestors leading to them)
  task list --all-projects [--all] [--json]  List the tasks of every registered project (Project column; text table, --json: tasks tagged with their project);
                                             needs no project; unreadable projects on stderr; exit 1 only if none can be read;
                                             cannot be combined with --follow, --tree, --parent, -p or TASK_PROJECT
                                             (a single project contradicts all of them)
  task show <id> [--json] [--with-parent] [--with-children]   Show task detail (always incl. parentId, childrenIds); flags add parent/children summaries
  task history <id> [--json] [--follow|-f]   Show status-change history for a task
  task set-status <id> <status>              Update task status (valid values: task status list)
  task status list [--json]                  List the valid statuses of the project in order, marking the default (initial status of a new task) and the terminal ones
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
  task projects summary [--json]             Open/total tasks per registered project and in total (unreadable projects listed with their reason)

Global flags:
  --config <dir>       Global config directory (default: ~/.task)
  --json               Force JSON output; errors become {"error":"...","hint":"..."} (no "hint" key when there is none)
  -p, --project <ref>  Project of the shared registry: name, alias, id or unique id prefix (min 4), case-insensitive; never a path. Also: TASK_PROJECT env var.
                       Order: -p, then TASK_PROJECT, then the registered project that contains the cwd (deepest registered folder wins). A reference that
                       does not resolve is an error (suggestions listed), never a fallback; so is a folder that is in no registered project (the error gives: project add "<dir>").
                       Refused with 'task list --all-projects'. Register a project with the project CLI: project add "<dir>"

How the project was resolved is in 'task cli logs'.

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

Output: all commands output JSON (tasks are JSON objects with id, description, status, type, labels, meta)

Exit codes:
  0  success
  1  error

Environment variables:
  TASK_CONFIG       Override global config directory (default: ~/.task)
  TASK_PROJECT      Project of the shared registry (name, alias or id), below -p; refused by 'task list --all-projects'`;
}

/** `task projects --help`. */
export const PROJECTS_HELP = `task projects - figures over the projects of the shared project registry

Usage:
  task projects summary [--json]             Open/total tasks per project and in total; an unreadable project shows its reason and is not counted;
                                             exit 1 only when registered projects exist and none can be read
  task projects --help                       Show this help

These commands need no project: the registry is global (-p and TASK_PROJECT are not used here).`;

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
                              'task list' unless --all) "(terminal)". --json: [{"name": "...", "default": false, "terminal": false}]
  task status --help          Show this help

The list is the statuses of the project's merged config.yml (see 'task --help', config); without any, backlog, in-progress, done.`;
