#!/usr/bin/env node
import { ConfigDir, UpdateManager } from '@wadeck-app/shared-cli';
import { logCliInvocation } from '@wadeck-app/shared-cli/CliLogger';
import { resolveOwnBundlePath } from '@wadeck-app/shared-cli/resolveOwnBundlePath';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { TaskConfigLoader } from '@wadeck-app/task-core';
import { createQueueEventSink, getTaskLogDir, openTaskContext, resolveQueueJsPath } from '@wadeck-app/task-service';
import { TASK_BUNDLE_NAME } from './TaskBundleName.js';
import { parseArgs } from './cli/args.js';
import type { CommandEnv } from './cli/env.js';
import { taskHelp } from './cli/help.js';
import { errorOutput, failure } from './cli/output.js';
import type { CommandResult } from './cli/output.js';
import { printUpdateNotice } from './cli/updateNotice.js';
import { runCliSubcommand } from './commands/CliSubcommands.js';
import { runListAllProjects } from './commands/GlobalViewCommands.js';
import { runInit } from './commands/InitCommand.js';
import { runPluginsCommand } from './commands/PluginsCommand.js';
import { runProjectsCommand } from './commands/ProjectsCommand.js';
import { PROJECT_COMMANDS, VALID_COMMANDS_HINT } from './commands/projectCommands.js';
import { VERSION } from './version.js';

export type { CommandResult } from './cli/output.js';

export async function runTaskCommand(args: string[], cwd: string): Promise<CommandResult> {
	const { configDir, projectDir, jsonMode, command, rest } = parseArgs(args);
	const effectiveProjectDir = projectDir ?? process.env['TASK_PROJECT_DIR'] ?? process.env['PROJECT_DIR'];
	const effectiveCwd = effectiveProjectDir ? path.resolve(cwd, effectiveProjectDir) : cwd;

	// Log every CLI invocation to ~/.config/task/logs/YYYY-MM-DD.ndjson
	try {
		logCliInvocation(ConfigDir.get('task'), 'task', args);
	} catch {
		/* never block the CLI on logging failure */
	}

	printUpdateNotice();

	if (!command || command === '--help') {
		return { exitCode: 0, output: taskHelp() };
	}
	if (command === '--version' || command === '-V') {
		return { exitCode: 0, output: VERSION };
	}
	if (command === 'init') {
		return runInit(effectiveCwd);
	}
	if (command === 'cli') {
		return runCliSubcommand(rest, jsonMode);
	}
	if (command === 'plugins') {
		return runPluginsCommand(rest, jsonMode);
	}
	if (command === 'projects') {
		return runProjectsCommand(rest, jsonMode, cwd);
	}

	// Across every registered project: needs no project here (the registry is in the global config dir).
	if (command === 'list' && rest.includes('--all-projects')) {
		return runListAllProjects(rest, jsonMode, ConfigDir.get('task'), projectDir);
	}

	if (!TaskConfigLoader.isInitialized(effectiveCwd)) {
		return errorOutput(jsonMode, 'project not initialized', 'Run: task init');
	}
	let env: CommandEnv;
	try {
		env = {
			command,
			jsonMode,
			ctx: openTaskContext({ projectDir: effectiveCwd, globalConfigDir: configDir }),
			// A one-shot CLI has no event loop to keep responsive: the synchronous lookup is kept (the HTTP routes use the async default).
			eventSink: createQueueEventSink({
				getLogDir: () => getTaskLogDir(ConfigDir.get('task')),
				resolveQueueJs: resolveQueueJsPath,
			}),
		};
	} catch (error) {
		return failure(jsonMode, error);
	}

	const handler = PROJECT_COMMANDS.get(command);
	if (handler === undefined) {
		return errorOutput(jsonMode, `unknown command: ${command}`, VALID_COMMANDS_HINT);
	}
	return handler(rest, env);
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const { exitCode, output } = await runTaskCommand(args, process.cwd());
	if (exitCode === 0) {
		if (output.length > 0) process.stdout.write(output + '\n');
	} else {
		if (output.length > 0) process.stderr.write(output + '\n');
	}

	// Schedule background updater after command completes
	const bundlePath = resolveOwnBundlePath(TASK_BUNDLE_NAME, fileURLToPath(import.meta.url));
	new UpdateManager('@wadeck-app/task-cli').scheduleBackgroundUpdate(bundlePath, 'task-updater.cjs');

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
