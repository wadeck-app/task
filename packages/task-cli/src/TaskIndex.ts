#!/usr/bin/env node
import { ConfigDir, UpdateManager } from '@wadeck-app/shared-cli';
import { logCliInvocation } from '@wadeck-app/shared-cli/CliLogger';
import { resolveOwnBundlePath } from '@wadeck-app/shared-cli/resolveOwnBundlePath';
import { fileURLToPath } from 'node:url';

import {
	appendTaskLog,
	createQueueEventSink,
	getTaskLogDir,
	openResolvedProject,
	readProjectOption,
	resolveProjectFromArgs,
} from '@wadeck-app/task-service';
import type { ProjectOption, ResolvedProject } from '@wadeck-app/task-service';
import { declareBeforeFirstDelivery } from './QueueEventsDeclaration.js';
import { TASK_BUNDLE_NAME } from './TaskBundleName.js';
import { parseArgs, usesProjectDirOption } from './cli/args.js';
import type { CommandEnv } from './cli/env.js';
import { STATUS_HELP, taskHelp } from './cli/help.js';
import { errorOutput, failure } from './cli/output.js';
import type { CommandResult } from './cli/output.js';
import { printUpdateNotice } from './cli/updateNotice.js';
import { runCliSubcommand } from './commands/CliSubcommands.js';
import { describeProjectSelection, runListAllProjects } from './commands/GlobalViewCommands.js';
import { runPluginsCommand } from './commands/PluginsCommand.js';
import { runProjectsCommand } from './commands/ProjectsCommand.js';
import { isStatusHelp } from './commands/StatusCommand.js';
import { PROJECT_COMMANDS, VALID_COMMANDS_HINT } from './commands/projectCommands.js';
import { VERSION } from './version.js';

export type { CommandResult } from './cli/output.js';

export async function runTaskCommand(args: string[], cwd: string): Promise<CommandResult> {
	// The project flag and TASK_PROJECT are read by the shared SDK. A malformed flag (no value, repeated) is only an error for
	// a command that needs a project: help, status and 'projects' do not look at it, so the error waits until then.
	let projectOption: ProjectOption = { args };
	let projectOptionError: unknown;
	try {
		projectOption = readProjectOption(args);
	} catch (error) {
		projectOptionError = error;
	}
	const { configDir, jsonMode, command, rest } = parseArgs(projectOption.args);

	// Log every CLI invocation to ~/.config/task/logs/YYYY-MM-DD.ndjson
	try {
		logCliInvocation(ConfigDir.get('task'), 'task', args);
	} catch {
		/* never block the CLI on logging failure */
	}

	// The CLI does not reject unknown options in general: without this, `--project-dir x` would be taken for an argument and the command
	// would silently run on the project of the cwd, which may not be the one the user meant.
	if (usesProjectDirOption(args)) {
		return errorOutput(
			jsonMode,
			'unknown option: --project-dir',
			'Select the project with -p <id|name|alias> or run from a registered folder (register one with: project add "<dir>")'
		);
	}

	printUpdateNotice();

	if (!command || command === '--help') {
		return { exitCode: 0, output: taskHelp() };
	}
	if (command === '--version' || command === '-V') {
		return { exitCode: 0, output: VERSION };
	}
	if (command === 'cli') {
		return runCliSubcommand(rest, jsonMode);
	}
	if (command === 'plugins') {
		return runPluginsCommand(rest, jsonMode);
	}
	if (command === 'projects') {
		return runProjectsCommand(rest, jsonMode);
	}
	// Help needs no project (the listing itself does: it goes through the handler below).
	if (command === 'status' && isStatusHelp(rest)) {
		return { exitCode: 0, output: STATUS_HELP };
	}

	// Across every registered project: needs no project here.
	if (command === 'list' && rest.includes('--all-projects')) {
		if (projectOptionError !== undefined) return failure(jsonMode, projectOptionError);
		return runListAllProjects(rest, jsonMode, describeProjectSelection(projectOption));
	}

	// Checked before the project is looked up: an unknown command fails the same way in any folder.
	const handler = PROJECT_COMMANDS.get(command);
	if (handler === undefined) {
		return errorOutput(jsonMode, `unknown command: ${command}`, VALID_COMMANDS_HINT);
	}

	let env: CommandEnv;
	try {
		if (projectOptionError !== undefined) throw projectOptionError;
		const resolved = resolveProjectFromArgs({ cwd, argv: args }).project;
		announceResolution(resolved);
		env = {
			command,
			jsonMode,
			ctx: openResolvedProject(resolved, configDir),
			// The first event of the process declares the task events to the queue, unless the marker says it was done.
			eventSink: declareBeforeFirstDelivery(
				createQueueEventSink({ getLogDir: () => getTaskLogDir(ConfigDir.get('task')) }),
				{ configDir: ConfigDir.get('task'), taskVersion: VERSION }
			),
		};
	} catch (error) {
		return failure(jsonMode, error);
	}

	try {
		return await handler(rest, env);
	} finally {
		// main() exits the process right after: let the queue SDK finish what it has in flight first.
		await env.eventSink.flush?.();
	}
}

/** How the project was found goes to the task log (Decision #12b). */
function announceResolution(resolved: ResolvedProject): void {
	appendTaskLog(getTaskLogDir(ConfigDir.get('task')), 'info', resolved.logLine);
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const { exitCode, output } = await runTaskCommand(args, process.cwd());
	if (exitCode === 0) {
		if (output.length > 0) process.stdout.write(output + '\n');
	} else {
		if (output.length > 0) process.stderr.write(output + '\n');
	}

	// Schedule background updater after command completes. Passing VERSION: shared-cli spawns nothing for a repo-built dev bundle.
	const bundlePath = resolveOwnBundlePath(TASK_BUNDLE_NAME, fileURLToPath(import.meta.url));
	new UpdateManager('@wadeck-app/task-cli').scheduleBackgroundUpdate(bundlePath, 'task-updater.cjs', VERSION);

	process.exit(exitCode);
}

const isEntryPoint =
	process.argv[1] !== undefined &&
	(process.argv[1] === fileURLToPath(import.meta.url) ||
		process.argv[1].endsWith('TaskIndex.js') ||
		process.argv[1].endsWith('TaskIndex.ts'));

if (isEntryPoint) {
	main().catch(error => {
		process.stderr.write(`Error: ${String(error)}\n`);
		process.exit(1);
	});
}
