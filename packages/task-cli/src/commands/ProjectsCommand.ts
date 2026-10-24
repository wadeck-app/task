// task projects summary: open/total tasks per project. The other `task projects` subcommands moved to the project CLI.
import { ConfigDir } from '@wadeck-app/shared-cli';

import { runProjectsSummary } from './GlobalViewCommands.js';
import { REMOVED_PROJECTS_SUBCOMMANDS, runRemovedProjectsSubcommand } from './RemovedCommands.js';
import { PROJECTS_HELP } from '../cli/help.js';
import { errorOutput, failure } from '../cli/output.js';
import type { CommandResult } from '../cli/output.js';

export function runProjectsCommand(rest: string[], jsonMode: boolean, cwd: string): CommandResult {
	const [subCmd, ...args] = rest;
	if (subCmd === undefined || subCmd === '--help') {
		return { exitCode: 0, output: PROJECTS_HELP };
	}
	if (REMOVED_PROJECTS_SUBCOMMANDS.has(subCmd)) {
		return runRemovedProjectsSubcommand(subCmd, args, cwd, jsonMode);
	}
	if (subCmd !== 'summary') {
		return errorOutput(
			jsonMode,
			`unknown task projects subcommand: ${subCmd}`,
			'Valid subcommand: summary (add, remove, move, prune and list moved to the project CLI)'
		);
	}
	try {
		return runProjectsSummary(args, jsonMode, ConfigDir.get('task'));
	} catch (error) {
		// A corrupt legacy list: the registry error carries its fix.
		return failure(jsonMode, error);
	}
}
