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

/** Destination of task events (the queue, a test recorder, ...). Must not throw for undeliverable events: it reports them. */
export interface EventSink {
	deliver(event: TaskEvent): Promise<void>;
}

/** Delivers events sequentially, in order. */
export async function deliverEvents(sink: EventSink, events: readonly TaskEvent[]): Promise<void> {
	for (const event of events) {
		await sink.deliver(event);
	}
}
