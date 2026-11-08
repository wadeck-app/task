import * as fs from 'node:fs';

import { TaskNotFoundError } from '@wadeck-app/task-core';

import { describeError } from './describeError.js';
import { DanglingLinkError, InvalidLinkTypeError } from './errors.js';
import { ALL_LINK_NAMES, getTaskLinks, linkTasks, parseLinkType, readTaskLinks, unlinkTasks } from './links.js';
import { createTestContext, type TestContext } from './testHelpers.js';

describe('parseLinkType', () => {
	it('resolves stored names as non-inverse', () => {
		expect(parseLinkType('blockedBy')).toEqual({ type: 'blockedBy', inverse: false });
		expect(parseLinkType('duplicateOf')).toEqual({ type: 'duplicateOf', inverse: false });
		expect(parseLinkType('causedBy')).toEqual({ type: 'causedBy', inverse: false });
	});

	it('resolves inverse names to their stored type with inverse=true', () => {
		expect(parseLinkType('blocks')).toEqual({ type: 'blockedBy', inverse: true });
		expect(parseLinkType('duplicates')).toEqual({ type: 'duplicateOf', inverse: true });
		expect(parseLinkType('causes')).toEqual({ type: 'causedBy', inverse: true });
	});

	it('returns undefined for unknown names, and ALL_LINK_NAMES lists stored then inverse names', () => {
		expect(parseLinkType('nope')).toBeUndefined();
		expect(ALL_LINK_NAMES).toEqual(['blockedBy', 'duplicateOf', 'causedBy', 'blocks', 'duplicates', 'causes']);
	});
});

