import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { COMMENT_AUTHOR_MAX, COMMENT_TEXT_MAX, CommentNotFoundError, InvalidCommentTextError } from './taskComments';
import { TaskStore } from './TaskStore';
import type { ActivityEntry, TaskRecord } from './TaskStore';

// Comments: a plain-text list in the task file (`comments`), written atomically with the change like every mutator.
describe('TaskStore comments', () => {
	let rootDir: string;
	let tasksDir: string;
	let store: TaskStore;

	beforeEach(() => {
		rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-store-'));
		tasksDir = path.join(rootDir, 'tasks');
		fs.mkdirSync(tasksDir, { recursive: true });
		store = new TaskStore(tasksDir);
	});

	afterEach(() => {
		fs.rmSync(rootDir, { recursive: true, force: true });
	});

	const onDisk = (id: string): TaskRecord =>
		JSON.parse(fs.readFileSync(path.join(tasksDir, `${id}.json`), 'utf8')) as TaskRecord;
	const activity = (id: string): ActivityEntry[] => onDisk(id).activity ?? [];

	it('a new task has no comments key (additive format, no migration)', () => {
		const task = store.create('A', 'backlog');

		expect(onDisk(task.id)).not.toHaveProperty('comments');
	});

	it('addComment stores id, instant and trimmed text, keeps inner newlines, and bumps updatedAt', () => {
		const task = store.create('A', 'backlog');

		const { comment, task: after } = store.addComment(task.id, '  first line\n\n  second line  \n');

		expect(comment.id).toMatch(/^[0-9a-z]{6}$/);
		expect(comment.at).toMatch(/^\d{4}-\d\d-\d\dT/);
		expect(comment.text).toBe('first line\n\n  second line');
		expect(comment).not.toHaveProperty('author');
		expect(comment).not.toHaveProperty('editedAt');
		expect(onDisk(task.id).comments).toEqual([comment]);
		expect(after.comments).toEqual([comment]);
		expect(onDisk(task.id).updatedAt >= task.updatedAt).toBe(true);
	});

	it('addComment keeps the author when given (trimmed) and omits a blank one', () => {
		const task = store.create('A', 'backlog');

		const named = store.addComment(task.id, 'x', '  alice ').comment;
		const blank = store.addComment(task.id, 'y', '   ').comment;

		expect(named.author).toBe('alice');
		expect(blank).not.toHaveProperty('author');
	});

	it('addComment appends in order with ids unique within the task', () => {
		const task = store.create('A', 'backlog');
		const ids = Array.from({ length: 50 }, (_, i) => store.addComment(task.id, `c${i}`).comment.id);

		expect(new Set(ids).size).toBe(50);
		expect(onDisk(task.id).comments!.map(c => c.text)).toEqual(Array.from({ length: 50 }, (_, i) => `c${i}`));
	});

	it('refuses a blank text, a text over the maximum and an author over the maximum, writing nothing', () => {
		const task = store.create('A', 'backlog');
		const before = fs.readFileSync(path.join(tasksDir, `${task.id}.json`), 'utf8');

		expect(() => store.addComment(task.id, '')).toThrow(InvalidCommentTextError);
		expect(() => store.addComment(task.id, ' \n\t ')).toThrow(InvalidCommentTextError);
		expect(() => store.addComment(task.id, 'x'.repeat(COMMENT_TEXT_MAX + 1))).toThrow(InvalidCommentTextError);
		expect(() => store.addComment(task.id, 'x', 'a'.repeat(COMMENT_AUTHOR_MAX + 1))).toThrow(
			InvalidCommentTextError
		);
		expect(fs.readFileSync(path.join(tasksDir, `${task.id}.json`), 'utf8')).toBe(before);
	});

	it('accepts a text of exactly the maximum', () => {
		const task = store.create('A', 'backlog');

		expect(store.addComment(task.id, 'x'.repeat(COMMENT_TEXT_MAX)).comment.text).toHaveLength(COMMENT_TEXT_MAX);
	});

	it('the error for a bad text says the limit and how to fix it', () => {
		const task = store.create('A', 'backlog');

		expect(() => store.addComment(task.id, '  ')).toThrow(/blank/);
		try {
			store.addComment(task.id, 'x'.repeat(COMMENT_TEXT_MAX + 1));
			throw new Error('expected a throw');
		} catch (error) {
			expect(error).toBeInstanceOf(InvalidCommentTextError);
			expect((error as InvalidCommentTextError).hint).toContain(String(COMMENT_TEXT_MAX));
		}
	});

	it('addComment on an unknown task throws the usual TaskNotFoundError', () => {
		expect(() => store.addComment('nope1234', 'x')).toThrow(/Task not found/);
	});

	it('editComment replaces the text, sets editedAt, keeps id, at and author', () => {
		const task = store.create('A', 'backlog');
		const { comment } = store.addComment(task.id, 'old', 'alice');

		const result = store.editComment(task.id, comment.id, ' new text ');

		expect(result.changed).toBe(true);
		expect(result.oldText).toBe('old');
		expect(result.comment).toMatchObject({ id: comment.id, at: comment.at, author: 'alice', text: 'new text' });
		expect(result.comment.editedAt).toMatch(/^\d{4}-\d\d-\d\dT/);
		expect(onDisk(task.id).comments).toEqual([result.comment]);
	});

	it('editComment with the same text changes nothing on disk', () => {
		const task = store.create('A', 'backlog');
		const { comment } = store.addComment(task.id, 'same');
		const before = fs.readFileSync(path.join(tasksDir, `${task.id}.json`), 'utf8');

		const result = store.editComment(task.id, comment.id, '  same ');

		expect(result.changed).toBe(false);
		expect(result.comment).not.toHaveProperty('editedAt');
		expect(fs.readFileSync(path.join(tasksDir, `${task.id}.json`), 'utf8')).toBe(before);
	});

	it('editComment refuses a blank text and keeps the old one', () => {
		const task = store.create('A', 'backlog');
		const { comment } = store.addComment(task.id, 'keep');

		expect(() => store.editComment(task.id, comment.id, '  ')).toThrow(InvalidCommentTextError);
		expect(onDisk(task.id).comments![0]!.text).toBe('keep');
	});

	it('an unknown comment id throws CommentNotFoundError listing the valid ids', () => {
		const task = store.create('A', 'backlog');
		const first = store.addComment(task.id, 'a').comment;
		const second = store.addComment(task.id, 'b').comment;

		for (const act of [
			() => store.editComment(task.id, 'zzzzzz', 'x'),
			() => store.removeComment(task.id, 'zzzzzz'),
		]) {
			try {
				act();
				throw new Error('expected a throw');
			} catch (error) {
				expect(error).toBeInstanceOf(CommentNotFoundError);
				const typed = error as CommentNotFoundError;
				expect(typed.commentId).toBe('zzzzzz');
				expect(typed.validIds).toEqual([first.id, second.id]);
				expect(typed.message).toContain('zzzzzz');
				expect(typed.hint).toContain(first.id);
				expect(typed.hint).toContain(second.id);
			}
		}
	});

	it('the hint of an unknown id on a task without comments says there are none', () => {
		const task = store.create('A', 'backlog');

		try {
			store.removeComment(task.id, 'zzzzzz');
			throw new Error('expected a throw');
		} catch (error) {
			expect(error).toBeInstanceOf(CommentNotFoundError);
			expect((error as CommentNotFoundError).validIds).toEqual([]);
			expect((error as CommentNotFoundError).hint).toMatch(/no comment/i);
		}
	});

	it('removeComment removes it and drops the key with the last one', () => {
		const task = store.create('A', 'backlog');
		const a = store.addComment(task.id, 'a').comment;
		const b = store.addComment(task.id, 'b').comment;

		const removed = store.removeComment(task.id, a.id);
		expect(removed.comment).toEqual(a);
		expect(onDisk(task.id).comments).toEqual([b]);

		store.removeComment(task.id, b.id);
		expect(onDisk(task.id)).not.toHaveProperty('comments');
	});

	it('edit and remove append activity entries with a text preview; add does not (the comment itself is the record)', () => {
		const task = store.create('A', 'backlog');
		const { comment } = store.addComment(task.id, 'first');
		expect(activity(task.id)).toEqual([]);

		store.editComment(task.id, comment.id, 'second');
		store.removeComment(task.id, comment.id);

		const entries = activity(task.id);
		expect(entries.map(e => e.kind)).toEqual(['comment-edited', 'comment-removed']);
		expect(entries[0]).toMatchObject({ field: comment.id, oldValue: 'first', newValue: 'second' });
		expect(entries[1]).toMatchObject({ field: comment.id, oldValue: 'second' });
	});

	it('the activity preview of a long comment is cut, the comment itself is not', () => {
		const task = store.create('A', 'backlog');
		const { comment } = store.addComment(task.id, 'x'.repeat(3000));

		store.editComment(task.id, comment.id, 'y'.repeat(3000));

		expect(activity(task.id)[0]!.oldValue!.length).toBeLessThanOrEqual(200);
		expect(onDisk(task.id).comments![0]!.text).toHaveLength(3000);
	});

	it('goes through the injected writer (atomic writes)', () => {
		const writes: string[] = [];
		const spied = new TaskStore(tasksDir, {
			writeFile: (file, content) => {
				writes.push(file);
				fs.writeFileSync(file, content, 'utf8');
			},
		});
		const task = spied.create('A', 'backlog');
		writes.length = 0;

		spied.addComment(task.id, 'x');

		expect(writes).toEqual([path.join(tasksDir, `${task.id}.json`)]);
	});
});
