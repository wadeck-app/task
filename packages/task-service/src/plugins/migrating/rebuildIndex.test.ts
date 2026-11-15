import { BackendDataError } from '@wadeck-app/task-core';

import { identityMeta } from './identityBlock.js';
import { PAIR_KINDS, SINCE, copyToNew, createInNew, rowInCurrent, seedCurrent, wrap } from './testHelpers.js';
import type { Pair } from './testHelpers.js';
import { adoptIndex, rebuildIndex } from './rebuildIndex.js';

const NOW = '2026-11-16T08:00:00.000Z';

async function failure(promise: Promise<unknown>): Promise<BackendDataError> {
	try {
		await promise;
	} catch (error) {
		expect(error).toBeInstanceOf(BackendDataError);
		return error as BackendDataError;
	}
	throw new Error('the call should have failed');
}

describe.each(PAIR_KINDS)('rebuildIndex: the index from the identity blocks of the stores: $name', kind => {
	let pair: Pair;

	beforeEach(async () => {
		pair = await kind.open();
	});

	afterEach(async () => {
		await pair.dispose();
	});

	const run = () => rebuildIndex({ current: pair.a, next: pair.b, now: () => NOW });

	it('is empty for a new side with no task, and for tasks only in current (they need no row)', async () => {
		await seedCurrent(pair.a);

		const report = await run();

		expect(report.rows).toEqual([]);
		expect(report.unindexed).toEqual([]);
	});

	it('gives a copy of a task of current a moving row, and a task made in new an in-b row', async () => {
		const seed = await seedCurrent(pair.a);
		const copy = await copyToNew(pair, seed.parent, { state: 'moving' });
		const made = await createInNew(pair, { title: 'Made in new' });

		const report = await run();

		// Sorted by public id, whatever order the new side lists them in.
		const expected = [
			{ publicId: seed.parent.id, a: seed.parent.id, b: copy.b, state: 'moving', since: NOW, version: 1 },
			{ publicId: made.publicId, b: made.b, state: 'in-b', since: NOW, version: 1 },
		].sort((x, y) => (x.publicId < y.publicId ? -1 : 1));
		expect(report.rows).toEqual(expected);
	});

	it('lists a task of new that carries no identity block as unindexed, and does not route to it', async () => {
		await seedCurrent(pair.a);
		const stranger = await pair.bRaw.create({ title: 'Made by hand in new', status: 'backlog' });

		const report = await run();

		expect(report.rows).toEqual([]);
		expect(report.unindexed).toEqual([{ id: stranger.id, title: 'Made by hand in new' }]);
	});

	it('keeps a task whose copy in current is gone as in-b, and says so', async () => {
		const seed = await seedCurrent(pair.a);
		await copyToNew(pair, seed.loose, { state: 'moving' });
		await pair.a.deleteTask(seed.loose.id);

		const report = await run();

		expect(report.rows.map(row => [row.publicId, row.state, row.a])).toEqual([[seed.loose.id, 'in-b', undefined]]);
		expect(report.notes.join('\n')).toContain(seed.loose.id);
		expect(report.notes.join('\n')).toContain('no longer exists in "current"');
	});

	it('reads current as authoritative for a copy it cannot place, and warns when the copy differs from what was copied', async () => {
		const seed = await seedCurrent(pair.a);
		const copy = await copyToNew(pair, seed.child1, { state: 'in-b', title: 'Child one (in new)' });

		const report = await run();

		expect(report.rows.find(row => row.publicId === seed.child1.id)?.state).toBe('moving');
		const note = report.notes.join('\n');
		expect(note).toContain(seed.child1.id);
		expect(note).toContain('differs from what was copied');
		expect(note).toContain(copy.b);
	});

	it('does not warn for a copy that is what was copied', async () => {
		const seed = await seedCurrent(pair.a);
		await copyToNew(pair, seed.child2, { state: 'moving' });

		expect((await run()).notes).toEqual([]);
	});

	it('only reads: the new side is listed and resolved, never written', async () => {
		const seed = await seedCurrent(pair.a);
		await copyToNew(pair, seed.parent, { state: 'moving' });
		pair.bCalls.length = 0;

		await run();

		expect([...new Set(pair.bCalls)].sort()).toEqual(['list', 'resolve']);
	});

	it('refuses a block whose public id is not the id it was copied from, naming the task', async () => {
		const seed = await seedCurrent(pair.a);
		const created = await pair.bRaw.create({ title: 'Odd', status: 'backlog' });
		const block = identityMeta({ publicId: 'other', fromId: seed.parent.id, hash: '0123456789abcdef' });
		for (const [key, value] of Object.entries(block)) await pair.bRaw.setMeta(created.id, key, value);

		const error = await failure(run());

		expect(error.message).toContain(created.id);
		expect(error.message).toContain('other');
		expect(error.message).toContain(seed.parent.id);
	});

	it('refuses a damaged block, naming the task in new', async () => {
		await seedCurrent(pair.a);
		const created = await pair.bRaw.create({ title: 'Damaged', status: 'backlog' });
		await pair.bRaw.setMeta(created.id, 'migrating.publicId', 'x');

		const error = await failure(run());

		expect(error.message).toContain(created.id);
		expect(error.message).toContain('migrating.hash');
	});

	it('refuses two tasks of new that claim one public id, naming both', async () => {
		const seed = await seedCurrent(pair.a);
		const first = await copyToNew(pair, seed.parent, { state: 'moving' });
		const second = await copyToNew(pair, seed.parent, { state: 'moving' });

		const error = await failure(run());

		expect(error.message).toContain(seed.parent.id);
		expect(error.message).toContain(first.b);
		expect(error.message).toContain(second.b);
	});

	it('refuses a task made in new whose public id is the id of another task of current', async () => {
		const seed = await seedCurrent(pair.a);
		const created = await pair.bRaw.create({ title: 'Collides', status: 'backlog' });
		const block = identityMeta({ publicId: seed.parent.id, hash: '0123456789abcdef' });
		for (const [key, value] of Object.entries(block)) await pair.bRaw.setMeta(created.id, key, value);

		const error = await failure(run());

		expect(error.message).toContain(seed.parent.id);
		expect(error.message).toContain(created.id);
	});

	describe('adoptIndex: writing what was rebuilt', () => {
		it('writes the rows, so the wrapper reads the tasks of new at once', async () => {
			const seed = await seedCurrent(pair.a);
			await copyToNew(pair, seed.parent, { state: 'moving' });
			const made = await createInNew(pair, { title: 'Made in new' });
			const wrapped = wrap(pair);

			const report = await adoptIndex(wrapped.index, { current: pair.a, next: pair.b, now: () => NOW });

			expect(report.rows).toHaveLength(2);
			expect(wrapped.index.snapshot().rows).toEqual(report.rows);
			expect((await wrapped.backend.get(made.publicId)).title).toBe('Made in new');
		});

		it('keeps a damaged index aside under a name of its own, and replaces it', async () => {
			const seed = await seedCurrent(pair.a);
			await copyToNew(pair, seed.parent, { state: 'moving' });
			const wrapped = wrap(pair);
			wrapped.files.text = '{ broken';
			const written: Array<[string, string]> = [];
			const write = wrapped.files.write;
			wrapped.files.write = (file: string, content: string): void => {
				written.push([file, content]);
				write(file, content);
			};

			const report = await adoptIndex(wrapped.index, { current: pair.a, next: pair.b, now: () => NOW });

			expect(written[0]?.[0]).toMatch(/index\.json\.damaged-/);
			expect(written[0]?.[1]).toBe('{ broken');
			expect(wrapped.index.snapshot().rows).toEqual(report.rows);
			expect(report.notes.join('\n')).toContain('damaged');
		});

		it('says which rows of the old index it could not rebuild (a deleted task leaves no trace in the stores)', async () => {
			const seed = await seedCurrent(pair.a);
			const wrapped = wrap(pair);
			wrapped.index.mutate(() => [{ ...rowInCurrent(seed.child2.id, 'deleted'), since: SINCE }]);

			const report = await adoptIndex(wrapped.index, { current: pair.a, next: pair.b, now: () => NOW });

			expect(report.notes.join('\n')).toContain(seed.child2.id);
			expect(report.notes.join('\n')).toContain('deleted');
			expect(wrapped.index.snapshot().rows).toEqual([]);
		});
	});
});
