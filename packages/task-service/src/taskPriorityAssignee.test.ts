import { InvalidTaskFieldError, UnknownPriorityError, UnsupportedByBackendError } from '@wadeck-app/task-core';

import { clearTaskAssignee, setTaskAssignee } from './taskAssignee.js';
import { clearTaskPriority, setTaskPriority } from './taskPriority.js';
import { createTestContext, type TestContext } from './testHelpers.js';

describe('priority and assignee use cases', () => {
	let t: TestContext;
	let id: string;
	beforeEach(async () => {
		t = createTestContext();
		id = (await t.ctx.store.create({ title: 'a', status: 'backlog' })).id;
	});
	afterEach(() => t.cleanup());

	const env = () => ({ taskProjectName: 'proj', taskProjectPath: t.rootDir });

	describe('setTaskPriority / clearTaskPriority', () => {
		it('sets the priority through a prefix, answers the record without revision and fires onTaskPriorityChanged', async () => {
			const result = await setTaskPriority(t.ctx, { id: id.slice(0, 4), priority: ' high ' });

			expect(result.task.priority).toBe('high');
			expect(result.task).not.toHaveProperty('revision');
			expect(result.events).toEqual([
				{ name: 'onTaskPriorityChanged', payload: { taskId: id, newPriority: 'high', ...env() } },
			]);
			expect(JSON.parse(JSON.stringify(result.events[0]!.payload))).not.toHaveProperty('oldPriority');
		});

		it('a change carries the old priority; the same priority fires nothing', async () => {
			await setTaskPriority(t.ctx, { id, priority: 'high' });

			const same = await setTaskPriority(t.ctx, { id, priority: 'high' });
			const changed = await setTaskPriority(t.ctx, { id, priority: 'low' });

			expect(same.events).toEqual([]);
			expect(changed.events).toEqual([
				{
					name: 'onTaskPriorityChanged',
					payload: { taskId: id, oldPriority: 'high', newPriority: 'low', ...env() },
				},
			]);
		});

		it('refuses a priority outside the project list, naming the valid ones, and writes nothing', async () => {
			const failure = await setTaskPriority(t.ctx, { id, priority: 'critical' }).catch((error: unknown) => error);

			expect(failure).toBeInstanceOf(UnknownPriorityError);
			expect((failure as Error).message).toContain('urgent, high, medium, low');
			expect(await t.ctx.store.get(id)).not.toHaveProperty('priority');
		});

		it('refuses a blank priority', async () => {
			await expect(setTaskPriority(t.ctx, { id, priority: '  ' })).rejects.toBeInstanceOf(InvalidTaskFieldError);
		});

		it('clears the priority: the event has the old one and no new one; a task without one fires nothing', async () => {
			await setTaskPriority(t.ctx, { id, priority: 'urgent' });

			const cleared = await clearTaskPriority(t.ctx, { id });
			const again = await clearTaskPriority(t.ctx, { id });

			expect(cleared.task.priority).toBeUndefined();
			expect(cleared.events).toEqual([
				{ name: 'onTaskPriorityChanged', payload: { taskId: id, oldPriority: 'urgent', ...env() } },
			]);
			expect(JSON.parse(JSON.stringify(cleared.events[0]!.payload))).not.toHaveProperty('newPriority');
			expect(again.events).toEqual([]);
		});

		it('an unknown task is not found', async () => {
			await expect(setTaskPriority(t.ctx, { id: 'nope', priority: 'high' })).rejects.toThrow(/not found/i);
		});
	});

	describe('setTaskAssignee / clearTaskAssignee', () => {
		it('assigns by hand and fires onTaskAssigneeChanged without outcome', async () => {
			const result = await setTaskAssignee(t.ctx, { id: id.slice(0, 4), assignee: ' bob ' });

			expect(result.task.assignee).toBe('bob');
			expect(result.task).not.toHaveProperty('revision');
			expect(result.events).toEqual([
				{ name: 'onTaskAssigneeChanged', payload: { taskId: id, newAssignee: 'bob', ...env() } },
			]);
			expect(JSON.parse(JSON.stringify(result.events[0]!.payload))).not.toHaveProperty('outcome');
		});

		it('the same assignee fires nothing; another one carries old and new', async () => {
			await setTaskAssignee(t.ctx, { id, assignee: 'bob' });

			expect((await setTaskAssignee(t.ctx, { id, assignee: 'bob' })).events).toEqual([]);
			expect((await setTaskAssignee(t.ctx, { id, assignee: 'amy' })).events).toEqual([
				{
					name: 'onTaskAssigneeChanged',
					payload: { taskId: id, oldAssignee: 'bob', newAssignee: 'amy', ...env() },
				},
			]);
		});

		it('refuses a blank or multi-line assignee', async () => {
			await expect(setTaskAssignee(t.ctx, { id, assignee: ' ' })).rejects.toBeInstanceOf(InvalidTaskFieldError);
			await expect(setTaskAssignee(t.ctx, { id, assignee: 'a\nb' })).rejects.toBeInstanceOf(
				InvalidTaskFieldError
			);
		});

		it('unassigns: old assignee, no new one; nobody assigned fires nothing', async () => {
			await setTaskAssignee(t.ctx, { id, assignee: 'bob' });

			const cleared = await clearTaskAssignee(t.ctx, { id });

			expect(cleared.task.assignee).toBeUndefined();
			expect(cleared.events).toEqual([
				{ name: 'onTaskAssigneeChanged', payload: { taskId: id, oldAssignee: 'bob', ...env() } },
			]);
			expect((await clearTaskAssignee(t.ctx, { id })).events).toEqual([]);
		});
	});

	describe('one read per use case', () => {
		it('resolve answers priority and assignee and no use case reads the record a second time', async () => {
			await setTaskPriority(t.ctx, { id, priority: 'high' });
			await setTaskAssignee(t.ctx, { id, assignee: 'bob' });
			const resolved = await t.ctx.store.resolve(id);
			expect(resolved).toMatchObject({ priority: 'high', assignee: 'bob' });

			const get = vi.spyOn(t.ctx.store, 'get');
			await setTaskPriority(t.ctx, { id, priority: 'low' });
			await clearTaskPriority(t.ctx, { id });
			await setTaskAssignee(t.ctx, { id, assignee: 'amy' });
			await clearTaskAssignee(t.ctx, { id });
			expect(get).not.toHaveBeenCalled();
		});
	});

	describe('a backend without the capability', () => {
		it.each([
			['setTaskPriority', (c: TestContext['ctx']) => setTaskPriority(c, { id, priority: 'high' }), 'priority'],
			['clearTaskPriority', (c: TestContext['ctx']) => clearTaskPriority(c, { id }), 'priority'],
			['setTaskAssignee', (c: TestContext['ctx']) => setTaskAssignee(c, { id, assignee: 'bob' }), 'assignee'],
			['clearTaskAssignee', (c: TestContext['ctx']) => clearTaskAssignee(c, { id }), 'assignee'],
		])('%s is refused loudly naming the strategy and the local alternative', async (_name, run, capability) => {
			const noFields = Object.create(t.ctx.store, {
				capabilities: {
					value: { ...t.ctx.store.capabilities, priority: false, assignee: false, claim: false },
				},
				kind: { value: 'github' },
			}) as typeof t.ctx.store;

			const failure = await run({ ...t.ctx, store: noFields }).catch((error: unknown) => error);

			expect(failure).toBeInstanceOf(UnsupportedByBackendError);
			expect((failure as UnsupportedByBackendError).capability).toBe(capability);
			expect((failure as UnsupportedByBackendError).hint).toMatch(/local strategy/);
		});
	});
});
