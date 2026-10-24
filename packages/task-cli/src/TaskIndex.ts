#!/usr/bin/env node
import { ConfigDir, UpdateManager } from '@wadeck-app/shared-cli';
import { logCliInvocation } from '@wadeck-app/shared-cli/CliLogger';
import { resolveOwnBundlePath } from '@wadeck-app/shared-cli/resolveOwnBundlePath';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	appendTaskLog,
	createQueueEventSink,
	getTaskLogDir,
	openTaskContext,
	resolveProject,
} from '@wadeck-app/task-service';
import type { ResolvedProject } from '@wadeck-app/task-service';
import { declareBeforeFirstDelivery } from './QueueEventsDeclaration.js';
import { TASK_BUNDLE_NAME } from './TaskBundleName.js';
import { parseArgs } from './cli/args.js';
import type { CommandEnv } from './cli/env.js';
import { taskHelp } from './cli/help.js';
import { errorOutput, failure } from './cli/output.js';
import type { CommandResult } from './cli/output.js';
import { printUpdateNotice } from './cli/updateNotice.js';
import { runCliSubcommand } from './commands/CliSubcommands.js';
import { describeProjectSelection, runListAllProjects } from './commands/GlobalViewCommands.js';
import { runInit } from './commands/InitCommand.js';
import { runPluginsCommand } from './commands/PluginsCommand.js';
import { runProjectsCommand } from './commands/ProjectsCommand.js';
import { PROJECT_COMMANDS, VALID_COMMANDS_HINT } from './commands/projectCommands.js';
import { VERSION } from './version.js';

export type { CommandResult } from './cli/output.js';

export async function runTaskCommand(args: string[], cwd: string): Promise<CommandResult> {
	const { configDir, projectDir, projectRef, jsonMode, command, rest } = parseArgs(args);
	// `task init` keeps the pre-registry rule in stage 1: it creates a .task in --project-dir / TASK_PROJECT_DIR / PROJECT_DIR / cwd.
	const legacyProjectDir = projectDir ?? process.env['TASK_PROJECT_DIR'] ?? process.env['PROJECT_DIR'];
	const effectiveCwd = legacyProjectDir ? path.resolve(cwd, legacyProjectDir) : cwd;

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
		return runProjectsCommand(rest, jsonMode, cwd, { projectDir, projectRef });
	}

	// Across every registered project: needs no project here (the registry is in the global config dir).
	if (command === 'list' && rest.includes('--all-projects')) {
		return runListAllProjects(
			rest,
			jsonMode,
			ConfigDir.get('task'),
			describeProjectSelection(projectDir, projectRef)
		);
	}

	let env: CommandEnv;
	try {
		const resolved = resolveProject({ cwd, projectRef, projectDir });
		announceResolution(resolved);
		env = {
			command,
			jsonMode,
			ctx: openTaskContext({
				projectDir: resolved.path,
				globalConfigDir: configDir,
				project: { id: resolved.id, name: resolved.name },
			}),
			// The first event of the process declares the task events to the queue, unless the marker says it was done.
			eventSink: declareBeforeFirstDelivery(
				createQueueEventSink({ getLogDir: () => getTaskLogDir(ConfigDir.get('task')) }),
				{ configDir: ConfigDir.get('task'), taskVersion: VERSION }
			),
		};
	} catch (error) {
		return failure(jsonMode, error);
	}

	const handler = PROJECT_COMMANDS.get(command);
	if (handler === undefined) {
		return errorOutput(jsonMode, `unknown command: ${command}`, VALID_COMMANDS_HINT);
	}
	try {
		return await handler(rest, env);
	} finally {
		// main() exits the process right after: let the queue SDK finish what it has in flight first.
		await env.eventSink.flush?.();
	}
}

/**
 * How the project was found goes to the task log (Decision #12b). A project found by the legacy rule (not in the shared
 * registry) is announced on stderr, whatever the output mode, so that stdout stays the answer.
 */
function announceResolution(resolved: ResolvedProject): void {
	appendTaskLog(getTaskLogDir(ConfigDir.get('task')), 'info', resolved.logLine);
	if (resolved.legacyWarning !== undefined) process.stderr.write(resolved.legacyWarning + '\n');
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
