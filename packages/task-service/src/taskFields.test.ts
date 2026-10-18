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

		expect(setType(t.ctx, { id: task.id.slice(0, 4), type: 'whatever' }).type).toBe('whatever');
		expect(t.ctx.store.get(task.id).type).toBe('whatever');
	});

	it('accepts a configured type', () => {
		t = createTestContext({ types: ['bug', 'feature'] });
		const task = t.ctx.store.create('a', 'backlog');

		expect(setType(t.ctx, { id: task.id, type: 'bug' }).type).toBe('bug');
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

describe('labels and meta', () => {
	let t: TestContext;
	let id: string;
	beforeEach(() => {
		t = createTestContext();
		id = t.ctx.store.create('a', 'backlog').id;
	});
	afterEach(() => t.cleanup());

	it('addLabel / removeLabel resolve the prefix and return the updated task', () => {
		expect(addLabel(t.ctx, { id: id.slice(0, 4), label: 'urgent' }).labels).toEqual(['urgent']);
		expect(removeLabel(t.ctx, { id, label: 'urgent' }).labels ?? []).toEqual([]);
	});

	it('setMeta stores the key/value', () => {
		expect(setMeta(t.ctx, { id, key: 'k', value: 'v' }).meta).toEqual({ k: 'v' });
	});

	it('all throw TaskNotFoundError for an unknown id', () => {
		expect(() => addLabel(t.ctx, { id: 'zzzz', label: 'x' })).toThrow(TaskNotFoundError);
		expect(() => removeLabel(t.ctx, { id: 'zzzz', label: 'x' })).toThrow(TaskNotFoundError);
		expect(() => setMeta(t.ctx, { id: 'zzzz', key: 'k', value: 'v' })).toThrow(TaskNotFoundError);
	});
});
