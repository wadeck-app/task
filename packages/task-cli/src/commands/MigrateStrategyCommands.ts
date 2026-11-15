// task strategy migrate <sub>: arguments and printing over the task-service use cases of a migrating project (`openMigration`,
// `openMigrationControl`). start / status / pause / resume / log are for people; `worker` is the INTERNAL subcommand the detached
// process runs (`start` and `resume` launch it); `finalize` and `abort` end the migration (the project switches to "new" alone, or goes back to "current").
import {
	abortProjectMigration,
	deliverEvents,
	describeError,
	finalizeProjectMigration,
	openMigration,
	openMigrationControl,
	openResolvedProject,
} from '@wadeck-app/task-service';
import type {
	AbortResult,
	EventSink,
	FinalizeResult,
	LogEntry,
	MigrationStatusReport,
	PlanLoss,
	ResolvedProject,
	StartResult,
} from '@wadeck-app/task-service';

import { pollUntilAborted } from '../cli/follow.js';
import { MIGRATE_STRATEGY_HELP } from '../cli/help.js';
import { errorOutput, failure, jsonResult } from '../cli/output.js';
import type { CommandResult } from '../cli/output.js';

export interface LaunchRequest {
	projectId: string;
	dataDir: string;
	cwd: string;
	/** The global task config directory the command was given (`--config`): the worker gets the same one. */
	configDir?: string;
}

export interface MigrateStrategyDeps {
	/** The global task config directory (`--config`). */
	configDir?: string | undefined;
	/** Starts the background worker process for the project (the entry builds the command line); resolves with its pid when known. */
	launch: (request: LaunchRequest) => Promise<{ pid?: number }>;
	/** Standard output and standard error of a command that prints as it goes (`log --follow`, the worker). */
	out: (text: string) => void;
	warn: (text: string) => void;
	sleep: (ms: number) => Promise<void>;
	/** Ends `log --follow` and the worker (Ctrl+C, SIGTERM). */
	signal?: AbortSignal | undefined;
	followIntervalMs?: number;
	/** How long start and resume wait for the worker to take its lock. Default 10 s. */
	workerStartTimeoutMs?: number;
	/** The sink the summary event of `finalize` goes to (built lazily: nothing else raises an event). */
	makeSink?: () => EventSink;
	/** How long `abort` waits for a worker that was asked to stop. Default 60 s. */
	abortWaitMs?: number;
}

const SUBCOMMANDS = ['start', 'status', 'pause', 'resume', 'log', 'finalize', 'abort'] as const;
type Subcommand = (typeof SUBCOMMANDS)[number] | 'worker';

const USAGE: Record<Subcommand, string> = {
	start: 'Usage: task strategy migrate start [-p <project>] [--allow-loss <kinds>] [--dry-run] [--json]',
	status: 'Usage: task strategy migrate status [-p <project>] [--json]',
	pause: 'Usage: task strategy migrate pause [-p <project>] [--json]',
	resume: 'Usage: task strategy migrate resume [-p <project>] [--json]',
	log: 'Usage: task strategy migrate log [-p <project>] [--follow] [--tail <n>] [--json]',
	finalize: 'Usage: task strategy migrate finalize [-p <project>] [--json]',
	abort: 'Usage: task strategy migrate abort [-p <project>] [--keep-moved] [--json]',
	worker: 'Usage: task strategy migrate worker -p <project>   (internal: the background process runs it)',
};

const DEFAULT_WORKER_START_TIMEOUT_MS = 10_000;
const DEFAULT_TAIL = 50;
const FOLLOW_INTERVAL_MS = 1000;
const STATUS = 'task strategy migrate status';

export function isMigrateStrategy(rest: readonly string[]): boolean {
	return rest[0] === 'migrate';
}

/** `task strategy migrate`, `... help`, `... --help`: no project needed. */
export function isMigrateStrategyHelp(rest: readonly string[]): boolean {
	return rest[0] === 'migrate' && (rest.length === 1 || ['--help', 'help', '-h'].includes(rest[1]!));
}

