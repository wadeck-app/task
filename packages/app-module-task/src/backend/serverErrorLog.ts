import * as fs from 'node:fs';
import * as path from 'node:path';

export interface ServerErrorContext {
	method: string;
	/** The route pattern as registered (e.g. `/tasks/:id`). */
	route: string;
	status: number;
	error: unknown;
}

/**
 * Records an unexpected (5xx) failure where it stays visible after the HTTP answer is gone:
 * app-core's own output (`writeStderr`) and the task log `<logDir>/YYYY-MM-DD.ndjson` (`task cli logs`), in the line
 * format the queue event sink uses. ModuleContext offers no logger, hence both. Never throws: a log that cannot be
 * written is reported on `writeStderr` and must not replace the answer the caller is about to send.
 */
export function recordServerError(
	logDir: string,
	context: ServerErrorContext,
	writeStderr: (text: string) => void
): void {
	const { method, route, status, error } = context;
	const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
	const headline = `${method} ${route} failed (${status}): ${error instanceof Error ? error.message : String(error)}`;
	writeStderr(`[task] ${headline} (stack and details: task cli logs)\n`);
	try {
		const logFile = path.join(logDir, `${new Date().toISOString().slice(0, 10)}.ndjson`);
		fs.mkdirSync(path.dirname(logFile), { recursive: true });
		const msg = `${headline}\n${detail}`;
		fs.appendFileSync(logFile, JSON.stringify({ ts: new Date().toISOString(), level: 'error', msg }) + '\n');
	} catch (logError) {
		writeStderr(
			`[task] could not record the error in the task log: ${(logError as Error).message}. Check that ${logDir} is writable.\n`
		);
	}
}
