import { deliverEvents, replayCommand, type EventSink, type TaskEvent } from './events.js';

const linked: TaskEvent = {
	name: 'onTaskLinked',
	payload: { taskId: 'abc', linkType: 'blockedBy', targetId: 'def', taskProjectName: 'p', taskProjectPath: '/p' },
};
const unlinked: TaskEvent = { ...linked, name: 'onTaskUnlinked' };

describe('replayCommand', () => {
	it('is the exact `queue push` command that redelivers the event', () => {
		expect(replayCommand(linked)).toBe(`queue push onTaskLinked '${JSON.stringify(linked.payload)}'`);
	});
});

describe('deliverEvents', () => {
	it('counts delivered events and lists the undelivered ones with their reason and replay command, in order', async () => {
		const sink: EventSink = {
			deliver: event =>
				Promise.resolve(
					event.name === 'onTaskLinked' ? { delivered: true } : { delivered: false, reason: 'exit 3' }
				),
		};

		const outcome = await deliverEvents(sink, [linked, unlinked, linked]);

		expect(outcome).toEqual({
			delivered: 2,
			undelivered: [{ event: unlinked, reason: 'exit 3', replay: replayCommand(unlinked) }],
		});
	});

	it('reports nothing undelivered for an empty list', async () => {
		const sink: EventSink = { deliver: () => Promise.reject(new Error('must not be called')) };

		expect(await deliverEvents(sink, [])).toEqual({ delivered: 0, undelivered: [] });
	});

	it('lets a throwing sink propagate', async () => {
		const sink: EventSink = { deliver: () => Promise.reject(new Error('boom')) };

		await expect(deliverEvents(sink, [linked])).rejects.toThrow('boom');
	});
});
