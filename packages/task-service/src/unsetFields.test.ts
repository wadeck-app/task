import { TaskNotFoundError } from '@wadeck-app/task-core';

import { setMeta, setType, unsetMeta, unsetType } from './taskFields.js';
import { createTestContext, type TestContext } from './testHelpers.js';

describe('unsetMeta and unsetType', () => {
	let t: TestContext;
	let id: string;
	beforeEach(() => {
		t = createTestContext();
		id = t.ctx.store.create('a', 'backlog').id;
	});
	afterEach(() => t.cleanup());

	const env = () => ({ taskProjectName: 'proj', taskProjectPath: t.rootDir });

	it('unsetMeta removes the key and fires onTaskMetaChanged with oldValue and NO newValue', () => {
		setMeta(t.ctx, { id, key: 'owner', value: 'ann' });
		setMeta(t.ctx, { id, key: 'team', value: 'x' });

		const result = unsetMeta(t.ctx, { id: id.slice(0, 4), key: 'owner' });

		expect(result.task.meta).toEqual({ team: 'x' });
		expect(result.events).toEqual([
			{ name: 'onTaskMetaChanged', payload: { taskId: id, key: 'owner', oldValue: 'ann', ...env() } },
		]);
		expect(JSON.parse(JSON.stringify(result.events[0]!.payload))).not.toHaveProperty('newValue');
	});

	it('unsetMeta keeps the "" of an empty value as oldValue, and fires nothing for an absent key', () => {
		setMeta(t.ctx, { id, key: 'blank', value: '' });

		expect(unsetMeta(t.ctx, { id, key: 'blank' }).events[0]!.payload).toMatchObject({ key: 'blank', oldValue: '' });
		expect(unsetMeta(t.ctx, { id, key: 'blank' }).events).toEqual([]);
		expect(unsetMeta(t.ctx, { id, key: 'constructor' }).events).toEqual([]);
	});

	it('unsetType clears the type and fires onTaskTypeChanged with oldType and NO newType', () => {
		setType(t.ctx, { id, type: 'bug' });

		const result = unsetType(t.ctx, { id: id.slice(0, 4) });

		expect(result.task.type).toBeUndefined();
		expect(t.ctx.store.get(id)).not.toHaveProperty('type');
		expect(result.events).toEqual([
			{ name: 'onTaskTypeChanged', payload: { taskId: id, oldType: 'bug', ...env() } },
		]);
		expect(JSON.parse(JSON.stringify(result.events[0]!.payload))).not.toHaveProperty('newType');
	});

	it('unsetType on a task without type fires nothing', () => {
		expect(unsetType(t.ctx, { id }).events).toEqual([]);
	});

	it('both throw TaskNotFoundError for an unknown id', () => {
		expect(() => unsetMeta(t.ctx, { id: 'zzzz', key: 'k' })).toThrow(TaskNotFoundError);
		expect(() => unsetType(t.ctx, { id: 'zzzz' })).toThrow(TaskNotFoundError);
	});
});
