import { CommentNotFoundError, InvalidCommentTextError, TaskNotFoundError } from '@wadeck-app/task-core';

import { addComment, editComment, listComments, removeComment } from './comments.js';
import { describeError } from './describeError.js';
import { createTestContext, type TestContext } from './testHelpers.js';

describe('comments use cases', () => {
	let t: TestContext;
	let id: string;
	beforeEach(() => {
		t = createTestContext();
		id = t.ctx.store.create('Title', 'backlog').id;
	});
	afterEach(() => t.cleanup());

	const env = () => ({ taskProjectName: 'proj', taskProjectPath: t.rootDir });

	describe('addComment', () => {
		it('stores the comment (prefix accepted) and fires onTaskCommentAdded with the FULL text', () => {
			const long = `${'word '.repeat(500)}end`;

			const result = addComment(t.ctx, { id: id.slice(0, 4), text: long, author: 'alice' });

			expect(result.comment.text).toBe(long);
			expect(result.events).toEqual([
				{
					name: 'onTaskCommentAdded',
					payload: { taskId: id, commentId: result.comment.id, text: long, author: 'alice', ...env() },
				},
			]);
			expect(t.ctx.store.get(id).comments).toEqual([result.comment]);
		});

		it('leaves author out of the JSON payload when there is none', () => {
			const result = addComment(t.ctx, { id, text: 'hi' });

			expect(JSON.parse(JSON.stringify(result.events[0]!.payload))).not.toHaveProperty('author');
		});

		it('refuses a blank text with no event and no write', () => {
			expect(() => addComment(t.ctx, { id, text: '  ' })).toThrow(InvalidCommentTextError);
			expect(t.ctx.store.get(id).comments).toBeUndefined();
		});

		it('unknown task: TaskNotFoundError', () => {
			expect(() => addComment(t.ctx, { id: 'zzzz', text: 'x' })).toThrow(TaskNotFoundError);
		});
	});

	describe('editComment', () => {
		it('fires onTaskCommentEdited with the old and the new full text', () => {
			const { comment } = addComment(t.ctx, { id, text: 'old' });

			const result = editComment(t.ctx, { id, commentId: comment.id, text: 'new' });

			expect(result.comment.text).toBe('new');
			expect(result.comment.editedAt).toBeDefined();
			expect(result.events).toEqual([
				{
					name: 'onTaskCommentEdited',
					payload: { taskId: id, commentId: comment.id, oldText: 'old', newText: 'new', ...env() },
				},
			]);
		});

		it('fires nothing when the text is unchanged', () => {
			const { comment } = addComment(t.ctx, { id, text: 'same' });

			const result = editComment(t.ctx, { id, commentId: comment.id, text: ' same ' });

			expect(result.events).toEqual([]);
			expect(result.comment.editedAt).toBeUndefined();
		});

		it('an unknown comment id throws CommentNotFoundError (hint lists the valid ids)', () => {
			const { comment } = addComment(t.ctx, { id, text: 'x' });

			expect(() => editComment(t.ctx, { id, commentId: 'nope00', text: 'y' })).toThrow(CommentNotFoundError);
			expect(describeError(new CommentNotFoundError(id, 'nope00', [comment.id])).hint).toContain(comment.id);
		});
	});

	describe('removeComment', () => {
		it('fires onTaskCommentRemoved', () => {
			const { comment } = addComment(t.ctx, { id, text: 'x' });

			const result = removeComment(t.ctx, { id, commentId: comment.id });

			expect(result.events).toEqual([
				{ name: 'onTaskCommentRemoved', payload: { taskId: id, commentId: comment.id, ...env() } },
			]);
			expect(t.ctx.store.get(id).comments).toBeUndefined();
		});

		it('an unknown comment id throws and fires nothing', () => {
			expect(() => removeComment(t.ctx, { id, commentId: 'nope00' })).toThrow(CommentNotFoundError);
		});
	});

	describe('listComments', () => {
		it('lists the comments of a task, oldest first, and the empty list for none', () => {
			expect(listComments(t.ctx, { id })).toEqual({ id, comments: [] });
			const a = addComment(t.ctx, { id, text: 'a' }).comment;
			const b = addComment(t.ctx, { id, text: 'b' }).comment;

			expect(listComments(t.ctx, { id: id.slice(0, 4) })).toEqual({ id, comments: [a, b] });
		});
	});

	describe('describeError', () => {
		it('classifies the two comment errors: invalid text, comment not found', () => {
			const invalid = describeError(new InvalidCommentTextError('a comment cannot be blank', 'Give the text.'));
			expect(invalid).toEqual({
				kind: 'invalid',
				message: 'a comment cannot be blank',
				hint: 'Give the text.',
				details: {},
			});

			const missing = describeError(new CommentNotFoundError(id, 'nope00', ['aaaaaa', 'bbbbbb']));
			expect(missing.kind).toBe('not-found');
			expect(missing.message).toContain('nope00');
			expect(missing.hint).toContain('aaaaaa, bbbbbb');
			expect(missing.details).toEqual({ commentId: 'nope00', validIds: ['aaaaaa', 'bbbbbb'] });
		});
	});
});
