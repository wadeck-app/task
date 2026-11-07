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

	const create = (title: string, parentId?: string) => t.ctx.store.create(title, 'backlog', parentId);
	const ids = (hits: Array<{ id: string }>) => hits.map(hit => hit.id);

	it('answers id, headline and status, nothing else', () => {
		const task = create('Fix login');
		t.ctx.store.updateStatus(task.id, 'done');

		expect(searchTasks(t.ctx, { q: 'login' })).toEqual([{ id: task.id, headline: 'Fix login', status: 'done' }]);
	});

	it('ranks an id prefix before a title word prefix before a substring', () => {
		// Created first so that the index order alone would put them before the id match.
		const inside = create('prefix-ID-suffix');
		const word = create('see ID first');
		const byId = create('Unrelated');
		t.ctx.store.setTitle(inside.id, `prefix${byId.id}suffix`);
		t.ctx.store.setTitle(word.id, `see ${byId.id} first`);

		expect(ids(searchTasks(t.ctx, { q: byId.id }))).toEqual([byId.id, word.id, inside.id]);
	});

	it('ranks a word prefix before a substring, case-insensitively, keeping the index order inside a rank', () => {
		const catalog = create('Catalog sync');
		const login = create('Fix LOGIN redirect');
		const logout = create('logout page');

		expect(ids(searchTasks(t.ctx, { q: 'Log' }))).toEqual([login.id, logout.id, catalog.id]);
	});

	it('matches an id prefix typed in capitals', () => {
		const task = create('Anything');

		expect(ids(searchTasks(t.ctx, { q: task.id.slice(0, 4).toUpperCase() }))).toContain(task.id);
	});

	it('limits the answer: default, explicit, clamped to the maximum and to at least 1', () => {
		for (let n = 0; n < 30; n++) create(`item ${n}`);

		expect(searchTasks(t.ctx, { q: 'item' })).toHaveLength(SEARCH_DEFAULT_LIMIT);
		expect(searchTasks(t.ctx, { q: 'item', limit: 3 })).toHaveLength(3);
		expect(searchTasks(t.ctx, { q: 'item', limit: 500 })).toHaveLength(SEARCH_MAX_LIMIT);
		expect(searchTasks(t.ctx, { q: 'item', limit: 0 })).toHaveLength(1);
		expect(SEARCH_MAX_LIMIT).toBe(20);
	});

	it('an empty query lists the first tasks of the index', () => {
		const a = create('a');
		create('b');

		expect(searchTasks(t.ctx, { q: '', limit: 1 })[0]!.id).toBe(a.id);
	});

	it('excludes the given ids', () => {
		const a = create('same word');
		const b = create('same word too');

		expect(ids(searchTasks(t.ctx, { q: 'same', exclude: [a.id] }))).toEqual([b.id]);
	});

	it('excludeDescendantsOf removes the task itself and every descendant (any depth), and accepts a prefix', () => {
		const root = create('topic root');
		const child = create('topic child', root.id);
		const grandChild = create('topic grandchild', child.id);
		const sibling = create('topic sibling');

		const hits = searchTasks(t.ctx, { q: 'topic', excludeDescendantsOf: root.id.slice(0, 5) });

		expect(ids(hits)).toEqual([sibling.id]);
		expect(ids(hits)).not.toContain(grandChild.id);
	});

	it('excludeDescendantsOf of an unknown task is a TaskNotFoundError', () => {
		expect(() => searchTasks(t.ctx, { q: 'x', excludeDescendantsOf: 'zzzz' })).toThrow(TaskNotFoundError);
	});

	it('shows the headline of a long title, not the whole text', () => {
		create(`Short headline\n${'long body '.repeat(40)}`);

		expect(searchTasks(t.ctx, { q: 'long body' })[0]!.headline).toBe('Short headline');
	});

	it('reads the index only: with every task file gone it still answers', () => {
		const root = create('lonely topic');
		create('lonely child', root.id);
		const tasksDir = path.join(t.rootDir, 'data', 'tasks');
		for (const file of fs.readdirSync(tasksDir)) fs.rmSync(path.join(tasksDir, file));

		expect(searchTasks(t.ctx, { q: 'lonely', excludeDescendantsOf: root.id })).toEqual([]);
		expect(searchTasks(t.ctx, { q: 'lonely' })).toHaveLength(2);
	});

	it('answers within 250 ms on 1 000 tasks (measured value printed)', () => {
		seedTasks(t, 1000);
		searchTasks(t.ctx, { q: 'topic 7' });

		const start = performance.now();
		const hits = searchTasks(t.ctx, { q: 'topic 7', limit: 20, excludeDescendantsOf: 's0000000' });
		const elapsed = performance.now() - start;
		console.info(`searchTasks over 1000 tasks: ${elapsed.toFixed(1)} ms`);

		expect(hits).toHaveLength(20);
		expect(elapsed).toBeLessThan(250);
	});
});
