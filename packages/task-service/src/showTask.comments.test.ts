import { addComment } from './comments.js';
import { showTask } from './showTask.js';
import { createTestContext, type TestContext } from './testHelpers.js';

describe('showTask: comments', () => {
	let t: TestContext;
	let id: string;
	beforeEach(async () => {
		t = createTestContext();
		id = (await t.ctx.store.create({ title: 'Title', status: 'backlog' })).id;
	});
	afterEach(() => t.cleanup());

	it('commentCount is 0 for a task without comments, and no comments key appears', async () => {
		const detail = await showTask(t.ctx, { id });

		expect(detail['commentCount']).toBe(0);
		expect(detail).not.toHaveProperty('comments');
	});

	it('commentCount counts the comments and the record keeps its comments', async () => {
		await addComment(t.ctx, { id, text: 'a' });
		await addComment(t.ctx, { id, text: 'b' });

		const detail = await showTask(t.ctx, { id });

		expect(detail['commentCount']).toBe(2);
		expect(detail['comments']).toHaveLength(2);
	});
});
