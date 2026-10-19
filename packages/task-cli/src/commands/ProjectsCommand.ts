// task projects list|add|remove|prune: the projects registered (by `task init` or `add`) with the task app-module. Needs no project.
import { ConfigDir } from '@wadeck-app/shared-cli';
import {
	inspectRegisteredProjects,
	isSameProjectDir,
	listRegisteredProjects,
	pruneMissingProjects,
	registerInitializedProject,
	unregisterProject,
} from '@wadeck-app/task-service';
import type { ProjectHealth } from '@wadeck-app/task-service';
import * as path from 'node:path';

import { PROJECTS_HELP } from '../cli/help.js';
import { errorOutput, failure, jsonResult } from '../cli/output.js';
import type { CommandResult } from '../cli/output.js';

function statusFlag(project: ProjectHealth): string {
	if (!project.exists) return '[missing]';
	if (!project.initialized) return '[not initialized]';
	return project.error === null ? '[ok]' : `[unreadable: ${project.error}]`;
}

function runList(rest: string[], jsonMode: boolean, configDir: string): CommandResult {
	if (rest.length > 0) {
		return errorOutput(jsonMode, `unexpected argument: ${rest[0]}`, 'Usage: task projects list [--json]');
	}
	const projects = inspectRegisteredProjects(configDir);
	if (jsonMode) return jsonResult(projects);
	if (projects.length === 0) {
		return {
			exitCode: 0,
			output: '(no project registered -- run `task init` in a project directory to register it)',
		};
	}
	return { exitCode: 0, output: projects.map(p => `${p.path}  ${statusFlag(p)}`).join('\n') };
}

function runAdd(rest: string[], jsonMode: boolean, configDir: string, cwd: string): CommandResult {
	const [dir, ...extra] = rest;
	if (extra.length > 0) {
		return errorOutput(jsonMode, `unexpected argument: ${extra[0]}`, 'Usage: task projects add [dir]');
	}
	const result = registerInitializedProject(configDir, path.resolve(cwd, dir ?? '.'));
	if (jsonMode) return jsonResult(result);
	return { exitCode: 0, output: `${result.added ? 'Registered project' : 'Already registered'}: ${result.path}` };
}

function runRemove(rest: string[], jsonMode: boolean, configDir: string, cwd: string): CommandResult {
	const usage = 'Usage: task projects remove <dir>';
	const [dir, ...extra] = rest;
	if (!dir) {
		return errorOutput(jsonMode, 'missing project directory', usage);
	}
	if (extra.length > 0) {
		return errorOutput(jsonMode, `unexpected argument: ${extra[0]}`, usage);
	}
	const target = path.resolve(cwd, dir);
	// The path as stored is reported, so the user sees which entry went (the match ignores case on Windows).
	const stored = listRegisteredProjects(configDir).find(p => isSameProjectDir(p, target));
	if (stored === undefined || !unregisterProject(configDir, target).removed) {
		return errorOutput(
			jsonMode,
			`project "${target}" is not registered`,
			'Run `task projects list` to see the registered directories.'
		);
	}
	return jsonMode ? jsonResult({ removed: stored }) : { exitCode: 0, output: `Removed project: ${stored}` };
}

function runPrune(rest: string[], jsonMode: boolean, configDir: string): CommandResult {
	const usage = 'Usage: task projects prune [--dry-run] [--json]';
	const unknown = rest.find(arg => arg !== '--dry-run');
	if (unknown !== undefined) {
		return errorOutput(jsonMode, `unknown flag: ${unknown}`, usage);
	}
	const dryRun = rest.includes('--dry-run');
	const { removed } = pruneMissingProjects(configDir, { dryRun });
	if (jsonMode) return jsonResult({ dryRun, removed });
	if (removed.length === 0) {
		return { exitCode: 0, output: 'Nothing to prune: every registered directory exists.' };
	}
	const verb = dryRun ? 'Would remove' : 'Removed';
	return { exitCode: 0, output: removed.map(p => `${verb} ${p}`).join('\n') };
}

export function runProjectsCommand(rest: string[], jsonMode: boolean, cwd: string): CommandResult {
	const [subCmd, ...args] = rest;
	if (subCmd === undefined || subCmd === '--help') {
		return { exitCode: 0, output: PROJECTS_HELP };
	}
	try {
		const configDir = ConfigDir.get('task');
		switch (subCmd) {
			case 'list':
				return runList(args, jsonMode, configDir);
			case 'add':
				return runAdd(args, jsonMode, configDir, cwd);
			case 'remove':
				return runRemove(args, jsonMode, configDir, cwd);
			case 'prune':
				return runPrune(args, jsonMode, configDir);
			// violations-suppress: ts/no-switch-default-break returns a user-facing error, not a silent fallback
			default:
				return errorOutput(
					jsonMode,
					`unknown task projects subcommand: ${subCmd}`,
					'Valid subcommands: list, add, remove, prune'
				);
		}
	} catch (error) {
		// A corrupt or unwritable registry: the registry error carries its fix.
		return failure(jsonMode, error);
	}
}
