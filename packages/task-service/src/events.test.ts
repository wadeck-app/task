import { deliverEvents, replayCommand, type EventSink, type TaskEvent } from './events.js';

const linked: TaskEvent = {
	name: 'onTaskLinked',
	payload: { taskId: 'abc', linkType: 'blockedBy', targetId: 'def', taskProjectName: 'p', taskProjectPath: '/p' },
};
const unlinked: TaskEvent = { ...linked, name: 'onTaskUnlinked' };

describe('replayCommand', () => {
	// `queue push` has no working-directory option: it uses its cwd to find .queue/subscribers.yml, so the replay changes directory first.
	it('changes to the project directory, then runs the exact `queue push`', () => {
		expect(replayCommand(linked)).toBe(`cd '/p' && queue push onTaskLinked '${JSON.stringify(linked.payload)}'`);
	});

	it('quotes single quotes of the directory and of the payload for a POSIX shell', () => {
		const event: TaskEvent = {
			name: 'onTaskLinked',
			payload: { ...linked.payload, taskProjectPath: "C:\\Users\\O'Neil\\my proj", targetId: "it's" },
		};

		const command = replayCommand(event);

		expect(command.startsWith(`cd 'C:\\Users\\O'\\''Neil\\my proj' && queue push onTaskLinked `)).toBe(true);
		expect(command).toContain(`it'\\''s`);
	});

	it('names the missing directory instead of silently omitting the cd', () => {
		const payload: Record<string, unknown> = { ...linked.payload };
		delete payload['taskProjectPath'];

		expect(replayCommand({ name: 'onTaskLinked', payload } as unknown as TaskEvent)).toContain(
			`cd '<project directory>' && queue push`
		);
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
