import type { LinkType } from '@wadeck-app/task-core';

/** Project identification appended to every event payload. */
export interface TaskProjectEnv {
	taskProjectName: string;
	taskProjectPath: string;
}

export interface TaskCreatedEvent {
	name: 'onTaskCreated';
	payload: {
		taskId: string;
		status: string;
		description: string;
		parentId: string | undefined;
		type: string | undefined;
		labels: string[];
	} & TaskProjectEnv;
}

export interface TaskStatusChangeEvent {
	name: 'onStatusChange';
	payload: {
		taskId: string;
		oldStatus: string;
		newStatus: string;
		type: string | undefined;
		labels: string[];
	} & TaskProjectEnv;
}

export interface TaskLinkedEvent {
	name: 'onTaskLinked';
	payload: { taskId: string; linkType: LinkType; targetId: string } & TaskProjectEnv;
}

export interface TaskUnlinkedEvent {
	name: 'onTaskUnlinked';
	payload: { taskId: string; linkType: LinkType; targetId: string } & TaskProjectEnv;
}

export interface TaskUnblockedEvent {
	name: 'onTaskUnblocked';
	payload: {
		taskId: string;
		blockerId: string;
		status: string;
		type: string | undefined;
		labels: string[];
	} & TaskProjectEnv;
}

/** Event produced by an operation. Operations never deliver events: the caller hands them to an EventSink. */
export type TaskEvent =
	TaskCreatedEvent | TaskStatusChangeEvent | TaskLinkedEvent | TaskUnlinkedEvent | TaskUnblockedEvent;

/** Result of delivering one event. A sink reports an undeliverable event this way instead of throwing. */
export type EventDelivery = { delivered: true } | { delivered: false; reason: string };

/** Destination of task events (the queue, a test recorder, ...). Reports undeliverable events in its result; throws only on unexpected failures. */
export interface EventSink {
	deliver(event: TaskEvent): Promise<EventDelivery>;
}

export interface UndeliveredEvent {
	event: TaskEvent;
	reason: string;
	/** Shell command that replays the event once the cause is fixed. */
	replay: string;
}

export interface DeliveryOutcome {
	delivered: number;
	undelivered: UndeliveredEvent[];
}

/** The `queue push` command that redelivers `event`. */
export function replayCommand(event: TaskEvent): string {
	return `queue push ${event.name} '${JSON.stringify(event.payload)}'`;
}

/** Delivers events sequentially, in order, and reports which ones did not arrive. */
export async function deliverEvents(sink: EventSink, events: readonly TaskEvent[]): Promise<DeliveryOutcome> {
	const outcome: DeliveryOutcome = { delivered: 0, undelivered: [] };
	for (const event of events) {
		const result = await sink.deliver(event);
		if (result.delivered) {
			outcome.delivered++;
		} else {
			outcome.undelivered.push({ event, reason: result.reason, replay: replayCommand(event) });
		}
	}
	return outcome;
}