export function migrateStrategyHelp(): CommandResult {
	return { exitCode: 0, output: MIGRATE_STRATEGY_HELP };
}

interface Parsed {
	flags: Set<string>;
	values: Map<string, string>;
}

/** Flags (`--dry-run`) and value options (`--allow-loss a,b` or `--allow-loss=a,b`) of one subcommand; anything else is refused. */
function parseOptions(
	sub: Subcommand,
	args: readonly string[],
	spec: { flags: readonly string[]; values: readonly string[] },
	jsonMode: boolean
): Parsed | CommandResult {
	const parsed: Parsed = { flags: new Set(), values: new Map() };
	for (let index = 0; index < args.length; index++) {
		const arg = args[index]!;
		const name = arg.split('=')[0]!;
		if (spec.flags.includes(arg)) {
			parsed.flags.add(arg);
		} else if (spec.values.includes(name)) {
			if (parsed.values.has(name)) return errorOutput(jsonMode, `${name} was given twice`, USAGE[sub]);
			let value: string | undefined;
			if (arg.includes('=')) value = arg.slice(name.length + 1);
			else {
				value = args[index + 1];
				index++;
			}
			if (value === undefined || value === '' || value.startsWith('-')) {
				return errorOutput(jsonMode, `${name} needs a value`, USAGE[sub]);
			}
			parsed.values.set(name, value);
		} else if (arg.startsWith('-')) {
			return errorOutput(jsonMode, `unknown option: ${arg}`, USAGE[sub]);
		} else {
			return errorOutput(jsonMode, `unexpected argument: ${arg}`, USAGE[sub]);
		}
	}
	return parsed;
}

const isResult = (value: Parsed | CommandResult): value is CommandResult => 'exitCode' in value;

function plural(count: number, word: string): string {
	return `${count} ${word}${count === 1 ? '' : 's'}`;
}

function formatMinutes(minutes: number): string {
	if (minutes < 1) return 'less than a minute';
	if (minutes < 90) return `about ${Math.round(minutes)} min`;
	const hours = minutes / 60;
	return hours < 48 ? `about ${hours.toFixed(1)} h` : `about ${(hours / 24).toFixed(1)} days`;
}

function formatLoss(loss: PlanLoss): string {
	return `  ${loss.kind.padEnd(14)} ${`${loss.tasks} task(s)`.padEnd(10)} ${loss.allowed ? 'accepted    ' : 'NOT ACCEPTED'}  ${loss.text}`;
}

function formatPlan(result: StartResult): string[] {
	const { plan } = result;
	const lines = [
		`Migration plan: ${plan.tasks} task(s) to move from "current" to "new"${plan.alreadyMoved > 0 ? ` (${plan.alreadyMoved} already in "new")` : ''}.`,
	];
	if (plan.losses.length === 0) lines.push('Losses: none.');
	else lines.push('What the move cannot keep:', ...plan.losses.map(formatLoss));
	const { estimate } = plan;
	const pace =
		estimate.minutes === undefined
			? 'no limit on the pace (the time depends on the speed of the two strategies)'
			: `${formatMinutes(estimate.minutes)} at the pace of ${estimate.limitedBy ?? 'the limit'}`;
	lines.push(
		`Estimate (not measured): ${estimate.requests} request(s), ${estimate.writes} write(s), ${estimate.requestsPerMove} request(s) a task; ${pace}.`,
		...estimate.notes.map(note => `  note: ${note}`)
	);
	if (result.blocked) {
		const kinds = plan.blocking.map(loss => loss.kind).join(',');
		lines.push(
			`BLOCKED: a real start will be refused while these losses are not accepted. Accept them with: task strategy migrate start --allow-loss ${kinds} (or --allow-loss all).`,
			...plan.blocking.map(loss => `  ${loss.kind}: ${loss.fix}`)
		);
	} else if (result.dryRun) {
		lines.push(
			'Nothing was written. Start it with: task strategy migrate start' +
				(plan.losses.length > 0 ? ' --allow-loss <the kinds above>' : '')
		);
	}
	return lines;
}

