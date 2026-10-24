// task cli migrate-data [-p <ref>] [--dry-run] [--json]: copies the .task of a registered project into the shared registry.
import { migrateData } from '@wadeck-app/task-service';
import type { MigrateDataResult, ResolvedProject } from '@wadeck-app/task-service';

import { errorOutput, failure, jsonResult } from '../cli/output.js';
import type { CommandResult } from '../cli/output.js';

export const MIGRATE_DATA_USAGE = 'Usage: task cli migrate-data [-p <ref>] [--dry-run] [--json]';

function bytes(count: number): string {
	return `${count} byte${count === 1 ? '' : 's'}`;
}

function plural(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function describe(result: MigrateDataResult): string {
	const { project, source, destination, tasks, index, config } = result;
	const lines = [
		`${result.dryRun ? 'Dry run, would copy' : 'Copied'} the data of project ${project.name} (${project.id})`,
		`  from ${source}`,
		`  to   ${destination.dataDir}`,
		`  ${plural(tasks.count, 'task')} (${bytes(tasks.bytes)})`,
		`  task-index.json: ${index.copied ? bytes(index.bytes) : 'not in the source'}`,
		`  config.yml: ${config.copied ? `${bytes(config.bytes)} -> ${destination.configFile}` : 'not in the source'}`,
	];
	if (result.notCopied.length > 0) lines.push(`  not copied (not task files): ${result.notCopied.join(', ')}`);
	for (const warning of result.warnings) lines.push(`Warning: ${warning}`);
	lines.push(result.nextStep);
	return lines.join('\n');
}

/**
 * `resolve` returns the project of the run (the same resolution as every command: -p, TASK_PROJECT, the cwd) and may throw its
 * typed errors. The copy is refused with the reason and the next step when the project is virtual, has nothing
 * to copy, or already has data in the registry; the `.task` is never modified.
 */
export function runMigrateData(args: string[], jsonMode: boolean, resolve: () => ResolvedProject): CommandResult {
	const unknown = args.find(arg => arg !== '--dry-run');
	if (unknown !== undefined) {
		return errorOutput(jsonMode, `unknown argument: ${unknown}`, MIGRATE_DATA_USAGE);
	}
	try {
		const result = migrateData(resolve(), { dryRun: args.includes('--dry-run') });
		return jsonMode ? jsonResult(result) : { exitCode: 0, output: describe(result) };
	} catch (error) {
		return failure(jsonMode, error);
	}
}
