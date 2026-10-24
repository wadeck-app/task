import { TaskNotFoundError } from '@wadeck-app/task-core';

import { InvalidTaskTypeError } from './errors.js';
import { addLabel, removeLabel, setMeta, setType } from './taskFields.js';
import { createTestContext, type TestContext } from './testHelpers.js';

describe('setType', () => {
	let t: TestContext;
	afterEach(() => t.cleanup());

	it('accepts any string when no types are configured', () => {
		t = createTestContext();
		const task = t.ctx.store.create('a', 'backlog');

		expect(setType(t.ctx, { id: task.id.slice(0, 4), type: 'whatever' }).task.type).toBe('whatever');
		expect(t.ctx.store.get(task.id).type).toBe('whatever');
	});

	it('accepts a configured type', () => {
		t = createTestContext({ types: ['bug', 'feature'] });
		const task = t.ctx.store.create('a', 'backlog');

		expect(setType(t.ctx, { id: task.id, type: 'bug' }).task.type).toBe('bug');
	});

	it('throws InvalidTaskTypeError with the strategy message for an unconfigured type, changing nothing', () => {
		t = createTestContext({ types: ['bug', 'feature'] });
		const task = t.ctx.store.create('a', 'backlog');

		let caught: unknown;
		try {
			setType(t.ctx, { id: task.id, type: 'chore' });
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(InvalidTaskTypeError);
		expect((caught as Error).message).toBe('unknown type "chore". Valid types: bug, feature');
		expect(t.ctx.store.get(task.id).type).toBeUndefined();
	});

	it('throws TaskNotFoundError for an unknown id', () => {
		t = createTestContext();
		expect(() => setType(t.ctx, { id: 'zzzz', type: 'x' })).toThrow(TaskNotFoundError);
	});
});

describe('setType events', () => {
	let t: TestContext;
	beforeEach(() => {
		t = createTestContext();
	});
	afterEach(() => t.cleanup());

	it('produces onTaskTypeChanged with oldType and newType and the project, delivering nothing itself', () => {
		const task = t.ctx.store.create('a', 'backlog');
		t.ctx.store.setType(task.id, 'bug');

		const result = setType(t.ctx, { id: task.id.slice(0, 4), type: 'feature' });

		expect(result.events).toEqual([
			{
				name: 'onTaskTypeChanged',
				payload: {
					taskId: task.id,
					oldType: 'bug',
					newType: 'feature',
					taskProjectName: 'proj',
					taskProjectPath: t.rootDir,
				},
			},
		]);
	});

	it('leaves oldType undefined (absent on the wire) when the task had no type', () => {
		const task = t.ctx.store.create('a', 'backlog');

		const [event] = setType(t.ctx, { id: task.id, type: 'bug' }).events;

		expect(event!.payload).toMatchObject({ newType: 'bug' });
		expect(JSON.parse(JSON.stringify(event!.payload))).not.toHaveProperty('oldType');
	});

	it('produces no event when the type is unchanged', () => {
		const task = t.ctx.store.create('a', 'backlog');
		setType(t.ctx, { id: task.id, type: 'bug' });

		const result = setType(t.ctx, { id: task.id, type: 'bug' });

		expect(result.events).toEqual([]);
		expect(result.task.type).toBe('bug');
	});

	it('produces no event when the type is refused', () => {
		t.cleanup();
		t = createTestContext({ types: ['bug'] });
		const task = t.ctx.store.create('a', 'backlog');

		expect(() => setType(t.ctx, { id: task.id, type: 'chore' })).toThrow(InvalidTaskTypeError);
	});
});

describe('labels and meta', () => {
	let t: TestContext;
	let id: string;
	beforeEach(() => {
		t = createTestContext();
		id = t.ctx.store.create('a', 'backlog').id;
	});
	afterEach(() => t.cleanup());

	it('addLabel / removeLabel resolve the prefix and return the updated task', () => {
		expect(addLabel(t.ctx, { id: id.slice(0, 4), label: 'urgent' }).task.labels).toEqual(['urgent']);
		expect(removeLabel(t.ctx, { id, label: 'urgent' }).task.labels ?? []).toEqual([]);
	});

	it('addLabel produces onTaskLabelAdded, and nothing when the task already has the label', () => {
		const added = addLabel(t.ctx, { id: id.slice(0, 4), label: 'urgent' });
		expect(added.events).toEqual([
			{
				name: 'onTaskLabelAdded',
				payload: { taskId: id, label: 'urgent', taskProjectName: 'proj', taskProjectPath: t.rootDir },
			},
		]);

		const again = addLabel(t.ctx, { id, label: 'urgent' });
		expect(again.events).toEqual([]);
		expect(again.task.labels).toEqual(['urgent']);
	});

	it('removeLabel produces onTaskLabelRemoved, and nothing when the task does not have the label', () => {
		addLabel(t.ctx, { id, label: 'urgent' });

		const removed = removeLabel(t.ctx, { id: id.slice(0, 4), label: 'urgent' });
		expect(removed.events).toEqual([
			{
				name: 'onTaskLabelRemoved',
				payload: { taskId: id, label: 'urgent', taskProjectName: 'proj', taskProjectPath: t.rootDir },
			},
		]);

		expect(removeLabel(t.ctx, { id, label: 'urgent' }).events).toEqual([]);
		expect(removeLabel(t.ctx, { id, label: 'never-there' }).events).toEqual([]);
	});

	it('setMeta stores the key/value', () => {
		expect(setMeta(t.ctx, { id, key: 'k', value: 'v' }).task.meta).toEqual({ k: 'v' });
	});

	it('setMeta produces onTaskMetaChanged: oldValue absent for a new key, present (even empty) for an existing one', () => {
		const first = setMeta(t.ctx, { id: id.slice(0, 4), key: 'owner', value: 'ann' });
		expect(first.events).toEqual([
			{
				name: 'onTaskMetaChanged',
				payload: {
					taskId: id,
					key: 'owner',
					oldValue: undefined,
					newValue: 'ann',
					taskProjectName: 'proj',
					taskProjectPath: t.rootDir,
				},
			},
		]);
		expect(JSON.parse(JSON.stringify(first.events[0]!.payload))).not.toHaveProperty('oldValue');

		setMeta(t.ctx, { id, key: 'empty', value: '' });
		const second = setMeta(t.ctx, { id, key: 'empty', value: 'x' });
		expect(second.events[0]!.payload).toMatchObject({ oldValue: '', newValue: 'x' });
	});

	it('setMeta produces no event when the value is unchanged (an empty value for a new key is a change)', () => {
		setMeta(t.ctx, { id, key: 'owner', value: 'ann' });
		const again = setMeta(t.ctx, { id, key: 'owner', value: 'ann' });
		expect(again.events).toEqual([]);
		expect(again.task.meta).toEqual({ owner: 'ann' });

		expect(setMeta(t.ctx, { id, key: 'blank', value: '' }).events).toHaveLength(1);
		expect(setMeta(t.ctx, { id, key: 'blank', value: '' }).events).toEqual([]);
	});

	it('all throw TaskNotFoundError for an unknown id', () => {
		expect(() => addLabel(t.ctx, { id: 'zzzz', label: 'x' })).toThrow(TaskNotFoundError);
		expect(() => removeLabel(t.ctx, { id: 'zzzz', label: 'x' })).toThrow(TaskNotFoundError);
		expect(() => setMeta(t.ctx, { id: 'zzzz', key: 'k', value: 'v' })).toThrow(TaskNotFoundError);
	});
});