function formatStatus(report: MigrationStatusReport): string {
	if (!report.started) return report.next;
	const lines: string[] = [];
	const row = (label: string, text: string): void => void lines.push(`${`${label}:`.padEnd(13)}${text}`);
	row(
		'Migration',
		`${report.status} since ${report.statusSince} (started ${report.startedAt}; losses accepted: ${report.acceptedLosses?.join(', ') || 'none'})`
	);
	if (report.stop !== undefined) row('Stopped', report.stop.text);
	const { counts } = report;
	if (counts !== undefined) {
		row(
			'Tasks',
			`${counts.moved} of ${counts.total} moved (${report.percent}%); in current ${counts.inCurrent}, moving ${counts.moving} (${counts.stale} stale), deleted ${counts.deleted}, made in new ${counts.madeInNew}`
		);
		if (counts.openTransactions > 0) {
			row(
				'Open',
				`${plural(counts.openTransactions, 'unfinished transaction')} in the write-ahead log (settled by the next move or opening)`
			);
		}
	}
	const worker = report.worker;
	if (worker !== undefined) {
		if (worker.running) {
			const doing =
				worker.phase === undefined
					? ''
					: `, ${worker.phase}${worker.task === undefined ? '' : ` task ${worker.task}`}`;
			const beat =
				worker.heartbeatAgeSeconds === undefined ? '' : `, heartbeat ${worker.heartbeatAgeSeconds} s ago`;
			row('Worker', `running, pid ${worker.pid}${doing}${beat}`);
			if (worker.pauseUntil !== undefined)
				row(
					'Waiting',
					`until ${worker.pauseUntil}${worker.pauseReason === undefined ? '' : ` (${worker.pauseReason})`}`
				);
		} else {
			row(
				'Worker',
				worker.starting
					? 'starting'
					: `not running${worker.pid === undefined ? '' : ` (the last one, pid ${worker.pid}, is gone)`}`
			);
		}
	}
	if (report.control !== undefined) row('Asked', `${report.control.command} (${report.control.at})`);
	if (report.rate !== undefined) {
		const limits = report.rate.limits
			.map(limit => `${limit.name} ${limit.limit} ${limit.unit}/${limit.windowMs / 60_000 >= 60 ? 'h' : 'min'}`)
			.join(', ');
		row(
			'Pace',
			`last minute: ${report.rate.used.requests} request(s), ${report.rate.used.writes} write(s); limits: ${limits || 'none'}`
		);
	}
	if (report.eta !== undefined) {
		row(
			'ETA',
			report.eta.minutes === undefined
				? `unknown: ${report.eta.note ?? ''}`
				: report.eta.minutes === 0
					? 'nothing left to move'
					: `${formatMinutes(report.eta.minutes)} at the pace limit`
		);
	}
	const c = report.counters;
	if (c !== undefined)
		row(
			'Counters',
			`moved ${c.moved}, skipped (claimed) ${c.skippedClaimed}, deferred ${c.deferred}, failures ${c.failures}, rate pauses ${c.ratePauses}`
		);
	if (report.parked !== undefined && report.parked.length > 0) {
		row('Set aside', report.parked.map(item => `${item.task} (${item.reason})`).join('; '));
	}
	if (report.lastErrors !== undefined && report.lastErrors.length > 0) {
		lines.push(
			'Last errors:',
			...report.lastErrors
				.slice(-5)
				.map(
					note =>
						`  ${note.at}  task ${note.task}  ${note.kind}: ${note.message}${note.fix === undefined ? '' : ` (fix: ${note.fix})`}`
				)
		);
	}
	for (const problem of report.problems) lines.push(`Problem:     ${problem}`);
	lines.push(`Next:        ${report.next}`);
	return lines.join('\n');
}

function formatLogEntry(entry: LogEntry): string {
	const task = typeof entry.task === 'string' && entry.task !== '' ? `  [${entry.task}]` : '';
	return `${entry.at ?? ''}  ${(entry.level ?? 'info').padEnd(5)}${task}  ${entry.message ?? JSON.stringify(entry)}`;
}

