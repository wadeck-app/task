import { TaskNotFoundError } from '@wadeck-app/task-core';

import { setMeta, setType, unsetMeta, unsetType } from './taskFields.js';
import { createTestContext, type TestContext } from './testHelpers.js';

describe('unsetMeta and unsetType', () => {
	let t: TestContext;
	let id: string;
	beforeEach(async () => {
		t = createTestContext();
		id = (await t.ctx.store.create({ title: 'a', status: 'backlog' })).id;
	});
	afterEach(() => t.cleanup());

	const env = () => ({ taskProjectName: 'proj', taskProjectPath: t.rootDir });

	it('unsetMeta removes the key and fires onTaskMetaChanged with oldValue and NO newValue', async () => {
		await setMeta(t.ctx, { id, key: 'owner', value: 'ann' });
		await setMeta(t.ctx, { id, key: 'team', value: 'x' });

		const result = await unsetMeta(t.ctx, { id: id.slice(0, 4), key: 'owner' });

		expect(result.task.meta).toEqual({ team: 'x' });
		expect(result.events).toEqual([
			{ name: 'onTaskMetaChanged', payload: { taskId: id, key: 'owner', oldValue: 'ann', ...env() } },
		]);
		expect(JSON.parse(JSON.stringify(result.events[0]!.payload))).not.toHaveProperty('newValue');
	});

	it('unsetMeta keeps the "" of an empty value as oldValue, and fires nothing for an absent key', async () => {
		await setMeta(t.ctx, { id, key: 'blank', value: '' });

		expect((await unsetMeta(t.ctx, { id, key: 'blank' })).events[0]!.payload).toMatchObject({
			key: 'blank',
			oldValue: '',
		});
		expect((await unsetMeta(t.ctx, { id, key: 'blank' })).events).toEqual([]);
		expect((await unsetMeta(t.ctx, { id, key: 'constructor' })).events).toEqual([]);
	});

	it('unsetType clears the type and fires onTaskTypeChanged with oldType and NO newType', async () => {
		await setType(t.ctx, { id, type: 'bug' });

		const result = await unsetType(t.ctx, { id: id.slice(0, 4) });

		expect(result.task.type).toBeUndefined();
		expect(await t.ctx.store.get(id)).not.toHaveProperty('type');
		expect(result.events).toEqual([
			{ name: 'onTaskTypeChanged', payload: { taskId: id, oldType: 'bug', ...env() } },
		]);
		expect(JSON.parse(JSON.stringify(result.events[0]!.payload))).not.toHaveProperty('newType');
	});

	it('unsetType on a task without type fires nothing', async () => {
		expect((await unsetType(t.ctx, { id })).events).toEqual([]);
	});

	it('both throw TaskNotFoundError for an unknown id', async () => {
		await expect(unsetMeta(t.ctx, { id: 'zzzz', key: 'k' })).rejects.toThrow(TaskNotFoundError);
		await expect(unsetType(t.ctx, { id: 'zzzz' })).rejects.toThrow(TaskNotFoundError);
	});
});
