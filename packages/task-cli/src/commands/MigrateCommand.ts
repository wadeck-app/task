// task migrate: arguments and printing over the task-service migration (`migrateProjects`). The engine, the loss table and the journal
// live in task-service; this file parses the command line, resolves the two registered projects and prints the result.
import {
	DEFAULT_MIGRATION_OPTIONS,
	deliverEvents,
	describeError,
	migrateProjects,
	resolveProjectReference,
} from '@wadeck-app/task-service';
import type {
	EventSink,
	LossRow,
	MigrationOptions,
	MigrationProgress,
	MigrationResult,
	ResolvedProject,
} from '@wadeck-app/task-service';

import { MIGRATE_HELP } from '../cli/help.js';
import { errorOutput, failure } from '../cli/output.js';
import type { CommandResult } from '../cli/output.js';

const USAGE =
	'Usage: task migrate --from <project> --to <project> [--dry-run] [--allow-loss <kind>[,<kind>...]] [--resume] [--history-comment] [--emit-events] [--json]\n' +
	'Run `task migrate --help` for what each option does.';

/** `task migrate --help` needs no project. */
export function isMigrateHelp(rest: readonly string[]): boolean {
	return rest.includes('--help');
}

export function migrateHelp(): CommandResult {
	return { exitCode: 0, output: MIGRATE_HELP };
}

export function projectFlagRefusal(jsonMode: boolean): CommandResult {
	return errorOutput(
		jsonMode,
		'task migrate does not take -p/--project: name the two projects with --from and --to',
		USAGE
	);
}

export interface ParsedMigrate {
	from: string;
	to: string;
	options: MigrationOptions;
}

/** The sides and the options typed, or the error to print. Checked before any project is looked up. */
export function parseMigrateArgs(rest: readonly string[], jsonMode: boolean): ParsedMigrate | CommandResult {
	let from: string | undefined;
	let to: string | undefined;
	const options: MigrationOptions = { ...DEFAULT_MIGRATION_OPTIONS };
	const allow: string[] = [];
	let allowGiven = false;

	const valueOf = (index: number): string | undefined => {
		const next = rest[index + 1];
		return next === undefined || next.startsWith('--') ? undefined : next;
	};
	for (let index = 0; index < rest.length; index++) {
		const arg = rest[index]!;
		const [name, inline] =
			arg.startsWith('--') && arg.includes('=')
				? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)]
				: [arg, undefined];
		switch (name) {
			case '--from':
			case '--to': {
				const value = inline ?? valueOf(index);
				if (value === undefined || value === '') {
					return errorOutput(jsonMode, `${name} needs a project (id, name or alias)`, USAGE);
				}
				if (inline === undefined) index++;
				if (name === '--from') {
					if (from !== undefined) return errorOutput(jsonMode, '--from is given twice', USAGE);
					from = value;
				} else {
					if (to !== undefined) return errorOutput(jsonMode, '--to is given twice', USAGE);
					to = value;
				}
				break;
			}
			case '--allow-loss': {
				const value = inline ?? valueOf(index);
				allowGiven = true;
				if (value === undefined) {
					return errorOutput(
						jsonMode,
						'--allow-loss needs a list of loss kinds, for example --allow-loss history,created-at',
						USAGE
					);
				}
				if (inline === undefined) index++;
				allow.push(
					...value
						.split(',')
						.map(kind => kind.trim())
						.filter(kind => kind !== '')
				);
				break;
			}
			case '--dry-run':
				options.dryRun = true;
				break;
			case '--resume':
				options.resume = true;
				break;
			case '--emit-events':
				options.emitEvents = true;
				break;
			case '--history-comment':
				options.historyComment = true;
				break;
			default:
				if (arg.startsWith('-')) return errorOutput(jsonMode, `unknown option: ${arg}`, USAGE);
				return errorOutput(jsonMode, `unexpected argument: ${arg}`, USAGE);
		}
	}
	if (allowGiven && allow.length === 0) {
		return errorOutput(
			jsonMode,
			'--allow-loss needs a list of loss kinds, for example --allow-loss history,created-at',
			USAGE
		);
	}
	if (from === undefined && to === undefined) {
		return errorOutput(jsonMode, '--from <project> and --to <project> are required', USAGE);
	}
	if (from === undefined) return errorOutput(jsonMode, '--from <project> is required', USAGE);
	if (to === undefined) return errorOutput(jsonMode, '--to <project> is required', USAGE);
	options.allowLoss = [...new Set(allow)];
	return { from, to, options };
}

