import {
	AmbiguousTaskPrefixError,
	BackendDataError,
	BackendRejectedError,
	TaskNotFoundError,
} from '@wadeck-app/task-core';
import type { TaskSummary, TaskTreeNode } from '@wadeck-app/task-core';

import { PAIR_KINDS, copyToNew, createInNew, rowInCurrent, seedCurrent, seedRows, wrap } from './testHelpers.js';
import type { Pair, Seed, Wrapped } from './testHelpers.js';
import type { IndexRow } from './routingIndex.js';

const isTerminal = (status: string): boolean => status === 'done' || status === 'cancelled' || status === 'duplicate';

interface World {
	pair: Pair;
	seed: Seed;
	wrapped: Wrapped;
	rows: { parent: IndexRow; child1: IndexRow; child2: IndexRow; made: IndexRow };
}

/**
 * The project in every state at once:
 *  - Parent: `moving` (a stale copy in new; current is authoritative)
 *  - Child one: `in-b` (new is authoritative: another title, status and labels; current keeps a stale copy)
 *  - Child two: `deleted`
 *  - Loose: no row (in current, blocked by Child one)
 *  - Made in new: a task that never was in current, under Parent
 */
async function mixedWorld(pair: Pair): Promise<World> {
	const seed = await seedCurrent(pair.a);
	const parent = await copyToNew(pair, seed.parent, { state: 'moving', title: 'Parent (stale copy)' });
	const child1 = await copyToNew(pair, seed.child1, {
		state: 'in-b',
		title: 'Child one (in new)',
		status: 'in-progress',
		labels: ['y', 'z'],
		parentB: parent.b!,
	});
	const made = await createInNew(pair, { title: 'Made in new', parentB: parent.b!, labels: ['z'] });
	const child2 = rowInCurrent(seed.child2.id, 'deleted');
	const wrapped = wrap(pair);
	seedRows(wrapped, [parent, child1, child2, made]);
	return { pair, seed, wrapped, rows: { parent, child1, child2, made } };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
	try {
		await promise;
	} catch (error) {
		return error;
	}
	throw new Error('the call should have failed');
}

const titles = (tasks: readonly TaskSummary[]): string[] => tasks.map(task => task.title).sort();
const flat = (node: TaskTreeNode): string[] => [node.title, ...node.children.flatMap(flat)].sort();

