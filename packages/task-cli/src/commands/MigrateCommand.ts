// task migrate: arguments and printing over the task-service migration (`migrateProjects`). The engine, the loss table and the journal
// live in task-service; this file parses the command line, resolves the two registered projects and prints the result.
import * as path from 'node:path';

import {
	COMMENTS_MODES,
	DEFAULT_MIGRATION_OPTIONS,
	LIST_LIMIT_MAX,
	deliverEvents,
	describeError,
	migrateInPlace,
	migrateProjects,
	resolveProjectReference,
} from '@wadeck-app/task-service';
import type {
	CommentsMode,
	EventSink,
	LossRow,
	MigrationOptions,
	MigrationSelection,
	MigrationProgress,
	MigrationResult,
	ResolvedProject,
} from '@wadeck-app/task-service';

import { MIGRATE_HELP } from '../cli/help.js';
import { errorOutput, failure } from '../cli/output.js';
import type { CommandResult } from '../cli/output.js';

const SUBSET =
	'[--only-open | --status <s>[,<s>...]] [--ids <id>[,<id>...]] [--limit <n>] [--comments each|digest|none]';
const USAGE =
	`Usage: task migrate --from <project> --to <project> [--dry-run] [--allow-loss <kind>[,<kind>...]] [--resume] [--history-comment] ${SUBSET} [--emit-events] [--json]\n` +
	`   or: task migrate --in-place --to-config <file> [-p <project>] [--dry-run] [--allow-loss <kind>[,<kind>...]] [--resume] [--history-comment] ${SUBSET} [--emit-events] [--json]\n` +
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
	/** The two projects of a migration between projects (empty for an in-place one). */
	from: string;
	to: string;
	/** `--in-place --to-config <file>`: the project changes storage; `draft` is the file path, `project` the name it resolved to. */
	inPlace?: { draft: string; project?: string };
	options: MigrationOptions;
	/** `--fail-on-blocked` (dry run only): exit 1 when a real run would be refused. */
	failOnBlocked?: boolean;
}

