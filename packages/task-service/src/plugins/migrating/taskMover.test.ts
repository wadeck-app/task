import { readIdentity } from './identityBlock.js';
import { PAIR_KINDS, seedCurrent, wrap } from './testHelpers.js';
import type { Pair, Seed, Wrapped } from './testHelpers.js';

const ACCEPT_ALL = { acceptedLosses: ['all'] };
const FUTURE = '2098-01-01T00:30:00.000Z';
const NOW = '2098-01-01T00:00:00.000Z';

interface WalLine {
	task: string;
	event: string;
	step?: string;
	phase?: string;
	outcome?: string;
}

describe.each(PAIR_KINDS)('moveTask, the state machine of one task: $name', kind => {
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

	const rowOf = (id: string) => wrapped.index.snapshot().byPublicId(id);
	const bWrites = (): string[] =>
		wrapped.faults.calls.filter(
			call =>
				call.startsWith('b:') &&
				/:(create|createMigrated|set|add|remove|update|clear|delete|claim|release)/.test(call)
		);
	const fileText = (suffix: string): string =>
		[...wrapped.wal.texts.entries()].find(([file]) => file.endsWith(suffix))?.[1] ?? '';
	const walLines = (): WalLine[] =>
		fileText('wal.ndjson')
			.split('\n')
			.filter(line => line !== '')
			.map(line => JSON.parse(line) as WalLine);

	it('moves a task: a copy in new with the identity block, authority switched, the copy in current kept, relations translated', async () => {
		// Relation targets without a copy make a copy wait; order them the way a worker would.
		expect((await wrapped.backend.moves.moveTask(seed.loose.id, ACCEPT_ALL)).outcome).toBe('deferred');
		expect(rowOf(seed.loose.id)).toMatchObject({ state: 'moving', stale: true });
		expect((await wrapped.backend.moves.moveTask(seed.child1.id, ACCEPT_ALL)).outcome).toBe('deferred');
		expect((await wrapped.backend.moves.moveTask(seed.parent.id, ACCEPT_ALL)).outcome).toBe('moved');
		expect((await wrapped.backend.moves.moveTask(seed.child1.id, ACCEPT_ALL)).outcome).toBe('moved');
		expect((await wrapped.backend.moves.moveTask(seed.loose.id, ACCEPT_ALL)).outcome).toBe('moved');

		const row = rowOf(seed.child1.id)!;
		expect(row.state).toBe('in-b');
		expect(row.stale).toBeUndefined();
		const identity = readIdentity((await pair.bRaw.resolve(row.b!)).meta, 'copy');
		expect(identity).toMatchObject({ publicId: seed.child1.id, fromId: seed.child1.id, authority: 'new' });
		const read = await wrapped.backend.get(seed.child1.id);
		expect(read.id).toBe(seed.child1.id);
		expect(read.title).toBe('Child one');
		expect(read.parentId).toBe(seed.parent.id);
		expect([...(read.labels ?? [])].sort()).toEqual(['x', 'y']);
		expect((await wrapped.backend.getLinks(seed.loose.id)).blockedBy.map(task => task.id)).toEqual([
			seed.child1.id,
		]);
		// Decision D17: the copy in current is kept.
		expect((await pair.a.get(seed.child1.id)).title).toBe('Child one');
		expect(wrapped.journal.openTransactions()).toEqual([]);
	});

	it('logs every step before it is applied, in order, in the write-ahead log and the human log', async () => {
		await wrapped.backend.moves.moveTask(seed.parent.id, ACCEPT_ALL);

		const mine = walLines().filter(entry => entry.task === seed.parent.id);
		const intents = mine
			.filter(entry => entry.event === 'step' && entry.phase === 'intent')
			.map(entry => entry.step);
		expect(intents).toEqual(['copy', 'index', 'catch-up', 'verify', 'marker', 'switch']);
		for (const step of intents) {
			const intent = mine.findIndex(entry => entry.step === step && entry.phase === 'intent');
			const done = mine.findIndex(entry => entry.step === step && entry.phase === 'done');
			expect(done, `${step} done`).toBeGreaterThan(intent);
		}
		expect(mine.filter(entry => entry.event === 'end').map(entry => entry.outcome)).toEqual(['moved']);
		expect(fileText('log.ndjson')).toContain(`move ${seed.parent.id}: switch on index`);
	});

	it('says already-moved the second time, and writes nothing', async () => {
		await wrapped.backend.moves.moveTask(seed.parent.id, ACCEPT_ALL);
		const before = bWrites().length;

		expect((await wrapped.backend.moves.moveTask(seed.parent.id, ACCEPT_ALL)).outcome).toBe('already-moved');
		expect(bWrites()).toHaveLength(before);
	});

	it('leaves a claimed task where it is: skipped-claimed, nothing written to new, not an error', async () => {
		await pair.a.claim!(seed.parent.id, { assignee: 'w1', leaseUntil: FUTURE, now: NOW });
		const before = bWrites().length;

		const outcome = await wrapped.backend.moves.moveTask(seed.parent.id, ACCEPT_ALL);

		expect(outcome).toEqual({ outcome: 'skipped-claimed', leaseUntil: FUTURE });
		expect(bWrites()).toHaveLength(before);
		expect(rowOf(seed.parent.id)).toBeUndefined();
		expect(wrapped.journal.openTransactions()).toEqual([]);
	});

	it('does not move a task whose losses are not accepted: nothing written, the fix named', async () => {
		const before = bWrites().length;

		const outcome = await wrapped.backend.moves.moveTask(seed.child2.id, { acceptedLosses: [] });

		expect(outcome.outcome).toBe('blocked-losses');
		if (outcome.outcome !== 'blocked-losses') throw new Error('unreachable');
		expect(outcome.losses.length).toBeGreaterThan(0);
		expect(outcome.losses.every(loss => loss.fix !== '')).toBe(true);
		expect(bWrites()).toHaveLength(before);
		expect(rowOf(seed.child2.id)).toBeUndefined();
	});

	it('keeps a task moving when a lease appears before the switch', async () => {
		expect((await wrapped.backend.moves.moveTask(seed.child1.id, ACCEPT_ALL)).outcome).toBe('deferred');
		await pair.a.claim!(seed.child1.id, { assignee: 'w1', leaseUntil: FUTURE, now: NOW });

		const outcome = await wrapped.backend.moves.moveTask(seed.child1.id, ACCEPT_ALL);

		expect(outcome.outcome).toBe('skipped-claimed');
		expect(rowOf(seed.child1.id)?.state).toBe('moving');
	});

	describe('catchUp', () => {
		it('brings a stale copy equal and clears the flag, without switching authority', async () => {
			expect((await wrapped.backend.moves.moveTask(seed.child1.id, ACCEPT_ALL)).outcome).toBe('deferred');
			await wrapped.backend.moves.moveTask(seed.parent.id, ACCEPT_ALL);
			// current changes behind the copy's back (another process, a failed mirror).
			await pair.a.setTitle(seed.child1.id, 'Renamed in current');

			const outcome = await wrapped.backend.moves.catchUp(seed.child1.id, ACCEPT_ALL);

			expect(outcome).toEqual({ outcome: 'caught-up' });
			const row = rowOf(seed.child1.id)!;
			expect(row.state).toBe('moving');
			expect(row.stale).toBeUndefined();
			expect((await pair.bRaw.get(row.b!)).title).toBe('Renamed in current');
		});

		it('says not-moving for a task that is not moving', async () => {
			expect(await wrapped.backend.moves.catchUp(seed.loose.id)).toEqual({
				outcome: 'not-moving',
				state: 'in-a',
			});
		});
	});
});
