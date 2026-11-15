import { BackendRejectedError, TaskNotFoundError } from '@wadeck-app/task-core';
import type { VersionedRecord } from '@wadeck-app/task-core';

import { IDENTITY_KEYS, readIdentity } from './identityBlock.js';
import { PAIR_KINDS, copyToNew, createInNew, seedCurrent, seedRows, wrap } from './testHelpers.js';
import type { Pair, Seed, Wrapped } from './testHelpers.js';

const WRITES = new Set([
	'create',
	'createMigrated',
	'setTitle',
	'setDescription',
	'updateStatus',
	'setType',
	'clearType',
	'addLabel',
	'removeLabel',
	'setMeta',
	'removeMeta',
	'setParent',
	'removeParent',
	'addLink',
	'removeLink',
	'addComment',
	'editComment',
	'removeComment',
	'setPriority',
	'clearPriority',
	'setAssignee',
	'clearAssignee',
	'claim',
	'release',
	'deleteTask',
]);

/** The writes the sides received, as `a:setTitle`, in the order they were made. */
const writesOf = (wrapped: Wrapped): string[] => wrapped.faults.calls.filter(call => WRITES.has(call.slice(2)));

async function rejection(promise: Promise<unknown>): Promise<unknown> {
	try {
		await promise;
	} catch (error) {
		return error;
	}
	throw new Error('the call should have failed');
}

