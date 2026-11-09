import type { TaskServiceContext } from './context.js';
import { eventSinkFor, eventsRaisedByServer } from './eventsRaisedByServer.js';
import type { EventSink, TaskEvent } from './events.js';
import { createTestContext } from './testHelpers.js';

const EVENT: TaskEvent = { name: 'onTaskLabelAdded', payload: { taskId: 'a', label: 'x', taskProjectName: 'p' } };

function sinkThatRecords(): EventSink & { got: TaskEvent[]; flushes: number } {
	const sink = {
		got: [] as TaskEvent[],
		flushes: 0,
		deliver(event: TaskEvent) {
			sink.got.push(event);
			return Promise.resolve({ delivered: true as const });
		},
		flush() {
			sink.flushes++;
			return Promise.resolve();
		},
	};
	return sink;
}

function remoteLike(): { ctx: TaskServiceContext; cleanup: () => void } {
	const t = createTestContext();
	const store = new Proxy(t.ctx.store, {
		get: (target, property, receiver) =>
			property === 'capabilities'
				? { ...target.capabilities, events: 'server' }
				: (Reflect.get(target, property, receiver) as unknown),
	});
	return { ctx: { ...t.ctx, store }, cleanup: t.cleanup };
}

describe('who raises the events of a project', () => {
	it("a local project raises its own: the sink is the caller's", () => {
		const t = createTestContext();
		const sink = sinkThatRecords();

		expect(eventsRaisedByServer(t.ctx)).toBe(false);
		expect(eventSinkFor(t.ctx, sink)).toBe(sink);
		t.cleanup();
	});

	it('a project whose server raises them gets a sink that raises none, and says it delivered (the server did)', async () => {
		const { ctx, cleanup } = remoteLike();
		const sink = sinkThatRecords();

		const mine = eventSinkFor(ctx, sink);
		const outcome = await mine.deliver(EVENT);

		expect(eventsRaisedByServer(ctx)).toBe(true);
		expect(outcome).toEqual({ delivered: true });
		expect(sink.got).toEqual([]);
		cleanup();
	});

	it('still flushes the real sink (it may hold something from another project of the same process)', async () => {
		const { ctx, cleanup } = remoteLike();
		const sink = sinkThatRecords();

		await eventSinkFor(ctx, sink).flush?.();

		expect(sink.flushes).toBe(1);
		cleanup();
	});
});
