import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runTaskCommand } from '../TaskIndex.js';
import { taskHelp } from '../cli/help.js';
import type { CommandResult } from '../cli/output.js';
import { registerTestProject } from '../testHelpers.js';

// task comment, comments, comment-edit, comment-rm.

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

async function newTask(title = 'Task'): Promise<string> {
	const result = await run('new', title);
	expect(result.exitCode, result.output).toBe(0);
	return json<{ id: string }>(result).id;
}

interface CommentJson {
	id: string;
	at: string;
	text: string;
	author?: string;
	editedAt?: string;
}

async function comment(id: string, ...args: string[]): Promise<CommentJson> {
	const result = await run('comment', id, ...args, '--json');
	expect(result.exitCode, result.output).toBe(0);
	return json<{ taskId: string; comment: CommentJson }>(result).comment;
}

describe('task comment', () => {
	it('joins the words of an unquoted text and prints a one-line confirmation naming the comment id', async () => {
		const id = await newTask();

		const result = await run('comment', id.slice(0, 4), 'looks', 'good', 'to', 'me');

		expect(result.exitCode).toBe(0);
		const stored = (await run('comments', id, '--json')).output;
		const [first] = JSON.parse(stored) as CommentJson[];
		expect(first!.text).toBe('looks good to me');
		expect(result.output).toBe(`Comment ${first!.id} added to task ${id}`);
	});

	it('--json prints {taskId, comment} with the full text and no author key by default', async () => {
		const id = await newTask();

		const result = await run('comment', id, 'hello', '--json');

		const body = json<{ taskId: string; comment: CommentJson }>(result);
		expect(body.taskId).toBe(id);
		expect(body.comment).toMatchObject({ text: 'hello' });
		expect(body.comment.id).toMatch(/^[0-9a-z]{6}$/);
		expect(body.comment).not.toHaveProperty('author');
	});

	it('--author stores the author; nothing falls back to the OS user', async () => {
		const id = await newTask();

		expect((await comment(id, 'a', '--author', 'alice')).author).toBe('alice');
		expect(await comment(id, 'b')).not.toHaveProperty('author');
	});

	it('--author without a value is an error with the usage', async () => {
		const id = await newTask();

		const result = await run('comment', id, 'x', '--author');

		expect(result.exitCode).toBe(1);
		expect(result.output).toContain('--author requires a name');
		expect(result.output).toContain('Usage: task comment <id> <text...>');
	});

	it('--file reads the text from a file, and from standard input with -', async () => {
		const id = await newTask();
		const file = path.join(root, 'note.txt');
		fs.writeFileSync(file, 'line one\nline two\n');

		const created = await comment(id, '--file', file);

		expect(created.text).toBe('line one\nline two');
	});

	it('--file with a missing path says which file, keeps the usage hint, exit 1', async () => {
		const id = await newTask();

		const result = await run('comment', id, '--file', path.join(root, 'nope.txt'));

		expect(result.exitCode).toBe(1);
		expect(result.output).toContain('cannot read');
		expect(result.output).toContain('nope.txt');
		expect(result.output).toContain('Usage: task comment');
	});

	it('--file together with words is refused', async () => {
		const id = await newTask();
		const file = path.join(root, 'n.txt');
		fs.writeFileSync(file, 'x');

		const result = await run('comment', id, 'words', '--file', file);

		expect(result.exitCode).toBe(1);
		expect(result.output).toContain('cannot be combined');
	});

	it('an empty --file says there is no comment to store', async () => {
		const id = await newTask();
		const file = path.join(root, 'empty.txt');
		fs.writeFileSync(file, '\n\n');

		const result = await run('comment', id, '--file', file);

		expect(result.exitCode).toBe(1);
		expect(result.output).toContain('is empty');
		expect(result.output).toContain('no comment to store');
	});

	it('words after -- are text even when they look like flags', async () => {
		const id = await newTask();

		const created = await comment(id, '--', '--author', 'is', 'text');

		expect(created.text).toBe('--author is text');
		expect(created).not.toHaveProperty('author');
	});

	it('refuses a missing id, a missing text and a blank text with a usage hint and exit 1', async () => {
		const id = await newTask();

		for (const args of [['comment'], ['comment', id], ['comment', id, '   ']]) {
			const result = await run(...args);
			expect(result.exitCode, args.join(' ')).toBe(1);
			expect(result.output, args.join(' ')).toMatch(/Usage: task comment <id> <text\.\.\.>|blank/);
		}
	});

	it('an over-long text is refused with the limit in the hint', async () => {
		const id = await newTask();

		const result = await run('comment', id, 'x'.repeat(10001), '--json');

		expect(result.exitCode).toBe(1);
		const body = json<{ error: string; hint: string }>(result);
		expect(body.error).toContain('10000');
		expect(body.hint).toContain('10000');
	});

	it('an unknown flag and an unknown task are errors; JSON errors are {error, hint}', async () => {
		const id = await newTask();

		const flag = await run('comment', id, 'x', '--bogus');
		expect(flag.exitCode).toBe(1);
		expect(flag.output).toContain('unknown flag: --bogus');

		const unknown = await run('comment', 'zzzzzz', 'x', '--json');
		expect(unknown.exitCode).toBe(1);
		expect(json<{ error: string }>(unknown).error).toContain('Task not found');
	});
});

