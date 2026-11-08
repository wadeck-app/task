import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runTaskCommand } from '../TaskIndex.js';
import { registerTestProject } from '../testHelpers.js';
import type { CommandResult } from '../cli/output.js';

// task history <id> [--all]: the status history as before, or the whole activity.

let root: string;
let dir: string;

beforeEach(async () => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-text-cmd-'));
	dir = path.join(root, 'work');
	await registerTestProject(dir);
	vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

const run = (...args: string[]): Promise<CommandResult> => runTaskCommand(args, dir);

async function createdId(text: string): Promise<string> {
	const result = await run('new', text);
	expect(result.exitCode, result.output).toBe(0);
	return (JSON.parse(result.output) as { id: string }).id;
}

describe('task history', () => {
	it('without --all keeps printing the status history array, whatever else changed', async () => {
		const id = await createdId('Fix login');
		await run('set-type', id, 'bug');

		const result = await run('history', id);

		expect(result.exitCode).toBe(0);
		const entries = JSON.parse(result.output) as Array<Record<string, unknown>>;
		expect(entries).toHaveLength(1);
		expect(Object.keys(entries[0]!).sort()).toEqual(['status', 'timestamp']);
	});

	it('--all --json prints the merged rows, newest first', async () => {
		const id = await createdId('Fix login');
		await run('set-type', id, 'bug');
		await run('add-label', id, 'billing');

		const result = await run('history', id, '--all', '--json');

		expect(result.exitCode).toBe(0);
		const rows = JSON.parse(result.output) as Array<{ kind: string; text: string; source: string; icon: string }>;
		expect(rows.map(row => row.text)).toEqual([
			'Label billing added',
			'Type set to bug',
			expect.stringMatching(/^Created with status /),
		]);
		expect(rows.map(row => row.source)).toEqual(['activity', 'activity', 'history']);
		expect(rows[0]).toMatchObject({ kind: 'label-added', icon: 'tag', tone: 'neutral' });
	});

	it('--all prints one line per row in text mode: UTC minute, then the sentence', async () => {
		const id = await createdId('Fix login');
		await run('set-type', id, 'bug');

		const result = await run('history', id, '--all');

		expect(result.exitCode).toBe(0);
		const lines = result.output.split('\n');
		expect(lines).toHaveLength(2);
		expect(lines[0]).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d {2}Type set to bug$/);
		expect(lines[1]).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d {2}Created with status /);
	});

	it('--all shows the title and description edits', async () => {
		const id = await createdId('Fix login');
		await run('set-title', id, 'Fix the login');
		await run('set-description', id, 'More words');

		const rows = JSON.parse((await run('history', id, '--all', '--json')).output) as Array<{
			text: string;
			details?: unknown;
		}>;

		expect(rows[0]).toMatchObject({
			text: 'Description edited',
			details: { oldValue: 'Fix the login', newValue: 'More words' },
		});
		expect(rows[1]).toMatchObject({
			text: 'Title edited',
			details: { oldValue: 'Fix login', newValue: 'Fix the login' },
		});
	});

	it('--all with --follow is refused with a way out, in text and in JSON', async () => {
		const id = await createdId('Fix login');

		const text = await run('history', id, '--all', '--follow');
		const json = await run('history', id, '--all', '-f', '--json');

		expect(text.exitCode).toBe(1);
		expect(text.output).toContain('--all cannot be combined with --follow');
		expect(text.output).toContain('task history');
		expect(json.exitCode).toBe(1);
		expect(JSON.parse(json.output)).toMatchObject({ error: expect.stringContaining('--all') });
		expect(JSON.parse(json.output)).toHaveProperty('hint');
	});

	it('--all of an unknown task fails like the plain history', async () => {
		const result = await run('history', 'zzzzzzzz', '--all', '--json');

		expect(result.exitCode).toBe(1);
		expect(JSON.parse(result.output)).toHaveProperty('error');
	});

	it('--all emits no event', async () => {
		const id = await createdId('Fix login');
		const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

		await run('history', id, '--all');

		expect(stdout).not.toHaveBeenCalled();
	});

	it('help lists --all', async () => {
		const result = await run('--help');

		expect(result.output).toMatch(/task history <id> \[--all\]/);
	});
});