/** The sides and the options typed, or the error to print. Checked before any project is looked up. */
export function parseMigrateArgs(rest: readonly string[], jsonMode: boolean): ParsedMigrate | CommandResult {
	let from: string | undefined;
	let to: string | undefined;
	let inPlace = false;
	let toConfig: string | undefined;
	const options: MigrationOptions = { ...DEFAULT_MIGRATION_OPTIONS };
	let failOnBlocked = false;
	const allow: string[] = [];
	let allowGiven = false;
	const selection: { onlyOpen?: true; statuses?: string[]; ids?: string[]; limit?: number } = {};

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
			case '--in-place':
				inPlace = true;
				break;
			case '--to-config': {
				const value = inline ?? valueOf(index);
				if (value === undefined || value === '') {
					return errorOutput(
						jsonMode,
						'--to-config needs the path of the draft config.yml',
						'Write the config.yml the project should have after the migration (with its strategy section), then: task migrate --in-place --to-config <file>'
					);
				}
				if (inline === undefined) index++;
				if (toConfig !== undefined) return errorOutput(jsonMode, '--to-config is given twice', USAGE);
				toConfig = value;
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
			case '--only-open':
				selection.onlyOpen = true;
				break;
			case '--status':
			case '--ids': {
				const value = inline ?? valueOf(index);
				const what = name === '--ids' ? 'source task ids' : 'source statuses';
				if (value === undefined || value === '') {
					return errorOutput(
						jsonMode,
						`${name} needs a comma separated list of ${what}, for example ${name} ${name === '--ids' ? 'ab12cd34,ef56ab78' : 'backlog,in-progress'}`,
						USAGE
					);
				}
				if (inline === undefined) index++;
				const key = name === '--ids' ? 'ids' : 'statuses';
				if (selection[key] !== undefined) {
					return errorOutput(jsonMode, `${name} is given twice`, `Put every value in one list: ${name} a,b`);
				}
				const entries = value.split(',').map(entry => entry.trim());
				if (entries.some(entry => entry === '')) {
					return errorOutput(
						jsonMode,
						`${name} has an empty entry: ${JSON.stringify(value)}`,
						`Give ${what} separated by single commas.`
					);
				}
				selection[key] = entries;
				break;
			}
			case '--limit': {
				const value = inline ?? valueOf(index);
				if (value === undefined || value === '') {
					return errorOutput(jsonMode, `--limit needs a whole number from 1 to ${LIST_LIMIT_MAX}`, USAGE);
				}
				if (inline === undefined) index++;
				if (selection.limit !== undefined) return errorOutput(jsonMode, '--limit is given twice', USAGE);
				if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > LIST_LIMIT_MAX) {
					return errorOutput(
						jsonMode,
						`--limit ${JSON.stringify(value)} is not a whole number from 1 to ${LIST_LIMIT_MAX}`,
						'--limit <n> copies at most n tasks per run; the same command copies the next ones.'
					);
				}
				selection.limit = Number(value);
				break;
			}
			case '--comments': {
				const value = inline ?? valueOf(index);
				if (value === undefined || value === '') {
					return errorOutput(jsonMode, `--comments needs one of: ${COMMENTS_MODES.join(', ')}`, USAGE);
				}
				if (inline === undefined) index++;
				if (options.comments !== undefined) return errorOutput(jsonMode, '--comments is given twice', USAGE);
				if (!(COMMENTS_MODES as readonly string[]).includes(value)) {
					return errorOutput(
						jsonMode,
						`--comments ${value} is not one of ${COMMENTS_MODES.join(', ')}`,
						'each = one comment per source comment (the default), digest = ONE comment per task, none = no comment (a loss of the kind comments).'
					);
				}
				options.comments = value as CommentsMode;
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
			case '--accept-differences':
				options.acceptDifferences = true;
				break;
			case '--accept-draft-change':
				options.acceptDraftChange = true;
				break;
			case '--fail-on-blocked':
				failOnBlocked = true;
				break;
			case '--allow-non-empty-target':
				options.allowNonEmptyTarget = true;
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
	if (selection.onlyOpen === true && selection.statuses !== undefined) {
		return errorOutput(
			jsonMode,
			'--only-open and --status contradict each other',
			'--only-open means every status that does not end a task; --status names the statuses. Give only one of them.'
		);
	}
	if (options.comments === 'none' && options.historyComment) {
		return errorOutput(
			jsonMode,
			'--comments none and --history-comment contradict each other: the history note is a comment',
			'Use --comments digest with --history-comment (the note and the comments go in ONE comment per task), or drop --history-comment.'
		);
	}
	if (Object.keys(selection).length > 0) options.selection = selection as MigrationSelection;
	if (!inPlace && (options.acceptDifferences === true || options.acceptDraftChange === true)) {
		const flag = options.acceptDifferences === true ? '--accept-differences' : '--accept-draft-change';
		return errorOutput(
			jsonMode,
			`${flag} only goes with --in-place`,
			'It accepts a read-back difference or a changed draft of an in-place migration: task migrate --in-place --to-config <file> ...'
		);
	}
	if (failOnBlocked && !options.dryRun) {
		return errorOutput(
			jsonMode,
			'--fail-on-blocked only goes with --dry-run',
			'It makes a dry run exit 1 when a real run would be refused: task migrate ... --dry-run --fail-on-blocked'
		);
	}
	if (!inPlace && options.allowNonEmptyTarget === true) {
		return errorOutput(
			jsonMode,
			'--allow-non-empty-target only goes with --in-place',
			'It accepts tasks that already are on the target of an in-place migration: task migrate --in-place --to-config <file> ...'
		);
	}
	if (options.acceptDraftChange === true && !options.resume) {
		return errorOutput(
			jsonMode,
			'--accept-draft-change only continues an unfinished run: it needs --resume',
			'task migrate --in-place --to-config <file> --resume --accept-draft-change'
		);
	}
	if (inPlace) {
		if (from !== undefined || to !== undefined) {
			const named =
				from !== undefined && to !== undefined ? '--from and --to' : from !== undefined ? '--from' : '--to';
			return errorOutput(
				jsonMode,
				`--in-place migrates the project in scope into the storage of a draft config: it does not take ${named}`,
				'To copy into ANOTHER registered project use: task migrate --from <project> --to <project>. To change the storage of one project use: task migrate --in-place --to-config <file> [-p <project>]'
			);
		}
		if (toConfig === undefined) {
			return errorOutput(
				jsonMode,
				'--in-place needs --to-config <file>: the draft config.yml with the strategy the project moves to',
				USAGE
			);
		}
		options.allowLoss = [...new Set(allow)];
		return { from: '', to: '', inPlace: { draft: toConfig }, options, ...(failOnBlocked ? { failOnBlocked } : {}) };
	}
	if (toConfig !== undefined) {
		return errorOutput(
			jsonMode,
			'--to-config only goes with --in-place',
			'To change the storage of one project use: task migrate --in-place --to-config <file>. To copy into another registered project use --to <project>.'
		);
	}
	if (from === undefined && to === undefined) {
		return errorOutput(jsonMode, '--from <project> and --to <project> are required', USAGE);
	}
	if (from === undefined) return errorOutput(jsonMode, '--from <project> is required', USAGE);
	if (to === undefined) return errorOutput(jsonMode, '--to <project> is required', USAGE);
	options.allowLoss = [...new Set(allow)];
	return { from, to, options, ...(failOnBlocked ? { failOnBlocked } : {}) };
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
	const parts =
		parsed.inPlace === undefined
			? ['task migrate', '--from', quoted(parsed.from), '--to', quoted(parsed.to)]
			: [
					'task migrate --in-place --to-config',
					quoted(parsed.inPlace.draft),
					...(parsed.inPlace.project === undefined ? [] : ['-p', quoted(parsed.inPlace.project)]),
				];
	if (allow.length > 0) parts.push('--allow-loss', allow.join(','));
	if (options.historyComment) parts.push('--history-comment');
	// The selection and the comments mode describe the run: a resume must continue THIS run, not another one.
	const { selection } = options;
	if (selection?.onlyOpen === true) parts.push('--only-open');
	if (selection?.statuses !== undefined) parts.push('--status', selection.statuses.map(quoted).join(','));
	if (selection?.ids !== undefined) parts.push('--ids', selection.ids.map(quoted).join(','));
	if (selection?.limit !== undefined) parts.push('--limit', String(selection.limit));
	if (options.comments !== undefined && options.comments !== 'each') parts.push('--comments', options.comments);
	// --accept-differences and --accept-draft-change are never copied: each is a decision about ONE run, not a habit to repeat.
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
	stopped: 'STOPPED, the source changed meanwhile (the config was NOT switched)',
	failed: 'FAILED',
	partial: 'PARTIAL, the selected tasks are copied and verified; the config was NOT switched',
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

/** What the selection kept and left out, and what waits for a later run. */
function selectionLines(report: NonNullable<MigrationResult['selection']>): string[] {
	const { excludedBy } = report;
	const why = [
		excludedBy.status > 0 ? `${excludedBy.status} by status` : undefined,
		excludedBy.ids > 0 ? `${excludedBy.ids} by --ids` : undefined,
		excludedBy.limit > 0 ? `${excludedBy.limit} by --limit` : undefined,
	].filter((text): text is string => text !== undefined);
	const lines = [
		`Selection: ${report.selected} selected${report.alreadyMigrated > 0 ? `, ${report.alreadyMigrated} already migrated` : ''}${report.excluded > 0 ? `, ${report.excluded} left out (${why.join(', ')})` : ''}, of ${report.total} in the source`,
	];
	const { parents, links } = report.deferred;
	if (parents + links > 0) {
		lines.push(
			`           ${parents} parent(s) and ${links} link(s) wait for the run that copies their other end (kept in the journal, written then)`
		);
	}
	return lines;
}

/** The in-place part of a result: strategy checks of a dry run, id map, the state of the switch, how to go back. */
function inPlaceLines(result: MigrationResult, report: NonNullable<MigrationResult['inPlace']>): string[] {
	const lines: string[] = [];
	const config = report.config ?? 'config.yml';
	if (report.checks !== undefined) {
		lines.push('Strategy checks of the draft (nothing is written):');
		for (const line of report.checks) {
			lines.push(`  [${line.status}] ${line.name}: ${line.text}`);
			if (line.fix !== undefined && line.status !== 'ok') lines.push(`        fix: ${line.fix}`);
		}
		if (report.checksNote !== undefined) lines.push(`  not checked: ${report.checksNote}`);
	}
	if (result.targetNotEmpty !== undefined) {
		lines.push(
			`Blocker:   the target already holds ${result.targetNotEmpty.count} task${result.targetNotEmpty.count === 1 ? '' : 's'} that this migration did not create (${result.targetNotEmpty.ids.join(', ')}${result.targetNotEmpty.count > result.targetNotEmpty.ids.length ? ', ...' : ''}): a real run refuses`,
			`           ${result.targetNotEmpty.hint}`
		);
	}
	if (report.draft !== undefined) lines.push(`Draft:     ${report.draft}`);
	if (report.acceptedDifferences !== undefined && report.acceptedDifferences.length > 0) {
		lines.push(
			`ACCEPTED differences (${report.acceptedDifferences.length}, by --accept-differences, which is never copied into a printed command; also in the journal):`,
			...report.acceptedDifferences.map(
				m =>
					`  - ${m.sourceId} -> ${m.targetId} ${m.field}: expected ${JSON.stringify(m.expected)}, found ${JSON.stringify(m.actual)}`
			)
		);
	}
	lines.push(`Id map:    ${report.idMapFile}`);
	const backup = report.backup === undefined ? '' : `; the previous one is kept as ${report.backup}`;
	if (report.bookkeepingPending === true) {
		lines.push(
			`Switch:    DONE: ${config} now is the draft, BUT the journal could not be saved: run the same command with --resume to finish the bookkeeping`,
			...(report.rollback === undefined ? [] : [`Rollback:  ${report.rollback}`])
		);
	} else if (report.switched) {
		lines.push(
			`Switch:    DONE: ${config} now is the draft${backup}`,
			`Rollback:  ${report.rollback ?? 'restore the previous config.yml'}`
		);
	} else if (result.status === 'dry-run') {
		lines.push(
			`Switch:    would replace ${config} by the draft after the read-back, keeping the old one (when there is one) as ${config}.before-migration`
		);
	} else if (result.status === 'partial') {
		lines.push(
			`Switch:    NOT done: ${config} is unchanged, the project still reads its previous storage (a selection that leaves tasks out never switches)`
		);
	} else if (result.failure?.step === 'switch') {
		lines.push(
			`Switch:    FAILED, every task is written and verified: ${config} is NOT replaced yet (the project still reads its previous storage)`
		);
	} else {
		lines.push(`Switch:    NOT done: ${config} is unchanged, the project still reads its previous storage`);
	}
	if (result.idMap.length > 0 && result.status !== 'dry-run') {
		const width = Math.max(...result.idMap.map(entry => entry.source.length));
		lines.push(
			'Id map (old id -> new id):',
			...result.idMap.map(entry => `  ${entry.source.padEnd(width)} -> ${entry.target}`)
		);
	}
	return lines;
}

/**
 * 0 for a dry run (even when a real run would be refused: the answer carries `blocked` and `blockers`; `--fail-on-blocked` turns that into 1)
 * and for a completed run whose bookkeeping is done; 1 otherwise.
 */
export function migrationExitCode(result: MigrationResult, parsed: ParsedMigrate): number {
	if (result.status === 'dry-run') return parsed.failOnBlocked === true && result.blocked === true ? 1 : 0;
	// A partial run did what it was asked (the selection) and left the config alone on purpose; scripts test inPlace.switched.
	return (result.status === 'completed' || result.status === 'partial') && result.inPlace?.bookkeepingPending !== true
		? 0
		: 1;
}

/** The text of a result: what was done or would be, what is lost, what to type next. */
export function formatMigration(result: MigrationResult, parsed: ParsedMigrate): string {
	const { counts } = result;
	const lines = [
		parsed.inPlace === undefined
			? `Migration ${result.from.name} (${result.from.kind}) -> ${result.to.name} (${result.to.kind}): ${HEADLINES[result.status]}`
			: `In-place migration of ${result.from.name}, storage ${result.from.kind} -> ${result.to.kind}: ${HEADLINES[result.status]}`,
		'',
		result.dryRun
			? `Tasks:     ${counts.source} read; would create ${counts.created}, finish ${counts.resumed}, skip ${counts.skipped}`
			: `Tasks:     ${counts.source} read; created ${counts.created}, finished ${counts.resumed}, skipped ${counts.skipped}, failed ${counts.failed}, remaining ${counts.remaining}`,
	];
	if (result.selection !== undefined) lines.push(...selectionLines(result.selection));
	if (result.comments !== undefined) {
		lines.push(
			`Comments:  ${result.comments.mode}: ${result.comments.planned} comment(s) written, ${result.comments.saved} write(s) saved against one comment each`
		);
	}
	if (result.losses.length > 0) lines.push(...lossLines(result.losses));
	if (result.notes.length > 0) lines.push('Notes:', ...result.notes.map(note => `  - ${note}`));
	if (result.warnings.length > 0) lines.push('Warnings:', ...result.warnings.map(warning => `  - ${warning}`));
	if (result.estimate.requests > 0 || result.estimate.seconds > 0) {
		const { estimate } = result;
		// Said only when a cap is what limits the run: the hours (rounded to 0.1 h) exceed the time at the pace of the writes.
		const capBound =
			estimate.contentCapPerHour !== undefined &&
			estimate.hours !== undefined &&
			estimate.hours * 3600 - estimate.seconds > 180;
		const cap =
			capBound && estimate.contentCapPerHour !== undefined
				? `; at least ${estimate.hours} h with the caps of ${
						estimate.contentCapPerMinute === undefined
							? ''
							: `${estimate.contentCapPerMinute} content-generating requests a minute and `
					}${estimate.contentCapPerHour} content-generating requests an hour`
				: '';
		lines.push(
			`Estimate:  about ${estimate.writes} writes, ${estimate.requests} requests, ${duration(estimate.seconds)} (${result.to.kind}, at the configured write spacing; computed from the plan, not measured${cap})`
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
	if (result.dryRun && result.blocked === true) {
		lines.push(
			`BLOCKED: a real run will be refused (${(result.blockers ?? []).join(', ')})${parsed.failOnBlocked === true ? '' : ' (exit code 0: add --fail-on-blocked to make a script stop)'}`
		);
	}
	if (result.inPlace !== undefined) lines.push(...inPlaceLines(result, result.inPlace));

	if (result.status === 'rate-limited') {
		lines.push(
			'',
			`Retry after ${result.retryAt ?? '(the service gave no time: wait a few minutes)'}, then continue with: ${result.resumeCommand ?? commandLine(parsed, { resume: true })}`
		);
	} else if ((result.status === 'failed' || result.status === 'stopped') && result.failure !== undefined) {
		const { failure: stopped } = result;
		const label = result.status === 'stopped' ? 'Stopped' : 'Failed';
		lines.push(
			'',
			['verify', 'switch', 'source-changed'].includes(stopped.step)
				? `${label}: ${stopped.message}`
				: `${label}${stopped.sourceId === undefined ? '' : ` on task ${stopped.sourceId}`} (${stopped.step}): ${stopped.message}`
		);
		if (stopped.hint !== undefined) lines.push(stopped.hint);
		if (result.resumeCommand !== undefined) {
			lines.push(
				stopped.step === 'switch'
					? `Fix the cause, then run: ${result.resumeCommand} (it only replaces the config: every task is already written and verified)`
					: stopped.step === 'source-changed'
						? `Then run: ${result.resumeCommand} (what was added is copied, then everything is read back again before the switch)`
						: `Fix the cause, then continue with: ${result.resumeCommand} (nothing is created twice)`
			);
		}
	} else if (result.status === 'blocked' || (result.status === 'dry-run' && result.blocking.length > 0)) {
		lines.push(
			'',
			`Next: to accept these losses run: ${commandLine(parsed, { allow: result.blocking }).replace(' --dry-run', '')}`
		);
	} else if (result.status === 'dry-run') {
		lines.push('', `Next: run again without --dry-run: ${commandLine(parsed)}`);
	} else if (result.status === 'partial') {
		lines.push(
			'',
			`Next: ${result.resumeCommand ?? commandLine(parsed, { resume: true })} (copies more tasks; the config is switched only when every task of the source is copied, a run with no selection finishes it)`
		);
	} else if (result.status === 'completed' && result.selection !== undefined && result.selection.excluded > 0) {
		lines.push(
			'',
			result.selection.excludedBy.limit > 0
				? `Next: ${commandLine(parsed)} (the same command copies the next tasks)`
				: 'Next: the tasks left out are copied by a run with another selection, or none; the relations to them are written then.'
		);
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
	/** The directory the command runs in: a relative `--to-config` is taken from it. */
	cwd: string;
	/** The project of this command (`-p`, `TASK_PROJECT`, the cwd), for `--in-place`; throws the error to print. */
	resolveOwnProject: () => ResolvedProject;
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
	const typed = parseMigrateArgs(rest, jsonMode);
	if ('exitCode' in typed) return typed;
	let parsed: ParsedMigrate = typed;

	let result: MigrationResult;
	if (parsed.inPlace !== undefined) {
		// One project: the one in scope. The draft is taken from the cwd, and the resume command names both absolutely.
		let project: ResolvedProject;
		try {
			project = deps.resolveOwnProject();
		} catch (error) {
			return failure(jsonMode, error);
		}
		const draftFile = path.resolve(deps.cwd, parsed.inPlace.draft);
		parsed = { ...parsed, inPlace: { draft: draftFile, project: project.id } };
		try {
			result = await migrateInPlace({
				project,
				draftFile,
				options: parsed.options,
				resumeCommand: commandLine(parsed, { resume: true }),
				globalConfigDir: deps.configDir,
				onProgress: progress => {
					const line = progressLine(progress, project.name);
					if (line !== undefined) process.stderr.write(`${line}\n`);
				},
			});
		} catch (error) {
			return failure(jsonMode, error);
		}
	} else {
		const from = resolveSide('--from', parsed.from, jsonMode);
		if ('exitCode' in from) return from;
		const to = resolveSide('--to', parsed.to, jsonMode);
		if ('exitCode' in to) return to;
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
	const exitCode = migrationExitCode(result, parsed);
	const { events: _events, ...printed } = result;
	return jsonMode
		? { exitCode, output: JSON.stringify(printed, null, 2) }
		: { exitCode, output: formatMigration(result, parsed) };
}