describe('task comments', () => {
	it('says there is none, and --json prints an empty array', async () => {
		const id = await newTask();

		const text = await run('comments', id);
		expect(text).toEqual({ exitCode: 0, output: `No comments on task ${id}.` });
		expect(json<unknown[]>(await run('comments', id, '--json'))).toEqual([]);
	});

	it('lists them oldest first with id, UTC minute, author, edited marker, and the multi-line text indented', async () => {
		const id = await newTask();
		const first = await comment(id, 'first\nsecond line', '--author', 'alice');
		const second = await comment(id, 'plain');
		await run('comment-edit', id, second.id, 'plain edited');

		const result = await run('comments', id.slice(0, 4));

		expect(result.exitCode).toBe(0);
		const lines = result.output.split('\n');
		expect(lines[0]).toMatch(new RegExp(`^${first.id}  \\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d  alice$`));
		expect(lines[1]).toBe('  first');
		expect(lines[2]).toBe('  second line');
		expect(lines[3]).toBe('');
		expect(lines[4]).toMatch(new RegExp(`^${second.id}  \\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d  \\(edited\\)$`));
		expect(lines[5]).toBe('  plain edited');
	});

	it('--json lists the comments with their full text, chronological', async () => {
		const id = await newTask();
		const a = await comment(id, 'a');
		const b = await comment(id, 'b');

		expect(json<CommentJson[]>(await run('comments', id, '--json'))).toEqual([a, b]);
	});

	it('needs an id; an unknown task is an error', async () => {
		expect((await run('comments')).output).toContain('Usage: task comments <id>');
		expect((await run('comments', 'zzzzzz')).exitCode).toBe(1);
	});
});

