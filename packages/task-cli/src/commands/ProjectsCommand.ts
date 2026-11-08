// task projects summary: open/total tasks per project.
import { runProjectsSummary } from './GlobalViewCommands.js';
import { PROJECTS_HELP } from '../cli/help.js';
import { errorOutput, failure } from '../cli/output.js';
import type { CommandResult } from '../cli/output.js';

export async function runProjectsCommand(rest: string[], jsonMode: boolean): Promise<CommandResult> {
	const [subCmd, ...args] = rest;
	if (subCmd === undefined || subCmd === '--help') {
		return { exitCode: 0, output: PROJECTS_HELP };
	}
	if (subCmd !== 'summary') {
		return errorOutput(jsonMode, `unknown task projects subcommand: ${subCmd}`, 'Valid subcommand: summary');
	}
	try {
		// Awaited here, inside the try: a rejected summary must reach the catch below.
		return await runProjectsSummary(args, jsonMode);
	} catch (error) {
		// The registry error carries its own fix.
		return failure(jsonMode, error);
	}
}
