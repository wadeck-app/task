import { TaskNotFoundError } from '@wadeck-app/task-core';

import { InvalidTaskTypeError } from './errors.js';
import { addLabel, removeLabel, setMeta, setType } from './taskFields.js';
import { createTestContext, type TestContext } from './testHelpers.js';

describe('setType', () => {
	let t: TestContext;
	afterEach(() => t.cleanup());

	it('accepts any string when no types are configured', async () => {
		t = createTestContext();
		const task = await t.ctx.store.create({ title: 'a', status: 'backlog' });

		expect((await setType(t.ctx, { id: task.id.slice(0, 4), type: 'whatever' })).task.type).toBe('whatever');
		expect((await t.ctx.store.get(task.id)).type).toBe('whatever');
	});

	it('accepts a configured type', async () => {
		t = createTestContext({ types: ['bug', 'feature'] });
		const task = await t.ctx.store.create({ title: 'a', status: 'backlog' });

		expect((await setType(t.ctx, { id: task.id, type: 'bug' })).task.type).toBe('bug');
	});

	it('throws InvalidTaskTypeError with the strategy message for an unconfigured type, changing nothing', async () => {
		t = createTestContext({ types: ['bug', 'feature'] });
		const task = await t.ctx.store.create({ title: 'a', status: 'backlog' });

		let caught: unknown;
		try {
			await setType(t.ctx, { id: task.id, type: 'chore' });
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(InvalidTaskTypeError);
		expect((caught as Error).message).toBe('unknown type "chore". Valid types: bug, feature');
		expect((await t.ctx.store.get(task.id)).type).toBeUndefined();
	});

	it('throws TaskNotFoundError for an unknown id', async () => {
		t = createTestContext();
		await expect(setType(t.ctx, { id: 'zzzz', type: 'x' })).rejects.toThrow(TaskNotFoundError);
	});
});

describe('setType events', () => {
	let t: TestContext;
	beforeEach(() => {
		t = createTestContext();
	});
	afterEach(() => t.cleanup());

	it('produces onTaskTypeChanged with oldType and newType and the project, delivering nothing itself', async () => {
		const task = await t.ctx.store.create({ title: 'a', status: 'backlog' });
		await t.ctx.store.setType(task.id, 'bug');

		const result = await setType(t.ctx, { id: task.id.slice(0, 4), type: 'feature' });

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

	it('leaves oldType undefined (absent on the wire) when the task had no type', async () => {
		const task = await t.ctx.store.create({ title: 'a', status: 'backlog' });

		const [event] = (await setType(t.ctx, { id: task.id, type: 'bug' })).events;

		expect(event!.payload).toMatchObject({ newType: 'bug' });
		expect(JSON.parse(JSON.stringify(event!.payload))).not.toHaveProperty('oldType');
	});

	it('produces no event when the type is unchanged', async () => {
		const task = await t.ctx.store.create({ title: 'a', status: 'backlog' });
		await setType(t.ctx, { id: task.id, type: 'bug' });

		const result = await setType(t.ctx, { id: task.id, type: 'bug' });

		expect(result.events).toEqual([]);
		expect(result.task.type).toBe('bug');
	});

	it('produces no event when the type is refused', async () => {
		t.cleanup();
		t = createTestContext({ types: ['bug'] });
		const task = await t.ctx.store.create({ title: 'a', status: 'backlog' });

		await expect(setType(t.ctx, { id: task.id, type: 'chore' })).rejects.toThrow(InvalidTaskTypeError);
	});
});

describe('labels and meta', () => {
	let t: TestContext;
	let id: string;
	beforeEach(async () => {
		t = createTestContext();
		id = (await t.ctx.store.create({ title: 'a', status: 'backlog' })).id;
	});
	afterEach(() => t.cleanup());

	it('addLabel / removeLabel resolve the prefix and return the updated task', async () => {
		expect((await addLabel(t.ctx, { id: id.slice(0, 4), label: 'urgent' })).task.labels).toEqual(['urgent']);
		expect((await removeLabel(t.ctx, { id, label: 'urgent' })).task.labels ?? []).toEqual([]);
	});

	it('addLabel produces onTaskLabelAdded, and nothing when the task already has the label', async () => {
		const added = await addLabel(t.ctx, { id: id.slice(0, 4), label: 'urgent' });
		expect(added.events).toEqual([
			{
				name: 'onTaskLabelAdded',
				payload: { taskId: id, label: 'urgent', taskProjectName: 'proj', taskProjectPath: t.rootDir },
			},
		]);

		const again = await addLabel(t.ctx, { id, label: 'urgent' });
		expect(again.events).toEqual([]);
		expect(again.task.labels).toEqual(['urgent']);
	});

	it('removeLabel produces onTaskLabelRemoved, and nothing when the task does not have the label', async () => {
		await addLabel(t.ctx, { id, label: 'urgent' });

		const removed = await removeLabel(t.ctx, { id: id.slice(0, 4), label: 'urgent' });
		expect(removed.events).toEqual([
			{
				name: 'onTaskLabelRemoved',
				payload: { taskId: id, label: 'urgent', taskProjectName: 'proj', taskProjectPath: t.rootDir },
			},
		]);

		expect((await removeLabel(t.ctx, { id, label: 'urgent' })).events).toEqual([]);
		expect((await removeLabel(t.ctx, { id, label: 'never-there' })).events).toEqual([]);
	});

	it('setMeta stores the key/value', async () => {
		expect((await setMeta(t.ctx, { id, key: 'k', value: 'v' })).task.meta).toEqual({ k: 'v' });
	});

	it('setMeta produces onTaskMetaChanged: oldValue absent for a new key, present (even empty) for an existing one', async () => {
		const first = await setMeta(t.ctx, { id: id.slice(0, 4), key: 'owner', value: 'ann' });
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

		await setMeta(t.ctx, { id, key: 'empty', value: '' });
		const second = await setMeta(t.ctx, { id, key: 'empty', value: 'x' });
		expect(second.events[0]!.payload).toMatchObject({ oldValue: '', newValue: 'x' });
	});

	it('setMeta produces no event when the value is unchanged (an empty value for a new key is a change)', async () => {
		await setMeta(t.ctx, { id, key: 'owner', value: 'ann' });
		const again = await setMeta(t.ctx, { id, key: 'owner', value: 'ann' });
		expect(again.events).toEqual([]);
		expect(again.task.meta).toEqual({ owner: 'ann' });

		expect((await setMeta(t.ctx, { id, key: 'blank', value: '' })).events).toHaveLength(1);
		expect((await setMeta(t.ctx, { id, key: 'blank', value: '' })).events).toEqual([]);
	});

	it('all throw TaskNotFoundError for an unknown id', async () => {
		await expect(addLabel(t.ctx, { id: 'zzzz', label: 'x' })).rejects.toThrow(TaskNotFoundError);
		await expect(removeLabel(t.ctx, { id: 'zzzz', label: 'x' })).rejects.toThrow(TaskNotFoundError);
		await expect(setMeta(t.ctx, { id: 'zzzz', key: 'k', value: 'v' })).rejects.toThrow(TaskNotFoundError);
	});
});
