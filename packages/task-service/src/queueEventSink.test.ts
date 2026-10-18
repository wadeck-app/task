import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async importOriginal => {
	const actual = await importOriginal<typeof import('node:child_process')>();
	return { ...actual, spawn: spawnMock };
});

import { deliverEvents, type TaskEvent } from './events.js';
import { createQueueEventSink } from './queueEventSink.js';

const EVENT: TaskEvent = {
	name: 'onTaskLinked',
	payload: { taskId: 'abc', linkType: 'blockedBy', targetId: 'def', taskProjectName: 'p', taskProjectPath: '/p' },
};

function fakeChild(outcome: { code?: number; error?: Error }): EventEmitter {
	const child = new EventEmitter();
	setImmediate(() => {
		if (outcome.error) child.emit('error', outcome.error);
		else child.emit('close', outcome.code ?? 0);
	});
	return child;
}

describe('createQueueEventSink', () => {
	let logRoot: string;
	let stderr: string[];

	beforeEach(() => {
		logRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'task-sink-'));
		stderr = [];
	});
	afterEach(() => fs.rmSync(logRoot, { recursive: true, force: true }));

	function makeSink(resolveQueueJs: () => string = () => '/q/queue.js') {
		return createQueueEventSink({
			getLogDir: () => path.join(logRoot, 'logs'),
			writeStderr: text => stderr.push(text),
			resolveQueueJs,
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

	it('spawns node on queue.js with the event name and the JSON payload as verbatim args', async () => {
		spawnMock.mockImplementation(() => fakeChild({ code: 0 }));

		await makeSink().deliver(EVENT);

		expect(spawnMock).toHaveBeenCalledTimes(1);
		const [command, args, options] = spawnMock.mock.calls[0]!;
		expect(command).toBe(process.execPath);
		expect(args).toEqual(['/q/queue.js', 'push', 'onTaskLinked', JSON.stringify(EVENT.payload)]);
		expect(options).toMatchObject({ stdio: 'inherit', windowsHide: true });
		expect(stderr).toEqual([]);
		expect(logLines()).toEqual([]);
	});

	it('reports a non-zero exit on stderr and in the ndjson log with a replay command', async () => {
		spawnMock.mockImplementation(() => fakeChild({ code: 3 }));

		await makeSink().deliver(EVENT);

		expect(stderr.join('')).toBe(
			`[task] queue push 'onTaskLinked' for task abc not delivered: exit 3 (details and replay command: task cli logs)\n`
		);
		const lines = logLines();
		expect(lines).toHaveLength(1);
		expect(lines[0]!.level).toBe('error');
		expect(lines[0]!.msg).toBe(
			`queue push 'onTaskLinked' for task abc not delivered: exit 3. Replay with: queue push onTaskLinked '${JSON.stringify(EVENT.payload)}'`
		);
	});

	it('reports a spawn error once even if close also fires', async () => {
		spawnMock.mockImplementation(() => {
			const child = fakeChild({ error: new Error('spawn boom') });
			setImmediate(() => child.emit('close', 1));
			return child;
		});

		await makeSink().deliver(EVENT);

		expect(logLines()).toHaveLength(1);
		expect(logLines()[0]!.msg).toContain('not delivered: spawn boom');
	});

	it('reports an unresolvable queue binary without spawning', async () => {
		await makeSink(() => {
			throw new Error('queue.cmd not found\nsecond line');
		}).deliver(EVENT);

		expect(spawnMock).not.toHaveBeenCalled();
		expect(logLines()[0]!.msg).toContain('not delivered: queue not found on PATH (queue.cmd not found)');
	});

	it('says so on stderr when the undelivered event cannot be logged either', async () => {
		spawnMock.mockImplementation(() => fakeChild({ code: 1 }));
		// A regular file where the log directory should be makes mkdirSync fail.
		fs.writeFileSync(path.join(logRoot, 'logs'), 'not a directory');

		await makeSink().deliver(EVENT);

		expect(stderr.join('')).toContain('[task] could not record the undelivered event in the task log:');
	});

	it('deliverEvents delivers sequentially, in order', async () => {
		spawnMock.mockImplementation(() => fakeChild({ code: 0 }));
		const second: TaskEvent = { ...EVENT, name: 'onTaskUnlinked' };

		await deliverEvents(makeSink(), [EVENT, second]);

		expect(spawnMock.mock.calls.map(c => (c[1] as string[])[2])).toEqual(['onTaskLinked', 'onTaskUnlinked']);
	});
});
