import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { startFakeQueueDaemon } from '@wadeck-app/queue-sdk/testing';

import { deliverEvents } from './events.js';
import { createQueueEventSink } from './queueEventSink.js';

/**
 * Safety net: vitest.setup.ts sets QUEUE_SDK_OFF=1 for every test of this package, so a test that builds the DEFAULT sink
 * (no injected publisher) can never push to a queue, whichever daemon the machine runs. The fake daemon stands for that
 * daemon: it is reachable through QUEUE_CONFIG_DIR, which the default publisher honours, and must see nothing.
 */
describe('default queue sink under the test setup', () => {
	let root: string;
	let savedConfigDir: string | undefined;

	beforeEach(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-sink-net-'));
		savedConfigDir = process.env['QUEUE_CONFIG_DIR'];
	});

	afterEach(() => {
		if (savedConfigDir === undefined) delete process.env['QUEUE_CONFIG_DIR'];
		else process.env['QUEUE_CONFIG_DIR'] = savedConfigDir;
		fs.rmSync(root, { recursive: true, force: true });
	});

	it('sets QUEUE_SDK_OFF=1', () => {
		expect(process.env['QUEUE_SDK_OFF']).toBe('1');
	});

	it('sends nothing to a reachable daemon and reports the event as dropped, naming the switch', async () => {
		const daemon = await startFakeQueueDaemon();
		try {
			process.env['QUEUE_CONFIG_DIR'] = daemon.configDir;
			const stderr: string[] = [];
			const sink = createQueueEventSink({
				getLogDir: () => path.join(root, 'logs'),
				writeStderr: text => stderr.push(text),
			});

			const outcome = await deliverEvents(sink, [
				{
					name: 'onStatusChange',
					payload: {
						taskId: 'abc',
						oldStatus: 'backlog',
						newStatus: 'done',
						status: 'done',
						type: undefined,
						labels: [],
						taskProjectName: 'p',
						taskProjectPath: root,
					},
				},
			]);

			expect(daemon.pushes()).toEqual([]);
			expect(outcome.delivered).toBe(0);
			expect(outcome.undelivered[0]!.status).toBe('dropped');
			expect(outcome.undelivered[0]!.reason).toContain('QUEUE_SDK_OFF');
		} finally {
			await daemon.close();
		}
	}, 20_000);

	it('declares nothing to a reachable daemon either (registerEvents is switched off too) and names the switch', async () => {
		const daemon = await startFakeQueueDaemon();
		try {
			process.env['QUEUE_CONFIG_DIR'] = daemon.configDir;
			const stderr: string[] = [];
			const sink = createQueueEventSink({
				getLogDir: () => path.join(root, 'logs'),
				writeStderr: text => stderr.push(text),
			});

			const outcome = await sink.declareEvents();

			expect(daemon.registrations()).toEqual([]);
			expect(outcome.status).toBe('dropped');
			if (outcome.status === 'registered') throw new Error('unreachable');
			expect(outcome.reason).toContain('QUEUE_SDK_OFF');
			expect(stderr).toEqual([]);
		} finally {
			await daemon.close();
		}
	}, 20_000);
});
