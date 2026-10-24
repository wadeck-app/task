import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { createQueuePublisher } from '@wadeck-app/queue-sdk';
import { startFakeQueueDaemon, type FakeQueueDaemon } from '@wadeck-app/queue-sdk/testing';

import { declareTaskEvents } from './declareTaskEvents.js';
import { queueEventDeclarations } from './queueEventDeclarations.js';
import type { EventPublisher, RegisterEventsOutcome } from './queueEventSink.js';

function logLines(logDir: string): { level: string; msg: string }[] {
	if (!fs.existsSync(logDir)) return [];
	return fs
		.readdirSync(logDir)
		.flatMap(file => fs.readFileSync(path.join(logDir, file), 'utf8').split('\n'))
		.filter(line => line !== '')
		.map(line => JSON.parse(line) as { level: string; msg: string });
}

/** The real SDK against the SDK's fake daemon; PATH holds no `queue`, so nothing can be started. */
describe('declareTaskEvents with the real queue SDK and the SDK fake daemon', () => {
	let root: string;
	let daemon: FakeQueueDaemon;
	let stderr: string[];
	const saved: Record<string, string | undefined> = {};

	beforeEach(async () => {
		root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'task-declare-')));
		stderr = [];
		for (const name of ['PATH', 'Path', 'QUEUE_SDK_OFF']) saved[name] = process.env[name];
		// vitest.setup.ts switches the SDK off for every test; these tests exercise it, against the fake only.
		delete process.env['QUEUE_SDK_OFF'];
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

	const logDir = () => path.join(root, 'logs');
	const options = () => ({ getLogDir: logDir, writeStderr: (text: string) => stderr.push(text) });
	const publisher = () => createQueuePublisher({ configDir: daemon.configDir, silent: true });

	it('registers the task events under the source "task", quietly', async () => {
		const outcome = await declareTaskEvents(publisher(), options());

		expect(outcome).toEqual({ status: 'registered', count: queueEventDeclarations.length });
		const registrations = daemon.registrations();
		expect(registrations).toHaveLength(1);
		expect(registrations[0]!.source).toBe('task');
		// Through JSON, like the wire.
		expect(registrations[0]!.events).toEqual(JSON.parse(JSON.stringify(queueEventDeclarations)));
		expect(stderr).toEqual([]);
		expect(logLines(logDir())).toEqual([]);
	}, 20_000);

	it('is idempotent: a second call sends the same declaration again and answers registered', async () => {
		const queue = publisher();
		await declareTaskEvents(queue, options());
		const second = await declareTaskEvents(queue, options());

		expect(second).toEqual({ status: 'registered', count: queueEventDeclarations.length });
		const registrations = daemon.registrations();
		expect(registrations).toHaveLength(2);
		expect(registrations[1]!.events).toEqual(registrations[0]!.events);
	}, 20_000);

	it('reports a rejected declaration as a bug of ours: stderr, and the log with every problem path', async () => {
		daemon.respondNextRegistration({
			status: 'rejected',
			reason: 'events[3].name: bad name; events[1].description: too long',
			problems: [
				{ path: 'events[3].name', message: 'bad name' },
				{ path: 'events[1].description', message: 'too long' },
			],
		});

		const outcome = await declareTaskEvents(publisher(), options());

		expect(outcome.status).toBe('rejected');
		if (outcome.status !== 'rejected') throw new Error('unreachable');
		expect(outcome.problems).toEqual([
			{ path: 'events[3].name', message: 'bad name' },
			{ path: 'events[1].description', message: 'too long' },
		]);
		expect(stderr.join('')).toContain('events[3].name');
		expect(stderr.join('')).toMatch(/bug|report/i);
		expect(stderr.join('')).toContain('task cli logs');
		const lines = logLines(logDir());
		expect(lines).toHaveLength(1);
		expect(lines[0]!.level).toBe('error');
		expect(lines[0]!.msg).toContain('events[3].name: bad name');
		expect(lines[0]!.msg).toContain('events[1].description: too long');
	}, 20_000);

	it('reports a daemon older than protocol 1.1.0 as unsupported: logged as info, nothing on stderr', async () => {
		await daemon.close();
		daemon = await startFakeQueueDaemon({ protocolVersion: '1.0.0' });

		const outcome = await declareTaskEvents(publisher(), options());

		expect(outcome.status).toBe('unsupported');
		expect(daemon.registrations()).toEqual([]);
		expect(stderr).toEqual([]);
		const lines = logLines(logDir());
		expect(lines).toHaveLength(1);
		expect(lines[0]!.level).toBe('info');
		expect(lines[0]!.msg).toMatch(/queue-cli/);
	}, 20_000);

	it('maps unknown (connection reset twice: the declaration may be stored) to a warn line, quiet on stderr', async () => {
		daemon.resetNextRegistration(2);

		const outcome = await declareTaskEvents(publisher(), options());

		expect(outcome.status).toBe('unknown');
		expect(stderr).toEqual([]);
		const lines = logLines(logDir());
		expect(lines).toHaveLength(1);
		expect(lines[0]!.level).toBe('warn');
	}, 20_000);

	it('still registers after one connection reset: the SDK retries a registration once because it is idempotent', async () => {
		daemon.resetNextRegistration(1);

		const outcome = await declareTaskEvents(publisher(), options());

		expect(outcome).toEqual({ status: 'registered', count: queueEventDeclarations.length });
		expect(stderr).toEqual([]);
		expect(logLines(logDir())).toEqual([]);
	}, 20_000);

	it('reports a missing daemon (no queue to start) as dropped: logged as warn, nothing on stderr', async () => {
		const queue = publisher();
		await daemon.close();

		const outcome = await declareTaskEvents(queue, options());

		expect(outcome.status).toBe('dropped');
		expect(stderr).toEqual([]);
		const lines = logLines(logDir());
		expect(lines).toHaveLength(1);
		expect(lines[0]!.level).toBe('warn');
	}, 20_000);

	it('returns the failure when the task log cannot be written, and says so on stderr', async () => {
		daemon.respondNextRegistration({
			status: 'rejected',
			reason: 'r',
			problems: [{ path: 'events[0]', message: 'm' }],
		});
		const blocker = path.join(root, 'file-not-dir');
		fs.writeFileSync(blocker, 'x');

		const outcome = await declareTaskEvents(publisher(), {
			getLogDir: () => path.join(blocker, 'logs'),
			writeStderr: text => stderr.push(text),
		});

		expect(outcome.status).toBe('rejected');
		expect(stderr.join('')).toContain('could not record');
	}, 20_000);
});

