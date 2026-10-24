import { queueEventDeclarations, TASK_QUEUE_SOURCE } from './queueEventDeclarations.js';
import type { EventPublisher } from './queueEventSink.js';
import { appendTaskLog } from './taskLog.js';

export interface DeclareTaskEventsOptions {
	/** Directory of the task log (`<config dir>/logs`). Called lazily. */
	getLogDir: () => string;
	/** Where the one line for a BUG of ours goes (a rejected declaration). Default: process.stderr. */
	writeStderr?: (text: string) => void;
}

/**
 * What came of declaring the events to the queue. Only `registered` means the queue knows them now.
 * `rejected` is a bug in our declaration; `unsupported` an old queue (nothing to fix here); `dropped` nothing was stored
 * (queue not reachable, switched off); `unknown` it may be stored (the connection broke twice).
 */
export type DeclareEventsOutcome =
	| { status: 'registered'; count: number }
	| { status: 'rejected'; reason: string; problems: { path: string; message: string }[] }
	| { status: 'unsupported'; reason: string }
	| { status: 'dropped'; reason: string }
	| { status: 'unknown'; reason: string };

const NO_REASON = 'the queue SDK gave no reason (run `queue status`)';

/**
 * Tells the queue which events task pushes (`registerEvents`, source `task`; it replaces the previous declaration, so
 * calling it again is harmless). Never throws. Reporting: `registered` is quiet; `unsupported` (info), `dropped` and `unknown`
 * (warn) go to the task log only; `rejected` is a bug in our declaration, so it also gets one stderr line.
 */
export async function declareTaskEvents(
	publisher: EventPublisher,
	options: DeclareTaskEventsOptions
): Promise<DeclareEventsOutcome> {
	const writeStderr = options.writeStderr ?? ((text: string) => void process.stderr.write(text));

	function log(level: 'info' | 'warn' | 'error', msg: string): void {
		let failure: string | undefined;
		try {
			failure = appendTaskLog(options.getLogDir(), level, msg);
		} catch (error) {
			failure = error instanceof Error ? error.message : String(error);
		}
		if (failure !== undefined) {
			writeStderr(`[task] could not record the event declaration result in the task log: ${failure}\n`);
		}
	}

	let outcome: Exclude<DeclareEventsOutcome, { status: 'registered' }>;
	try {
		const result = await publisher.registerEvents(TASK_QUEUE_SOURCE, [...queueEventDeclarations]);
		const reason = result.reason ?? NO_REASON;
		switch (result.status) {
			case 'registered':
				return { status: 'registered', count: result.count ?? queueEventDeclarations.length };
			case 'rejected':
				outcome = { status: 'rejected', reason, problems: result.problems ?? [] };
				break;
			case 'unsupported':
				outcome = { status: 'unsupported', reason };
				break;
			case 'dropped':
				outcome = { status: 'dropped', reason };
				break;
			case 'unknown':
				outcome = { status: 'unknown', reason };
				break;
		}
	} catch (error) {
		// The SDK promises never to reject: if it does, whether the declaration was stored is not known.
		const message = error instanceof Error ? error.message : String(error);
		outcome = {
			status: 'unknown',
			reason: `the queue SDK failed unexpectedly (${message}): the declaration MAY be stored`,
		};
	}

	switch (outcome.status) {
		case 'rejected': {
			const problems =
				outcome.problems.length > 0
					? outcome.problems.map(problem => `${problem.path}: ${problem.message}`).join('; ')
					: outcome.reason;
			writeStderr(
				`[task] the queue refused the declaration of the task events (a bug in task, please report it): ${problems} (details: task cli logs)\n`
			);
			log('error', `queue event declaration rejected, nothing stored: ${problems}`);
			return outcome;
		}
		case 'unsupported':
			log(
				'info',
				`queue event declaration not sent, the queue is too old for the event catalog: ${outcome.reason}`
			);
			return outcome;
		case 'dropped':
			log('warn', `queue event declaration not stored: ${outcome.reason}`);
			return outcome;
		case 'unknown':
			log('warn', `queue event declaration MAY be stored, it is sent again next time: ${outcome.reason}`);
			return outcome;
	}
}
