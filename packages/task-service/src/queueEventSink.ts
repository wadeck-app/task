import { execFile, execFileSync, execSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';

import { replayCommand, type EventDelivery, type EventSink, type TaskEvent } from './events.js';

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

const execFileAsync = promisify(execFile);

/** Same lookup as {@link resolveQueueJsPath} without blocking the event loop (used by the default sink). */
export async function resolveQueueJsPathAsync(): Promise<string> {
	const lookup =
		process.platform === 'win32'
			? await execFileAsync('where', ['queue.cmd'], { encoding: 'utf8', windowsHide: true })
			: await execFileAsync('which', ['queue'], { encoding: 'utf8', windowsHide: true });
	const first = lookup.stdout.trim().split('\n')[0]!.trim();
	return path.join(path.dirname(first), 'node_modules', '@wadeck-app', 'queue-cli', 'bin', 'queue.js');
}

/** How long a failed lookup of queue is remembered before looking again. */
export const DEFAULT_RESOLVE_FAILURE_TTL_MS = 5_000;
/** How long `queue push` may run before it is killed and the event reported as undelivered. */
export const DEFAULT_PUSH_TIMEOUT_MS = 10_000;

export interface QueueEventSinkOptions {
	/** Directory receiving the `YYYY-MM-DD.ndjson` log of undelivered events (e.g. `<ConfigDir task>/logs`). Called lazily. */
	getLogDir: () => string;
	/** Where to report undelivered events for the interactive user. Default: process.stderr. */
	writeStderr?: (text: string) => void;
	/**
	 * Resolves queue's JS entry point; may be asynchronous. Default: {@link resolveQueueJsPathAsync} (looked up on PATH).
	 * A success is kept for the life of the sink, a failure for {@link QueueEventSinkOptions.resolveFailureTtlMs}.
	 */
	resolveQueueJs?: () => string | Promise<string>;
	/** How long a failed lookup is remembered before looking again. Default: {@link DEFAULT_RESOLVE_FAILURE_TTL_MS}. */
	resolveFailureTtlMs?: number;
	/** Kill `queue push` and report the event as undelivered after this long. Default: {@link DEFAULT_PUSH_TIMEOUT_MS}. */
	pushTimeoutMs?: number;
	/** Clock (ms) used for the failure TTL. Default: Date.now. */
	now?: () => number;
}

/**
 * Default Node sink: delivers each event with `node queue.js push <event> <json>`.
 * A failed delivery never throws: it is reported on stderr AND in the task log (stderr is lost when task runs
 * inside a flow step, the log is not), and returned as `{ delivered: false, reason }` so callers without a terminal
 * (the HTTP routes) can surface it. The log line carries the exact command that replays the event.
 */
export function createQueueEventSink(options: QueueEventSinkOptions): EventSink {
	const writeStderr = options.writeStderr ?? ((text: string) => void process.stderr.write(text));
	const resolveQueueJs = options.resolveQueueJs ?? resolveQueueJsPathAsync;
	const resolveFailureTtlMs = options.resolveFailureTtlMs ?? DEFAULT_RESOLVE_FAILURE_TTL_MS;
	const pushTimeoutMs = options.pushTimeoutMs ?? DEFAULT_PUSH_TIMEOUT_MS;
	const now = options.now ?? Date.now;
	let queueJsPath: string | undefined;
	let pendingLookup: Promise<string> | undefined;
	let lastLookupFailure: { error: Error; at: number } | undefined;

	/** Finds queue once: concurrent callers share one lookup, a recent failure is replayed instead of retried. */
	function lookUpQueueJs(): Promise<string> {
		if (queueJsPath !== undefined) return Promise.resolve(queueJsPath);
		if (lastLookupFailure !== undefined && now() - lastLookupFailure.at < resolveFailureTtlMs) {
			return Promise.reject(lastLookupFailure.error);
		}
		if (pendingLookup !== undefined) return pendingLookup;
		const attempt = (async (): Promise<string> => {
			try {
				queueJsPath = await resolveQueueJs();
				lastLookupFailure = undefined;
				return queueJsPath;
			} catch (error) {
				lastLookupFailure = { error: error instanceof Error ? error : new Error(String(error)), at: now() };
				throw lastLookupFailure.error;
			}
		})();
		pendingLookup = attempt;
		const clear = (): void => {
			if (pendingLookup === attempt) pendingLookup = undefined;
		};
		attempt.then(clear, clear);
		return attempt;
	}

	function reportUndelivered(event: TaskEvent, reason: string): void {
		const taskPart = typeof event.payload.taskId === 'string' ? ` for task ${event.payload.taskId}` : '';
		const msg = `queue push '${event.name}'${taskPart} not delivered: ${reason}. Replay with: ${replayCommand(event)}`;
		writeStderr(
			`[task] queue push '${event.name}'${taskPart} not delivered: ${reason} (details and replay command: task cli logs)\n`
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
		async deliver(event: TaskEvent): Promise<EventDelivery> {
			const json = JSON.stringify(event.payload);
			let queueJs: string;
			try {
				queueJs = await lookUpQueueJs();
			} catch (error) {
				const reason = `queue not found on PATH (${(error as Error).message.split('\n')[0]})`;
				reportUndelivered(event, reason);
				return { delivered: false, reason };
			}
			// Spawn node directly with queue.js -- no shell, args passed verbatim (no JSON quoting issues).
			return new Promise<EventDelivery>(resolve => {
				// 'error' and 'close' can both fire for one child: report only the first outcome.
				let settled = false;
				const settle = (failure?: string): void => {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					if (failure === undefined) {
						resolve({ delivered: true });
					} else {
						reportUndelivered(event, failure);
						resolve({ delivered: false, reason: failure });
					}
				};
				const child = spawn(process.execPath, [queueJs, 'push', event.name, json], {
					stdio: 'inherit',
					windowsHide: true,
				});
				// A hung `queue push` must not hang the caller (an HTTP request): kill it and report the event as undelivered.
				const timer = setTimeout(() => {
					const killed = child.kill();
					settle(
						`timed out after ${pushTimeoutMs} ms (${killed === false ? 'queue push could not be killed' : 'queue push killed'})`
					);
				}, pushTimeoutMs);
				child.on('close', code => settle(code === 0 ? undefined : `exit ${code}`));
				child.on('error', err => settle((err as Error).message));
			});
		},
	};
}
