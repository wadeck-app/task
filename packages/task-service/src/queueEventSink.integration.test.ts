import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { deliverEvents, type TaskEvent } from './events.js';
import { createQueueEventSink } from './queueEventSink.js';

/**
 * Real process boundary, stub `queue`: a fake `queue.cmd` / `queue` on PATH next to the node_modules layout the sink
 * resolves, whose queue.js records its cwd, its args and the `.queue/subscribers.yml` it finds by walking up from the cwd
 * (what queue's ConfigLoader does). The real queue and the user's queue config are never touched.
 */
describe('createQueueEventSink with a stub queue on PATH', () => {
	let root: string;
	let projectDir: string;
	let recordFile: string;
	let previousPath: string | undefined;
	let previousCwd: string;

	beforeEach(() => {
		root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'task-sink-int-')));
		previousPath = process.env['PATH'];
		previousCwd = process.cwd();

		const binDir = path.join(root, 'bin');
		const queueJsDir = path.join(binDir, 'node_modules', '@wadeck-app', 'queue-cli', 'bin');
		fs.mkdirSync(queueJsDir, { recursive: true });
		recordFile = path.join(root, 'record.ndjson');
		fs.writeFileSync(
			path.join(queueJsDir, 'queue.js'),
			`const fs = require('node:fs');
const path = require('node:path');
let dir = process.cwd();
let subscribers = null;
for (;;) {
	const candidate = path.join(dir, '.queue', 'subscribers.yml');
	if (fs.existsSync(candidate)) { subscribers = candidate; break; }
	const parent = path.dirname(dir);
	if (parent === dir) break;
	dir = parent;
}
fs.appendFileSync(${JSON.stringify(recordFile)}, JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2), subscribers }) + '\\n');
`
		);
		if (process.platform === 'win32') {
			fs.writeFileSync(path.join(binDir, 'queue.cmd'), '@echo off\r\n');
		} else {
			fs.writeFileSync(path.join(binDir, 'queue'), '#!/bin/sh\n', { mode: 0o755 });
		}
		process.env['PATH'] = `${binDir}${path.delimiter}${previousPath ?? ''}`;

		projectDir = path.join(root, 'project');
		fs.mkdirSync(path.join(projectDir, '.queue'), { recursive: true });
		fs.writeFileSync(path.join(projectDir, '.queue', 'subscribers.yml'), 'subscribers: []\n');
	});

	afterEach(() => {
		process.chdir(previousCwd);
		if (previousPath === undefined) delete process.env['PATH'];
		else process.env['PATH'] = previousPath;
		fs.rmSync(root, { recursive: true, force: true });
	});

	const recorded = (): Array<{ cwd: string; args: string[]; subscribers: string | null }> =>
		fs
			.readFileSync(recordFile, 'utf8')
			.trim()
			.split('\n')
			.map(line => JSON.parse(line) as { cwd: string; args: string[]; subscribers: string | null });

	it('pushes in the project directory, so the project subscribers are found, whatever the cwd of task', async () => {
		// Where an app-core module (or `task --project-dir`) runs: NOT the project.
		const elsewhere = path.join(root, 'elsewhere');
		fs.mkdirSync(elsewhere);
		process.chdir(elsewhere);
		const event: TaskEvent = {
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
		};
		const sink = createQueueEventSink({ getLogDir: () => path.join(root, 'logs'), writeStderr: () => undefined });

		const outcome = await deliverEvents(sink, [event]);

		expect(outcome).toEqual({ delivered: 1, undelivered: [] });
		const [call] = recorded();
		expect(call!.cwd).toBe(projectDir);
		expect(call!.subscribers).toBe(path.join(projectDir, '.queue', 'subscribers.yml'));
		expect(call!.args).toEqual(['push', 'onStatusChange', JSON.stringify(event.payload)]);
	}, 20_000);
});
