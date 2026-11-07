import { TaskNotFoundError } from '@wadeck-app/task-core';

import { InvalidTaskTextError } from './errors.js';
import { setTaskText } from './setTaskText.js';
import { createTestContext, type TestContext } from './testHelpers.js';

describe('setTaskText', () => {
	let t: TestContext;
	let id: string;
	beforeEach(() => {
		t = createTestContext();
		id = t.ctx.store.create('Old title', 'backlog').id;
	});
	afterEach(() => t.cleanup());

	const env = () => ({ taskProjectName: 'proj', taskProjectPath: t.rootDir });

	it('changes the title (prefix accepted), rewrites the index and fires onTaskTextChanged with the old title', () => {
		const result = setTaskText(t.ctx, { id: id.slice(0, 4), title: 'New title' });

		expect(result.task.title).toBe('New title');
		expect(t.ctx.store.list()[0]?.title).toBe('New title');
		expect(result.events).toEqual([
			{
				name: 'onTaskTextChanged',
				payload: { taskId: id, field: 'title', oldValue: 'Old title', newValue: 'New title', ...env() },
			},
		]);
	});

	it('sets a description: oldValue is absent when the task had none, present afterwards', () => {
		const first = setTaskText(t.ctx, { id, description: 'Body' });
		expect(first.task.description).toBe('Body');
		expect(first.events).toEqual([
			{ name: 'onTaskTextChanged', payload: { taskId: id, field: 'description', newValue: 'Body', ...env() } },
		]);
		expect(JSON.parse(JSON.stringify(first.events[0]!.payload))).not.toHaveProperty('oldValue');

		const second = setTaskText(t.ctx, { id, description: 'Other' });
		expect(second.events[0]!.payload).toMatchObject({ field: 'description', oldValue: 'Body', newValue: 'Other' });
	});

	it('fires nothing and writes nothing when the text is unchanged', () => {
		const before = t.ctx.store.get(id).updatedAt;

		expect(setTaskText(t.ctx, { id, title: 'Old title' }).events).toEqual([]);
		// A description equal to the title is the same body as having none.
		expect(setTaskText(t.ctx, { id, description: 'Old title' }).events).toEqual([]);
		expect(t.ctx.store.get(id).updatedAt).toBe(before);
	});

	it('changes both in one call: title event first, then description event', () => {
		const result = setTaskText(t.ctx, { id, title: 'T2', description: 'D2' });

		expect(result.events.map(event => (event.payload as { field: string }).field)).toEqual([
			'title',
			'description',
		]);
		expect(t.ctx.store.get(id)).toMatchObject({ title: 'T2', description: 'D2' });
	});

	it('an old file holding the title twice: a new title leaves the old text as description, and fires one title event', () => {
		const old = t.ctx.store.create('Legacy', 'backlog', undefined, 'Legacy');
		expect(old).not.toHaveProperty('description');

		const result = setTaskText(t.ctx, { id: old.id, title: 'Renamed' });

		expect(result.events).toHaveLength(1);
		expect(t.ctx.store.get(old.id).title).toBe('Renamed');
	});

	it('clearing the description (empty text) fires an event with an empty newValue, and the body is the title again', () => {
		setTaskText(t.ctx, { id, description: 'Body' });

		const result = setTaskText(t.ctx, { id, description: '' });

		expect(result.events[0]!.payload).toMatchObject({ field: 'description', oldValue: 'Body', newValue: '' });
		expect(t.ctx.store.get(id)).not.toHaveProperty('description');
	});

	it('rejects a blank title and a call with nothing to change, writing nothing', () => {
		expect(() => setTaskText(t.ctx, { id, title: '  ' })).toThrow(InvalidTaskTextError);
		expect(() => setTaskText(t.ctx, { id })).toThrow(InvalidTaskTextError);
		expect(t.ctx.store.get(id).title).toBe('Old title');
	});

	it('throws TaskNotFoundError for an unknown id', () => {
		expect(() => setTaskText(t.ctx, { id: 'zzzz', title: 'x' })).toThrow(TaskNotFoundError);
	});
});