describe.each(PAIR_KINDS)('MigratingBackend reads by state: $name', kind => {
	let pair: Pair;

	beforeEach(async () => {
		pair = await kind.open();
	});

	afterEach(async () => {
		await pair.dispose();
	});

	describe('only the states that need nothing from the new side', () => {
		it('with no row, or rows in-a, answers exactly what current answers and never asks the new side', async () => {
			const seed = await seedCurrent(pair.a);
			const wrapped = wrap(pair);
			seedRows(wrapped, [rowInCurrent(seed.parent.id)]);

			expect(await wrapped.backend.list()).toEqual(await pair.a.list());
			expect(await wrapped.backend.get(seed.child1.id)).toEqual(await pair.a.get(seed.child1.id));
			expect(await wrapped.backend.getTree(seed.parent.id)).toEqual(await pair.a.getTree(seed.parent.id));
			expect(await wrapped.backend.getLinks(seed.loose.id)).toEqual(await pair.a.getLinks(seed.loose.id));
			expect(await wrapped.backend.listLabels()).toEqual(await pair.a.listLabels());
			expect(pair.bCalls).toEqual([]);
		});

		it('with a task moving, reads current (authoritative) and still never asks the new side', async () => {
			const seed = await seedCurrent(pair.a);
			const row = await copyToNew(pair, seed.parent, { state: 'moving', title: 'Parent (stale copy)' });
			const wrapped = wrap(pair);
			seedRows(wrapped, [row]);
			pair.bCalls.length = 0;

			expect(titles(await wrapped.backend.list())).toEqual(['Child one', 'Child two', 'Loose', 'Parent']);
			expect((await wrapped.backend.get(seed.parent.id)).title).toBe('Parent');
			expect((await wrapped.backend.resolve(seed.parent.id)).title).toBe('Parent');
			expect(titles(await wrapped.backend.getChildren(seed.parent.id))).toEqual(['Child one', 'Child two']);
			expect(pair.bCalls).toEqual([]);
		});
	});

	describe('every state at once', () => {
		let world: World;
		beforeEach(async () => {
			world = await mixedWorld(pair);
		});

		it('lists each task once under its public id, from the side that is authoritative, and hides a deleted one', async () => {
			const list = await world.wrapped.backend.list();

			expect(titles(list)).toEqual(['Child one (in new)', 'Loose', 'Made in new', 'Parent']);
			const byId = new Map(list.map(task => [task.id, task]));
			expect([...byId.keys()].sort()).toEqual(
				[world.seed.parent.id, world.seed.child1.id, world.seed.loose.id, world.rows.made.publicId].sort()
			);
			expect(byId.get(world.seed.child1.id)?.status).toBe('in-progress');
			expect(byId.has(world.seed.child2.id)).toBe(false);
		});

		it('shows a parent that lives in the other side under its public id', async () => {
			const byId = new Map((await world.wrapped.backend.list()).map(task => [task.id, task]));

			expect(byId.get(world.seed.child1.id)?.parentId).toBe(world.seed.parent.id);
			expect(byId.get(world.rows.made.publicId)?.parentId).toBe(world.seed.parent.id);
		});

		it('reads a record from the side that is authoritative and translates its relations to public ids', async () => {
			const child = await world.wrapped.backend.get(world.seed.child1.id);
			expect(child.id).toBe(world.seed.child1.id);
			expect(child.title).toBe('Child one (in new)');
			expect(child.parentId).toBe(world.seed.parent.id);
			expect([...(child.labels ?? [])].sort()).toEqual(['y', 'z']);

			const parent = await world.wrapped.backend.get(world.seed.parent.id);
			expect(parent.title).toBe('Parent');

			const made = await world.wrapped.backend.get(world.rows.made.publicId);
			expect(made.id).toBe(world.rows.made.publicId);
			expect(made.parentId).toBe(world.seed.parent.id);
		});

		it('refuses an unknown id and a deleted one as not found', async () => {
			expect(await rejection(world.wrapped.backend.get('nope'))).toBeInstanceOf(TaskNotFoundError);
			expect(await rejection(world.wrapped.backend.get(world.seed.child2.id))).toBeInstanceOf(TaskNotFoundError);
			expect(await rejection(world.wrapped.backend.resolve(world.seed.child2.id))).toBeInstanceOf(
				TaskNotFoundError
			);
			expect(await rejection(world.wrapped.backend.findByPrefix(world.seed.child2.id))).toBeInstanceOf(
				TaskNotFoundError
			);
		});

		it('answers getMany in the order asked, across both sides', async () => {
			const found = await world.wrapped.backend.getMany([
				world.rows.made.publicId,
				world.seed.loose.id,
				world.seed.child1.id,
			]);

			expect(found.map(task => task.title)).toEqual(['Made in new', 'Loose', 'Child one (in new)']);
		});

		it('getMany fails on the first id that is missing or deleted', async () => {
			const error = await rejection(world.wrapped.backend.getMany([world.seed.loose.id, world.seed.child2.id]));
			expect(error).toBeInstanceOf(TaskNotFoundError);
			expect((error as TaskNotFoundError).taskId).toBe(world.seed.child2.id);
		});

		it('resolves an id, and a unique prefix of one, to the authoritative copy', async () => {
			const exact = await world.wrapped.backend.findByPrefix(world.seed.child1.id);
			expect(exact.title).toBe('Child one (in new)');
			expect(exact.id).toBe(world.seed.child1.id);

			const resolved = await world.wrapped.backend.resolve(world.seed.child1.id);
			expect(resolved.title).toBe('Child one (in new)');
			expect(resolved.id).toBe(world.seed.child1.id);

			const prefixOf = (id: string): string => (id.length > 2 ? id.slice(0, -1) : id);
			const byPrefix = await world.wrapped.backend.findByPrefix(prefixOf(world.rows.made.publicId));
			expect(byPrefix.title).toBe('Made in new');
			const looseByPrefix = await world.wrapped.backend.resolve(prefixOf(world.seed.loose.id));
			expect(looseByPrefix.title).toBe('Loose');
		});

		it('answers a prefix that matches several tasks as ambiguous, listing the public ids', async () => {
			// Two tasks in new answer to public ids that start the same way.
			const first = await createInNew(pair, { title: 'Twin one' });
			const second = await createInNew(pair, { title: 'Twin two' });
			const rows = [
				...world.wrapped.index.snapshot().rows,
				{ ...first, publicId: 'zz-1' },
				{ ...second, publicId: 'zz-2' },
			];
			world.wrapped.index.mutate(() => rows);

			const error = await rejection(world.wrapped.backend.findByPrefix('zz-'));

			expect(error).toBeInstanceOf(AmbiguousTaskPrefixError);
			expect((error as AmbiguousTaskPrefixError).matches.sort()).toEqual(['zz-1', 'zz-2']);
			expect(await rejection(world.wrapped.backend.resolve('zz-'))).toBeInstanceOf(AmbiguousTaskPrefixError);
		});

		it('merges the relations of both sides: a link to a task that moved shows the task as it is in the new side', async () => {
			const blockers = (await world.wrapped.backend.getLinks(world.seed.loose.id)).blockedBy;

			expect(blockers).toHaveLength(1);
			expect(blockers[0]?.id).toBe(world.seed.child1.id);
			expect(blockers[0]?.title).toBe('Child one (in new)');
			expect(blockers[0]?.status).toBe('in-progress');
		});

		it('merges the inverse relations: what current says is blocked by a task that moved is still seen, and so is what new says', async () => {
			// The task made in new is blocked by the copy of Child one in new; Loose (in current) is blocked by Child one too.
			await pair.bRaw.addLink(world.rows.made.b!, 'blockedBy', world.rows.child1.b!);

			const links = await world.wrapped.backend.getLinks(world.seed.child1.id);

			expect(links.blocks.map(task => task.id).sort()).toEqual(
				[world.seed.loose.id, world.rows.made.publicId].sort()
			);

			const made = await world.wrapped.backend.get(world.rows.made.publicId);
			expect(made.links).toEqual([{ type: 'blockedBy', target: world.seed.child1.id }]);
			expect((await world.wrapped.backend.getLinks(world.rows.made.publicId)).blockedBy.map(t => t.id)).toEqual([
				world.seed.child1.id,
			]);
		});

		it('ignores what the stale copy of a task says about a relation when another copy is authoritative', async () => {
			// The stale copy in current of Child one is blocked by Loose in no way; make current claim it is blocked by Parent.
			await pair.a.addLink(world.seed.child1.id, 'blockedBy', world.seed.parent.id);

			const links = await world.wrapped.backend.getLinks(world.seed.child1.id);

			expect(links.blockedBy).toEqual([]);
			const parentLinks = await world.wrapped.backend.getLinks(world.seed.parent.id);
			expect(parentLinks.blocks).toEqual([]);
		});

		it('tells the open blockers and what a closing task unblocks from the authoritative status', async () => {
			expect(
				(await world.wrapped.backend.getOpenBlockers(world.seed.loose.id, isTerminal)).map(t => t.id)
			).toEqual([world.seed.child1.id]);
			expect(await world.wrapped.backend.getUnblockedBy(world.seed.child1.id, isTerminal)).toEqual([]);

			await pair.bRaw.updateStatus(world.rows.child1.b!, 'done');

			expect(await world.wrapped.backend.getOpenBlockers(world.seed.loose.id, isTerminal)).toEqual([]);
			expect(
				(await world.wrapped.backend.getUnblockedBy(world.seed.child1.id, isTerminal)).map(t => t.id)
			).toEqual([world.seed.loose.id]);
		});

		it('reads the links of a deleted task as not found', async () => {
			expect(await rejection(world.wrapped.backend.getLinks(world.seed.child2.id))).toBeInstanceOf(
				TaskNotFoundError
			);
			expect(await rejection(world.wrapped.backend.getLinksLenient(world.seed.child2.id))).toBeInstanceOf(
				TaskNotFoundError
			);
		});

		it('builds the hierarchy over both sides: children, tree, descendants, ancestors, full tree, forest', async () => {
			const { backend } = world.wrapped;
			const { parent, child1, loose } = world.seed;

			expect(titles(await backend.getChildren(parent.id))).toEqual(['Child one (in new)', 'Made in new']);
			expect(flat(await backend.getTree(parent.id))).toEqual(['Child one (in new)', 'Made in new', 'Parent']);
			expect(titles(await backend.getDescendants(parent.id))).toEqual(['Child one (in new)', 'Made in new']);
			expect((await backend.getAncestors(child1.id)).map(t => t.id)).toEqual([parent.id]);
			expect((await backend.getAncestors(world.rows.made.publicId)).map(t => t.id)).toEqual([parent.id]);

			const full = await backend.getFullTree(world.rows.made.publicId);
			expect(full.id).toBe(parent.id);
			const selected = full.children.find(node => node.selected === true);
			expect(selected?.id).toBe(world.rows.made.publicId);

			const forest = await backend.getForest();
			expect(forest.map(node => node.id).sort()).toEqual([loose.id, parent.id].sort());
			expect((await backend.getForest({ parentId: parent.id })).map(node => node.title).sort()).toEqual([
				'Child one (in new)',
				'Made in new',
			]);
			const filtered = await backend.getForest({ predicate: task => task.title === 'Made in new' });
			expect(filtered.map(node => node.id)).toEqual([parent.id]);
			expect(filtered[0]?.children.map(node => node.title)).toEqual(['Made in new']);
		});

		it('refuses a tree or a forest under an unknown or deleted task as not found, and gives such a task no ancestors, as current does', async () => {
			const { backend } = world.wrapped;
			for (const id of ['nope', world.seed.child2.id]) {
				expect(await rejection(backend.getTree(id))).toBeInstanceOf(TaskNotFoundError);
				expect(await rejection(backend.getForest({ parentId: id }))).toBeInstanceOf(TaskNotFoundError);
				expect(await backend.getAncestors(id)).toEqual([]);
			}
		});

		it('filters a page by the status the task has where it is authoritative', async () => {
			const page = await world.wrapped.backend.listPage({ statusIn: ['in-progress'] });

			// Child two is in-progress in current but deleted; the stale copy of Child one in current is backlog.
			expect(page.items.map(task => task.id)).toEqual([world.seed.child1.id]);
		});

		it('filters a page by parent, root tasks and text across both sides', async () => {
			const { backend } = world.wrapped;
			const { parent, loose } = world.seed;

			expect(titles((await backend.listPage({ parentId: parent.id })).items)).toEqual([
				'Child one (in new)',
				'Made in new',
			]);
			expect(titles((await backend.listPage({ parentId: null })).items)).toEqual(['Loose', 'Parent']);
			expect(titles((await backend.listPage({ text: 'new' })).items)).toEqual([
				'Child one (in new)',
				'Made in new',
			]);
			expect(titles((await backend.listPage({ text: 'loos' })).items)).toEqual(['Loose']);
			expect(loose.id).toBeDefined();
		});

		it('pages a merged listing with a cursor, each task once, and refuses a cursor it did not give', async () => {
			const { backend } = world.wrapped;
			const seen: string[] = [];
			let cursor: string | undefined;
			let pages = 0;
			do {
				const page = await backend.listPage({ limit: 3, ...(cursor === undefined ? {} : { cursor }) });
				seen.push(...page.items.map(task => task.id));
				cursor = page.nextCursor;
				pages++;
			} while (cursor !== undefined && pages < 5);

			expect(pages).toBe(2);
			expect(seen).toHaveLength(4);
			expect(new Set(seen).size).toBe(4);

			const error = await rejection(backend.listPage({ cursor: 'garbage' }));
			expect(error).toBeInstanceOf(BackendRejectedError);
			expect((error as Error).message).toContain('cursor');
		});

		it('counts labels over the copies that are authoritative only', async () => {
			// current: x on Child one and Child two. Child one is in new with y and z; Child two is deleted; Made in new has z.
			const counts = await world.wrapped.backend.listLabels();

			expect(counts).toEqual([
				{ label: 'z', count: 2 },
				{ label: 'y', count: 1 },
			]);
		});
	});

	describe('an index that does not match the stores is a loud error', () => {
		it('names the task, the side and the id when new has no task the index sends there', async () => {
			const seed = await seedCurrent(pair.a);
			const wrapped = wrap(pair);
			seedRows(wrapped, [
				{
					publicId: seed.parent.id,
					a: seed.parent.id,
					b: 'ghost',
					state: 'in-b',
					since: '2026-11-15T10:00:00.000Z',
					version: 1,
				},
			]);

			for (const call of [() => wrapped.backend.get(seed.parent.id), () => wrapped.backend.list()]) {
				const error = await rejection(call());
				expect(error).toBeInstanceOf(BackendDataError);
				expect((error as Error).message).toContain(seed.parent.id);
				expect((error as Error).message).toContain('ghost');
				expect((error as BackendDataError).hint).toContain('rebuild');
			}
		});

		it('names the task and the id when current has no task the index keeps there', async () => {
			const seed = await seedCurrent(pair.a);
			const row = await copyToNew(pair, seed.parent, { state: 'moving' });
			const wrapped = wrap(pair);
			seedRows(wrapped, [
				row,
				{ publicId: 'missing1', a: 'missing1', state: 'in-a', since: '2026-11-15T10:00:00.000Z', version: 1 },
			]);

			const error = await rejection(wrapped.backend.list());

			expect(error).toBeInstanceOf(BackendDataError);
			expect((error as Error).message).toContain('missing1');
		});

		it('refuses a relation that points to a task of new the index does not know, naming it', async () => {
			const seed = await seedCurrent(pair.a);
			const unknown = await pair.bRaw.create({ title: 'Nobody indexed me', status: 'backlog' });
			const row = await createInNew(pair, { title: 'Orphan', parentB: unknown.id });
			const wrapped = wrap(pair);
			seedRows(wrapped, [row]);

			const error = await rejection(wrapped.backend.get(row.publicId));

			expect(error).toBeInstanceOf(BackendDataError);
			expect((error as Error).message).toContain(unknown.id);
			expect((error as BackendDataError).hint).toContain('rebuild');
			expect(seed.parent.id).toBeDefined();
		});

		it('refuses two tasks that answer to the same public id', async () => {
			const seed = await seedCurrent(pair.a);
			const made = await pair.bRaw.create({ title: 'Collides', status: 'backlog' });
			const wrapped = wrap(pair);
			seedRows(wrapped, [
				{ publicId: seed.parent.id, b: made.id, state: 'in-b', since: '2026-11-15T10:00:00.000Z', version: 1 },
			]);

			// The row says Parent is in new only, yet current still lists a task with that very id and no row of its own.
			const error = await rejection(wrapped.backend.list());

			expect(error).toBeInstanceOf(BackendDataError);
			expect((error as Error).message).toContain(seed.parent.id);
		});

		it('a damaged index fails every read, names the file and rewrites nothing', async () => {
			await seedCurrent(pair.a);
			const wrapped = wrap(pair);
			wrapped.files.text = '{ broken';

			for (const call of [
				() => wrapped.backend.list(),
				() => wrapped.backend.get('x'),
				() => wrapped.backend.getForest(),
				() => wrapped.backend.listLabels(),
			]) {
				const error = await rejection(call());
				expect(error).toBeInstanceOf(BackendDataError);
				expect((error as Error).message).toContain('index.json');
			}
			expect(wrapped.files.text).toBe('{ broken');
		});
	});

	describe('writes are not routed yet (phase P2): none goes where it would be wrong', () => {
		it('keeps creating in current, and the new task is listed with the others', async () => {
			const world = await mixedWorld(pair);

			const created = await world.wrapped.backend.create({ title: 'Brand new', status: 'backlog' });

			expect((await pair.a.get(created.id)).title).toBe('Brand new');
			expect(titles(await world.wrapped.backend.list())).toContain('Brand new');
		});

		it('keeps writing to a task that is in current only', async () => {
			const world = await mixedWorld(pair);

			const changed = await world.wrapped.backend.setTitle(world.seed.loose.id, 'Loose renamed');

			expect(changed.title).toBe('Loose renamed');
			expect((await pair.a.get(world.seed.loose.id)).title).toBe('Loose renamed');
		});

		it.each([
			['moving', (w: World) => w.seed.parent.id],
			['in-b', (w: World) => w.seed.child1.id],
			['made in new', (w: World) => w.rows.made.publicId],
		])('refuses a write to a task that is %s, naming the state, and changes nothing', async (_name, pick) => {
			const world = await mixedWorld(pair);
			const id = pick(world);
			const before = (await world.wrapped.backend.get(id)).title;

			const error = await rejection(world.wrapped.backend.setTitle(id, 'Changed'));

			expect(error).toBeInstanceOf(BackendRejectedError);
			expect((error as BackendRejectedError).backendKind).toBe('migrating');
			expect((error as Error).message).toContain(id);
			expect((error as BackendRejectedError).hint).toContain('phase');
			expect((await world.wrapped.backend.get(id)).title).toBe(before);
		});

		it('refuses a write that names such a task as parent or as link target', async () => {
			const world = await mixedWorld(pair);

			expect(
				await rejection(
					world.wrapped.backend.create({ title: 'Child', status: 'backlog', parentId: world.seed.child1.id })
				)
			).toBeInstanceOf(BackendRejectedError);
			expect(
				await rejection(world.wrapped.backend.setParent(world.seed.loose.id, world.seed.child1.id))
			).toBeInstanceOf(BackendRejectedError);
			expect(
				await rejection(world.wrapped.backend.addLink(world.seed.loose.id, 'blockedBy', world.seed.parent.id))
			).toBeInstanceOf(BackendRejectedError);
		});

		it('answers a write to a deleted task as not found', async () => {
			const world = await mixedWorld(pair);

			expect(await rejection(world.wrapped.backend.setTitle(world.seed.child2.id, 'x'))).toBeInstanceOf(
				TaskNotFoundError
			);
		});
	});
});
