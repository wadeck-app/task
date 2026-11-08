import * as fs from 'node:fs';
import * as path from 'node:path';

import { TaskNotFoundError } from '@wadeck-app/task-core';

import { searchTasks, SEARCH_DEFAULT_LIMIT, SEARCH_MAX_LIMIT } from './searchTasks.js';
import { createTestContext, seedTasks, type TestContext } from './testHelpers.js';

describe('searchTasks', () => {
	let t: TestContext;
	beforeEach(() => {
		t = createTestContext();
	});
	afterEach(() => t.cleanup());

	const create = async (title: string, parentId?: string) =>
		await t.ctx.store.create({ title: title, status: 'backlog', parentId: parentId });
	const ids = (hits: Array<{ id: string }>) => hits.map(hit => hit.id);

	it('answers id, headline and status, nothing else', async () => {
		const task = await create('Fix login');
		await t.ctx.store.updateStatus(task.id, 'done');

		expect(await searchTasks(t.ctx, { q: 'login' })).toEqual([
			{ id: task.id, headline: 'Fix login', status: 'done' },
		]);
	});

	it('ranks an id prefix before a title word prefix before a substring', async () => {
		// Created first so that the index order alone would put them before the id match.
		const inside = await create('prefix-ID-suffix');
		const word = await create('see ID first');
		const byId = await create('Unrelated');
		await t.ctx.store.setTitle(inside.id, `prefix${byId.id}suffix`);
		await t.ctx.store.setTitle(word.id, `see ${byId.id} first`);

		expect(ids(await searchTasks(t.ctx, { q: byId.id }))).toEqual([byId.id, word.id, inside.id]);
	});

	it('ranks a word prefix before a substring, case-insensitively, keeping the index order inside a rank', async () => {
		const catalog = await create('Catalog sync');
		const login = await create('Fix LOGIN redirect');
		const logout = await create('logout page');

		expect(ids(await searchTasks(t.ctx, { q: 'Log' }))).toEqual([login.id, logout.id, catalog.id]);
	});

	it('matches an id prefix typed in capitals', async () => {
		const task = await create('Anything');

		expect(ids(await searchTasks(t.ctx, { q: task.id.slice(0, 4).toUpperCase() }))).toContain(task.id);
	});

	it('limits the answer: default, explicit, clamped to the maximum and to at least 1', async () => {
		for (let n = 0; n < 30; n++) await create(`item ${n}`);

		expect(await searchTasks(t.ctx, { q: 'item' })).toHaveLength(SEARCH_DEFAULT_LIMIT);
		expect(await searchTasks(t.ctx, { q: 'item', limit: 3 })).toHaveLength(3);
		expect(await searchTasks(t.ctx, { q: 'item', limit: 500 })).toHaveLength(SEARCH_MAX_LIMIT);
		expect(await searchTasks(t.ctx, { q: 'item', limit: 0 })).toHaveLength(1);
		expect(SEARCH_MAX_LIMIT).toBe(20);
	});

	it('an empty query lists the first tasks of the index', async () => {
		const a = await create('a');
		await create('b');

		expect((await searchTasks(t.ctx, { q: '', limit: 1 }))[0]!.id).toBe(a.id);
	});

	it('excludes the given ids', async () => {
		const a = await create('same word');
		const b = await create('same word too');

		expect(ids(await searchTasks(t.ctx, { q: 'same', exclude: [a.id] }))).toEqual([b.id]);
	});

	it('excludeDescendantsOf removes the task itself and every descendant (any depth), and accepts a prefix', async () => {
		const root = await create('topic root');
		const child = await create('topic child', root.id);
		const grandChild = await create('topic grandchild', child.id);
		const sibling = await create('topic sibling');

		const hits = await searchTasks(t.ctx, { q: 'topic', excludeDescendantsOf: root.id.slice(0, 5) });

		expect(ids(hits)).toEqual([sibling.id]);
		expect(ids(hits)).not.toContain(grandChild.id);
	});

	it('excludeDescendantsOf of an unknown task is a TaskNotFoundError', async () => {
		await expect(searchTasks(t.ctx, { q: 'x', excludeDescendantsOf: 'zzzz' })).rejects.toThrow(TaskNotFoundError);
	});

	it('shows the headline of a long title, not the whole text', async () => {
		await create(`Short headline\n${'long body '.repeat(40)}`);

		expect((await searchTasks(t.ctx, { q: 'long body' }))[0]!.headline).toBe('Short headline');
	});

	it('reads the index only: with every task file gone it still answers', async () => {
		const root = await create('lonely topic');
		await create('lonely child', root.id);
		const tasksDir = path.join(t.rootDir, 'data', 'tasks');
		for (const file of fs.readdirSync(tasksDir)) fs.rmSync(path.join(tasksDir, file));

		expect(await searchTasks(t.ctx, { q: 'lonely', excludeDescendantsOf: root.id })).toEqual([]);
		expect(await searchTasks(t.ctx, { q: 'lonely' })).toHaveLength(2);
	});

	it('answers within 250 ms on 1 000 tasks (measured value printed)', async () => {
		seedTasks(t, 1000);
		await searchTasks(t.ctx, { q: 'topic 7' });

		const start = performance.now();
		const hits = await searchTasks(t.ctx, { q: 'topic 7', limit: 20, excludeDescendantsOf: 's0000000' });
		const elapsed = performance.now() - start;
		console.info(`searchTasks over 1000 tasks: ${elapsed.toFixed(1)} ms`);

		expect(hits).toHaveLength(20);
		expect(elapsed).toBeLessThan(250);
	});
});
