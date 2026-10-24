// task status list: the valid statuses of the project, in order, with the default and the terminal ones.
import { listStatuses } from '@wadeck-app/task-service';
import type { StatusInfo } from '@wadeck-app/task-service';

import type { ProjectCommand } from '../cli/env.js';
import { STATUS_HELP } from '../cli/help.js';
import { errorOutput, jsonResult } from '../cli/output.js';

export const STATUS_LIST_USAGE = 'Usage: task status list [--json]';

/** `task status` / `task status --help` need no project: the dispatcher answers them before resolving one. */
export function isStatusHelp(rest: readonly string[]): boolean {
	return rest[0] === undefined || rest[0] === '--help';
}

/** `doing (default)`, `done (terminal)`, `only (default, terminal)`, or the bare name. */
function statusLine(status: StatusInfo): string {
	const markers = [...(status.default ? ['default'] : []), ...(status.terminal ? ['terminal'] : [])];
	return markers.length === 0 ? status.name : `${status.name} (${markers.join(', ')})`;
}

export const runStatus: ProjectCommand = (rest, { jsonMode, ctx }) => {
	const [subCmd, ...args] = rest;
	if (isStatusHelp(rest)) {
		return { exitCode: 0, output: STATUS_HELP };
	}
	if (subCmd !== 'list') {
		return errorOutput(jsonMode, `unknown task status subcommand: ${subCmd}`, 'Valid subcommands: list');
	}
	if (args.length > 0) {
		return errorOutput(jsonMode, `unexpected argument: ${args[0]}`, STATUS_LIST_USAGE);
	}
	const statuses = listStatuses(ctx);
	if (jsonMode) return jsonResult(statuses);
	return { exitCode: 0, output: statuses.map(statusLine).join('\n') };
};
