import { deliverEvents } from '@wadeck-app/task-service';
import type { EventSink, TaskEvent, UndeliveredEvent } from '@wadeck-app/task-service';

import { RequestError } from './errors.js';

/** An event the queue did not receive, as reported in the body of a mutating route. */
export interface UndeliveredAnswer {
	event: string;
	taskId: string | undefined;
	reason: string;
	/** Command that replays the event once the cause is fixed. */
	replay: string;
}

function toUndeliveredAnswer(undelivered: UndeliveredEvent): UndeliveredAnswer {
	return {
		event: undelivered.event.name,
		taskId: undelivered.event.payload.taskId,
		reason: undelivered.reason,
		replay: undelivered.replay,
	};
}

/** One display line about the events the queue did not get; null when all were delivered. */
function undeliveredLine(undelivered: readonly UndeliveredAnswer[]): string | null {
	if (undelivered.length === 0) return null;
	const details = undelivered
		.map(entry => `${entry.event} (${entry.reason}), replay with: ${entry.replay}`)
		.join('; ');
	return `The change is saved but ${undelivered.length} queue event(s) were not delivered: ${details}`;
}

/** The `undelivered` / `undeliveredText` fields every mutating route that produces events adds to its body. */
export function undeliveredFields(undelivered: readonly UndeliveredAnswer[]): {
	undelivered: readonly UndeliveredAnswer[];
	undeliveredText: string | null;
} {
	return { undelivered, undeliveredText: undeliveredLine(undelivered) };
}

/**
 * Hands the events to the sink. Events the sink could not deliver do not fail the request (the change is applied):
 * they are returned for the JSON body. A sink that throws is a 500.
 */
export async function deliverForRequest(sink: EventSink, events: readonly TaskEvent[]): Promise<UndeliveredAnswer[]> {
	try {
		const outcome = await deliverEvents(sink, events);
		return outcome.undelivered.map(toUndeliveredAnswer);
	} catch (error) {
		throw new RequestError(
			500,
			`the change was applied but its queue events were not delivered: ${error instanceof Error ? error.message : String(error)}`,
			'The change is saved; only the events are missing. Check that the queue CLI is installed and on PATH (`queue --version`).'
		);
	}
}