/** A scripted publisher: for what the SDK fake cannot produce: a `dropped` answer without reason and a publisher that breaks its promise. */
describe('declareTaskEvents with a scripted publisher', () => {
	let logRoot: string;
	let stderr: string[];

	beforeEach(() => {
		logRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'task-declare-fake-'));
		stderr = [];
	});
	afterEach(() => fs.rmSync(logRoot, { recursive: true, force: true }));

	const options = () => ({
		getLogDir: () => path.join(logRoot, 'logs'),
		writeStderr: (text: string) => stderr.push(text),
	});

	function scripted(answer: () => Promise<RegisterEventsOutcome>): EventPublisher {
		return {
			publishAndWait: () => Promise.resolve({ status: 'queued' }),
			registerEvents: answer,
		};
	}

	it('says what the SDK did not when a non-registered answer has no reason', async () => {
		const outcome = await declareTaskEvents(
			scripted(() => Promise.resolve({ status: 'dropped' })),
			options()
		);

		expect(outcome.status).toBe('dropped');
		if (outcome.status === 'registered') throw new Error('unreachable');
		expect(outcome.reason).not.toBe('');
	});

	it('never throws when the publisher rejects: unknown, with the message', async () => {
		const outcome = await declareTaskEvents(
			scripted(() => Promise.reject(new Error('boom'))),
			options()
		);

		expect(outcome.status).toBe('unknown');
		if (outcome.status === 'registered') throw new Error('unreachable');
		expect(outcome.reason).toContain('boom');
		expect(logLines(path.join(logRoot, 'logs'))).toHaveLength(1);
	});

	it('never throws when the publisher throws synchronously', async () => {
		const throwing: EventPublisher = {
			publishAndWait: () => Promise.resolve({ status: 'queued' }),
			registerEvents: () => {
				throw new Error('sync boom');
			},
		};

		const outcome = await declareTaskEvents(throwing, options());

		expect(outcome.status).toBe('unknown');
	});

	it('registered with a count of its own reports that count', async () => {
		const outcome = await declareTaskEvents(
			scripted(() => Promise.resolve({ status: 'registered', count: 5 })),
			options()
		);
		expect(outcome).toEqual({ status: 'registered', count: 5 });
	});
});
