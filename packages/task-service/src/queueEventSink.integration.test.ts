import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { createQueuePublisher } from '@wadeck-app/queue-sdk';
import { startFakeQueueDaemon, type FakeQueueDaemon } from '@wadeck-app/queue-sdk/testing';

import { deliverEvents, type TaskEvent } from './events.js';
import { createQueueEventSink } from './queueEventSink.js';

/**
 * The REAL SDK against the SDK's own fake daemon (`@wadeck-app/queue-sdk/testing`: free port, temp config dir, the real
 * version check and token). The real queue daemon and the user's queue config are never touched: the publisher is given the
 * fake's `configDir`, and PATH holds no `queue`, so the SDK cannot start one either.
 */
describe('createQueueEventSink with the real queue SDK and the SDK fake daemon', () => {
	let root: string;
	let daemon: FakeQueueDaemon;
	const saved: Record<string, string | undefined> = {};

	beforeEach(async () => {
		root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'task-sink-int-')));
		for (const name of ['PATH', 'Path', 'QUEUE_SDK_OFF']) saved[name] = process.env[name];
		// vitest.setup.ts switches the SDK off for every test; these tests are the ones exercising it, against the fake only.
		delete process.env['QUEUE_SDK_OFF'];
		// No `queue` anywhere: when no daemon answers, the SDK finds nothing to start.
		const emptyBin = path.join(root, 'empty-bin');
		fs.mkdirSync(emptyBin);
		process.env['PATH'] = emptyBin;
		if (process.platform === 'win32') process.env['Path'] = emptyBin;
		daemon = await startFakeQueueDaemon();
	});

	afterEach(async () => {
		await daemon.close();
		for (const [name, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
		fs.rmSync(root, { recursive: true, force: true });
	});

	function project(name: string): string {
		const dir = path.join(root, name);
		fs.mkdirSync(dir, { recursive: true });
		return dir;
	}

	const event = (projectDir: string, taskId = 'abc'): TaskEvent => ({
		name: 'onStatusChange',
		payload: {
			taskId,
			oldStatus: 'backlog',
			newStatus: 'done',
			status: 'done',
			type: undefined,
			labels: [],
			taskProjectName: path.basename(projectDir),
			taskProjectPath: projectDir,
		},
	});

	function sinkWithLogs() {
		const stderr: string[] = [];
		const sink = createQueueEventSink({
			getLogDir: () => path.join(root, 'logs'),
			writeStderr: text => stderr.push(text),
			// The sink's own wiring (silent, onError into the task log), pointed at the fake instead of the user's daemon.
			createPublisher: hooks =>
				createQueuePublisher({ configDir: daemon.configDir, silent: true, onError: hooks.onError }),
		});
		return { sink, stderr };
	}

	it('pushes the event with the project directory as cwd and the payload', async () => {
		const projectDir = project('project');
		const { sink, stderr } = sinkWithLogs();

		const outcome = await deliverEvents(sink, [event(projectDir)]);
		await sink.flush();

		expect(outcome).toEqual({ delivered: 1, undelivered: [] });
		expect(stderr).toEqual([]);
		const pushes = daemon.pushes();
		expect(pushes).toHaveLength(1);
		expect(pushes[0]).toMatchObject({
			event: 'onStatusChange',
			cwd: projectDir,
			payload: { taskId: 'abc', oldStatus: 'backlog', newStatus: 'done', taskProjectPath: projectDir },
		});
		expect('type' in (pushes[0]!.payload as object)).toBe(false);
	}, 20_000);

	it('sends each project its own cwd through the same publisher, in order', async () => {
		const alpha = project('alpha');
		const beta = project('beta');
		const { sink } = sinkWithLogs();

		const outcome = await deliverEvents(sink, [event(alpha, 'a1'), event(beta, 'b1')]);
		await sink.flush();

		expect(outcome).toEqual({ delivered: 2, undelivered: [] });
		expect(daemon.pushes().map(push => [push.cwd, (push.payload as { taskId: string }).taskId])).toEqual([
			[alpha, 'a1'],
			[beta, 'b1'],
		]);
	}, 20_000);

	it('reports a refused push (aborted) as dropped with the SDK reason and the replay command', async () => {
		const projectDir = project('project');
		daemon.respondNext({ status: 'aborted', reason: 'refused by a subscriber' });
		const { sink, stderr } = sinkWithLogs();

		const outcome = await deliverEvents(sink, [event(projectDir)]);

		expect(outcome.delivered).toBe(0);
		expect(outcome.undelivered).toHaveLength(1);
		expect(outcome.undelivered[0]!.status).toBe('dropped');
		expect(outcome.undelivered[0]!.reason).toContain('refused by a subscriber');
		expect(outcome.undelivered[0]!.replay).toContain(`cd '${projectDir}' && queue push onStatusChange`);
		expect(stderr.join('')).toContain('refused by a subscriber');
		expect(daemon.pushes()).toHaveLength(1);
	}, 20_000);

	it('reports a connection reset after sending as unknown (may be recorded), without retrying', async () => {
		const projectDir = project('project');
		daemon.resetNext();
		const { sink, stderr } = sinkWithLogs();

		const outcome = await deliverEvents(sink, [event(projectDir)]);

		expect(daemon.pushes()).toHaveLength(1);
		expect(outcome.delivered).toBe(0);
		expect(outcome.undelivered).toHaveLength(1);
		expect(outcome.undelivered[0]!.status).toBe('unknown');
		expect(outcome.undelivered[0]!.reason).toContain('MAY be recorded');
		expect(stderr.join('')).toContain('MAY be recorded');
	}, 20_000);

	it('reports a missing daemon (no queue to start either) as dropped, with a replay command', async () => {
		const projectDir = project('project');
		const { sink, stderr } = sinkWithLogs();
		await daemon.close();

		const outcome = await deliverEvents(sink, [event(projectDir)]);

		expect(outcome.delivered).toBe(0);
		expect(outcome.undelivered).toHaveLength(1);
		expect(outcome.undelivered[0]!.status).toBe('dropped');
		expect(outcome.undelivered[0]!.replay).toContain(`cd '${projectDir}' && queue push onStatusChange`);
		expect(stderr.join('')).toContain('not delivered');
	}, 20_000);
});