function quoted(text: string): string {
	return /^[A-Za-z0-9_.@:/-]+$/.test(text) ? text : `"${text.replaceAll('"', '\\"')}"`;
}

/** The command that runs this migration with the options typed (plus `extra` kinds allowed, minus the dry run). */
export function commandLine(
	parsed: ParsedMigrate,
	change: { allow?: readonly string[]; resume?: boolean } = {}
): string {
	const { options } = parsed;
	const allow = [...new Set([...options.allowLoss, ...(change.allow ?? [])])];
	const parts = ['task migrate', '--from', quoted(parsed.from), '--to', quoted(parsed.to)];
	if (allow.length > 0) parts.push('--allow-loss', allow.join(','));
	if (options.historyComment) parts.push('--history-comment');
	if (options.emitEvents) parts.push('--emit-events');
	if (change.resume === true || options.resume) parts.push('--resume');
	return parts.join(' ');
}

function duration(seconds: number): string {
	if (seconds < 90) return `${seconds} s`;
	const minutes = Math.round(seconds / 60);
	if (minutes < 90) return `${minutes} min`;
	return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')} min`;
}

const HEADLINES: Record<MigrationResult['status'], string> = {
	'dry-run': 'DRY RUN, nothing was written',
	blocked: 'BLOCKED, nothing was written',
	completed: 'done',
	'rate-limited': 'STOPPED on the rate limit',
	failed: 'FAILED',
};

function lossLines(rows: readonly LossRow[]): string[] {
	const width = Math.max(...rows.map(row => row.kind.length));
	return [
		'Losses:',
		...rows.flatMap(row => {
			const more = row.count > row.taskIds.length && row.taskIds.length > 0 ? ` (and others)` : '';
			return [
				`  ${row.kind.padEnd(width)}  ${String(row.count).padStart(4)}  ${row.allowed ? 'allowed' : 'BLOCKING'}`,
				`      ${row.text}`,
				`      fix: ${row.fix}`,
				...(row.taskIds.length === 0 ? [] : [`      tasks: ${row.taskIds.join(', ')}${more}`]),
			];
		}),
	];
}

/** The text of a result: what was done or would be, what is lost, what to type next. */
export function formatMigration(result: MigrationResult, parsed: ParsedMigrate): string {
	const { counts } = result;
	const lines = [
		`Migration ${result.from.name} (${result.from.kind}) -> ${result.to.name} (${result.to.kind}): ${HEADLINES[result.status]}`,
		'',
		result.dryRun
			? `Tasks:     ${counts.source} read; would create ${counts.created}, finish ${counts.resumed}, skip ${counts.skipped}`
			: `Tasks:     ${counts.source} read; created ${counts.created}, finished ${counts.resumed}, skipped ${counts.skipped}, failed ${counts.failed}, remaining ${counts.remaining}`,
	];
	if (result.losses.length > 0) lines.push(...lossLines(result.losses));
	if (result.notes.length > 0) lines.push('Notes:', ...result.notes.map(note => `  - ${note}`));
	if (result.warnings.length > 0) lines.push('Warnings:', ...result.warnings.map(warning => `  - ${warning}`));
	if (result.estimate.requests > 0 || result.estimate.seconds > 0) {
		lines.push(
			`Estimate:  about ${result.estimate.writes} writes, ${result.estimate.requests} requests, ${duration(result.estimate.seconds)} (${result.to.kind}, at the configured write spacing)`
		);
	}
	if (result.verification !== undefined) {
		const { checked, mismatches } = result.verification;
		if (mismatches.length === 0) {
			lines.push(`Verified:  ${checked} task(s) read back, all as planned`);
		} else {
			lines.push(
				`Verified:  ${checked} task(s) read back, ${mismatches.length} difference(s):`,
				...mismatches
					.slice(0, 20)
					.map(
						m =>
							`  - ${m.sourceId} -> ${m.targetId} ${m.field}: expected ${JSON.stringify(m.expected)}, found ${JSON.stringify(m.actual)}`
					),
				...(mismatches.length > 20 ? [`  - and ${mismatches.length - 20} more (--json lists them all)`] : [])
			);
		}
	}
	lines.push(`Journal:   ${result.journal}`);

	if (result.status === 'rate-limited') {
		lines.push(
			'',
			`Retry after ${result.retryAt ?? '(the service gave no time: wait a few minutes)'}, then continue with: ${result.resumeCommand ?? commandLine(parsed, { resume: true })}`
		);
	} else if (result.status === 'failed' && result.failure !== undefined) {
		const { failure: stopped } = result;
		lines.push(
			'',
			stopped.step === 'verify'
				? `Failed: ${stopped.message}`
				: `Failed${stopped.sourceId === undefined ? '' : ` on task ${stopped.sourceId}`} (${stopped.step}): ${stopped.message}`
		);
		if (stopped.hint !== undefined) lines.push(stopped.hint);
		if (result.resumeCommand !== undefined) {
			lines.push(`Fix the cause, then continue with: ${result.resumeCommand} (nothing is created twice)`);
		}
	} else if (result.status === 'blocked' || (result.status === 'dry-run' && result.blocking.length > 0)) {
		lines.push(
			'',
			`Next: to accept these losses run: ${commandLine(parsed, { allow: result.blocking }).replace(' --dry-run', '')}`
		);
	} else if (result.status === 'dry-run') {
		lines.push('', `Next: run again without --dry-run: ${commandLine(parsed)}`);
	}
	return lines.join('\n');
}

