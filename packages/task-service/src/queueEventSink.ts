import * as fs from 'node:fs';
import * as path from 'node:path';

import { createQueuePublisher } from '@wadeck-app/queue-sdk';

import { declareTaskEvents, type DeclareEventsOutcome } from './declareTaskEvents.js';
import type { QueueEventDeclaration } from './queueEventDeclarations.js';
import {
	eventProjectDir,
	replayCommand,
	type EventDelivery,
	type EventSink,
	type TaskEvent,
	type UndeliveredStatus,
} from './events.js';

/** What `publishAndWait` of `@wadeck-app/queue-sdk` answers (it never rejects). */
export interface PublishOutcome {
	/** `queued`/`dispatched`: recorded. `dropped`: NOT recorded. `unknown`: sent, then the connection broke or timed out: MAY be recorded. */
	status: 'queued' | 'dispatched' | 'dropped' | 'unknown';
	eventId?: string | undefined;
	reason?: string | undefined;
}

/** What `registerEvents` of `@wadeck-app/queue-sdk` answers (it never rejects). */
export interface RegisterEventsOutcome {
	/** `registered`: stored. `rejected`: the daemon refused it. `unsupported`: daemon older than protocol 1.1.0. `dropped`: nothing stored. `unknown`: may be stored. */
	status: 'registered' | 'rejected' | 'unsupported' | 'dropped' | 'unknown';
	count?: number | undefined;
	problems?: { path: string; message: string }[] | undefined;
	reason?: string | undefined;
}

/** The part of the SDK publisher the sink uses; tests inject a fake. */
export interface EventPublisher {
	publishAndWait(event: string, payload: unknown, options: { cwd: string }): Promise<PublishOutcome>;
	/** Declares the events of a source to the queue (replaces its previous declaration). */
	registerEvents(source: string, events: QueueEventDeclaration[]): Promise<RegisterEventsOutcome>;
	/** Waits for the pushes in flight (`QueuePublisher.flush`). */
	flush?(): Promise<void>;
}

/** The default sink: delivers events, and declares them to the queue. */
export type QueueEventSink = EventSink & {
	flush(): Promise<void>;
	/**
	 * Tells the queue which events task pushes (see {@link declareTaskEvents}), through the sink's publisher. Never throws;
	 * `flush()` waits for it. The caller decides when (module: at start; CLI: before the first delivery after an install or update).
	 */
	declareEvents(): Promise<DeclareEventsOutcome>;
};

/** A failure the SDK reports through its `onError` (`{ kind, message, event, outcome }`; kinds: queue-sdk docs/troubleshooting.md). */
interface SdkFailure {
	kind: string;
	message: string;
	event?: string | undefined;
	outcome?: string | undefined;
}

export interface PublisherHooks {
	onError: (failure: SdkFailure) => void;
}

export interface QueueEventSinkOptions {
	/** Directory receiving the `YYYY-MM-DD.ndjson` log of undelivered events (e.g. `<ConfigDir task>/logs`). Called lazily. */
	getLogDir: () => string;
	/** Where to report undelivered events for the interactive user. Default: process.stderr. */
	writeStderr?: (text: string) => void;
	/** The publisher to use (tests). Takes precedence over `createPublisher`. */
	publisher?: EventPublisher;
	/** Builds the publisher at the first delivery (never before). Default: the queue SDK, silent (the sink reports) and logging `onError` in the task log. */
	createPublisher?: (hooks: PublisherHooks) => EventPublisher;
}

/** Why a `dropped` answer had no reason from the SDK: said out loud rather than leaving an empty reason. */
const NO_REASON = 'the queue SDK gave no reason (run `queue status` and read `queue history`)';

/**
 * Default Node sink: delivers each event through `@wadeck-app/queue-sdk` (`publishAndWait`, with `cwd = payload.taskProjectPath`:
 * the SDK sends it and queue finds the project's subscribers from it). One publisher for the life of the sink, created at the
 * first delivery. A failed delivery never throws: it is reported on stderr AND in the task log (stderr is lost when task runs
 * inside a flow step, the log is not), and returned as `{ delivered: false, reason, status, replay }` so callers without a
 * terminal (the HTTP routes) can surface it. The log line carries the payload (inside the replay text).
 */