export async function runMigrateStrategy(
	rest: readonly string[],
	jsonMode: boolean,
	resolved: ResolvedProject,
	deps: MigrateStrategyDeps
): Promise<CommandResult> {
	const [sub, ...args] = rest;
	if (sub === undefined || !([...SUBCOMMANDS, 'worker'] as string[]).includes(sub)) {
		return errorOutput(
			jsonMode,
			`unknown task strategy migrate subcommand: ${sub ?? ''}`,
			`Valid subcommands: ${SUBCOMMANDS.join(', ')}`
		);
	}
	try {
		switch (sub as Subcommand) {
			case 'start':
				return await start(args, jsonMode, resolved, deps);
			case 'status':
				return status(args, jsonMode, resolved);
			case 'pause':
				return pause(args, jsonMode, resolved);
			case 'resume':
				return await resume(args, jsonMode, resolved, deps);
			case 'log':
				return await log(args, jsonMode, resolved, deps);
			case 'finalize':
				return await finalize(args, jsonMode, resolved, deps);
			case 'abort':
				return await abort(args, jsonMode, resolved, deps);
			case 'worker':
				return await worker(args, jsonMode, resolved, deps);
		}
	} catch (error) {
		return failure(jsonMode, error);
	}
}

/** Launches the worker, waits for it to take its lock, and says what happened. */
async function launchAndConfirm(
	resolved: ResolvedProject,
	deps: MigrateStrategyDeps
): Promise<{ launched: boolean; running: boolean; pid?: number; error?: string; outcome?: string }> {
	const { control, input } = openMigrationControl(resolved.storage);
	let outcome;
	let launchFailure: unknown;
	try {
		outcome = await control.resume(input, async () => {
			try {
				return await deps.launch({
					projectId: resolved.id,
					dataDir: resolved.storage.dataDir,
					cwd: resolved.path ?? process.cwd(),
					...(deps.configDir === undefined ? {} : { configDir: deps.configDir }),
				});
			} catch (error) {
				launchFailure = error;
				throw error;
			}
		});
	} catch (error) {
		// Only a failed launch is told here; a refusal of resume (nothing started, nothing left to move) is the command's own answer.
		if (error !== launchFailure) throw error;
		return { launched: false, running: false, error: describeError(error).message };
	}
	if (outcome.outcome === 'already-running' || outcome.outcome === 'pause-cancelled') {
		return { launched: false, running: true, pid: outcome.pid, outcome: outcome.outcome };
	}
	const running = await control.waitForWorker(input, {
		timeoutMs: deps.workerStartTimeoutMs ?? DEFAULT_WORKER_START_TIMEOUT_MS,
		sleep: deps.sleep,
	});
	return {
		launched: true,
		running,
		...(outcome.pid === undefined ? {} : { pid: outcome.pid }),
		outcome: outcome.outcome,
	};
}

const workerLog = (resolved: ResolvedProject): string => `${resolved.storage.dataDir}/migrating/worker.out.log`;

