import { addComment, editComment, removeComment } from './comments.js';
import { setStatus } from './setStatus.js';
import { getTaskActivity } from './taskActivity.js';
import { createTestContext, type TestContext } from './testHelpers.js';

// Comments in the merged feed: the comment itself is a row with its FULL text; edits and removals are rows of their own.
describe('getTaskActivity with comments', () => {
	let t: TestContext;
	let id: string;
	beforeEach(async () => {
		t = createTestContext();
		id = (await t.ctx.store.create({ title: 'Fix login', status: 'backlog' })).id;
	});
	afterEach(() => t.cleanup());

	const tick = () => new Promise(resolve => setTimeout(resolve, 5));

	it('a comment is a row of kind comment with the full text, its author, and the comment id', async () => {
		const long = `${'long words '.repeat(100)}end\nsecond line`;
		await tick();
		const { comment } = await addComment(t.ctx, { id, text: long, author: 'alice' });

		const row = (await getTaskActivity(t.ctx, { id })).rows[0]!;

		expect(row).toMatchObject({
			id: `comment-${comment.id}`,
			source: 'comments',
			kind: 'comment',
			icon: 'message-square',
			tone: 'neutral',
			text: long,
			actor: 'alice',
			at: comment.at,
			commentId: comment.id,
		});
		expect(row).not.toHaveProperty('editedAt');
	});

	it('a comment without author has no actor key', async () => {
		await addComment(t.ctx, { id, text: 'x' });

		expect((await getTaskActivity(t.ctx, { id })).rows[0]).not.toHaveProperty('actor');
	});

	it('comments are merged with the status history by instant, newest first', async () => {
		await tick();
		await setStatus(t.ctx, { id, status: 'in-progress' });
		await tick();
		await addComment(t.ctx, { id, text: 'after the move' });

		expect((await getTaskActivity(t.ctx, { id })).rows.map(row => row.kind)).toEqual([
			'comment',
			'status',
			'created',
		]);
	});

	it('an edited comment shows its current text with editedAt, plus a comment-edited row with previews', async () => {
		const { comment } = await addComment(t.ctx, { id, text: 'old words' });
		await tick();
		const edited = (await editComment(t.ctx, { id, commentId: comment.id, text: 'new words' })).comment;

		const rows = (await getTaskActivity(t.ctx, { id })).rows;

		expect(rows.map(row => row.kind)).toEqual(['comment-edited', 'comment', 'created']);
		expect(rows[0]).toMatchObject({
			source: 'activity',
			icon: 'pencil',
			text: `Comment ${comment.id} edited`,
			details: { oldValue: 'old words', newValue: 'new words' },
		});
		expect(rows[1]).toMatchObject({ text: 'new words', editedAt: edited.editedAt });
	});

	it('a removed comment leaves a comment-removed row and its own row disappears', async () => {
		const { comment } = await addComment(t.ctx, { id, text: 'gone soon' });
		await tick();
		await removeComment(t.ctx, { id, commentId: comment.id });

		const rows = (await getTaskActivity(t.ctx, { id })).rows;

		expect(rows.map(row => row.kind)).toEqual(['comment-removed', 'created']);
		expect(rows[0]).toMatchObject({
			source: 'activity',
			icon: 'message-square-x',
			text: `Comment ${comment.id} removed`,
			details: { oldValue: 'gone soon' },
		});
	});
});
