import * as fs from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

import { deliverEvents, type TaskEvent } from './events.js';
import { createQueueEventSink } from './queueEventSink.js';

/**
 * The REAL SDK against a stand-in daemon, in a throwaway config dir: a loopback HTTP server that speaks the documented push
 * protocol (queue repo docs/push-protocol.md: `config.port`, `health_token`, `GET /version`, `POST /push`). The real queue
 * daemon (fixed port, app-core registration) and the user's queue config are never touched: QUEUE_CONFIG_DIR points to a
 * temp dir and PATH holds no `queue`, so the SDK cannot start one.
 */
describe('createQueueEventSink with the real queue SDK and a stand-in daemon', () => {
	let root: string;
	let configDir: string;
	let projectDir: string;
	let server: http.Server | undefined;
	const saved: Record<string, string | undefined> = {};
	const pushes: Array<{ authorization: string | undefined; body: Record<string, unknown> }> = [];

	beforeEach(() => {
		root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'task-sink-int-')));
		configDir = path.join(root, 'queue-config');
		projectDir = path.join(root, 'project');
		fs.mkdirSync(configDir);
		fs.mkdirSync(projectDir);
		for (const name of ['QUEUE_CONFIG_DIR', 'PATH', 'Path']) saved[name] = process.env[name];
		process.env['QUEUE_CONFIG_DIR'] = configDir;
		// No `queue` anywhere: when no daemon answers, the SDK finds nothing to start.
		const emptyBin = path.join(root, 'empty-bin');
		fs.mkdirSync(emptyBin);
		process.env['PATH'] = emptyBin;
		if (process.platform === 'win32') process.env['Path'] = emptyBin;
		pushes.length = 0;
	});

	afterEach(async () => {
		for (const [name, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
		await new Promise<void>(resolve => (server === undefined ? resolve() : server.close(() => resolve())));
		server = undefined;
		fs.rmSync(root, { recursive: true, force: true });
	});

	async function startStandInDaemon(pushAnswer: () => { status: number; body: unknown } | 'reset'): Promise<void> {
		server = http.createServer((request, response) => {
			if (request.method === 'GET' && request.url === '/version') {
				response.end(
					JSON.stringify({
						version: 'stand-in',
						pid: process.pid,
						config_dir: configDir,
						sdkVersion: 1,
						queueProtocol: { version: '1.0.0', accepts: '^1.0.0' },
					})
				);
				return;
			}
			const chunks: Buffer[] = [];
			request.on('data', (chunk: Buffer) => chunks.push(chunk));
			request.on('end', () => {
				pushes.push({
					authorization: request.headers.authorization,
					body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>,
				});
				const answer = pushAnswer();
				if (answer === 'reset') {
					request.socket.destroy();
					return;
				}
				response.statusCode = answer.status;
				response.end(JSON.stringify(answer.body));
			});
		});
		await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
		const port = (server.address() as AddressInfo).port;
		fs.writeFileSync(
			path.join(configDir, 'config.port'),
			JSON.stringify({ sdkVersion: 1, port, pid: process.pid, startedAt: new Date().toISOString() })
		);
		fs.writeFileSync(path.join(configDir, 'health_token'), 'stand-in-token');
	}

	const event = (): TaskEvent => ({
		name: 'onStatusChange',
		payload: {
			taskId: 'abc',
			oldStatus: 'backlog',
			newStatus: 'done',
			type: undefined,
			labels: [],
			taskProjectName: 'project',
			taskProjectPath: projectDir,
		},
	});

	function sinkWithLogs() {
		const stderr: string[] = [];
		const sink = createQueueEventSink({
			getLogDir: () => path.join(root, 'logs'),
			writeStderr: text => stderr.push(text),
		});
		return { sink, stderr };
	}

	it('pushes the event with the project directory as cwd and the payload in the body', async () => {
		await startStandInDaemon(() => ({
			status: 200,
			body: { ok: true, result: { status: 'queued', eventId: 'e1', subscriberCount: 1 } },
		}));
		const { sink, stderr } = sinkWithLogs();

		const outcome = await deliverEvents(sink, [event()]);
		await sink.flush();

		expect(outcome).toEqual({ delivered: 1, undelivered: [] });
		expect(stderr).toEqual([]);
		expect(pushes).toHaveLength(1);
		expect(pushes[0]!.authorization).toBe('Bearer stand-in-token');
		expect(pushes[0]!.body).toMatchObject({
			event: 'onStatusChange',
			cwd: projectDir,
			payload: { taskId: 'abc', oldStatus: 'backlog', newStatus: 'done', taskProjectPath: projectDir },
		});
		expect('type' in (pushes[0]!.body['payload'] as object)).toBe(false);
	}, 20_000);

	it('reports a connection reset after sending as unknown (may be recorded), without retrying', async () => {
		await startStandInDaemon(() => 'reset');
		const { sink, stderr } = sinkWithLogs();

		const outcome = await deliverEvents(sink, [event()]);

		expect(pushes).toHaveLength(1);
		expect(outcome.delivered).toBe(0);
		expect(outcome.undelivered).toHaveLength(1);
		expect(outcome.undelivered[0]!.status).toBe('unknown');
		expect(outcome.undelivered[0]!.reason).toContain('MAY be recorded');
		expect(stderr.join('')).toContain('MAY be recorded');
	}, 20_000);

	it('reports a missing daemon and queue as dropped, with a replay command, writing nothing but the task log', async () => {
		const { sink, stderr } = sinkWithLogs();

		const outcome = await deliverEvents(sink, [event()]);

		expect(outcome.delivered).toBe(0);
		expect(outcome.undelivered).toHaveLength(1);
		expect(outcome.undelivered[0]!.status).toBe('dropped');
		expect(outcome.undelivered[0]!.replay).toContain(`queue push onStatusChange`);
		expect(stderr.join('')).toContain('not delivered');
	}, 20_000);
});