async function start(
	args: readonly string[],
	jsonMode: boolean,
	resolved: ResolvedProject,
	deps: MigrateStrategyDeps
): Promise<CommandResult> {
	const parsed = parseOptions('start', args, { flags: ['--dry-run'], values: ['--allow-loss'] }, jsonMode);
	if (isResult(parsed)) return parsed;
	const allowLoss = parsed.values.get('--allow-loss');
	const accepted = allowLoss === undefined ? [] : allowLoss.split(',').map(kind => kind.trim());
	if (accepted.includes('')) {
		return errorOutput(
			jsonMode,
			'--allow-loss has an empty entry',
			'Give loss kinds separated by commas, for example --allow-loss history,comments (or all).'
		);
	}
	const dryRun = parsed.flags.has('--dry-run');
	const ctx = openResolvedProject(resolved, deps.configDir);
	let result: StartResult;
	try {
		const migration = await openMigration(ctx);
		result = await migration.start({ acceptedLosses: accepted, dryRun });
		for (const notice of ctx.takeNotices?.() ?? []) deps.warn(`warning: ${notice.text}`);
	} finally {
		await ctx.dispose?.();
	}
	if (dryRun) return jsonMode ? jsonResult(result) : { exitCode: 0, output: formatPlan(result).join('\n') };

	const worker = await launchAndConfirm(resolved, deps);
	if (jsonMode) {
		return {
			exitCode: worker.running ? 0 : 1,
			output: JSON.stringify(
				{
					...result,
					worker: {
						launched: worker.launched,
						running: worker.running,
						...(worker.pid === undefined ? {} : { pid: worker.pid }),
						...(worker.error === undefined ? {} : { error: worker.error }),
					},
				},
				null,
				2
			),
		};
	}
	const lines = [
		`Migration started: ${result.plan.tasks} task(s) routed, losses accepted: ${result.state?.acceptedLosses.join(', ') || 'none'}.`,
	];
	if (worker.error !== undefined) {
		return {
			exitCode: 1,
			output: [
				...lines,
				`Error: The migration was started, but its worker could not be launched: ${worker.error}`,
				`Launch it again with: task strategy migrate resume`,
			].join('\n'),
		};
	}
	if (!worker.running) {
		return {
			exitCode: 1,
			output: [
				...lines,
				'Error: The migration was started, but the worker did not start (no worker holds the lock after the time given).',
				`Its output (the reason is usually there): ${workerLog(resolved)}`,
				'Launch it again with: task strategy migrate resume',
			].join('\n'),
		};
	}
	lines.push(
		`Worker launched${worker.pid === undefined ? '' : ` (pid ${worker.pid})`}: it moves the tasks in the background, at the pace of the budget.`
	);
	lines.push(
		`Follow it: ${STATUS}   |   task strategy migrate log --follow   |   stop it: task strategy migrate pause`
	);
	return { exitCode: 0, output: lines.join('\n') };
}

function status(args: readonly string[], jsonMode: boolean, resolved: ResolvedProject): CommandResult {
	const parsed = parseOptions('status', args, { flags: [], values: [] }, jsonMode);
	if (isResult(parsed)) return parsed;
	const { control, input } = openMigrationControl(resolved.storage);
	const report = control.status(input);
	return jsonMode ? jsonResult(report) : { exitCode: 0, output: formatStatus(report) };
}

function pause(args: readonly string[], jsonMode: boolean, resolved: ResolvedProject): CommandResult {
	const parsed = parseOptions('pause', args, { flags: [], values: [] }, jsonMode);
	if (isResult(parsed)) return parsed;
	const { control, input } = openMigrationControl(resolved.storage);
	const result = control.pause(input);
	if (jsonMode) return jsonResult(result);
	switch (result.outcome) {
		case 'requested':
			return {
				exitCode: 0,
				output: `Pause requested: the worker (pid ${result.pid}) stops after the task it is moving. Continue later with: task strategy migrate resume`,
			};
		case 'paused':
			return {
				exitCode: 0,
				output: 'Migration paused (no worker was running). Continue with: task strategy migrate resume',
			};
		case 'already-paused':
			return {
				exitCode: 0,
				output: 'The migration is paused already. Continue with: task strategy migrate resume',
			};
	}
}

async function resume(
	args: readonly string[],
	jsonMode: boolean,
	resolved: ResolvedProject,
	deps: MigrateStrategyDeps
): Promise<CommandResult> {
	const parsed = parseOptions('resume', args, { flags: [], values: [] }, jsonMode);
	if (isResult(parsed)) return parsed;
	const worker = await launchAndConfirm(resolved, deps);
	if (worker.error !== undefined) {
		// A refusal (no migration started, nothing left to move) is the command's own answer; the migration is untouched.
		return errorOutput(jsonMode, worker.error, `See where it stands with: ${STATUS}`);
	}
	if (jsonMode) return { exitCode: worker.running ? 0 : 1, output: JSON.stringify(worker, null, 2) };
	if (worker.outcome === 'pause-cancelled') {
		return { exitCode: 0, output: `The pause was cancelled: the worker (pid ${worker.pid}) goes on.` };
	}
	if (worker.outcome === 'already-running') {
		return { exitCode: 0, output: `The worker is running already (pid ${worker.pid}). Follow it with: ${STATUS}` };
	}
	if (!worker.running) {
		return {
			exitCode: 1,
			output: [
				'Error: The worker did not start (no worker holds the lock after the time given).',
				`Its output (the reason is usually there): ${workerLog(resolved)}`,
				'Try again with: task strategy migrate resume',
			].join('\n'),
		};
	}
	return {
		exitCode: 0,
		output: `Worker launched${worker.pid === undefined ? '' : ` (pid ${worker.pid})`}. Follow it with: ${STATUS}`,
	};
}

