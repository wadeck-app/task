// Priority, assignee and claim commands: set-priority, unset-priority, set-assignee, unset-assignee, claim, release.
// Parsing and output only: the rules (scale, lease, conflicts, events) live in task-service.
import {
	claimTask,
	clearTaskAssignee,
	clearTaskPriority,
	deliverEvents,
	releaseTask,
	setTaskAssignee,
	setTaskPriority,
	withDescription,
} from '@wadeck-app/task-service';
import type { ClaimTaskResult, EventSink, TaskChangeResult } from '@wadeck-app/task-service';
import { MAX_LEASE_MINUTES, formatDuration } from '@wadeck-app/task-core';

import type { ProjectCommand } from '../cli/env.js';
import { errorOutput, failure, jsonResult } from '../cli/output.js';
import type { CommandResult } from '../cli/output.js';

const SET_PRIORITY_USAGE = 'Usage: task set-priority <id> <priority>';
const UNSET_PRIORITY_USAGE = 'Usage: task unset-priority <id>';
const SET_ASSIGNEE_USAGE =
	'Usage: task set-assignee <id> <name...>\nWords are joined with a space; put -- before a name that starts with --.';
const UNSET_ASSIGNEE_USAGE = 'Usage: task unset-assignee <id>';
const CLAIM_USAGE =
	'Usage: task claim <id> --as <name> [--lease <n>m|<n>h|<n>d] [--renew] [--force] [--json]\n' +
	'--as can be left out when the TASK_WORKER environment variable holds the name. The lease is a whole number with a unit: 30m, 2h, 1d.';
const RELEASE_USAGE = 'Usage: task release <id> [--as <name>] [--force] [--json]';

/** The non-empty arguments of a command that takes exactly the given positionals and no flag. */
function exactArgs(rest: string[], count: number, usage: string, jsonMode: boolean): string[] | CommandResult {
	const flag = rest.find(arg => arg.startsWith('--'));
	if (flag !== undefined) return errorOutput(jsonMode, `unknown flag: ${flag}`, usage);
	if (rest.length < count) return errorOutput(jsonMode, 'missing arguments', usage);
	if (rest.length > count) return errorOutput(jsonMode, `unexpected argument: ${rest[count]}`, usage);
	return rest;
}

export const runSetPriority: ProjectCommand = async (rest, { jsonMode, ctx, eventSink }) => {
	const args = exactArgs(rest, 2, SET_PRIORITY_USAGE, jsonMode);
	if (!Array.isArray(args)) return args as CommandResult;
	return changeOutput(jsonMode, eventSink, () => setTaskPriority(ctx, { id: args[0]!, priority: args[1]! }));
};

export const runUnsetPriority: ProjectCommand = async (rest, { jsonMode, ctx, eventSink }) => {
	const args = exactArgs(rest, 1, UNSET_PRIORITY_USAGE, jsonMode);
	if (!Array.isArray(args)) return args as CommandResult;
	return changeOutput(jsonMode, eventSink, () => clearTaskPriority(ctx, { id: args[0]! }));
};

export const runSetAssignee: ProjectCommand = async (rest, { jsonMode, ctx, eventSink }) => {
	const words: string[] = [];
	let literal = false;
	for (const arg of rest) {
		if (!literal && arg === '--') {
			literal = true;
		} else if (!literal && arg.startsWith('--')) {
			return errorOutput(jsonMode, `unknown flag: ${arg}`, SET_ASSIGNEE_USAGE);
		} else {
			words.push(arg);
		}
	}
	const [id, ...name] = words;
	if (!id || name.length === 0) {
		return errorOutput(jsonMode, 'missing arguments', SET_ASSIGNEE_USAGE);
	}
	return changeOutput(jsonMode, eventSink, () => setTaskAssignee(ctx, { id, assignee: name.join(' ') }));
};

export const runUnsetAssignee: ProjectCommand = async (rest, { jsonMode, ctx, eventSink }) => {
	const args = exactArgs(rest, 1, UNSET_ASSIGNEE_USAGE, jsonMode);
	if (!Array.isArray(args)) return args as CommandResult;
	return changeOutput(jsonMode, eventSink, () => clearTaskAssignee(ctx, { id: args[0]! }));
};

/** Runs a use case that returns `{task, events}`, delivers the events once the change is saved, prints the task. */
async function changeOutput(
	jsonMode: boolean,
	eventSink: EventSink,
	useCase: () => Promise<TaskChangeResult>
): Promise<CommandResult> {
	let result: TaskChangeResult;
	try {
		result = await useCase();
	} catch (error) {
		return failure(jsonMode, error);
	}
	await deliverEvents(eventSink, result.events);
	return jsonResult(withDescription(result.task));
}

export const LEASE_GRAMMAR =
	'A lease is a whole number and a unit: <n>m minutes, <n>h hours or <n>d days (for example 30m, 2h, 1d).';
const LEASE_UNIT_MINUTES: Record<string, number> = { m: 1, h: 60, d: 1440 };

/** `30m`, `2h`, `1d` to minutes. Anything else (seconds, decimals, a bare number, a sign, blanks) is an error naming the grammar. */
export function parseLease(text: string): number | string {
	const match = /^(\d+)([mhd])$/.exec(text);
	if (match === null) {
		return `--lease ${JSON.stringify(text)} is not a duration. ${LEASE_GRAMMAR}`;
	}
	const minutes = Number(match[1]) * LEASE_UNIT_MINUTES[match[2]!]!;
	if (minutes < 1 || minutes > MAX_LEASE_MINUTES) {
		return `--lease ${text} is out of range: a lease is 1 minute to ${MAX_LEASE_MINUTES / 1440} days. ${LEASE_GRAMMAR}`;
	}
	return minutes;
}

