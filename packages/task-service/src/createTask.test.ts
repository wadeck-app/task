import { TaskNotFoundError } from '@wadeck-app/task-core';

import { createTask } from './createTask.js';
import { InvalidTaskTextError } from './errors.js';
import { HEADLINE_MAX_LENGTH } from './taskText.js';
import { createTestContext, type TestContext } from './testHelpers.js';

describe('createTask', () => {
	let t: TestContext;
	beforeEach(() => {
		t = createTestContext({ defaultStatus: 'in-progress' });
	});
	afterEach(() => t.cleanup());

	it('creates the task with the configured default status', () => {
		const { task } = createTask(t.ctx, { description: 'write docs' });

		expect(task.title).toBe('write docs');
		expect(task.description).toBeUndefined();
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

	describe('title and description (D1, D2)', () => {
		const longText = `Refactor the importer

${'Details of the work to do. '.repeat(8)}`;

		it('stores a short single text as the title only, with no description key', () => {
			const { task } = createTask(t.ctx, { title: 'Fix login' });

			expect(task.title).toBe('Fix login');
			expect(task).not.toHaveProperty('description');
			expect(t.ctx.store.list()[0]?.title).toBe('Fix login');
		});

		it('stores both when given explicitly, even when the title is long (an explicit description wins)', () => {
			const longTitle = 'T'.repeat(HEADLINE_MAX_LENGTH + 20);

			const { task } = createTask(t.ctx, { title: longTitle, description: 'Body' });

			expect(task.title).toBe(longTitle);
			expect(task.description).toBe('Body');
		});

		it('drops an explicit description equal to the title', () => {
			const { task } = createTask(t.ctx, { title: 'Same', description: 'Same' });

			expect(task).not.toHaveProperty('description');
		});

		it('splits a long single text given as title: headline as title, full text as description', () => {
			const { task } = createTask(t.ctx, { title: longText });

			expect(task.title).toBe('Refactor the importer');
			expect(task.description).toBe(longText);
			expect(t.ctx.store.list()[0]?.title).toBe('Refactor the importer');
		});

		it('splits a long text given as description alone (the legacy input of the module and the flows)', () => {
			const { task } = createTask(t.ctx, { description: longText });

			expect(task.title).toBe('Refactor the importer');
			expect(task.description).toBe(longText);
		});

		it('onTaskCreated carries the FULL text as description after a split, and the description of an explicit pair', () => {
			const split = createTask(t.ctx, { description: longText });
			expect(split.events[0]!.payload).toMatchObject({ description: longText });

			const pair = createTask(t.ctx, { title: 'Short', description: 'Long body' });
			expect(pair.events[0]!.payload).toMatchObject({ description: 'Long body' });
		});

		it('rejects a missing or blank title and description, creating nothing', () => {
			expect(() => createTask(t.ctx, {})).toThrow(InvalidTaskTextError);
			expect(() => createTask(t.ctx, { title: '   ' })).toThrow(InvalidTaskTextError);
			expect(() => createTask(t.ctx, { title: '', description: ' ' })).toThrow(InvalidTaskTextError);
			expect(t.ctx.store.list()).toEqual([]);
		});

		it('a description alone is also the title when short', () => {
			const { task } = createTask(t.ctx, { description: 'write docs' });

			expect(task.title).toBe('write docs');
			expect(task).not.toHaveProperty('description');
		});
	});
});
