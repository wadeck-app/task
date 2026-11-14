// `task next`: claim the first available task in order. Parsing and output only: the selection, the ordering, the retry over lost
// races and the claim are task-service's nextTask.
import { deliverEvents, nextTask } from '@wadeck-app/task-service';

import type { ProjectCommand } from '../cli/env.js';
import { errorOutput, failure, jsonResult } from '../cli/output.js';
import type { CommandResult } from '../cli/output.js';
import { readSelectionFlag, repeatedProblem, valueProblem } from './ListFlags.js';
import type { SelectionFlags } from './ListFlags.js';
import { LEASE_GRAMMAR, claimOutput, parseLease, workerName } from './PriorityAssigneeCommands.js';

const NEXT_USAGE =
	'Usage: task next --as <name> [--status a,b] [--priority a,b] [--order <name>] [--lease <n>m|<n>h|<n>d] [--include-blocked] [--fresh] [--json]\n' +
	'--as can be left out when the TASK_WORKER environment variable holds the name. Default statuses: every non-terminal status; default order: priority-then-oldest; tasks with an open blockedBy link are skipped unless --include-blocked.';

export const runNext: ProjectCommand = async (rest, { jsonMode, ctx, eventSink }) => {
	const flags: SelectionFlags = { fresh: false };
	let as: string | undefined;
	let lease: string | undefined;
	let includeBlocked = false;
	for (let i = 0; i < rest.length; i++) {
		const arg = rest[i]!;
		if (arg === '--as' || arg === '--lease') {
			const value = rest[i + 1];
			const problem = valueProblem(arg, value);
			if (problem !== undefined) {
				return errorOutput(jsonMode, arg === '--lease' ? `${problem}. ${LEASE_GRAMMAR}` : problem, NEXT_USAGE);
			}
			const repeated = repeatedProblem(arg, arg === '--as' ? as !== undefined : lease !== undefined);
			if (repeated !== undefined) return errorOutput(jsonMode, repeated, NEXT_USAGE);
			if (arg === '--as') as = value;
			else lease = value;
			i++;
		} else if (arg === '--include-blocked') {
			includeBlocked = true;
		} else if (arg.startsWith('-')) {
			const read = readSelectionFlag(rest, i, flags);
			if (read === undefined) return errorOutput(jsonMode, `unknown flag: ${arg}`, NEXT_USAGE);
			if ('problem' in read) return errorOutput(jsonMode, read.problem, NEXT_USAGE);
			i += read.consumed;
		} else {
			return errorOutput(jsonMode, `unexpected argument: ${arg}`, NEXT_USAGE);
		}
	}
	const assignee = workerName(as);
	if (assignee === undefined) {
		return errorOutput(
			jsonMode,
			'who is claiming? --as <name> is required when the TASK_WORKER environment variable is not set',
			NEXT_USAGE
		);
	}
	let leaseMinutes: number | undefined;
	if (lease !== undefined) {
		const parsed = parseLease(lease);
		if (typeof parsed === 'string') return errorOutput(jsonMode, parsed, NEXT_USAGE);
		leaseMinutes = parsed;
	}
	const now = new Date();
	let result: Awaited<ReturnType<typeof nextTask>>;
	try {
		result = await nextTask(ctx, {
			assignee,
			now,
			...(flags.statuses === undefined ? {} : { statuses: flags.statuses }),
			...(flags.priorities === undefined ? {} : { priorities: flags.priorities }),
			...(flags.order === undefined ? {} : { order: flags.order }),
			...(leaseMinutes === undefined ? {} : { leaseMinutes }),
			...(flags.fresh ? { fresh: true } : {}),
			...(includeBlocked ? { includeBlocked: true } : {}),
		});
	} catch (error) {
		return failure(jsonMode, error);
	}
	if (result.claim === undefined) return describeNoTask(result.lost, result.skippedBlocked, jsonMode);
	await deliverEvents(eventSink, result.claim.events);
	const printed = claimOutput(jsonMode, result.claim, assignee, now);
	return jsonMode
		? jsonResult({ ...(JSON.parse(printed.output) as object), skippedBlocked: result.skippedBlocked })
		: printed;
};

/**
 * Nothing was claimed. That is an answer, not a failure (a dispatcher polls this command), but a lost race must not read as an empty
 * queue: `lost` says how many candidates other workers took meanwhile.
 */
export function describeNoTask(lost: number, skippedBlocked: number, jsonMode: boolean): CommandResult {
	if (jsonMode) return jsonResult({ task: null, lost, skippedBlocked });
	return {
		exitCode: 0,
		output:
			lost === 0
				? 'no available task'
				: `no available task: ${lost} candidate(s) were claimed by other workers meanwhile, retry`,
	};
}
