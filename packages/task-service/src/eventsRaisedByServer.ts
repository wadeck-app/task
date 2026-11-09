// Who raises the queue events of a project (capabilities.events): this process, or the server that stores the tasks (a remote
// project, design R7). The use cases build the same events either way; what differs is the destination. A caller that delivers the
// events a use case returned hands them to `eventSinkFor(ctx, sink)`: for a remote project the server has already raised them (it saw
// the write), so delivering them here too would run every subscriber twice, once with the paths of the wrong machine.
import type { TaskServiceContext } from './context.js';
import type { EventSink } from './events.js';

/** True when the server of the project raises its queue events and this process must raise none. */
export function eventsRaisedByServer(ctx: Pick<TaskServiceContext, 'store'>): boolean {
	return ctx.store.capabilities.events === 'server';
}

/** The sink to deliver the events of `ctx` to: the given one, or for a remote project a sink that raises none (the server did). */
export function eventSinkFor(ctx: Pick<TaskServiceContext, 'store'>, sink: EventSink): EventSink {
	if (!eventsRaisedByServer(ctx)) return sink;
	return {
		deliver: () => Promise.resolve({ delivered: true }),
		flush: () => sink.flush?.() ?? Promise.resolve(),
	};
}
