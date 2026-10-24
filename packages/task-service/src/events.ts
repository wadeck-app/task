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
		/** Always equal to `newStatus`: lets a subscriber filter on `payload.status` like on onTaskCreated / onTaskUnblocked. */
		status: string;
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

export interface TaskTypeChangedEvent {
	name: 'onTaskTypeChanged';
	payload: { taskId: string; oldType: string | undefined; newType: string } & TaskProjectEnv;
}

export interface TaskLabelAddedEvent {
	name: 'onTaskLabelAdded';
	payload: { taskId: string; label: string } & TaskProjectEnv;
}

export interface TaskLabelRemovedEvent {
	name: 'onTaskLabelRemoved';
	payload: { taskId: string; label: string } & TaskProjectEnv;
}

export interface TaskMetaChangedEvent {
	name: 'onTaskMetaChanged';
	payload: {
		taskId: string;
		key: string;
		oldValue: string | undefined;
		newValue: string;
	} & TaskProjectEnv;
}

export interface TaskParentChangedEvent {
	name: 'onTaskParentChanged';
	payload: {
		taskId: string;
		oldParentId: string | undefined;
		newParentId: string | undefined;
	} & TaskProjectEnv;
}

export interface TaskDeletedEvent {
	name: 'onTaskDeleted';
	payload: {
		taskId: string;
		/** The task's description (its title), as in onTaskCreated. */
		description: string;
		status: string;
		parentId: string | undefined;
		/** Children that lost their parent and became root tasks (empty in a cascade: they are deleted before it). */
		orphanedChildIds: string[];
		/** Links held by the tasks still present that pointed to this one and were removed with it. */
		removedLinkCount: number;
	} & TaskProjectEnv;
}

/** Event produced by an operation. Operations never deliver events: the caller hands them to an EventSink. */
export type TaskEvent =
	| TaskCreatedEvent
	| TaskStatusChangeEvent
	| TaskLinkedEvent
	| TaskUnlinkedEvent
	| TaskUnblockedEvent
	| TaskTypeChangedEvent
	| TaskLabelAddedEvent
	| TaskLabelRemovedEvent
	| TaskMetaChangedEvent
	| TaskParentChangedEvent
	| TaskDeletedEvent;

/**
 * What is known about an event that did not arrive: `dropped` = the queue did NOT record it (replaying is safe),
 * `unknown` = it MAY be recorded (connection broke or timed out after sending: check before replaying).
 */
export type UndeliveredStatus = 'dropped' | 'unknown';

/**
 * Result of delivering one event. A sink reports an undeliverable event this way instead of throwing.
 * `status` defaults to `dropped` and `replay` to {@link replayCommand} when a sink does not set them.
 */
export type EventDelivery =
	{ delivered: true } | { delivered: false; reason: string; status?: UndeliveredStatus; replay?: string };

/** Destination of task events (the queue, a test recorder, ...). Reports undeliverable events in its result; throws only on unexpected failures. */
export interface EventSink {
	deliver(event: TaskEvent): Promise<EventDelivery>;
	/** Waits for what the sink still has in flight. A one-shot process calls it before exiting. Optional: a sink that sends synchronously has nothing to wait for. */
	flush?(): Promise<void>;
}

export interface UndeliveredEvent {
	event: TaskEvent;
	reason: string;
	/** `dropped`: not recorded by the queue. `unknown`: may be recorded, see `replay`. */
	status: UndeliveredStatus;
	/** Text (a shell command, or the steps to check first for `unknown`) that redelivers the event once the cause is fixed. */
	replay: string;
}

export interface DeliveryOutcome {
	delivered: number;
	undelivered: UndeliveredEvent[];
}

/** POSIX single-quoting (bash, Git Bash, zsh): a single quote inside the text becomes '\''. */
function shellQuote(text: string): string {
	return `'${text.replaceAll("'", "'\\''")}'`;
}

/** Directory the queue command must run in for this event (queue looks for .queue/subscribers.yml from there); undefined when the payload has none. */
export function eventProjectDir(event: TaskEvent): string | undefined {
	const dir: unknown = (event.payload as { taskProjectPath?: unknown }).taskProjectPath;
	return typeof dir === 'string' && dir.length > 0 ? dir : undefined;
}

/**
 * The shell command that redelivers `event`: `cd '<project dir>' && queue push <event> '<json>'` (POSIX quoting).
 * The queue command has no working-directory option, it uses its cwd, hence the `cd`. A payload without project directory
 * (a bug of the producer) shows a placeholder, so that the text does not look replayable from anywhere.
 */
export function replayCommand(event: TaskEvent): string {
	const dir = eventProjectDir(event) ?? '<project directory>';
	return `cd ${shellQuote(dir)} && queue push ${event.name} ${shellQuote(JSON.stringify(event.payload))}`;
}

/** Delivers events sequentially, in order, and reports which ones did not arrive. */
export async function deliverEvents(sink: EventSink, events: readonly TaskEvent[]): Promise<DeliveryOutcome> {
	const outcome: DeliveryOutcome = { delivered: 0, undelivered: [] };
	for (const event of events) {
		const result = await sink.deliver(event);
		if (result.delivered) {
			outcome.delivered++;
		} else {
			outcome.undelivered.push({
				event,
				reason: result.reason,
				status: result.status ?? 'dropped',
				replay: result.replay ?? replayCommand(event),
			});
		}
	}
	return outcome;
}