describe.each(PAIR_KINDS)('MigratingBackend writes, by state of the task: $name', kind => {
	let pair: Pair;
	let seed: Seed;
	let wrapped: Wrapped;

	beforeEach(async () => {
		pair = await kind.open();
		seed = await seedCurrent(pair.a);
		wrapped = wrap(pair);
	});

	afterEach(async () => {
		await pair.dispose();
	});

	/** The task in state `moving`: a copy in new that follows current. */
	async function makeMoving(task: VersionedRecord, parentB?: string): Promise<string> {
		const row = await copyToNew(pair, task, {
			state: 'moving',
			authority: 'current',
			accepted: ['all'],
			...(parentB === undefined ? {} : { parentB }),
		});
		wrapped.index.mutate(rows => [...rows, row]);
		return row.b!;
	}

	/** The task in state `in-b`: new is the task, current keeps the copy. */
	async function makeInB(task: VersionedRecord, parentB?: string): Promise<string> {
		const row = await copyToNew(pair, task, {
			state: 'in-b',
			authority: 'new',
			...(parentB === undefined ? {} : { parentB }),
		});
		wrapped.index.mutate(rows => [...rows, row]);
		return row.b!;
	}

	describe('a task that is in current only', () => {
		it('is written in current and nowhere else, with no row and no log line', async () => {
			const changed = await wrapped.backend.setTitle(seed.loose.id, 'Loose renamed');

			expect(changed.title).toBe('Loose renamed');
			expect(writesOf(wrapped)).toEqual(['a:setTitle']);
			expect(wrapped.index.snapshot().rows).toEqual([]);
			expect(wrapped.wal.texts.size).toBe(0);
		});

		it('a refused write changes nothing and is the side error as it is', async () => {
			const error = await rejection(wrapped.backend.setParent(seed.loose.id, seed.loose.id));

			expect(error).toBeInstanceOf(Error);
			expect(wrapped.index.snapshot().rows).toEqual([]);
		});
	});

	describe('create', () => {
		it('goes to new: the task is not in current, has its id in new as public id, and is listed once', async () => {
			const before = (await pair.a.list()).length;

			const created = await wrapped.backend.create({ title: 'Brand new', status: 'backlog' });

			expect((await pair.a.list()).length).toBe(before);
			expect((await pair.bRaw.get(created.id)).title).toBe('Brand new');
			expect(wrapped.index.snapshot().byPublicId(created.id)).toMatchObject({
				publicId: created.id,
				b: created.id,
				state: 'in-b',
			});
			expect((await wrapped.backend.list()).filter(task => task.id === created.id)).toHaveLength(1);
			expect(await wrapped.backend.get(created.id)).toEqual(created);
		});

		it('gives the copy in new its identity block (public id = its id, no origin, authority new) and shows none of it', async () => {
			const created = await wrapped.backend.create({ title: 'Brand new', status: 'backlog' });

			const raw = await pair.bRaw.get(created.id);
			const identity = readIdentity(raw.meta, `task ${created.id}`);
			expect(identity).toMatchObject({ publicId: created.id, authority: 'new' });
			expect(identity?.fromId).toBeUndefined();
			expect(Object.keys(created.meta ?? {}).filter(key => key.startsWith('migrating.'))).toEqual([]);
			expect(JSON.stringify(created.activity ?? [])).not.toContain('migrating.');
		});

		it('can sit under a task whose copy in new follows current (moving)', async () => {
			const parentB = await makeMoving(seed.parent);

			const created = await wrapped.backend.create({
				title: 'Child',
				status: 'backlog',
				parentId: seed.parent.id,
			});

			expect(created.parentId).toBe(seed.parent.id);
			expect((await pair.bRaw.get(created.id)).parentId).toBe(parentB);
		});

		it('can sit under a task that was made in new', async () => {
			const made = await wrapped.backend.create({ title: 'Made', status: 'backlog' });

			const child = await wrapped.backend.create({ title: 'Child', status: 'backlog', parentId: made.id });

			expect(child.parentId).toBe(made.id);
		});

		it('refuses a parent that has no copy in new yet, naming it, before writing anything, with a way out', async () => {
			const error = (await rejection(
				wrapped.backend.create({ title: 'Child', status: 'backlog', parentId: seed.parent.id })
			)) as BackendRejectedError;

			expect(error).toBeInstanceOf(BackendRejectedError);
			expect(error.message).toContain(seed.parent.id);
			expect(error.hint).toContain('move');
			expect(writesOf(wrapped)).toEqual([]);
			expect(wrapped.wal.texts.size).toBe(0);
			expect((await pair.bRaw.list()).length).toBe(0);
		});
	});

	describe('a task that is moving (current is the truth, the copy in new follows)', () => {
		it("is written in current FIRST and then the same change in new; the answer is current's", async () => {
			const b = await makeMoving(seed.child2);

			const changed = await wrapped.backend.setTitle(seed.child2.id, 'Renamed');

			expect(writesOf(wrapped)).toEqual(['a:setTitle', 'b:setTitle']);
			expect(changed.title).toBe('Renamed');
			expect(changed.revision).toBe((await pair.a.get(seed.child2.id)).revision);
			expect((await pair.bRaw.get(b)).title).toBe('Renamed');
			expect((await wrapped.backend.get(seed.child2.id)).title).toBe('Renamed');
			expect(wrapped.index.snapshot().byPublicId(seed.child2.id)?.stale).toBeUndefined();
		});

		it('logs the write before it applies it and after, and leaves nothing open', async () => {
			await makeMoving(seed.child2);

			await wrapped.backend.setTitle(seed.child2.id, 'Renamed');

			expect(wrapped.journal.openTransactions()).toEqual([]);
			const log = (
				wrapped.wal.texts.get([...wrapped.wal.texts.keys()].find(file => file.endsWith('log.ndjson')) ?? '') ??
				''
			)
				.split('\n')
				.filter(line => line !== '')
				.map(line => JSON.parse(line) as Record<string, string>);
			const steps = log
				.filter(line => line['op'] === 'write')
				.map(line => `${line['step'] ?? line['event']}:${line['phase'] ?? line['outcome'] ?? ''}`);
			expect(steps).toEqual(['begin:', 'apply:intent', 'apply:done', 'mirror:intent', 'mirror:done', 'end:ok']);
			expect(log.every(line => line['task'] === seed.child2.id)).toBe(true);
		});

		it("a mirror that fails marks the copy stale, tells the log, and never fails the person's write", async () => {
			const b = await makeMoving(seed.child2);
			wrapped.faults.failOn('b', 'setTitle');

			const changed = await wrapped.backend.setTitle(seed.child2.id, 'Renamed');

			expect(changed.title).toBe('Renamed');
			expect((await wrapped.backend.get(seed.child2.id)).title).toBe('Renamed');
			expect((await pair.bRaw.get(b)).title).toBe('Child two');
			expect(wrapped.index.snapshot().byPublicId(seed.child2.id)?.stale).toBe(true);
			const log = [...wrapped.wal.texts.entries()].find(([file]) => file.endsWith('log.ndjson'))?.[1] ?? '';
			expect(log).toContain('"phase":"failed"');
			expect(log).toContain('injected fault: b.setTitle');
		});

		it('a write that current refuses is not mirrored and does not mark the copy stale', async () => {
			await makeMoving(seed.child2);

			const error = await rejection(wrapped.backend.setParent(seed.child2.id, seed.child2.id));

			expect(error).toBeInstanceOf(Error);
			expect(writesOf(wrapped)).toEqual(['a:setParent']);
			expect(wrapped.index.snapshot().byPublicId(seed.child2.id)?.stale).toBeUndefined();
			expect(wrapped.journal.openTransactions()).toEqual([]);
		});

		it('a write of current whose outcome is unknown (the answer was lost) marks the copy stale before the error reaches the person', async () => {
			const b = await makeMoving(seed.child2);
			wrapped.faults.failOn('a', 'setTitle', { applied: true });

			await expect(wrapped.backend.setTitle(seed.child2.id, 'Renamed')).rejects.toThrow('injected fault');

			expect((await pair.a.get(seed.child2.id)).title).toBe('Renamed');
			expect((await pair.bRaw.get(b)).title).toBe('Child two');
			expect(wrapped.index.snapshot().byPublicId(seed.child2.id)?.stale).toBe(true);
		});

		it('a relation to a task with no copy in new is written in current, and the copy is stale (it cannot follow yet)', async () => {
			await makeMoving(seed.child2);

			const changed = await wrapped.backend.setParent(seed.child2.id, seed.loose.id);

			expect(changed.parentId).toBe(seed.loose.id);
			expect(writesOf(wrapped)).toEqual(['a:setParent']);
			expect(wrapped.index.snapshot().byPublicId(seed.child2.id)?.stale).toBe(true);
		});

		it('refuses a relation to a task that only exists in new, before writing anything: current cannot hold it', async () => {
			await makeMoving(seed.child2);
			const made = await wrapped.backend.create({ title: 'Made in new', status: 'backlog' });
			wrapped.faults.calls.length = 0;

			const error = (await rejection(wrapped.backend.setParent(seed.child2.id, made.id))) as BackendRejectedError;

			expect(error).toBeInstanceOf(BackendRejectedError);
			expect(error.message).toContain(made.id);
			expect(error.message).toContain(seed.child2.id);
			expect(writesOf(wrapped)).toEqual([]);
			expect(wrapped.index.snapshot().byPublicId(seed.child2.id)?.stale).toBeUndefined();
		});

		it('serialises two writes to the same task: each is written then mirrored, in the order they were asked', async () => {
			const b = await makeMoving(seed.child2);

			await Promise.all([
				wrapped.backend.setTitle(seed.child2.id, 'one'),
				wrapped.backend.setTitle(seed.child2.id, 'two'),
			]);

			expect(writesOf(wrapped)).toEqual(['a:setTitle', 'b:setTitle', 'a:setTitle', 'b:setTitle']);
			expect((await pair.a.get(seed.child2.id)).title).toBe('two');
			expect((await pair.bRaw.get(b)).title).toBe('two');
		});

		it('a comment follows through the copy of the whole task, so its marker is the one a catch-up looks for', async () => {
			const b = await makeMoving(seed.child2);

			const added = await wrapped.backend.addComment(seed.child2.id, 'A note', { author: 'ann' });

			expect(added.comment.text).toBe('A note');
			expect(((await pair.a.get(seed.child2.id)).comments ?? []).map(comment => comment.text)).toEqual([
				'A note',
			]);
			expect(((await pair.bRaw.get(b)).comments ?? []).map(comment => comment.text).join('\n')).toContain(
				'A note'
			);
		});

		it('a claim is written in current and follows to the copy, lease included', async () => {
			const b = await makeMoving(seed.child2);

			const claimed = await wrapped.backend.claim(seed.child2.id, {
				assignee: 'w1',
				leaseUntil: '2098-01-01T00:30:00.000Z',
				now: '2098-01-01T00:00:00.000Z',
			});

			expect(claimed.task.assignee).toBe('w1');
			expect((await pair.bRaw.get(b)).assignee).toBe('w1');
			expect((await pair.bRaw.get(b)).leaseUntil).toBe('2098-01-01T00:30:00.000Z');
		});
	});

	describe('a task that is in new (new is the truth, current keeps the old copy as the backup)', () => {
		it('is written in new only; the copy in current is not touched', async () => {
			await makeInB(seed.child2);

			const changed = await wrapped.backend.setTitle(seed.child2.id, 'Renamed in new');

			expect(changed.title).toBe('Renamed in new');
			expect(writesOf(wrapped)).toEqual(['b:setTitle']);
			expect((await pair.a.get(seed.child2.id)).title).toBe('Child two');
			expect((await wrapped.backend.get(seed.child2.id)).title).toBe('Renamed in new');
			expect(wrapped.wal.texts.size).toBe(0);
		});

		it('refuses a parent that has no copy in new, naming the task to move first', async () => {
			await makeInB(seed.child2);

			const error = (await rejection(
				wrapped.backend.setParent(seed.child2.id, seed.loose.id)
			)) as BackendRejectedError;

			expect(error).toBeInstanceOf(BackendRejectedError);
			expect(error.message).toContain(seed.loose.id);
			expect(error.hint).toContain('move');
			expect(writesOf(wrapped)).toEqual([]);
		});

		it('takes a parent that has a copy in new (moving or in-b), and answers with public ids', async () => {
			await makeInB(seed.child2);
			await makeMoving(seed.loose);

			const changed = await wrapped.backend.setParent(seed.child2.id, seed.loose.id);

			expect(changed.parentId).toBe(seed.loose.id);
		});

		it('refuses a link to a task that has no copy in new', async () => {
			await makeInB(seed.child2);

			await expect(wrapped.backend.addLink(seed.child2.id, 'blockedBy', seed.parent.id)).rejects.toBeInstanceOf(
				BackendRejectedError
			);
			expect(writesOf(wrapped)).toEqual([]);
		});

		it('a task made in new is written in new like any other', async () => {
			const made = await createInNew(pair, { title: 'Made', authority: 'new' });
			seedRows(wrapped, [...wrapped.index.snapshot().rows, made]);

			const changed = await wrapped.backend.setTitle(made.publicId, 'Made, renamed');

			expect(changed.title).toBe('Made, renamed');
			expect(writesOf(wrapped)).toEqual(['b:setTitle']);
		});
	});

	describe('delete', () => {
		it('a task of current only is deleted in current, with no row', async () => {
			expect(await wrapped.backend.deleteTask(seed.loose.id)).toBe(true);

			expect(writesOf(wrapped)).toEqual(['a:deleteTask']);
			await expect(pair.a.get(seed.loose.id)).rejects.toBeInstanceOf(TaskNotFoundError);
		});

		it('a moving task is deleted in current FIRST, then its copy; it is gone for every read', async () => {
			const b = await makeMoving(seed.child2);

			expect(await wrapped.backend.deleteTask(seed.child2.id)).toBe(true);

			expect(writesOf(wrapped)).toEqual(['a:deleteTask', 'b:deleteTask']);
			expect(wrapped.index.snapshot().byPublicId(seed.child2.id)?.state).toBe('deleted');
			await expect(pair.bRaw.get(b)).rejects.toBeInstanceOf(TaskNotFoundError);
			await expect(wrapped.backend.get(seed.child2.id)).rejects.toBeInstanceOf(TaskNotFoundError);
			expect((await wrapped.backend.list()).map(task => task.id)).not.toContain(seed.child2.id);
			expect(wrapped.journal.openTransactions()).toEqual([]);
		});

		it('a copy that cannot be deleted does not fail the delete: it is logged and left to the recovery', async () => {
			await makeMoving(seed.child2);
			wrapped.faults.failOn('b', 'deleteTask');

			expect(await wrapped.backend.deleteTask(seed.child2.id)).toBe(true);

			await expect(wrapped.backend.get(seed.child2.id)).rejects.toBeInstanceOf(TaskNotFoundError);
			expect(wrapped.journal.openTransactions().map(tx => [tx.op, tx.task])).toEqual([
				['delete', seed.child2.id],
			]);
		});

		it('a task of new is deleted in new; the copy in current is kept as the backup', async () => {
			await makeInB(seed.child2);

			expect(await wrapped.backend.deleteTask(seed.child2.id)).toBe(true);

			expect(writesOf(wrapped)).toEqual(['b:deleteTask']);
			expect((await pair.a.get(seed.child2.id)).title).toBe('Child two');
			await expect(wrapped.backend.get(seed.child2.id)).rejects.toBeInstanceOf(TaskNotFoundError);
			expect((await wrapped.backend.list()).map(task => task.id)).not.toContain(seed.child2.id);
		});

		it('a write to a deleted task is "not found"', async () => {
			await makeInB(seed.child2);
			await wrapped.backend.deleteTask(seed.child2.id);

			await expect(wrapped.backend.setTitle(seed.child2.id, 'x')).rejects.toBeInstanceOf(TaskNotFoundError);
		});
	});

	describe('the identity block belongs to the strategy', () => {
		it.each([
			['setting', (w: Wrapped, id: string) => w.backend.setMeta(id, IDENTITY_KEYS.publicId, 'x')],
			['removing', (w: Wrapped, id: string) => w.backend.removeMeta(id, IDENTITY_KEYS.hash)],
		])('refuses %s a migrating. metadata entry, in every state, before any write', async (_name, call) => {
			await makeInB(seed.child2);
			await makeMoving(seed.child1);

			for (const id of [seed.child2.id, seed.child1.id, seed.loose.id]) {
				const error = (await rejection(call(wrapped, id))) as BackendRejectedError;
				expect(error).toBeInstanceOf(BackendRejectedError);
				expect(error.message).toContain('migrating.');
			}
			expect(writesOf(wrapped)).toEqual([]);
		});

		it.each([
			['resolve', (w: Wrapped, id: string) => w.backend.resolve(id)],
			['findByPrefix', (w: Wrapped, id: string) => w.backend.findByPrefix(id)],
			['getMany', async (w: Wrapped, id: string) => (await w.backend.getMany([id]))[0]!],
		])('is not shown by %s either', async (_name, read) => {
			const b = await makeInB(seed.child2);
			expect(Object.keys((await pair.bRaw.get(b)).meta ?? {}).some(key => key.startsWith('migrating.'))).toBe(
				true
			);

			const found = await read(wrapped, seed.child2.id);

			expect(Object.keys(found.meta ?? {}).filter(key => key.startsWith('migrating.'))).toEqual([]);
		});

		it('is not shown on a task that has it, and a person can still set their own metadata', async () => {
			await makeInB(seed.child2);

			const changed = await wrapped.backend.setMeta(seed.child2.id, 'team', 'core');

			expect(changed.meta).toEqual({ team: 'core' });
			expect((await wrapped.backend.get(seed.child2.id)).meta).toEqual({ team: 'core' });
		});
	});
});
