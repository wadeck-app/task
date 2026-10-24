// task delete: argument parsing and output over planDelete / executeDelete.
import {
	PartialDeleteError,
	TaskServiceError,
	deliverEvents,
	describeDeleteEffects,
	executeDelete,
	planDelete,
	selectDeleteTargets,
} from '@wadeck-app/task-service';
import type { DeletePlan, DeleteSelectionProblem, ExecuteDeleteResult } from '@wadeck-app/task-service';

import type { ProjectCommand } from '../cli/env.js';
import { errorOutput, failure, taskLine } from '../cli/output.js';
import type { CommandResult } from '../cli/output.js';

const DELETE_USAGE = 'Usage: task delete <id>[,<id2>,...] | --all | --filter <field>=<value>';

/** The CLI wording of a selection that cannot be used. */
function selectionProblemOutput(jsonMode: boolean, problem: DeleteSelectionProblem): CommandResult {
	switch (problem) {
		case 'all-and-filter':
			return errorOutput(jsonMode, '--all and --filter cannot be combined');
		case 'ids-with-all-or-filter':
			return errorOutput(jsonMode, 'positional IDs cannot be combined with --all or --filter');
		case 'none':
		case 'empty-ids':
			return errorOutput(jsonMode, 'missing arguments', DELETE_USAGE);
	}
}

/** The `--dry-run` text: what would be deleted and the side effects. */
function previewText(plan: DeletePlan): string {
	return [
		'Would delete:',
		...plan.tasks.map(taskLine),
		`Total: ${plan.tasks.length} task(s).`,
		...describeDeleteEffects(plan, 'would'),
	].join('\n');
}

export const runDelete: ProjectCommand = async (rest, { jsonMode, ctx, eventSink }) => {
	let dryRun = false;
	let all = false;
	// Like SQL ON DELETE CASCADE: also delete every descendant (default: children become root tasks).
	let cascade = false;
	let filter: string | undefined;
	const ids: string[] = [];

	let i = 0;
	while (i < rest.length) {
		const arg = rest[i]!;
		if (arg === '--dry-run') {
			dryRun = true;
			i++;
		} else if (arg === '--all') {
			all = true;
			i++;
		} else if (arg === '--cascade-delete') {
			cascade = true;
			i++;
		} else if (arg === '--filter') {
			filter = rest[i + 1];
			i += 2;
		} else if (arg.startsWith('--')) {
			return errorOutput(
				jsonMode,
				`unknown flag: ${arg}`,
				'Valid flags: --all, --filter <field>=<value>, --dry-run, --cascade-delete'
			);
		} else {
			// Comma-separated IDs allowed in a single positional arg
			ids.push(...arg.split(',').filter(s => s.length > 0));
			i++;
		}
	}

	let plan: DeletePlan;
	try {
		const selection = selectDeleteTargets({ ids: ids.length > 0 ? ids : undefined, all, filter });
		if ('problem' in selection) {
			return selectionProblemOutput(jsonMode, selection.problem);
		}
		plan = planDelete(ctx, { selector: selection.selector, cascade });
	} catch (error) {
		if (error instanceof TaskServiceError) {
			return failure(jsonMode, error);
		}
		throw error;
	}
	// Unknown ids only warn: the others are still deleted.
	for (const rawId of plan.notFound) {
		process.stderr.write(`Warning: task not found: ${rawId}\n`);
	}

	if (plan.tasks.length === 0) {
		return { exitCode: 0, output: 'Nothing to delete.' };
	}
	if (dryRun) {
		return { exitCode: 0, output: previewText(plan) };
	}
	let result: ExecuteDeleteResult;
	try {
		result = executeDelete(ctx, plan);
	} catch (error) {
		// Tasks deleted before the failure are gone for good: their events are delivered before the failure is reported.
		if (error instanceof PartialDeleteError) {
			await deliverEvents(eventSink, error.events);
		}
		return failure(jsonMode, error);
	}
	const { deletedCount, events } = result;
	// Delivered after the deletion is done (a failed push only warns, see the sink).
	await deliverEvents(eventSink, events);
	return {
		exitCode: 0,
		output: [`Deleted ${deletedCount} task(s).`, ...describeDeleteEffects(plan, 'did')].join('\n'),
	};
};