async function log(
	args: readonly string[],
	jsonMode: boolean,
	resolved: ResolvedProject,
	deps: MigrateStrategyDeps
): Promise<CommandResult> {
	const parsed = parseOptions('log', args, { flags: ['--follow', '-f'], values: ['--tail'] }, jsonMode);
	if (isResult(parsed)) return parsed;
	const tailText = parsed.values.get('--tail');
	const tail = tailText === undefined ? DEFAULT_TAIL : Number(tailText);
	if (!Number.isInteger(tail) || tail < 1) {
		return errorOutput(jsonMode, `--tail needs a whole number of at least 1, found ${tailText}`, USAGE.log);
	}
	const { control, input } = openMigrationControl(resolved.storage);
	const follow = parsed.flags.has('--follow') || parsed.flags.has('-f');
	const first = control.log(input, { tail });
	if (!follow) {
		if (jsonMode) return jsonResult(first.entries);
		return {
			exitCode: 0,
			output:
				first.entries.length === 0
					? 'The migration log is empty: nothing has been started or moved yet.'
					: first.entries.map(formatLogEntry).join('\n'),
		};
	}
	// Follow: the entries so far, then every line added, one poll after the other (the next waits for the end of the previous one).
	const show = (entry: LogEntry): void => deps.out(jsonMode ? JSON.stringify(entry) : formatLogEntry(entry));
	for (const entry of first.entries) show(entry);
	deps.warn('[task] Following the migration log -- Ctrl+C to stop');
	let seen = first.total;
	const controller = new AbortController();
	const stop = (): void => controller.abort();
	deps.signal?.addEventListener('abort', stop, { once: true });
	if (deps.signal?.aborted === true) stop();
	try {
		await pollUntilAborted(
			() => {
				const more = control.log(input, { after: seen });
				seen = more.total;
				if (!controller.signal.aborted) for (const entry of more.entries) show(entry);
				return Promise.resolve();
			},
			deps.followIntervalMs ?? FOLLOW_INTERVAL_MS,
			controller.signal
		);
	} finally {
		deps.signal?.removeEventListener('abort', stop);
	}
	return { exitCode: 0, output: '' };
}

function formatFinalize(result: FinalizeResult): string {
	const lines: string[] = [];
	if (result.outcome === 'already-finished') {
		lines.push('The migration is finished already: the project uses the new strategy alone. Nothing was changed.');
	} else {
		lines.push(
			result.outcome === 'bookkeeping-completed'
				? 'The migration is finished: the project config already was the new one (an earlier finalize stopped right after writing it); only its bookkeeping was completed.'
				: `Finalized: ${plural(result.moved, 'moved task')} and ${plural(result.madeInNew, 'task')} made in "new" are now the project: it uses the new strategy alone.`
		);
		if (result.config !== undefined) lines.push(`Config:  ${result.config}`);
		if (result.backup !== undefined) {
			lines.push(
				`Backup:  ${result.backup} (the config before the switch: copy it back to go back; ${'the tasks of "current" were NOT deleted'})`
			);
		}
	}
	lines.push(
		`Id map:  ${result.idMap.file} (${plural(result.idMap.entries, 'entry')}, ${result.idMap.changed} with a new id)`
	);
	for (const note of result.notes) lines.push(`note: ${note}`);
	for (const warning of result.warnings) lines.push(`WARNING: ${warning}`);
	if (result.outcome !== 'already-finished') {
		lines.push(
			'Next: check the project with: task strategy check   |   the copies in "current" are kept; delete them yourself when you no longer need them.'
		);
	}
	return lines.join('\n');
}

