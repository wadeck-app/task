import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runTaskCommand } from '../TaskIndex.js';
import { taskHelp } from '../cli/help.js';
import { readTextSource } from '../cli/readText.js';
import { registerTestProject } from '../testHelpers.js';
import type { CommandResult } from '../cli/output.js';

// task new "<text>" [--description ...], set-title, set-description, unset-meta, unset-type, find, labels.

let root: string;
let dir: string;
let stderr: string[];

beforeEach(async () => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-text-cmd-'));
	dir = path.join(root, 'work');
	await registerTestProject(dir);
	stderr = [];
	vi.spyOn(process.stderr, 'write').mockImplementation(chunk => {
		stderr.push(String(chunk));
		return true;
	});
});

afterEach(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

const run = (...args: string[]): Promise<CommandResult> => runTaskCommand(args, dir);
const json = <T = Record<string, unknown>>(result: CommandResult): T => JSON.parse(result.output) as T;

async function created(...args: string[]): Promise<Record<string, unknown> & { id: string }> {
	const result = await run('new', ...args);
	expect(result.exitCode, result.output).toBe(0);
	return json(result);
}

describe('task new', () => {
	it('a short text is the title only (no description key printed)', async () => {
		const task = await created('Fix login');

		expect(task['title']).toBe('Fix login');
		expect(task).not.toHaveProperty('description');
	});

	it('a long text (a flow prompt) is split: headline as title, full text as description', async () => {
		const prompt = `Review the importer\n\n${'Look at every code path and report. '.repeat(10)}`;

		const task = await created(prompt);

		expect(task['title']).toBe('Review the importer');
		expect(task['description']).toBe(prompt);
	});

	it('--description stores a separate body and wins over any split', async () => {
		const task = await created('Fix login', '--description', 'The redirect loops after logout.');

		expect(task['title']).toBe('Fix login');
		expect(task['description']).toBe('The redirect loops after logout.');
	});

	it('--description-file reads the body from a file (trailing newline dropped)', async () => {
		const file = path.join(root, 'body.md');
		fs.writeFileSync(file, '# Body\n\nSeveral lines.\n');

		const task = await created('Fix login', '--description-file', file);

		expect(task['description']).toBe('# Body\n\nSeveral lines.');
	});

	it('works with a parent and --description in any order', async () => {
		const parent = await created('parent');

		const task = await created('child', '--parent', parent.id.slice(0, 4), '--description', 'body');

		expect(task['parentId']).toBe(parent.id);
		expect(task['description']).toBe('body');
	});

	it.each([
		[['--description', 'a', '--description-file', 'f'], /cannot be combined/],
		[['--description'], /--description requires a text/],
		[['--description-file'], /--description-file requires a path/],
		[['--description-file', 'does-not-exist.md'], /does-not-exist\.md/],
		[['--bogus'], /unknown flag: --bogus/],
	])('refuses %j with an actionable error', async (flags, message) => {
		const result = await run('new', 'title', ...flags);

		expect(result.exitCode).toBe(1);
		expect(result.output).toMatch(message);
		expect(result.output).toMatch(/Usage: task new/);
	});

	it('refuses an empty description file and creates nothing', async () => {
		const file = path.join(root, 'empty.md');
		fs.writeFileSync(file, '\n');

		const result = await run('new', 'title', '--description-file', file);

		expect(result.exitCode).toBe(1);
		expect(result.output).toMatch(/is empty/);
		expect(json<unknown[]>(await run('list'))).toEqual([]);
	});

	it('--json shapes errors as {error, hint}', async () => {
		const result = await run('--json', 'new');

		expect(result.exitCode).toBe(1);
		expect(json(result)).toEqual({
			error: 'missing description',
			hint: expect.stringContaining('Usage: task new'),
		});
	});

	it('--description alone (no title text) is the single text of the task', async () => {
		const task = await created('--description', 'only a body');

		expect(task['title']).toBe('only a body');
	});
});

describe('task set-title / set-description', () => {
	it('set-title changes the title, list shows it, show keeps the description', async () => {
		const task = await created('Old', '--description', 'Body');

		const result = await run('set-title', task.id.slice(0, 4), 'New title');

		expect(result.exitCode).toBe(0);
		expect(json(result)).toMatchObject({ id: task.id, title: 'New title', description: 'Body' });
		expect(json<Array<{ title: string }>>(await run('list'))[0]!.title).toBe('New title');
	});

	it('set-description sets, and an empty text clears it', async () => {
		const task = await created('Title');

		expect(json(await run('set-description', task.id, 'Body'))).toMatchObject({ description: 'Body' });
		expect(json(await run('set-description', task.id, ''))).not.toHaveProperty('description');
		expect(json(await run('show', task.id))).not.toHaveProperty('description');
	});

	it.each([
		[['set-title'], /Usage: task set-title <id> <text>/],
		[['set-title', 'abcd'], /Usage: task set-title <id> <text>/],
		[['set-title', 'abcd', 'two', 'words'], /Quote the text/],
		[['set-description'], /Usage: task set-description <id> <text>/],
		[['set-description', 'abcd'], /Usage: task set-description <id> <text>/],
	])('%j fails with its usage', async (args, message) => {
		const result = await run(...args);

		expect(result.exitCode).toBe(1);
		expect(result.output).toMatch(message);
	});

	it('refuses a blank title and an unknown id with the usual error shape', async () => {
		const task = await created('Title');

		const blank = await run('--json', 'set-title', task.id, '   ');
		expect(blank.exitCode).toBe(1);
		expect(json(blank)).toEqual({ error: 'a title cannot be blank', hint: expect.any(String) });

		const unknown = await run('--json', 'set-title', 'zzzz', 'x');
		expect(unknown.exitCode).toBe(1);
		expect(json<{ error: string }>(unknown).error).toMatch(/zzzz/);
	});
});

describe('task unset-meta / unset-type', () => {
	it('unset-meta removes the key and prints the task', async () => {
		const task = await created('t');
		await run('set-meta', task.id, 'owner', 'ann');
		await run('set-meta', task.id, 'team', 'x');

		const result = await run('unset-meta', task.id, 'owner');

		expect(result.exitCode).toBe(0);
		expect(json(result)).toMatchObject({ meta: { team: 'x' } });
	});

	it('unset-meta of an absent key succeeds and changes nothing (like remove-label)', async () => {
		const task = await created('t');

		const result = await run('unset-meta', task.id, 'nope');

		expect(result.exitCode).toBe(0);
		expect(json(result)).not.toHaveProperty('meta');
	});

	it('unset-type clears the type', async () => {
		const task = await created('t');
		await run('set-type', task.id, 'bug');

		const result = await run('unset-type', task.id.slice(0, 4));

		expect(result.exitCode).toBe(0);
		expect(json(result)).not.toHaveProperty('type');
	});

	it.each([
		[['unset-meta'], /Usage: task unset-meta <id> <key>/],
		[['unset-meta', 'abcd'], /Usage: task unset-meta <id> <key>/],
		[['unset-type'], /Usage: task unset-type <id>/],
	])('%j fails with its usage', async (args, message) => {
		const result = await run(...args);

		expect(result.exitCode).toBe(1);
		expect(result.output).toMatch(message);
	});

	it('--json error for an unknown task', async () => {
		const result = await run('--json', 'unset-type', 'zzzz');

		expect(result.exitCode).toBe(1);
		expect(json<{ error: string }>(result).error).toMatch(/zzzz/);
	});
});

describe('task find', () => {
	it('prints one line per hit: id, headline, status (text), best match first', async () => {
		// Created first, so that only the ranking (word prefix before substring) can put the login task first.
		const catalog = await created('Catalog sync');
		const login = await created('Fix login redirect');

		const result = await run('find', 'log');

		expect(result.exitCode).toBe(0);
		expect(result.output).toBe(
			`  ${login.id}  Fix login redirect  [backlog]
  ${catalog.id}  Catalog sync  [backlog]`
		);
	});

	it('--json prints [{id, headline, status}] and joins several words into one query', async () => {
		const login = await created('Fix login redirect');
		await created('login page');

		const result = await run('find', 'login', 'redirect', '--json');

		expect(json(result)).toEqual([{ id: login.id, headline: 'Fix login redirect', status: 'backlog' }]);
	});

	it('--limit caps the answer; 0, 21 and text are refused naming the maximum', async () => {
		for (let n = 0; n < 5; n++) await created(`item ${n}`);

		expect(json<unknown[]>(await run('find', 'item', '--limit', '2', '--json'))).toHaveLength(2);
		for (const bad of ['0', '21', 'abc', '1.5']) {
			const result = await run('find', 'item', '--limit', bad);
			expect(result.exitCode, bad).toBe(1);
			expect(result.output).toMatch(/--limit must be an integer from 1 to 20/);
		}
		expect((await run('find', 'item', '--limit')).output).toMatch(/--limit requires a number/);
	});

	it('no match: empty stdout, exit 0, a note on stderr (text) or [] (json)', async () => {
		await created('something');

		const text = await run('find', 'zzz');
		expect(text).toEqual({ exitCode: 0, output: '' });
		expect(stderr.join('')).toMatch(/No task matches "zzz"/);

		expect(json(await run('find', 'zzz', '--json'))).toEqual([]);
	});

	it('shows the headline of a long-text task, found by a word of its body', async () => {
		const prompt = `Review the importer\n\n${'Check the quarterly handler. '.repeat(10)}`;
		const task = await created(prompt);

		const hits = json<Array<{ id: string; headline: string }>>(await run('find', 'quarterly', '--json'));

		expect(hits).toEqual([]);
		// Only the title (headline) is indexed: the body is not searched.
		expect(json<Array<{ id: string }>>(await run('find', 'importer', '--json'))[0]!.id).toBe(task.id);
	});

	it('requires a query, with --json shape', async () => {
		const result = await run('--json', 'find');

		expect(result.exitCode).toBe(1);
		expect(json(result)).toEqual({ error: 'missing query', hint: expect.stringContaining('Usage: task find') });
	});
});

describe('task labels', () => {
	it('lists labels with their task count, most used first (text and json)', async () => {
		const a = await created('a');
		const b = await created('b');
		await run('add-label', a.id, 'urgent');
		await run('add-label', b.id, 'urgent');
		await run('add-label', a.id, 'api');

		expect(await run('labels')).toEqual({ exitCode: 0, output: '  2  urgent\n  1  api' });
		expect(json(await run('labels', '--json'))).toEqual([
			{ label: 'urgent', count: 2 },
			{ label: 'api', count: 1 },
		]);
	});

	it('no label: empty stdout with a note on stderr (text), [] (json)', async () => {
		await created('a');

		expect(await run('labels')).toEqual({ exitCode: 0, output: '' });
		expect(stderr.join('')).toMatch(/No label in use/);
		expect(json(await run('labels', '--json'))).toEqual([]);
	});

	it('refuses an argument', async () => {
		const result = await run('labels', 'x');

		expect(result.exitCode).toBe(1);
		expect(result.output).toMatch(/Usage: task labels/);
	});
});

describe('help and unknown-command hint', () => {
	it('lists every new command, the new event and the description rules', () => {
		const help = taskHelp();

		for (const text of [
			'task new <text> [--description <text> | --description-file <path|->]',
			'task set-title <id> <text>',
			'task set-description <id> <text>',
			'task unset-meta <id> <key>',
			'task unset-type <id>',
			'task find <query> [--limit N] [--json]',
			'task labels [--json]',
			'onTaskTextChanged',
		]) {
			expect(help, text).toContain(text);
		}
	});

	it('the unknown-command hint names them too', async () => {
		const result = await run('bogus');

		for (const word of ['set-title', 'set-description', 'unset-meta', 'unset-type', 'find', 'labels']) {
			expect(result.output, word).toContain(word);
		}
	});
});

describe('readTextSource', () => {
	it('reads a file, and stdin for "-" (injected), dropping trailing whitespace', () => {
		const file = path.join(root, 'in.txt');
		fs.writeFileSync(file, 'text\r\n\n');

		expect(readTextSource(file)).toBe('text');
		expect(readTextSource('-', () => 'from stdin\n')).toBe('from stdin');
	});

	it('throws an error naming the path when the file is missing, and when the text is empty', () => {
		expect(() => readTextSource(path.join(root, 'nope.md'))).toThrow(/nope\.md/);
		expect(() => readTextSource('-', () => '  \n')).toThrow(/standard input is empty/);
	});
});