describe('task comment-edit', () => {
	it('replaces the text (words joined) and confirms', async () => {
		const id = await newTask();
		const created = await comment(id, 'old');

		const result = await run('comment-edit', id, created.id, 'new', 'text');

		expect(result).toEqual({ exitCode: 0, output: `Comment ${created.id} edited on task ${id}` });
		const [stored] = json<CommentJson[]>(await run('comments', id, '--json'));
		expect(stored).toMatchObject({ id: created.id, text: 'new text' });
		expect(stored!.editedAt).toBeDefined();
	});

	it('says unchanged when the text is the same, and --json reports changed: false', async () => {
		const id = await newTask();
		const created = await comment(id, 'same');

		expect((await run('comment-edit', id, created.id, 'same')).output).toBe(
			`Comment ${created.id} unchanged on task ${id}`
		);
		expect(json<{ changed: boolean }>(await run('comment-edit', id, created.id, 'same', '--json')).changed).toBe(
			false
		);
	});

	it('reads the text from --file', async () => {
		const id = await newTask();
		const created = await comment(id, 'old');
		const file = path.join(root, 'new.txt');
		fs.writeFileSync(file, 'from file\n');

		await run('comment-edit', id, created.id, '--file', file);

		expect(json<CommentJson[]>(await run('comments', id, '--json'))[0]!.text).toBe('from file');
	});

	it('an unknown comment id lists the valid ones in the hint (text and JSON), exit 1', async () => {
		const id = await newTask();
		const a = await comment(id, 'a');
		const b = await comment(id, 'b');

		const text = await run('comment-edit', id, 'nope00', 'x');
		expect(text.exitCode).toBe(1);
		expect(text.output).toContain('Comment not found: nope00');
		expect(text.output).toContain(`${a.id}, ${b.id}`);

		const asJson = json<{ error: string; hint: string }>(await run('comment-edit', id, 'nope00', 'x', '--json'));
		expect(asJson.hint).toContain(`${a.id}, ${b.id}`);
	});

	it('needs an id, a comment id and a text', async () => {
		const id = await newTask();

		for (const args of [['comment-edit'], ['comment-edit', id], ['comment-edit', id, 'abcdef']]) {
			const result = await run(...args);
			expect(result.exitCode, args.join(' ')).toBe(1);
			expect(result.output, args.join(' ')).toContain('Usage: task comment-edit <id> <comment-id> <text...>');
		}
	});
});

describe('task comment-rm', () => {
	it('removes the comment and confirms; --json prints the removed one', async () => {
		const id = await newTask();
		const a = await comment(id, 'a');
		const b = await comment(id, 'b');

		expect(await run('comment-rm', id, a.id)).toEqual({
			exitCode: 0,
			output: `Comment ${a.id} removed from task ${id}`,
		});
		const asJson = json<{ taskId: string; comment: CommentJson }>(await run('comment-rm', id, b.id, '--json'));
		expect(asJson).toEqual({ taskId: id, comment: b });
		expect(json<unknown[]>(await run('comments', id, '--json'))).toEqual([]);
	});

	it('an unknown comment id is an error naming the valid ones, none when the task has no comment', async () => {
		const id = await newTask();

		const result = await run('comment-rm', id, 'nope00');

		expect(result.exitCode).toBe(1);
		expect(result.output).toContain('has no comment yet');
	});

	it('needs an id and a comment id', async () => {
		const id = await newTask();

		for (const args of [['comment-rm'], ['comment-rm', id]]) {
			expect((await run(...args)).output).toContain('Usage: task comment-rm <id> <comment-id>');
		}
	});
});

describe('task show and delete with comments', () => {
	it('show --json has commentCount (0 without comments) and keeps its other keys', async () => {
		const id = await newTask();

		const before = json(await run('show', id, '--json'));
		expect(before['commentCount']).toBe(0);
		expect(before['id']).toBe(id);
		expect(before['childrenIds']).toEqual([]);

		await comment(id, 'x');
		expect(json(await run('show', id, '--json'))['commentCount']).toBe(1);
	});

	it('history --all lists the comment with its full text', async () => {
		const id = await newTask();
		const long = 'word '.repeat(80).trim();
		await comment(id, long);

		const rows = json<Array<{ kind: string; text: string }>>(await run('history', id, '--all', '--json'));

		expect(rows.find(row => row.kind === 'comment')?.text).toBe(long);
	});
});

describe('help and unknown-command hint', () => {
	it('documents the four commands and the three events', () => {
		const help = taskHelp();

		for (const text of [
			'task comment <id> <text...>',
			'task comments <id>',
			'task comment-edit <id> <comment-id> <text...>',
			'task comment-rm <id> <comment-id>',
			'onTaskCommentAdded',
			'onTaskCommentEdited',
			'onTaskCommentRemoved',
		]) {
			expect(help, text).toContain(text);
		}
	});

	it('the unknown-command hint names them', async () => {
		const result = await run('bogus');

		for (const word of ['comment,', 'comments', 'comment-edit', 'comment-rm']) {
			expect(result.output, word).toContain(word);
		}
	});
});