async function finalize(
	args: readonly string[],
	jsonMode: boolean,
	resolved: ResolvedProject,
	deps: MigrateStrategyDeps
): Promise<CommandResult> {
	const parsed = parseOptions('finalize', args, { flags: [], values: [] }, jsonMode);
	if (isResult(parsed)) return parsed;
	const result = await finalizeProjectMigration({
		project: resolved,
		...(deps.configDir === undefined ? {} : { globalConfigDir: deps.configDir }),
	});
	// The summary event goes out after the switch, like the events of any other command; a failure to deliver is reported by the sink.
	if (result.events.length > 0 && deps.makeSink !== undefined) {
		const sink = deps.makeSink();
		try {
			await deliverEvents(sink, result.events);
		} finally {
			await sink.flush?.();
		}
	}
	const { events: _events, ...printed } = result;
	void _events;
	return jsonMode ? jsonResult(printed) : { exitCode: 0, output: formatFinalize(result) };
}

function formatAbort(result: AbortResult): string {
	const lines: string[] = [];
	if (result.outcome === 'already-aborted') {
		lines.push('The migration is aborted already: the project uses "current" again. Nothing was changed.');
	} else {
		lines.push(
			result.outcome === 'bookkeeping-completed'
				? 'The migration is aborted: the project config already was the old one (an earlier abort stopped right after writing it); only its bookkeeping was completed.'
				: 'Aborted: the project uses its "current" strategy again. NOTHING was deleted, in "current" or in "new".'
		);
		if (result.config !== undefined) lines.push(`Config:  ${result.config}`);
		if (result.backup !== undefined)
			lines.push(`Backup:  ${result.backup} (the migrating config; copy it back to resume the migration set-up)`);
	}
	for (const note of result.notes) lines.push(`note: ${note}`);
	for (const warning of result.warnings) lines.push(`WARNING: ${warning}`);
	if (result.outcome !== 'already-aborted') {
		lines.push(
			'Next: check the project with: task strategy check. To migrate again, move the files of <data>/migrating aside first (nothing starts over a finished or aborted migration).'
		);
	}
	return lines.join('\n');
}

async function abort(
	args: readonly string[],
	jsonMode: boolean,
	resolved: ResolvedProject,
	deps: MigrateStrategyDeps
): Promise<CommandResult> {
	const parsed = parseOptions('abort', args, { flags: ['--keep-moved'], values: [] }, jsonMode);
	if (isResult(parsed)) return parsed;
	const result = await abortProjectMigration({
		project: resolved,
		...(deps.configDir === undefined ? {} : { globalConfigDir: deps.configDir }),
		keepMoved: parsed.flags.has('--keep-moved'),
		sleep: deps.sleep,
		...(deps.abortWaitMs === undefined ? {} : { waitMs: deps.abortWaitMs }),
	});
	return jsonMode ? jsonResult(result) : { exitCode: 0, output: formatAbort(result) };
}

async function worker(
	args: readonly string[],
	jsonMode: boolean,
	resolved: ResolvedProject,
	deps: MigrateStrategyDeps
): Promise<CommandResult> {
	const parsed = parseOptions('worker', args, { flags: [], values: [] }, jsonMode);
	if (isResult(parsed)) return parsed;
	const ctx = openResolvedProject(resolved, deps.configDir);
	try {
		const migration = await openMigration(ctx);
		const result = await migration.runWorker({
			sleep: deps.sleep,
			...(deps.signal === undefined ? {} : { signal: deps.signal }),
		});
		if (jsonMode) return { exitCode: result.status === 'stopped' ? 1 : 0, output: JSON.stringify(result, null, 2) };
		const line = `worker ended: ${result.status} (${result.moved} task(s) moved in this run)`;
		if (result.status === 'stopped') {
			return { exitCode: 1, output: `Error: ${line}: ${result.reason ?? ''}\nSee: ${STATUS}` };
		}
		return { exitCode: 0, output: line };
	} finally {
		await ctx.dispose?.();
	}
}
