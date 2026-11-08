import { createTask } from './createTask.js';
import { executeDelete, planDelete } from './deleteTasks.js';
import { createTestContext, type TestContext } from './testHelpers.js';

describe('onTaskDeleted description', () => {
	let t: TestContext;
	beforeEach(() => {
		t = createTestContext();
	});
	afterEach(() => t.cleanup());

	const del = async (id: string) =>
		await executeDelete(t.ctx, await planDelete(t.ctx, { selector: { kind: 'ids', ids: [id] } }));

	it('is the full text of a task that has a separate description, like onTaskCreated', async () => {
		const text = `Headline\n\n${'long body '.repeat(20)}`;
		const { task } = await createTask(t.ctx, { description: text });
		expect(task.title).toBe('Headline');

		expect((await del(task.id)).events[0]!.payload).toMatchObject({ description: text });
	});

	it('is the title for a task without description of its own', async () => {
		const { task } = await createTask(t.ctx, { title: 'Short' });

		expect((await del(task.id)).events[0]!.payload).toMatchObject({ description: 'Short' });
	});
});
