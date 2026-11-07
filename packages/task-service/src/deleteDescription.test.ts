import { createTask } from './createTask.js';
import { executeDelete, planDelete } from './deleteTasks.js';
import { createTestContext, type TestContext } from './testHelpers.js';

describe('onTaskDeleted description', () => {
	let t: TestContext;
	beforeEach(() => {
		t = createTestContext();
	});
	afterEach(() => t.cleanup());

	const del = (id: string) => executeDelete(t.ctx, planDelete(t.ctx, { selector: { kind: 'ids', ids: [id] } }));

	it('is the full text of a task that has a separate description, like onTaskCreated', () => {
		const text = `Headline\n\n${'long body '.repeat(20)}`;
		const { task } = createTask(t.ctx, { description: text });
		expect(task.title).toBe('Headline');

		expect(del(task.id).events[0]!.payload).toMatchObject({ description: text });
	});

	it('is the title for a task without description of its own', () => {
		const { task } = createTask(t.ctx, { title: 'Short' });

		expect(del(task.id).events[0]!.payload).toMatchObject({ description: 'Short' });
	});
});
