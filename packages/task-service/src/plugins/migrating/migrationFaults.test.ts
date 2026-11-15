import { TaskNotFoundError } from '@wadeck-app/task-core';
import type { VersionedRecord } from '@wadeck-app/task-core';

import { readIdentity } from './identityBlock.js';
import { rebuildIndex } from './rebuildIndex.js';
import { PAIR_KINDS, wrap } from './testHelpers.js';
import type { FaultOptions, Pair, Wrapped } from './testHelpers.js';

// The fault matrix of the migrating strategy: a fault (a crash, a refused or a lost answer of a side, a full disk for the routing index
// or the write-ahead log) at EVERY boundary of a move, of a person's write to a task that is moving, of a creation and of a deletion, over
// two pairs of sides. After each one the process "restarts" (a new wrapper over the same stores, index file and logs), the recovery runs,
// and the invariants of a database must hold: no task lost, no task twice, the public id stable, reads return the latest write that was
// acknowledged, nothing left open in the write-ahead log, and the index rebuilt from the stores alone agrees with the index.
const ACCEPT_ALL = { acceptedLosses: ['all'] };

class Crash extends Error {
	constructor(readonly boundary: string) {
		super(`simulated crash at ${boundary}`);
	}
}

const crashAt =
	(target: string) =>
	(name: string): void => {
		if (name === target) throw new Crash(name);
	};

/** A fault: where it hits, armed on the wrapper (and the files) before the operation. */
interface Fault {
	name: string;
	boundary?: string;
	arm?: (w: Wrapped, pair: Pair) => void;
}

const store = (side: 'a' | 'b', methods: string[], options: FaultOptions = {}): Fault['arm'] => {
	return (w): void => {
		for (const method of methods) w.faults.failOn(side, method, options);
	};
};

const CREATES = ['create', 'createMigrated'];

