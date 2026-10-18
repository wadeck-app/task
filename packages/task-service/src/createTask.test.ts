import { TaskNotFoundError } from '@wadeck-app/task-core';

import { createTask } from './createTask.js';
import { createTestContext, type TestContext } from './testHelpers.js';

describe('createTask', () => {
	let t: TestContext;
	beforeEach(() => {
		t = createTestContext({ defaultStatus: 'in-progress' });
	});
	afterEach(() => t.cleanup());

	it('creates the task with the configured default status', () => {
		const { task } = createTask(t.ctx, { description: 'write docs' });

		expect(task.description).toBe('write docs');
		expect(task.status).toBe('in-progress');
		expect(t.ctx.store.get(task.id).status).toBe('in-progress');
	});

	it('returns exactly one onTaskCreated event with the CLI payload, and does not deliver it', () => {
		const { task, events } = createTask(t.ctx, { description: 'write docs' });

		expect(events).toEqual([
			{
				name: 'onTaskCreated',
				payload: {
					taskId: task.id,
					status: 'in-progress',
					description: 'write docs',
					parentId: undefined,
					type: undefined,
					labels: [],
					taskProjectName: 'proj',
					taskProjectPath: t.rootDir,
				},
			},
		]);
	});

	it('resolves the parent by prefix and puts the full parent id in the event', () => {
		const parent = createTask(t.ctx, { description: 'parent' }).task;

		const { task, events } = createTask(t.ctx, { description: 'child', parent: parent.id.slice(0, 4) });

		expect(task.parentId).toBe(parent.id);
		expect(events[0]!.payload).toMatchObject({ parentId: parent.id });
	});

	it('throws TaskNotFoundError for an unknown parent and creates nothing', () => {
		expect(() => createTask(t.ctx, { description: 'orphan', parent: 'zzzz' })).toThrow(TaskNotFoundError);
		expect(t.ctx.store.list()).toEqual([]);
	});
});