export function createQueueEventSink(options: QueueEventSinkOptions): QueueEventSink {
	const writeStderr = options.writeStderr ?? ((text: string) => void process.stderr.write(text));
	let publisher: EventPublisher | undefined = options.publisher;

	function appendLog(level: 'error' | 'warn', msg: string): void {
		try {
			const logFile = path.join(options.getLogDir(), `${new Date().toISOString().slice(0, 10)}.ndjson`);
			fs.mkdirSync(path.dirname(logFile), { recursive: true });
			fs.appendFileSync(logFile, JSON.stringify({ ts: new Date().toISOString(), level, msg }) + '\n');
		} catch (error) {
			writeStderr(`[task] could not record the undelivered event in the task log: ${(error as Error).message}\n`);
		}
	}

	// The SDK already reports each failure to the caller of publishAndWait (reported once by deliver): the hook adds the
	// SDK's kind and message to the log only, silent on stderr to not print everything twice.
	const hooks: PublisherHooks = {
		onError(failure) {
			const eventPart = failure.event === undefined ? '' : ` (event ${failure.event})`;
			const outcomePart = failure.outcome === undefined ? '' : `, outcome ${failure.outcome}`;
			appendLog('warn', `queue SDK ${failure.kind}${eventPart}${outcomePart}: ${failure.message}`);
		},
	};

	function getPublisher(): EventPublisher {
		publisher ??= (options.createPublisher ?? defaultPublisher)(hooks);
		return publisher;
	}

	function undelivered(
		event: TaskEvent,
		status: UndeliveredStatus,
		reason: string,
		replay: string
	): EventDelivery & { delivered: false } {
		const taskPart = typeof event.payload.taskId === 'string' ? ` for task ${event.payload.taskId}` : '';
		writeStderr(
			`[task] queue push '${event.name}'${taskPart} not delivered: ${reason} (details and replay command: task cli logs)\n`
		);
		appendLog('error', `queue push '${event.name}'${taskPart} not delivered: ${reason}. Replay with: ${replay}`);
		return { delivered: false, reason, status, replay };
	}

	// Declarations still in flight: flush() waits for them like for the pushes (a one-shot process must not exit before).
	const declarations = new Set<Promise<unknown>>();

	return {
		declareEvents(): Promise<DeclareEventsOutcome> {
			let started: Promise<DeclareEventsOutcome>;
			try {
				started = declareTaskEvents(getPublisher(), {
					getLogDir: options.getLogDir,
					writeStderr,
				});
			} catch (error) {
				// Building the publisher failed: nothing was sent. Never throws, like the declaration itself.
				const message = error instanceof Error ? error.message : String(error);
				const reason = `the queue SDK publisher could not be created (${message})`;
				appendLog('warn', `queue event declaration not stored: ${reason}`);
				return Promise.resolve({ status: 'dropped', reason });
			}
			declarations.add(started);
			void started.finally(() => declarations.delete(started));
			return started;
		},

		async deliver(event: TaskEvent): Promise<EventDelivery> {
			// queue finds the project's .queue/subscribers.yml from the cwd the SDK sends: never fall back to our own cwd.
			const projectDir = eventProjectDir(event);
			if (projectDir === undefined) {
				return undelivered(
					event,
					'dropped',
					'the event payload has no taskProjectPath, so the project whose subscribers must receive it is unknown (bug in the code that produced the event: please report it)',
					replayCommand(event)
				);
			}
			let outcome: PublishOutcome;
			try {
				outcome = await getPublisher().publishAndWait(event.name, event.payload, { cwd: projectDir });
			} catch (error) {
				// The SDK promises never to reject: if it does, whether the event arrived is not known.
				const message = error instanceof Error ? error.message : String(error);
				return undelivered(
					event,
					'unknown',
					`the queue SDK failed unexpectedly (${message}): the event MAY be recorded`,
					uncertainReplay(event)
				);
			}
			switch (outcome.status) {
				case 'queued':
				case 'dispatched':
					return { delivered: true };
				case 'dropped':
					return undelivered(event, 'dropped', outcome.reason ?? NO_REASON, replayCommand(event));
				case 'unknown':
					return undelivered(
						event,
						'unknown',
						`the event MAY be recorded: ${outcome.reason ?? 'the connection broke or timed out after it was sent'}`,
						uncertainReplay(event)
					);
			}
		},

		async flush(): Promise<void> {
			await Promise.all([...declarations]);
			// Nothing was ever published: nothing to wait for, and no publisher is created just to flush it.
			if (publisher?.flush === undefined) return;
			try {
				await publisher.flush();
			} catch (error) {
				writeStderr(`[task] flushing the queue SDK failed, events may be lost: ${(error as Error).message}\n`);
			}
		},
	};
}

/** The SDK publisher: silent (the sink reports on stderr and in the log), failures going to the task log through `onError`. */
function defaultPublisher(hooks: PublisherHooks): EventPublisher {
	return createQueuePublisher({ silent: true, onError: hooks.onError });
}

/**
 * Replay text for an event that MAY be recorded (never retried automatically): check the history first, then replay the
 * recorded event, or push again when it is absent.
 */
function uncertainReplay(event: TaskEvent): string {
	const dir = eventProjectDir(event) ?? '<project directory>';
	return (
		`first check whether it arrived: cd '${dir.replaceAll("'", "'\\''")}' && queue history. ` +
		`If it is listed, run: queue replay <eventId> (the id shown by queue history). ` +
		`If it is absent, push it again: ${replayCommand(event)}`
	);
}