/** One line on stderr per task and stage, so a long run shows where it is. */
export function progressLine(progress: MigrationProgress, source: string): string | undefined {
	const count = `[${progress.done}/${progress.total}]`;
	switch (progress.stage) {
		case 'read':
			return progress.done === progress.total ? `reading ${source}: ${progress.total} task(s)` : undefined;
		case 'create':
			return `${count} ${progress.action ?? 'done'} ${progress.sourceId ?? ''} -> ${progress.targetId ?? ''}  ${progress.title ?? ''}`.trimEnd();
		case 'links':
			return `${count} linked ${progress.targetId ?? ''}: ${progress.items ?? 0} link(s)`;
		case 'comments':
			return `${count} commented ${progress.targetId ?? ''}: ${progress.items ?? 0} comment(s)`;
		case 'verify':
			return progress.done === progress.total ? `verified ${progress.total} task(s)` : undefined;
		default:
			return undefined;
	}
}

export interface MigrateDeps {
	/** Global config directory (`--config`). */
	configDir: string | undefined;
	/** The sink events go to (built lazily: a dry run or a blocked plan never creates one). */
	makeSink: () => EventSink;
}

function resolveSide(option: '--from' | '--to', ref: string, jsonMode: boolean): ResolvedProject | CommandResult {
	try {
		// TASK_PROJECT is not read: the two sides are the options, nothing else.
		return resolveProjectReference(ref);
	} catch (error) {
		const { message, hint } = describeError(error);
		return errorOutput(jsonMode, `${option}: ${message}`, hint);
	}
}

export async function runMigrate(
	rest: readonly string[],
	jsonMode: boolean,
	deps: MigrateDeps
): Promise<CommandResult> {
	const parsed = parseMigrateArgs(rest, jsonMode);
	if ('exitCode' in parsed) return parsed;
	const from = resolveSide('--from', parsed.from, jsonMode);
	if ('exitCode' in from) return from;
	const to = resolveSide('--to', parsed.to, jsonMode);
	if ('exitCode' in to) return to;

	let result: MigrationResult;
	try {
		result = await migrateProjects({
			from,
			to,
			options: parsed.options,
			resumeCommand: commandLine(parsed, { resume: true }),
			globalConfigDir: deps.configDir,
			onProgress: progress => {
				const line = progressLine(progress, from.name);
				if (line !== undefined) process.stderr.write(`${line}\n`);
			},
		});
	} catch (error) {
		return failure(jsonMode, error);
	}

	// The summary (and with --emit-events the per-task events) go out after the last write, like the events of any other command.
	if (result.events.length > 0) {
		const sink = deps.makeSink();
		try {
			await deliverEvents(sink, result.events);
		} finally {
			await sink.flush?.();
		}
	}
	const exitCode = result.status === 'dry-run' || result.status === 'completed' ? 0 : 1;
	const { events: _events, ...printed } = result;
	return jsonMode
		? { exitCode, output: JSON.stringify(printed, null, 2) }
		: { exitCode, output: formatMigration(result, parsed) };
}
