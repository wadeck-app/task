import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { readUpdaterLog, renderUpdaterLog } from './updateLog.js';
import { runTaskCliUpdate } from './TaskCliCommand.js';

vi.mock('@wadeck-app/shared-cli/CliMetaCommands', () => ({
	cliVersionCommand: vi.fn(),
	cliUpdateCommand: vi.fn(),
	cliRollbackCommand: vi.fn(),
	cliLogsCommand: vi.fn(),
	warnUnknownArgs: vi.fn(),
}));

// Lines in the exact shape of shared-updater's appendLog ({ ts, level, msg }) and shared-cli's logCliInvocation.
const line = (ts: string, level: string, msg: string): string => JSON.stringify({ ts, level, msg });
const NOW = new Date('2026-10-25T12:00:00.000Z');

describe('updater log (logs/<date>.ndjson)', () => {
	let dir: string;
	let written: string[];

	function writeDay(day: string, lines: string[]): void {
		fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
		fs.writeFileSync(path.join(dir, 'logs', `${day}.ndjson`), lines.join('\n') + '\n');
	}

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-updatelog-'));
		written = [];
		vi.spyOn(process.stdout, 'write').mockImplementation(chunk => {
			written.push(String(chunk));
			return true;
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
		delete process.env['XDG_CONFIG_HOME'];
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it('drops the CLI invocation lines, keeps the updater decisions', () => {
		writeDay('2026-10-25', [
			line('2026-10-25T10:00:00.000Z', 'info', 'cmd: task cli update --log'),
			line('2026-10-25T10:00:01.000Z', 'warn', '@wadeck-app/task-cli previous install 1 -> 2 was interrupted'),
			line('2026-10-25T10:00:02.000Z', 'info', 'cmd: task list'),
		]);
		const entries = readUpdaterLog(dir, { now: NOW });
		expect(entries.map(e => e.msg)).toEqual(['@wadeck-app/task-cli previous install 1 -> 2 was interrupted']);
	});

	it('keeps the last 50 entries of today without reading yesterday when today has enough', () => {
		writeDay(
			'2026-10-25',
			Array.from({ length: 60 }, (_, i) => line('2026-10-25T10:00:00.000Z', 'info', `today ${i}`))
		);
		writeDay('2026-10-24', [line('2026-10-24T10:00:00.000Z', 'info', 'yesterday')]);
		const entries = readUpdaterLog(dir, { now: NOW });
		expect(entries).toHaveLength(50);
		expect(entries[0]!.msg).toBe('today 10');
		expect(entries[49]!.msg).toBe('today 59');
	});

	it('completes with the previous day (older first) when today has fewer than 50', () => {
		writeDay('2026-10-24', [line('2026-10-24T23:00:00.000Z', 'error', 'yesterday')]);
		writeDay('2026-10-25', [line('2026-10-25T01:00:00.000Z', 'info', 'today')]);
		expect(readUpdaterLog(dir, { now: NOW }).map(e => e.msg)).toEqual(['yesterday', 'today']);
	});

	it('skips unparsable lines instead of crashing', () => {
		writeDay('2026-10-25', ['not json', line('2026-10-25T01:00:00.000Z', 'info', 'ok')]);
		expect(readUpdaterLog(dir, { now: NOW }).map(e => e.msg)).toEqual(['ok']);
	});

	it('renders time, level and message', () => {
		const text = renderUpdaterLog([{ ts: '2026-10-25T10:00:01.000Z', level: 'warn', msg: 'hello' }], dir);
		expect(text).toBe('2026-10-25 10:00:01Z  WARN   hello\n');
	});

	it('names the directory when there is no log at all (no empty output)', async () => {
		process.env['XDG_CONFIG_HOME'] = dir;
		await runTaskCliUpdate({ log: true, rawArgs: ['--log'] });
		const out = written.join('');
		expect(out).toContain('No updater log found');
		expect(out).toContain(path.join(dir, 'task', 'logs'));
	});

	it('says so when logs exist but hold no updater entry', async () => {
		process.env['XDG_CONFIG_HOME'] = dir;
		const day = new Date().toISOString().slice(0, 10);
		fs.mkdirSync(path.join(dir, 'task', 'logs'), { recursive: true });
		fs.writeFileSync(
			path.join(dir, 'task', 'logs', `${day}.ndjson`),
			line('2026-10-25T10:00:00.000Z', 'info', 'cmd: task list') + '\n'
		);
		await runTaskCliUpdate({ log: true, rawArgs: ['--log'] });
		expect(written.join('')).toContain('No updater entry');
	});

	it('--log --json prints the entries as a JSON array', async () => {
		process.env['XDG_CONFIG_HOME'] = dir;
		const day = new Date().toISOString().slice(0, 10);
		fs.mkdirSync(path.join(dir, 'task', 'logs'), { recursive: true });
		fs.writeFileSync(
			path.join(dir, 'task', 'logs', `${day}.ndjson`),
			line('2026-10-25T10:00:00.000Z', 'info', 'x updated') + '\n'
		);
		await runTaskCliUpdate({ log: true, json: true, rawArgs: ['--log', '--json'] });
		expect(JSON.parse(written.join(''))).toEqual([
			{ ts: '2026-10-25T10:00:00.000Z', level: 'info', msg: 'x updated' },
		]);
	});
});