describe('linkTasks / unlinkTasks / getTaskLinks', () => {
	let t: TestContext;
	let a: string;
	let b: string;
	beforeEach(async () => {
		t = createTestContext();
		a = (await t.ctx.store.create({ title: 'a', status: 'backlog' })).id;
		b = (await t.ctx.store.create({ title: 'b', status: 'backlog' })).id;
	});
	afterEach(() => t.cleanup());

	it('stores a stored-name link on the first task and returns an onTaskLinked event', async () => {
		const { task, events } = await linkTasks(t.ctx, {
			id: a.slice(0, 4),
			type: 'blockedBy',
			target: b.slice(0, 4),
		});

		expect(task.id).toBe(a);
		expect(task.links).toEqual([{ type: 'blockedBy', target: b }]);
		expect(events).toEqual([
			{
				name: 'onTaskLinked',
				payload: {
					taskId: a,
					linkType: 'blockedBy',
					targetId: b,
					taskProjectName: 'proj',
					taskProjectPath: t.rootDir,
				},
			},
		]);
	});

	it('an inverse name stores the link on the other task ("a blocks b" = "b blockedBy a")', async () => {
		const { task, events } = await linkTasks(t.ctx, { id: a, type: 'blocks', target: b });

		expect(task.id).toBe(b);
		expect((await t.ctx.store.get(b)).links).toEqual([{ type: 'blockedBy', target: a }]);
		expect(events[0]).toMatchObject({
			name: 'onTaskLinked',
			payload: { taskId: b, linkType: 'blockedBy', targetId: a },
		});
	});

	it('unlink removes the link and returns an onTaskUnlinked event', async () => {
		await linkTasks(t.ctx, { id: a, type: 'blockedBy', target: b });

		const { task, events } = await unlinkTasks(t.ctx, { id: b, type: 'blocks', target: a });

		expect(task.id).toBe(a);
		expect(task.links ?? []).toEqual([]);
		expect(events[0]).toMatchObject({
			name: 'onTaskUnlinked',
			payload: { taskId: a, linkType: 'blockedBy', targetId: b },
		});
	});

	it('throws InvalidLinkTypeError with valid types and a suggestion, before touching the store', async () => {
		let caught: unknown;
		try {
			await linkTasks(t.ctx, { id: 'zzzz', type: 'blockedBi', target: 'yyyy' });
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(InvalidLinkTypeError);
		const err = caught as InvalidLinkTypeError;
		expect(err.message).toBe('unknown link type "blockedBi"');
		expect(err.suggestions).toEqual(['blockedBy']);
		expect(err.hint).toBe(`Valid types: ${ALL_LINK_NAMES.join(', ')}\nDid you mean: blockedBy?`);
	});

	it('throws TaskNotFoundError for an unknown id or target, and no event is returned', async () => {
		await expect(linkTasks(t.ctx, { id: a, type: 'blockedBy', target: 'zzzz' })).rejects.toThrow(TaskNotFoundError);
		await expect(unlinkTasks(t.ctx, { id: 'zzzz', type: 'blockedBy', target: a })).rejects.toThrow(
			TaskNotFoundError
		);
	});

	it('propagates the store error for a self-link or duplicate link', async () => {
		await expect(linkTasks(t.ctx, { id: a, type: 'blockedBy', target: a })).rejects.toThrow(
			'cannot be linked to itself'
		);
		await linkTasks(t.ctx, { id: a, type: 'blockedBy', target: b });
		await expect(linkTasks(t.ctx, { id: a, type: 'blockedBy', target: b })).rejects.toThrow('already');
	});

	it('getTaskLinks returns outgoing links and derived inverses', async () => {
		await linkTasks(t.ctx, { id: a, type: 'blockedBy', target: b });

		expect((await getTaskLinks(t.ctx, { id: a })).blockedBy.map(x => x.id)).toEqual([b]);
		expect((await getTaskLinks(t.ctx, { id: b })).blocks.map(x => x.id)).toEqual([a]);
		await expect(getTaskLinks(t.ctx, { id: 'zzzz' })).rejects.toThrow(TaskNotFoundError);
	});
});

describe('a link to a task that no longer exists (the index was edited outside task)', () => {
	let t: TestContext;
	let a: string;
	let b: string;
	beforeEach(async () => {
		t = createTestContext();
		a = (await t.ctx.store.create({ title: 'a', status: 'backlog' })).id;
		b = (await t.ctx.store.create({ title: 'b', status: 'backlog' })).id;
		await linkTasks(t.ctx, { id: a, type: 'blockedBy', target: b });
		// b leaves the index only: a keeps its link.
		const indexPath = `${t.rootDir}/data/task-index.json`;
		const index = JSON.parse(fs.readFileSync(indexPath, 'utf8')) as { tasks: Array<{ id: string }> };
		index.tasks = index.tasks.filter(x => x.id !== b);
		fs.writeFileSync(indexPath, JSON.stringify(index));
	});
	afterEach(() => t.cleanup());

	it('getTaskLinks says which link dangles and how to remove it (a conflict with a fix, not an index crash)', async () => {
		let caught: unknown;
		try {
			await getTaskLinks(t.ctx, { id: a });
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(DanglingLinkError);
		const description = describeError(caught);
		expect(description.kind).toBe('conflict');
		expect(description.message).toContain(b);
		expect(description.hint).toBe(`Fix with: task unlink ${a} blockedBy ${b}`);
	});

	it('readTaskLinks reports the dangling entry instead of throwing, keeps the other links and words the fix', async () => {
		const c = (await t.ctx.store.create({ title: 'c', status: 'backlog' })).id;
		await linkTasks(t.ctx, { id: a, type: 'causedBy', target: c });

		const report = await readTaskLinks(t.ctx, { id: a });

		expect(report.links.causedBy.map(x => x.id)).toEqual([c]);
		expect(report.links.blockedBy).toEqual([]);
		expect(report.dangling).toEqual([
			{ relation: 'blockedBy', targetId: b, fix: `task unlink ${a} blockedBy ${b}` },
		]);
		expect(report.warnings).toEqual([
			`task "${a}" has a blockedBy link to "${b}", which does not exist. Fix with: task unlink ${a} blockedBy ${b}`,
		]);
	});

	it('readTaskLinks of a consistent task has no dangling entry and no warning', async () => {
		const report = await readTaskLinks(t.ctx, {
			id: (await t.ctx.store.create({ title: 'd', status: 'backlog' })).id,
		});
		expect(report.dangling).toEqual([]);
		expect(report.warnings).toEqual([]);
	});

	it('unlink removes it by the full id of the vanished task, and emits the event', async () => {
		const { task, events } = await unlinkTasks(t.ctx, { id: a, type: 'blockedBy', target: b });

		expect(task.links ?? []).toEqual([]);
		expect(events[0]).toMatchObject({
			name: 'onTaskUnlinked',
			payload: { taskId: a, linkType: 'blockedBy', targetId: b },
		});
	});

	it('unlink still refuses an unknown id that is not a link of the task', async () => {
		await expect(unlinkTasks(t.ctx, { id: a, type: 'blockedBy', target: 'zzzzzzzz' })).rejects.toThrow(
			TaskNotFoundError
		);
	});
});
