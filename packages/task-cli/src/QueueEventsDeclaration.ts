// Declaring the task events to the queue from the short-lived CLI: once per declaration, not at every command.
//
// The CLI has no start-up hook and the updater bundle (task-updater.cjs) must stay free of the queue SDK, so the declaration
// happens lazily, just before the first event of a process is delivered (the queue is about to be contacted anyway), and
// only when the marker `<config dir>/queue-events.json` does not already hold the hash of the current declaration. The
// marker is written only after the queue stored the declaration: a failed attempt is retried by the next process.
import * as fs from 'node:fs';
import * as path from 'node:path';

import { appendTaskLog, getTaskLogDir, queueEventDeclarationsHash } from '@wadeck-app/task-service';
import type { DeclareEventsOutcome, EventSink } from '@wadeck-app/task-service';

import type { CommandResult } from './cli/output.js';

/** What a sink must offer to be declared through (the default queue sink does). */
export type DeclaringSink = EventSink & { declareEvents(): Promise<DeclareEventsOutcome> };

export interface DeclarationOptions {
	/** The task config dir (`ConfigDir.get('task')`): holds the marker and the log. */
	configDir: string;
	/** Version of this CLI, informational in the marker. */
	taskVersion: string;
	/** Where the one line for a marker that cannot be written goes. Default: process.stderr. */
	writeStderr?: (text: string) => void;
}

/** The file recording the last declaration the queue stored: `{ hash, taskVersion, declaredAt }`. */
export function queueEventsMarkerPath(configDir: string): string {
	return path.join(configDir, 'queue-events.json');
}

/** The hash stored in the marker; undefined when there is no marker. A marker that cannot be read is logged and treated as absent. */
function readMarkerHash(options: DeclarationOptions): string | undefined {
	const file = queueEventsMarkerPath(options.configDir);
	let text: string;
	try {
		text = fs.readFileSync(file, 'utf8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
		logMarkerProblem(options, `cannot be read (${(error as Error).message})`);
		return undefined;
	}
	try {
		const marker: unknown = JSON.parse(text);
		const hash = (marker as { hash?: unknown } | null)?.hash;
		if (typeof hash === 'string') return hash;
		logMarkerProblem(options, 'has no "hash"');
	} catch (error) {
		logMarkerProblem(options, `is not valid JSON (${(error as Error).message})`);
	}
	return undefined;
}

function logMarkerProblem(options: DeclarationOptions, problem: string): void {
	// Self-healing: the declaration is sent again and the marker replaced. The log keeps the trace.
	appendTaskLog(
		getTaskLogDir(options.configDir),
		'warn',
		`${queueEventsMarkerPath(options.configDir)} ${problem}: declaring the task events to the queue again and replacing it`
	);
}

function writeMarker(options: DeclarationOptions): void {
	const file = queueEventsMarkerPath(options.configDir);
	const writeStderr = options.writeStderr ?? ((text: string) => void process.stderr.write(text));
	try {
		fs.mkdirSync(options.configDir, { recursive: true });
		const temporary = `${file}.${process.pid}.tmp`;
		const marker = {
			hash: queueEventDeclarationsHash(),
			taskVersion: options.taskVersion,
			declaredAt: new Date().toISOString(),
		};
		fs.writeFileSync(temporary, JSON.stringify(marker, null, 2) + '\n', 'utf8');
		fs.renameSync(temporary, file);
	} catch (error) {
		writeStderr(
			`[task] could not write ${file} (${(error as Error).message}): the task events will be declared again to the queue at the next event. Check that ${options.configDir} is writable.\n`
		);
	}
}

async function declare(sink: DeclaringSink): Promise<DeclareEventsOutcome> {
	try {
		return await sink.declareEvents();
	} catch (error) {
		// declareEvents promises never to reject; if it does, whether the queue stored the declaration is not known.
		const message = error instanceof Error ? error.message : String(error);
		return { status: 'unknown', reason: `declaring the events failed unexpectedly (${message})` };
	}
}

/**
 * Declares the events unless the marker says the queue already has this declaration. Never throws. The marker is written
 * only for `registered`; any other outcome (already reported in the task log by the sink) leaves it absent so that the next
 * process tries again.
 */
export async function declareOnce(
	sink: DeclaringSink,
	options: DeclarationOptions
): Promise<DeclareEventsOutcome | 'up-to-date'> {
	if (readMarkerHash(options) === queueEventDeclarationsHash()) return 'up-to-date';
	const outcome = await declare(sink);
	if (outcome.status === 'registered') writeMarker(options);
	return outcome;
}

/**
 * The sink with the declaration done lazily before its first delivery (once per process, then the marker decides for the
 * next ones). A command that delivers no event never declares. A failed declaration never fails the delivery.
 */
export function declareBeforeFirstDelivery(sink: DeclaringSink, options: DeclarationOptions): EventSink {
	let declaration: Promise<unknown> | undefined;
	return {
		async deliver(event) {
			declaration ??= declareOnce(sink, options);
			await declaration;
			return sink.deliver(event);
		},
		...(sink.flush === undefined ? {} : { flush: () => sink.flush!() }),
	};
}

/**
 * `task cli declare-events [--json]`: declares now, whatever the marker says (for a queue whose catalog was lost, or
 * once an old queue-cli was updated), and records the marker on success. Exit 1 with the reason and what to do otherwise.
 */
export async function runDeclareEvents(
	sink: DeclaringSink,
	jsonMode: boolean,
	options: DeclarationOptions
): Promise<CommandResult> {
	const outcome = await declare(sink);
	if (outcome.status === 'registered') writeMarker(options);
	const exitCode = outcome.status === 'registered' ? 0 : 1;
	if (jsonMode) return { exitCode, output: JSON.stringify(outcome) };
	switch (outcome.status) {
		case 'registered':
			return { exitCode, output: `Declared ${outcome.count} events to the queue (source: task).` };
		case 'rejected': {
			const problems = outcome.problems.map(problem => `  ${problem.path}: ${problem.message}`).join('\n');
			return {
				exitCode,
				output: `Error: the queue refused the declaration of the task events (a bug in task, please report it):\n${problems.length > 0 ? problems : `  ${outcome.reason}`}`,
			};
		}
		case 'unsupported':
			return {
				exitCode,
				output: `Error: the queue is too old to take event declarations: ${outcome.reason}\nUpdate queue-cli, restart the daemon (queue stop, queue start), then run: task cli declare-events`,
			};
		case 'dropped':
		case 'unknown':
			return {
				exitCode,
				output: `Error: the task events were not declared: ${outcome.reason}\nCheck the queue (queue status), then run: task cli declare-events (details: task cli logs)`,
			};
	}
}
