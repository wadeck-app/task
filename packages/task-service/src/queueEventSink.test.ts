import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { deliverEvents, type TaskEvent } from './events.js';
import { queueEventDeclarations } from './queueEventDeclarations.js';
import { createQueueEventSink, type EventPublisher, type PublishOutcome } from './queueEventSink.js';

const EVENT: TaskEvent = {
	name: 'onTaskLinked',
	payload: { taskId: 'abc', linkType: 'blockedBy', targetId: 'def', taskProjectName: 'p', taskProjectPath: '/p' },
};

interface PublishCall {
	event: string;
	payload: unknown;
	options: { cwd: string };
}

// Plain functions, not vi.fn(): the config's mockReset would wipe an implementation set at creation.
function fakePublisher(answer: (call: PublishCall) => Promise<PublishOutcome> | PublishOutcome): {
	publisher: Required<EventPublisher>;
	calls: PublishCall[];
	flushed: () => number;
} {
	const calls: PublishCall[] = [];
	let flushCount = 0;
	return {
		calls,
		flushed: () => flushCount,
		publisher: {
			async publishAndWait(event, payload, options) {
				const call = { event, payload, options };
				calls.push(call);
				return answer(call);
			},
			registerEvents() {
				return Promise.resolve({ status: 'registered', count: 5 });
			},
			flush() {
				flushCount++;
				return Promise.resolve();
			},
		},
	};
}

