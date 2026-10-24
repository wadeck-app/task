// Commands that moved to the `project` CLI in stage 2a (Decision #20): they stay as words that fail loudly with the replacement,
// never as silent no-ops. `task projects summary` and `task list --all-projects` are task features and stay.
import * as path from 'node:path';

import { errorOutput } from '../cli/output.js';
import type { CommandResult } from '../cli/output.js';

/** `task init`: projects are created and registered with the project CLI (the data lives in its registry folder). */
export function runRemovedInit(dir: string, jsonMode: boolean): CommandResult {
	return errorOutput(
		jsonMode,
		'task init was removed: projects are created with the project CLI, and their tasks live in its registry folder',
		`Run: project add "${dir}" [--name <name>]  (a project that still has a .task folder: then run \`task cli migrate-data -p <name>\` to copy its tasks)`
	);
}

/** The project CLI command that replaces a removed `task projects <sub>`. */
function replacement(sub: string, args: string[], cwd: string): string {
	switch (sub) {
		case 'add':
			return `project add "${path.resolve(cwd, args[0] ?? '.')}" [--name <name>]`;
		case 'remove':
			return 'project remove <name|id>  (see `project list`)';
		case 'move':
			return "project paths move <name|id> <old-dir> <new-dir>  (see 'project paths --help')";
		case 'prune':
			return 'project list to see the registered projects, then project remove <name|id> for each vanished one, or project paths move when it moved';
		default:
			return 'project list';
	}
}

/** `task projects add|remove|move|prune|list`: removed, answers with the replacement. Exit 1. */
export function runRemovedProjectsSubcommand(
	sub: string,
	args: string[],
	cwd: string,
	jsonMode: boolean
): CommandResult {
	return errorOutput(
		jsonMode,
		`task projects ${sub} was removed: the projects belong to the shared project registry, managed by the project CLI`,
		`Run: ${replacement(sub, args, cwd)}`
	);
}

/** The subcommands of `task projects` that were removed. */
export const REMOVED_PROJECTS_SUBCOMMANDS: ReadonlySet<string> = new Set(['add', 'remove', 'move', 'prune', 'list']);