describe.each(PAIR_KINDS)('fault matrix: $name', kind => {
	let pair: Pair;

	beforeEach(async () => {
		pair = await kind.open();
	});

	afterEach(async () => {
		await pair.dispose();
	});

	/** The process died: a new wrapper over the same stores, index file and logs, with no fault armed, then the recovery. */
	async function restart(from: Wrapped): Promise<Wrapped> {
		from.files.failWrites = 0;
		from.files.skipWrites = 0;
		from.wal.failAppend.clear();
		from.wal.skipAppends = 0;
		const next = wrap(pair, { files: from.files, wal: from.wal });
		const report = await next.backend.moves.recover();
		expect(report.unsettled, 'recovery left something unsettled').toEqual([]);
		expect(next.journal.openTransactions(), 'the write-ahead log still has open transactions').toEqual([]);
		return next;
	}

	/** The invariants of every state the project can be left in. */
	async function invariants(w: Wrapped, present: readonly string[]): Promise<void> {
		const listed = (await w.backend.list()).map(task => task.id);
		expect(new Set(listed).size, `a task is listed twice: ${listed.join(', ')}`).toBe(listed.length);
		for (const id of present) {
			expect(listed, `task ${id} is lost from the listing`).toContain(id);
			expect((await w.backend.get(id)).id, `public id of ${id} changed`).toBe(id);
		}
		// No two copies in new claim to be the same task.
		const origins = new Map<string, number>();
		for (const summary of await pair.bRaw.list()) {
			const identity = readIdentity((await pair.bRaw.resolve(summary.id)).meta, `task ${summary.id} in new`);
			if (identity === undefined) continue;
			origins.set(identity.publicId, (origins.get(identity.publicId) ?? 0) + 1);
		}
		for (const [publicId, count] of origins) expect(count, `two copies in new of task ${publicId}`).toBe(1);
		// The index rebuilt from the stores agrees with the index on every task that has a copy in new.
		const report = await rebuildIndex({ current: pair.a, next: pair.bRaw });
		expect(report.unindexed, 'a task of new has no identity block').toEqual([]);
		const snapshot = w.index.snapshot();
		for (const rebuilt of report.rows) {
			const row = snapshot.byPublicId(rebuilt.publicId);
			expect(row, `task ${rebuilt.publicId} has a copy in new but no routing row`).toBeDefined();
			if (row!.state === 'deleted') continue;
			expect(row!.state === 'in-b' ? 'in-b' : 'moving', `state of ${rebuilt.publicId}`).toBe(rebuilt.state);
			expect(row!.b).toBe(rebuilt.b);
		}
		for (const row of snapshot.rows) {
			if (row.state === 'in-b')
				expect(origins.has(row.publicId), `row in-b of ${row.publicId} has no copy`).toBe(true);
		}
	}

	async function solo(): Promise<VersionedRecord> {
		const created = await pair.a.create({ title: 'Solo', status: 'backlog' });
		await pair.a.addLabel(created.id, 'x');
		return pair.a.get(created.id);
	}

	/** The task as a move leaves it before the switch: the copy exists, equal to the task, the row says `moving` (through the real code). */
	async function moving(task: VersionedRecord): Promise<Wrapped> {
		const dying = wrap(pair, { boundary: crashAt('move:marker') });
		await attempt(() => dying.backend.moves.moveTask(task.id, ACCEPT_ALL));
		const base = await restart(dying);
		expect(await base.backend.moves.catchUp(task.id, ACCEPT_ALL)).toEqual({ outcome: 'caught-up' });
		expect(base.index.snapshot().byPublicId(task.id)).toMatchObject({ state: 'moving' });
		return base;
	}

	/** The task after its move. */
	async function inB(task: VersionedRecord): Promise<Wrapped> {
		const base = wrap(pair);
		expect((await base.backend.moves.moveTask(task.id, ACCEPT_ALL)).outcome).toBe('moved');
		return base;
	}

	const reopen = (base: Wrapped, boundary?: string): Wrapped =>
		wrap(pair, {
			files: base.files,
			wal: base.wal,
			...(boundary === undefined ? {} : { boundary: crashAt(boundary) }),
		});

	const attempt = async (call: () => Promise<unknown>): Promise<{ ok: boolean; value?: unknown }> => {
		try {
			return { ok: true, value: await call() };
		} catch {
			return { ok: false };
		}
	};

	// ---- a move ----

	const MOVE_FAULTS: Fault[] = [
		...[
			'move:read',
			'move:copy',
			'move:index-moving',
			'move:catch-up',
			'move:marker',
			'move:switch',
			'move:end',
		].map((boundary): Fault => ({ name: `crash at ${boundary}`, boundary })),
		{ name: 'current cannot be read (first read)', arm: store('a', ['get']) },
		{ name: 'current cannot be read (read of the catch-up)', arm: store('a', ['get'], { nth: 2 }) },
		{ name: 'current cannot be read (read of the marker step)', arm: store('a', ['get'], { nth: 4 }) },
		{ name: 'new refuses the creation of the copy', arm: store('b', CREATES) },
		{ name: 'new creates the copy and the answer is lost', arm: store('b', CREATES, { applied: true }) },
		{ name: 'new cannot write the hash marker', arm: store('b', ['setMeta']) },
		{ name: 'new writes the hash marker and the answer is lost', arm: store('b', ['setMeta'], { applied: true }) },
		{ name: 'new cannot write the authority marker', arm: store('b', ['setMeta'], { nth: 2 }) },
		{ name: 'the routing index cannot be written (moving row)', arm: w => (w.files.failWrites = 1) },
		{
			name: 'the routing index cannot be written (the switch)',
			arm: w => ((w.files.skipWrites = 1), (w.files.failWrites = 1)),
		},
		{ name: 'the write-ahead log is full from the start', arm: w => w.wal.failAppend.add('wal.ndjson') },
		...[1, 2, 3, 4, 5, 6, 8].map((after): Fault => ({
			name: `the write-ahead log is full after ${after} lines`,
			arm: w => {
				w.wal.failAppend.add('wal.ndjson');
				w.wal.skipAppends = after;
			},
		})),
	];

	it.each(MOVE_FAULTS)('a move survives: $name', async fault => {
		const task = await solo();
		const w1 = wrap(pair, fault.boundary === undefined ? {} : { boundary: crashAt(fault.boundary) });
		fault.arm?.(w1, pair);
		await attempt(() => w1.backend.moves.moveTask(task.id, ACCEPT_ALL));

		const w2 = await restart(w1);
		await invariants(w2, [task.id]);
		expect((await w2.backend.get(task.id)).title).toBe('Solo');

		const outcome = await w2.backend.moves.moveTask(task.id, ACCEPT_ALL);
		expect(outcome.outcome === 'moved' || outcome.outcome === 'already-moved', JSON.stringify(outcome)).toBe(true);
		await invariants(w2, [task.id]);
		const row = w2.index.snapshot().byPublicId(task.id)!;
		expect(row.state).toBe('in-b');
		expect((await pair.bRaw.get(row.b!)).title).toBe('Solo');
		expect(readIdentity((await pair.bRaw.resolve(row.b!)).meta, 'copy')?.authority).toBe('new');
		expect((await pair.a.get(task.id)).title).toBe('Solo');
		// A second restart changes nothing.
		const w3 = await restart(w2);
		await invariants(w3, [task.id]);
		expect(w3.index.snapshot().byPublicId(task.id)?.state).toBe('in-b');
	});

	// ---- a person's write while the task moves ----

	const WRITE_FAULTS: Fault[] = [
		{ name: 'crash before current is written', boundary: 'write:apply' },
		{ name: 'crash after current is written, before the mirror', boundary: 'write:mirror' },
		{ name: 'current refuses the write', arm: store('a', ['setTitle']) },
		{ name: 'current applies the write and the answer is lost', arm: store('a', ['setTitle'], { applied: true }) },
		{ name: 'new refuses the mirror', arm: store('b', ['setTitle']) },
		{ name: 'new applies the mirror and the answer is lost', arm: store('b', ['setTitle'], { applied: true }) },
		{
			name: 'new refuses the mirror and the routing index cannot record the stale flag',
			arm: (w): void => {
				w.faults.failOn('b', 'setTitle');
				w.files.failWrites = 1;
			},
		},
		{
			name: 'the write-ahead log is full after the first lines',
			arm: w => {
				w.wal.failAppend.add('wal.ndjson');
				w.wal.skipAppends = 2;
			},
		},
	];

	it.each(WRITE_FAULTS)('a write to a moving task survives: $name', async fault => {
		const task = await solo();
		const w1 = reopen(await moving(task), fault.boundary);
		fault.arm?.(w1, pair);
		const written = await attempt(() => w1.backend.setTitle(task.id, 'Latest'));

		const w2 = await restart(w1);
		await invariants(w2, [task.id]);
		const title = (await w2.backend.get(task.id)).title;
		expect(['Solo', 'Latest']).toContain(title);
		if (written.ok) expect(title, 'an acknowledged write was lost').toBe('Latest');

		const outcome = await w2.backend.moves.moveTask(task.id, ACCEPT_ALL);
		expect(outcome.outcome === 'moved', JSON.stringify(outcome)).toBe(true);
		const row = w2.index.snapshot().byPublicId(task.id)!;
		expect((await pair.bRaw.get(row.b!)).title, 'the copy does not follow the task').toBe(title);
		expect((await w2.backend.get(task.id)).title).toBe(title);
		await invariants(w2, [task.id]);
	});

	it.each([
		{ name: 'new refuses the write', arm: store('b', ['setTitle']) },
		{ name: 'new applies the write and the answer is lost', arm: store('b', ['setTitle'], { applied: true }) },
	])('a write to a task of new survives: $name', async fault => {
		const task = await solo();
		const w1 = reopen(await inB(task));
		fault.arm?.(w1, pair);
		const written = await attempt(() => w1.backend.setTitle(task.id, 'Latest'));

		const w2 = await restart(w1);
		await invariants(w2, [task.id]);
		const title = (await w2.backend.get(task.id)).title;
		if (written.ok) expect(title).toBe('Latest');
		expect(['Solo', 'Latest']).toContain(title);
		// current keeps its copy, untouched by a write to new (decision D17).
		expect((await pair.a.get(task.id)).title).toBe('Solo');
	});

	// ---- a creation ----

	const CREATE_FAULTS: Fault[] = [
		...['create:apply', 'create:identity', 'create:index', 'create:done'].map((boundary): Fault => ({
			name: `crash at ${boundary}`,
			boundary,
		})),
		{ name: 'new refuses the creation', arm: store('b', CREATES) },
		{ name: 'new creates the task and the answer is lost', arm: store('b', CREATES, { applied: true }) },
		{ name: 'new cannot write the first identity entry', arm: store('b', ['setMeta']) },
		{ name: 'new cannot write the last identity entry', arm: store('b', ['setMeta'], { nth: 3 }) },
		{ name: 'the routing index cannot be written', arm: w => (w.files.failWrites = 1) },
		{
			name: 'the write-ahead log is full after the first lines',
			arm: w => {
				w.wal.failAppend.add('wal.ndjson');
				w.wal.skipAppends = 2;
			},
		},
	];

	it.each(CREATE_FAULTS)('a creation survives: $name', async fault => {
		const w1 = wrap(pair, fault.boundary === undefined ? {} : { boundary: crashAt(fault.boundary) });
		fault.arm?.(w1, pair);
		const created = await attempt(() => w1.backend.create({ title: 'Fresh', status: 'backlog' }));

		const w2 = await restart(w1);
		const fresh = (await w2.backend.list()).filter(task => task.title === 'Fresh');
		expect(fresh.length, 'the creation made the task twice').toBeLessThanOrEqual(1);
		if (created.ok) expect(fresh, 'an acknowledged creation was lost').toHaveLength(1);
		await invariants(
			w2,
			fresh.map(task => task.id)
		);
		// The project still takes new tasks, and they are routed.
		const another = await w2.backend.create({ title: 'Another', status: 'backlog' });
		expect((await w2.backend.get(another.id)).title).toBe('Another');
	});

	// ---- a deletion ----

	const DELETE_FAULTS: Array<Fault & { state: 'moving' | 'in-b' }> = [
		...['delete:apply', 'delete:index', 'delete:copy'].flatMap(boundary =>
			(['moving', 'in-b'] as const).map((state): Fault & { state: 'moving' | 'in-b' } => ({
				name: `${state}: crash at ${boundary}`,
				boundary,
				state,
			}))
		),
		{ name: 'moving: current refuses the deletion', arm: store('a', ['deleteTask']), state: 'moving' },
		{
			name: 'moving: current deletes and the answer is lost',
			arm: store('a', ['deleteTask'], { applied: true }),
			state: 'moving',
		},
		{ name: 'moving: the copy cannot be deleted', arm: store('b', ['deleteTask']), state: 'moving' },
		{ name: 'in-b: new refuses the deletion', arm: store('b', ['deleteTask']), state: 'in-b' },
		{
			name: 'in-b: new deletes and the answer is lost',
			arm: store('b', ['deleteTask'], { applied: true }),
			state: 'in-b',
		},
		{ name: 'moving: the routing index cannot be written', arm: w => (w.files.failWrites = 1), state: 'moving' },
		{ name: 'in-b: the routing index cannot be written', arm: w => (w.files.failWrites = 1), state: 'in-b' },
	];

	it.each(DELETE_FAULTS)('a deletion survives: $name', async fault => {
		const task = await solo();
		const base = fault.state === 'moving' ? await moving(task) : await inB(task);
		const w1 = reopen(base, fault.boundary);
		fault.arm?.(w1, pair);
		const deleted = await attempt(() => w1.backend.deleteTask(task.id));

		const w2 = await restart(w1);
		let gone = false;
		try {
			await w2.backend.get(task.id);
		} catch (error) {
			if (!(error instanceof TaskNotFoundError)) throw error;
			gone = true;
		}
		if (deleted.ok && deleted.value === true) expect(gone, 'an acknowledged deletion came back').toBe(true);
		const listed = (await w2.backend.list()).map(summary => summary.id);
		expect(listed.includes(task.id), 'listing and get disagree').toBe(!gone);
		await invariants(w2, gone ? [] : [task.id]);
		if (gone) {
			// The copy in new is gone with it: nothing can come back by a rebuild.
			expect((await pair.bRaw.list()).length).toBe(0);
		}
	});
});