describe('createQueueEventSink', () => {
	let logRoot: string;
	let stderr: string[];

	beforeEach(() => {
		logRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'task-sink-'));
		stderr = [];
	});
	afterEach(() => fs.rmSync(logRoot, { recursive: true, force: true }));

	function makeSink(publisher: EventPublisher) {
		return createQueueEventSink({
			getLogDir: () => path.join(logRoot, 'logs'),
			writeStderr: text => stderr.push(text),
			publisher,
		});
	}

	function logLines(): Array<{ level: string; msg: string }> {
		const dir = path.join(logRoot, 'logs');
		if (!fs.existsSync(dir)) return [];
		return fs
			.readdirSync(dir)
			.flatMap(f => fs.readFileSync(path.join(dir, f), 'utf8').trim().split('\n'))
			.map(l => JSON.parse(l) as { level: string; msg: string });
	}

	it('publishes the event name and the payload object (never a command line) with the project directory as cwd', async () => {
		const fake = fakePublisher(() => ({ status: 'queued', eventId: 'e1' }));

		const outcome = await makeSink(fake.publisher).deliver(EVENT);

		expect(outcome).toEqual({ delivered: true });
		expect(fake.calls).toEqual([{ event: 'onTaskLinked', payload: EVENT.payload, options: { cwd: '/p' } }]);
		expect(stderr).toEqual([]);
		expect(logLines()).toEqual([]);
	});

	it.each(['queued', 'dispatched'] as const)('maps %s to delivered', async status => {
		const fake = fakePublisher(() => ({ status }));

		expect(await makeSink(fake.publisher).deliver(EVENT)).toEqual({ delivered: true });
	});

	describe('working directory', () => {
		const base = { taskId: 'abc', taskProjectName: 'p', taskProjectPath: '/proj/dir' };
		// One event of every type: queue finds .queue/subscribers.yml from the cwd the SDK sends.
		const everyEvent: TaskEvent[] = [
			{
				name: 'onTaskCreated',
				payload: {
					...base,
					status: 'backlog',
					description: 'd',
					parentId: undefined,
					type: undefined,
					labels: [],
				},
			},
			{
				name: 'onStatusChange',
				payload: {
					...base,
					oldStatus: 'backlog',
					newStatus: 'done',
					status: 'done',
					type: undefined,
					labels: [],
				},
			},
			{ name: 'onTaskLinked', payload: { ...base, linkType: 'blockedBy', targetId: 'def' } },
			{ name: 'onTaskUnlinked', payload: { ...base, linkType: 'blockedBy', targetId: 'def' } },
			{
				name: 'onTaskUnblocked',
				payload: { ...base, blockerId: 'def', status: 'backlog', type: undefined, labels: [] },
			},
		];

		it.each(everyEvent.map(e => [e.name, e] as const))(
			'publishes %s in the project directory',
			async (_n, event) => {
				const fake = fakePublisher(() => ({ status: 'queued' }));

				await makeSink(fake.publisher).deliver(event);

				expect(fake.calls[0]!.options).toEqual({ cwd: '/proj/dir' });
			}
		);

		it.each(['missing', 'empty', 'not a string'])(
			'refuses loudly when taskProjectPath is %s, without publishing',
			async kind => {
				const fake = fakePublisher(() => ({ status: 'queued' }));
				const payload: Record<string, unknown> = { ...EVENT.payload };
				if (kind === 'missing') delete payload['taskProjectPath'];
				else payload['taskProjectPath'] = kind === 'empty' ? '' : 42;

				const outcome = await makeSink(fake.publisher).deliver({
					name: 'onTaskLinked',
					payload,
				} as unknown as TaskEvent);

				expect(fake.calls).toEqual([]);
				expect(outcome).toMatchObject({
					delivered: false,
					status: 'dropped',
					reason: expect.stringContaining('taskProjectPath'),
				});
				expect(stderr.join('')).toContain('taskProjectPath');
				expect(logLines()).toHaveLength(1);
				expect(logLines()[0]!.msg).toContain('taskProjectPath');
			}
		);
	});

	describe('dropped (the queue did NOT record the event)', () => {
		const dropped = (): PublishOutcome => ({
			status: 'dropped',
			reason: 'queue is not installed: install queue-cli and check that `queue` is on PATH',
		});

		it('is undelivered with the SDK reason and the cd + queue push replay command', async () => {
			const outcome = await makeSink(fakePublisher(dropped).publisher).deliver(EVENT);

			expect(outcome).toEqual({
				delivered: false,
				status: 'dropped',
				reason: 'queue is not installed: install queue-cli and check that `queue` is on PATH',
				replay: `cd '/p' && queue push onTaskLinked '${JSON.stringify(EVENT.payload)}'`,
			});
		});

		it('is reported on stderr and in the ndjson log, the payload being in the log file', async () => {
			await makeSink(fakePublisher(dropped).publisher).deliver(EVENT);

			expect(stderr.join('')).toBe(
				`[task] queue push 'onTaskLinked' for task abc not delivered: queue is not installed: install queue-cli and check that \`queue\` is on PATH (details and replay command: task cli logs)\n`
			);
			const lines = logLines();
			expect(lines).toHaveLength(1);
			expect(lines[0]!.level).toBe('error');
			expect(lines[0]!.msg).toBe(
				`queue push 'onTaskLinked' for task abc not delivered: queue is not installed: install queue-cli and check that \`queue\` is on PATH. Replay with: cd '/p' && queue push onTaskLinked '${JSON.stringify(EVENT.payload)}'`
			);
		});

		it('says so when the SDK gives no reason', async () => {
			const outcome = await makeSink(fakePublisher(() => ({ status: 'dropped' })).publisher).deliver(EVENT);

			expect(outcome).toMatchObject({ delivered: false, reason: expect.stringContaining('no reason') });
		});
	});

	describe('unknown (the event MAY be recorded)', () => {
		const unknown = (): PublishOutcome => ({ status: 'unknown', reason: 'the connection was reset' });

		it('is undelivered-with-doubt: the reason says it may be recorded, the replay says to check queue history first', async () => {
			const outcome = await makeSink(fakePublisher(unknown).publisher).deliver(EVENT);

			expect(outcome).toMatchObject({ delivered: false, status: 'unknown' });
			if (outcome.delivered) throw new Error('unreachable');
			expect(outcome.reason).toContain('MAY be recorded');
			expect(outcome.reason).toContain('the connection was reset');
			expect(outcome.replay).toContain('queue history');
			expect(outcome.replay).toContain('queue replay <eventId>');
			expect(outcome.replay).toContain(`cd '/p'`);
		});

		it('keeps the payload in the log file and is never retried', async () => {
			const fake = fakePublisher(unknown);

			await makeSink(fake.publisher).deliver(EVENT);

			expect(fake.calls).toHaveLength(1);
			expect(logLines()).toHaveLength(1);
			expect(logLines()[0]!.msg).toContain(JSON.stringify(EVENT.payload));
			expect(stderr.join('')).toContain('MAY be recorded');
		});
	});

	it('reports a publisher that throws although the SDK promises it never does, as unknown', async () => {
		const fake = fakePublisher(() => {
			throw new Error('sdk exploded');
		});

		const outcome = await makeSink(fake.publisher).deliver(EVENT);

		expect(outcome).toMatchObject({
			delivered: false,
			status: 'unknown',
			reason: expect.stringContaining('sdk exploded'),
		});
		expect(logLines()).toHaveLength(1);
	});

	it('says so on stderr when the undelivered event cannot be logged either', async () => {
		// A regular file where the log directory should be makes mkdirSync fail.
		fs.writeFileSync(path.join(logRoot, 'logs'), 'not a directory');

		await makeSink(fakePublisher(() => ({ status: 'dropped', reason: 'r' })).publisher).deliver(EVENT);

		expect(stderr.join('')).toContain('[task] could not record the undelivered event in the task log:');
	});

	it('deliverEvents delivers sequentially, in order, and carries the status and the replay of the sink', async () => {
		const answers: PublishOutcome[] = [{ status: 'queued' }, { status: 'unknown', reason: 'timeout' }];
		const fake = fakePublisher(() => answers.shift()!);
		const second: TaskEvent = { ...EVENT, name: 'onTaskUnlinked' };

		const outcome = await deliverEvents(makeSink(fake.publisher), [EVENT, second]);

		expect(fake.calls.map(c => c.event)).toEqual(['onTaskLinked', 'onTaskUnlinked']);
		expect(outcome.delivered).toBe(1);
		expect(outcome.undelivered).toHaveLength(1);
		expect(outcome.undelivered[0]).toMatchObject({ event: second, status: 'unknown' });
		expect(outcome.undelivered[0]!.replay).toContain('queue history');
	});

	describe('flush', () => {
		it('flushes the publisher that was used', async () => {
			const fake = fakePublisher(() => ({ status: 'queued' }));
			const sink = makeSink(fake.publisher);
			await sink.deliver(EVENT);

			await sink.flush();

			expect(fake.flushed()).toBe(1);
		});

		it('does not create the default publisher just to flush it', async () => {
			let created = 0;
			const sink = createQueueEventSink({
				getLogDir: () => path.join(logRoot, 'logs'),
				writeStderr: text => stderr.push(text),
				createPublisher: () => {
					created++;
					return fakePublisher(() => ({ status: 'queued' })).publisher;
				},
			});

			await sink.flush();

			expect(created).toBe(0);
		});

		it('reports a failing flush on stderr instead of throwing', async () => {
			const fake = fakePublisher(() => ({ status: 'queued' }));
			fake.publisher.flush = () => Promise.reject(new Error('flush broke'));
			const sink = makeSink(fake.publisher);
			await sink.deliver(EVENT);

			await expect(sink.flush()).resolves.toBeUndefined();

			expect(stderr.join('')).toContain('flush broke');
		});
	});

	describe('lazy default publisher', () => {
		it('is created at the first delivery only, once, and receives an onError hook', async () => {
			const fake = fakePublisher(() => ({ status: 'queued' }));
			const created: Array<{ onError: unknown }> = [];
			const sink = createQueueEventSink({
				getLogDir: () => path.join(logRoot, 'logs'),
				writeStderr: text => stderr.push(text),
				createPublisher: hooks => {
					created.push(hooks);
					return fake.publisher;
				},
			});
			expect(created).toHaveLength(0);

			await sink.deliver(EVENT);
			await sink.deliver(EVENT);

			expect(created).toHaveLength(1);
			expect(typeof created[0]!.onError).toBe('function');
			expect(fake.calls).toHaveLength(2);
		});

		it('writes what the SDK reports through onError in the task log (kind, message, event), not on stderr', async () => {
			let hooks!: { onError: (failure: unknown) => void };
			const sink = createQueueEventSink({
				getLogDir: () => path.join(logRoot, 'logs'),
				writeStderr: text => stderr.push(text),
				createPublisher: h => {
					hooks = h as typeof hooks;
					return fakePublisher(() => ({ status: 'queued' })).publisher;
				},
			});
			await sink.deliver(EVENT);

			hooks.onError({
				kind: 'not-installed',
				message: 'queue is not on PATH',
				event: 'onTaskLinked',
				outcome: 'dropped',
			});

			const lines = logLines();
			expect(lines).toHaveLength(1);
			expect(lines[0]!.level).toBe('warn');
			expect(lines[0]!.msg).toContain('not-installed');
			expect(lines[0]!.msg).toContain('queue is not on PATH');
			expect(lines[0]!.msg).toContain('onTaskLinked');
			expect(stderr).toEqual([]);
		});
	});

	describe('declareEvents', () => {
		it('declares the task events through the publisher, under the source task', async () => {
			const calls: { source: string; events: unknown }[] = [];
			const { publisher } = fakePublisher(() => ({ status: 'queued' }));
			publisher.registerEvents = (source, events) => {
				calls.push({ source, events });
				return Promise.resolve({ status: 'registered', count: events.length });
			};

			const outcome = await makeSink(publisher).declareEvents();

			expect(outcome).toEqual({ status: 'registered', count: queueEventDeclarations.length });
			expect(calls).toEqual([{ source: 'task', events: queueEventDeclarations }]);
		});

		it('reports a rejection on stderr and in the task log', async () => {
			const { publisher } = fakePublisher(() => ({ status: 'queued' }));
			publisher.registerEvents = () =>
				Promise.resolve({
					status: 'rejected',
					reason: 'x',
					problems: [{ path: 'events[0].name', message: 'bad' }],
				});

			const outcome = await makeSink(publisher).declareEvents();

			expect(outcome.status).toBe('rejected');
			expect(stderr.join('')).toContain('events[0].name');
			expect(logLines()).toHaveLength(1);
		});

		it('answers dropped, without throwing, when the publisher cannot even be created', async () => {
			const sink = createQueueEventSink({
				getLogDir: () => path.join(logRoot, 'logs'),
				writeStderr: text => stderr.push(text),
				createPublisher: () => {
					throw new Error('no publisher today');
				},
			});

			const outcome = await sink.declareEvents();

			expect(outcome.status).toBe('dropped');
			if (outcome.status === 'registered') throw new Error('unreachable');
			expect(outcome.reason).toContain('no publisher today');
		});

		it('is awaited by flush(): a declaration in flight is not lost at shutdown', async () => {
			let release: () => void = () => undefined;
			const gate = new Promise<void>(resolve => (release = resolve));
			let finished = false;
			const { publisher } = fakePublisher(() => ({ status: 'queued' }));
			publisher.registerEvents = async () => {
				await gate;
				finished = true;
				return { status: 'registered', count: 5 };
			};
			const sink = makeSink(publisher);

			void sink.declareEvents();
			const flushed = sink.flush().then(() => expect(finished).toBe(true));
			release();
			await flushed;
		});
	});
});