interface ClaimFlags {
	positionals: string[];
	as: string | undefined;
	lease: string | undefined;
	renew: boolean;
	force: boolean;
}

/** Flags of claim and release (`allowed` names the ones the command knows) anywhere among the positionals. */
function parseClaimFlags(
	rest: string[],
	usage: string,
	allowed: ReadonlySet<string>,
	jsonMode: boolean
): ClaimFlags | CommandResult {
	const flags: ClaimFlags = { positionals: [], as: undefined, lease: undefined, renew: false, force: false };
	for (let i = 0; i < rest.length; i++) {
		const arg = rest[i]!;
		if (!arg.startsWith('--')) {
			flags.positionals.push(arg);
		} else if (!allowed.has(arg)) {
			return errorOutput(jsonMode, `unknown flag: ${arg}`, usage);
		} else if (arg === '--as' || arg === '--lease') {
			const value = rest[++i];
			// A value starting with "-" is the next flag, not a value (`--as --renew` would claim as "--renew").
			if (value === undefined || value.startsWith('-')) {
				return errorOutput(
					jsonMode,
					value === undefined
						? `${arg} requires a value`
						: `${arg} requires a value, found ${JSON.stringify(value)} (a value cannot start with "-").${arg === '--lease' ? ` ${LEASE_GRAMMAR}` : ''}`,
					usage
				);
			}
			if (arg === '--as') flags.as = value;
			else flags.lease = value;
		} else if (arg === '--renew') {
			flags.renew = true;
		} else {
			flags.force = true;
		}
	}
	return flags;
}

export const runClaim: ProjectCommand = async (rest, { jsonMode, ctx, eventSink }) => {
	const flags = parseClaimFlags(rest, CLAIM_USAGE, new Set(['--as', '--lease', '--renew', '--force']), jsonMode);
	if ('exitCode' in flags) return flags;
	const [id, extra] = flags.positionals;
	if (!id) return errorOutput(jsonMode, 'missing id', CLAIM_USAGE);
	if (extra !== undefined) return errorOutput(jsonMode, `unexpected argument: ${extra}`, CLAIM_USAGE);
	// A blank --as or TASK_WORKER counts as unset: a blank name would claim as nobody.
	const assignee = workerName(flags.as);
	if (assignee === undefined) {
		return errorOutput(
			jsonMode,
			'who is claiming? --as <name> is required when the TASK_WORKER environment variable is not set',
			CLAIM_USAGE
		);
	}
	let leaseMinutes: number | undefined;
	if (flags.lease !== undefined) {
		const parsed = parseLease(flags.lease);
		if (typeof parsed === 'string') return errorOutput(jsonMode, parsed, CLAIM_USAGE);
		leaseMinutes = parsed;
	}
	const now = new Date();
	let result: Awaited<ReturnType<typeof claimTask>>;
	try {
		result = await claimTask(ctx, {
			id,
			assignee,
			now,
			...(leaseMinutes === undefined ? {} : { leaseMinutes }),
			...(flags.renew ? { renew: true } : {}),
			...(flags.force ? { force: true } : {}),
		});
	} catch (error) {
		return failure(jsonMode, error);
	}
	await deliverEvents(eventSink, result.events);
	return claimOutput(jsonMode, result, assignee, now);
};

/** What `claim` and `next` print for a claimed task: the JSON answer, or one line with the lease. */
export function claimOutput(jsonMode: boolean, result: ClaimTaskResult, assignee: string, now: Date): CommandResult {
	const { task, outcome, previousAssignee, leaseUntil } = result;
	if (jsonMode) {
		return jsonResult({
			taskId: task.id,
			outcome,
			assignee: task.assignee,
			claimedAt: task.claimedAt,
			leaseUntil,
			...(previousAssignee === undefined ? {} : { previousAssignee }),
			revision: task.revision,
			task: withDescription(task),
		});
	}
	const lease = formatDuration(Date.parse(leaseUntil) - now.getTime());
	const who = task.assignee ?? assignee;
	const line =
		outcome === 'takeover'
			? `took over ${task.id} from ${previousAssignee ?? 'nobody'} as ${who}`
			: `${outcome === 'renewed' ? 'renewed' : 'claimed'} ${task.id} as ${who}`;
	return { exitCode: 0, output: `${line} until ${leaseUntil} (${lease})` };
}

/** The worker name: `--as`, else TASK_WORKER; a blank one counts as unset (a blank name would claim as nobody). */
export function workerName(asFlag: string | undefined): string | undefined {
	return [asFlag, process.env['TASK_WORKER']].map(value => value?.trim()).find(value => value);
}

export const runRelease: ProjectCommand = async (rest, { jsonMode, ctx, eventSink }) => {
	const flags = parseClaimFlags(rest, RELEASE_USAGE, new Set(['--as', '--force']), jsonMode);
	if ('exitCode' in flags) return flags;
	const [id, extra] = flags.positionals;
	if (!id) return errorOutput(jsonMode, 'missing id', RELEASE_USAGE);
	if (extra !== undefined) return errorOutput(jsonMode, `unexpected argument: ${extra}`, RELEASE_USAGE);
	let result: Awaited<ReturnType<typeof releaseTask>>;
	try {
		result = await releaseTask(ctx, {
			id,
			...(flags.as === undefined ? {} : { assignee: flags.as }),
			...(flags.force ? { force: true } : {}),
		});
	} catch (error) {
		return failure(jsonMode, error);
	}
	await deliverEvents(eventSink, result.events);
	return jsonMode
		? jsonResult({
				taskId: result.task.id,
				previousAssignee: result.previousAssignee,
				task: withDescription(result.task),
			})
		: { exitCode: 0, output: `released ${result.task.id} (was held by ${result.previousAssignee})` };
};
