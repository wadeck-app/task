// Reads the updater's decisions for `task cli update --log`.
// shared-updater's appendLog writes { ts, level, msg } lines to <configDir>/logs/<UTC date>.ndjson; shared-cli's
// logCliInvocation writes the same shape to the same file with msg 'cmd: task ...', which is not an updater entry.
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface UpdaterLogEntry {
	ts: string;
	level: string;
	msg: string;
}

export const UPDATER_LOG_LINES = 50;
const DAY_MS = 24 * 60 * 60 * 1000;

function readDay(logsDir: string, day: string): UpdaterLogEntry[] {
	const file = path.join(logsDir, `${day}.ndjson`);
	if (!fs.existsSync(file)) return [];
	const entries: UpdaterLogEntry[] = [];
	for (const raw of fs.readFileSync(file, 'utf-8').split('\n')) {
		if (raw.trim() === '') continue;
		let parsed: Partial<UpdaterLogEntry>;
		try {
			parsed = JSON.parse(raw) as Partial<UpdaterLogEntry>;
		} catch {
			continue;
		}
		if (typeof parsed.msg !== 'string' || typeof parsed.ts !== 'string') continue;
		if (parsed.msg.startsWith('cmd: ')) continue;
		entries.push({ ts: parsed.ts, level: String(parsed.level ?? 'info'), msg: parsed.msg });
	}
	return entries;
}

/** Last 50 updater entries of today's file, completed with the previous day's when today has fewer. Oldest first. */
export function readUpdaterLog(configDir: string, opts: { now?: Date; limit?: number } = {}): UpdaterLogEntry[] {
	const now = opts.now ?? new Date();
	const limit = opts.limit ?? UPDATER_LOG_LINES;
	const logsDir = path.join(configDir, 'logs');
	const today = readDay(logsDir, now.toISOString().slice(0, 10));
	if (today.length >= limit) return today.slice(-limit);
	const previous = readDay(logsDir, new Date(now.getTime() - DAY_MS).toISOString().slice(0, 10));
	return [...previous, ...today].slice(-limit);
}

export function renderUpdaterLog(entries: UpdaterLogEntry[], configDir: string): string {
	if (entries.length === 0) {
		return `No updater entry in today's or yesterday's logs in ${path.join(configDir, 'logs')}. Run: task cli update\n`;
	}
	return entries
		.map(e => {
			const time = e.ts.replace('T', ' ').replace(/\.\d+Z$/, 'Z');
			return `${time}  ${e.level.toUpperCase().padEnd(5)}  ${e.msg}\n`;
		})
		.join('');
}

/** What `--log` prints: a clear message naming the directory when no log directory exists at all. */
export function formatUpdaterLog(configDir: string, json: boolean): string {
	const logsDir = path.join(configDir, 'logs');
	if (!fs.existsSync(logsDir)) {
		return json
			? '[]\n'
			: `No updater log found: ${logsDir} does not exist yet (the updater has not run on this machine). Run: task cli update\n`;
	}
	const entries = readUpdaterLog(configDir);
	if (json) return JSON.stringify(entries, null, 2) + '\n';
	return renderUpdaterLog(entries, configDir);
}
