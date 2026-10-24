import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Appends one line to the task log `<logDir>/YYYY-MM-DD.ndjson` (the file `task cli logs` prints). Never throws: returns
 * the reason when the line could not be written, so the caller can say so where the user looks.
 */
export function appendTaskLog(logDir: string, level: 'info' | 'warn' | 'error', msg: string): string | undefined {
	try {
		const logFile = path.join(logDir, `${new Date().toISOString().slice(0, 10)}.ndjson`);
		fs.mkdirSync(path.dirname(logFile), { recursive: true });
		fs.appendFileSync(logFile, JSON.stringify({ ts: new Date().toISOString(), level, msg }) + '\n');
		return undefined;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}
