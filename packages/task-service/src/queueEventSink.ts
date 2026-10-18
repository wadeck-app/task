import { execFileSync, execSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { EventSink, TaskEvent } from './events.js';

/**
 * Locates queue's JS entry point (`.../@wadeck-app/queue-cli/bin/queue.js`) from PATH -- avoids shell and quoting issues
 * when spawning. Throws when `queue` is not installed.
 */
export function resolveQueueJsPath(): string {
	// On Windows, use 'where queue.cmd' via shell to get a native Windows path.
	// On Unix, use 'which queue' to get the script path.
	let nativeDir: string;
	if (process.platform === 'win32') {
		const winPath = execSync('where queue.cmd', { encoding: 'utf8', windowsHide: true })
			.trim()
			.split('\n')[0]!
			.trim();
		nativeDir = path.dirname(winPath);
	} else {
		nativeDir = path.dirname(execFileSync('which', ['queue'], { encoding: 'utf8', windowsHide: true }).trim());
	}
	return path.join(nativeDir, 'node_modules', '@wadeck-app', 'queue-cli', 'bin', 'queue.js');
}

export interface QueueEventSinkOptions {
	/** Directory receiving the `YYYY-MM-DD.ndjson` log of undelivered events (e.g. `<ConfigDir task>/logs`). Called lazily. */
	getLogDir: () => string;
	/** Where to report undelivered events for the interactive user. Default: process.stderr. */
	writeStderr?: (text: string) => void;
	/** Resolves queue's JS entry point. Default: {@link resolveQueueJsPath} (looked up on PATH, once per sink). */
	resolveQueueJs?: () => string;
}

/**
 * Default Node sink: delivers each event with `node queue.js push <event> <json>`.
 * A failed delivery never throws: it is reported on stderr AND in the task log (stderr is lost when task runs
 * inside a flow step, the log is not). The log line carries the exact command that replays the event.
 */
export function createQueueEventSink(options: QueueEventSinkOptions): EventSink {
	const writeStderr = options.writeStderr ?? ((text: string) => void process.stderr.write(text));
	const resolveQueueJs = options.resolveQueueJs ?? resolveQueueJsPath;
	let queueJsPath: string | undefined;

	function reportUndelivered(event: string, payload: Record<string, unknown>, reason: string): void {
		const taskPart = typeof payload['taskId'] === 'string' ? ` for task ${payload['taskId']}` : '';
		const msg = `queue push '${event}'${taskPart} not delivered: ${reason}. Replay with: queue push ${event} '${JSON.stringify(payload)}'`;
		writeStderr(
			`[task] queue push '${event}'${taskPart} not delivered: ${reason} (details and replay command: task cli logs)\n`
		);
		try {
			const logFile = path.join(options.getLogDir(), `${new Date().toISOString().slice(0, 10)}.ndjson`);
			fs.mkdirSync(path.dirname(logFile), { recursive: true });
			fs.appendFileSync(logFile, JSON.stringify({ ts: new Date().toISOString(), level: 'error', msg }) + '\n');
		} catch (error) {
			writeStderr(`[task] could not record the undelivered event in the task log: ${(error as Error).message}\n`);
		}
	}

	return {
		async deliver(event: TaskEvent): Promise<void> {
			const payload: Record<string, unknown> = { ...event.payload };
			const json = JSON.stringify(payload);
			let queueJs: string;
			try {
				queueJsPath ??= resolveQueueJs();
				queueJs = queueJsPath;
			} catch (error) {
				reportUndelivered(
					event.name,
					payload,
					`queue not found on PATH (${(error as Error).message.split('\n')[0]})`
				);
				return;
			}
			// Spawn node directly with queue.js -- no shell, args passed verbatim (no JSON quoting issues).
			await new Promise<void>(resolve => {
				// 'error' and 'close' can both fire for one child: report only the first outcome.
				let settled = false;
				const settle = (failure?: string): void => {
					if (settled) return;
					settled = true;
					if (failure !== undefined) reportUndelivered(event.name, payload, failure);
					resolve();
				};
				const child = spawn(process.execPath, [queueJs, 'push', event.name, json], {
					stdio: 'inherit',
					windowsHide: true,
				});
				child.on('close', code => settle(code === 0 ? undefined : `exit ${code}`));
				child.on('error', err => settle((err as Error).message));
			});
		},
	};
}
