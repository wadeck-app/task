// The commands that work on an initialized project, by command word.
import type { ProjectCommand } from '../cli/env.js';
import { runDelete } from './DeleteCommand.js';
import {
	runChildren,
	runFind,
	runHistory,
	runLabels,
	runLinks,
	runList,
	runParents,
	runShow,
	runTree,
} from './ReadCommands.js';
import { runStatus } from './StatusCommand.js';
import { runType } from './TypeCommand.js';
import {
	runAddLabel,
	runLink,
	runNew,
	runRemoveLabel,
	runRemoveParent,
	runSetDescription,
	runSetMeta,
	runSetParent,
	runSetStatus,
	runSetTitle,
	runSetType,
	runUnsetMeta,
	runUnsetType,
} from './WriteCommands.js';

export const PROJECT_COMMANDS: ReadonlyMap<string, ProjectCommand> = new Map<string, ProjectCommand>([
	['new', runNew],
	['list', runList],
	['show', runShow],
	['history', runHistory],
	['set-status', runSetStatus],
	['link', runLink],
	['unlink', runLink],
	['links', runLinks],
	['set-type', runSetType],
	['add-label', runAddLabel],
	['remove-label', runRemoveLabel],
	['set-parent', runSetParent],
	['remove-parent', runRemoveParent],
	['children', runChildren],
	['parents', runParents],
	['tree', runTree],
	['set-meta', runSetMeta],
	['unset-meta', runUnsetMeta],
	['unset-type', runUnsetType],
	['set-title', runSetTitle],
	['set-description', runSetDescription],
	['find', runFind],
	['labels', runLabels],
	['delete', runDelete],
	['type', runType],
	['status', runStatus],
]);

/** Shown for an unknown command: every command word, including the ones that need no project. */
export const VALID_COMMANDS_HINT =
	'Valid commands: new, list, show, history, set-status, set-type, set-parent, remove-parent, children, parents, tree, link, unlink, links, add-label, remove-label, set-meta, unset-meta, unset-type, set-title, set-description, find, labels, delete, type, status, plugins, projects';
