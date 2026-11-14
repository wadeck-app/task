import * as fs from 'node:fs';
import * as path from 'node:path';

import { UnknownPriorityError } from '@wadeck-app/task-core';

import { describeError } from './describeError.js';
import { InvalidListQueryError, InvalidStatusError } from './errors.js';
import { listTasks } from './listTasks.js';
import type { ListedTask } from './listTasks.js';
import { createTestContext, type TestContext } from './testHelpers.js';

const NOW = new Date('2026-11-14T12:00:00.000Z');
const minutes = (count: number): string => new Date(NOW.getTime() + count * 60_000).toISOString();

async function add(
	t: TestContext,
	title: string,
	extra: { status?: string; priority?: string; createdAt?: string; holder?: string; leaseEnd?: string } = {}
): Promise<string> {
	const task = await t.ctx.store.create({
		title,
		status: extra.status ?? 'backlog',
		...(extra.createdAt === undefined ? {} : { createdAt: extra.createdAt }),
	});
	if (extra.priority !== undefined) await t.ctx.store.setPriority!(task.id, extra.priority);
	if (extra.holder !== undefined) {
		// The claim is made one hour before NOW, so a lease ending at `leaseEnd` is live or over depending on the test.
		await t.ctx.store.claim!(task.id, {
			assignee: extra.holder,
			leaseUntil: extra.leaseEnd ?? minutes(30),
			now: minutes(-60),
		});
	}
	return task.id;
}

describe('listTasks with filters, order and limit', () => {
	let t: TestContext;
	beforeEach(() => {
		t = createTestContext();
	});
	afterEach(() => t.cleanup());

	it('without any new input the rows are the stored summaries, key for key (no effective priority added)', async () => {
		const id = await add(t, 'plain');
		const rows = await listTasks(t.ctx, {});

		expect(rows).toEqual(await t.ctx.store.list());
		expect(Object.keys(rows[0]!)).not.toContain('priority');
		expect(rows[0]!.id).toBe(id);
	});

	it('a filtered row carries the effective priority: the stored one, else the project default', async () => {
		const a = await add(t, 'a', { priority: 'urgent' });
		const b = await add(t, 'b');

		const rows = (await listTasks(t.ctx, { limit: 10 })) as ListedTask[];

		expect(Object.fromEntries(rows.map(row => [row.id, row.priority]))).toEqual({ [a]: 'urgent', [b]: 'medium' });
	});

	it('statuses replaces the hiding of terminal tasks and validates against the project', async () => {
		const open = await add(t, 'open');
		const done = await add(t, 'done', { status: 'done' });
		const progress = await add(t, 'progress', { status: 'in-progress' });

		expect((await listTasks(t.ctx, { statuses: ['done'] })).map(row => row.id)).toEqual([done]);
		expect((await listTasks(t.ctx, { statuses: ['backlog', 'in-progress'] })).map(row => row.id).sort()).toEqual(
			[open, progress].sort()
		);
		const failure = await listTasks(t.ctx, { statuses: ['backlg'] }).catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(InvalidStatusError);
		expect(describeError(failure).hint).toContain('Valid statuses: backlog, in-progress, done');
	});

	it('priorities keeps the effective priority, defaults included, and refuses an unknown one naming the valid ones', async () => {
		const high = await add(t, 'h', { priority: 'high' });
		const plain = await add(t, 'p');
		await add(t, 'l', { priority: 'low' });

		expect((await listTasks(t.ctx, { priorities: ['high'] })).map(row => row.id)).toEqual([high]);
		expect((await listTasks(t.ctx, { priorities: ['medium'] })).map(row => row.id)).toEqual([plain]);
		const failure = await listTasks(t.ctx, { priorities: ['critical'] }).catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(UnknownPriorityError);
		expect((failure as UnknownPriorityError).validPriorities).toEqual(['urgent', 'high', 'medium', 'low']);
	});

	it('assignee, unassigned and available select by holder and lease at the injected now', async () => {
		const free = await add(t, 'free');
		const live = await add(t, 'live', { holder: 'w1', leaseEnd: minutes(10) });
		const over = await add(t, 'over', { holder: 'w2', leaseEnd: minutes(-10) });

		const ids = async (input: Parameters<typeof listTasks>[1]) =>
			(await listTasks(t.ctx, { now: NOW, ...input })).map(row => row.id).sort();

		expect(await ids({ unassigned: true })).toEqual([free]);
		expect(await ids({ assignee: 'w1' })).toEqual([live]);
		expect(await ids({ assignee: ' w2 ' })).toEqual([over]);
		expect(await ids({ available: true })).toEqual([free, over].sort());
		const rows = (await listTasks(t.ctx, { now: NOW, assignee: 'w1' })) as ListedTask[];
		expect(rows[0]).toMatchObject({ assignee: 'w1', leaseUntil: minutes(10), leaseExpired: false });
		const expired = (await listTasks(t.ctx, { now: NOW, assignee: 'w2' })) as ListedTask[];
		expect(expired[0]!.leaseExpired).toBe(true);
		// A task with no lease carries no leaseExpired key.
		const unleased = (await listTasks(t.ctx, { now: NOW, unassigned: true })) as ListedTask[];
		expect(Object.keys(unleased[0]!)).not.toContain('leaseExpired');
	});

	it('a lease that ends exactly at now is over', async () => {
		const edge = await add(t, 'edge', { holder: 'w1', leaseEnd: NOW.toISOString() });
		expect((await listTasks(t.ctx, { now: NOW, available: true })).map(row => row.id)).toEqual([edge]);
	});

	it('assignee, unassigned and available are mutually exclusive, naming the pair', async () => {
		for (const [input, pair] of [
			[{ assignee: 'w1', unassigned: true }, 'assignee and unassigned'],
			[{ assignee: 'w1', available: true }, 'assignee and available'],
			[{ unassigned: true, available: true }, 'unassigned and available'],
		] as const) {
			const failure = await listTasks(t.ctx, input).catch((error: unknown) => error);
			expect(failure).toBeInstanceOf(InvalidListQueryError);
			expect((failure as Error).message).toBe(`${pair} cannot be combined`);
			expect(describeError(failure).kind).toBe('invalid');
		}
	});

	it('refuses a blank assignee and a limit out of range', async () => {
		for (const input of [{ assignee: '  ' }, { limit: 0 }, { limit: 1001 }, { limit: 1.5 }]) {
			await expect(listTasks(t.ctx, input)).rejects.toBeInstanceOf(InvalidListQueryError);
		}
	});

	it('orders by priority-then-oldest, by name or ref, and applies the limit AFTER the order', async () => {
		const oldLow = await add(t, 'old low', { priority: 'low', createdAt: '2026-01-01T00:00:00.000Z' });
		const newUrgent = await add(t, 'new urgent', { priority: 'urgent', createdAt: '2026-06-01T00:00:00.000Z' });
		const oldUrgent = await add(t, 'old urgent', { priority: 'urgent', createdAt: '2026-02-01T00:00:00.000Z' });
		const oldDefault = await add(t, 'old default', { createdAt: '2026-01-02T00:00:00.000Z' });

		const full = await listTasks(t.ctx, { order: 'priority-then-oldest' });
		expect(full.map(row => row.id)).toEqual([oldUrgent, newUrgent, oldDefault, oldLow]);
		expect((await listTasks(t.ctx, { order: 'plugins.ordering.default' })).map(row => row.id)).toEqual(
			full.map(row => row.id)
		);
		// The two most urgent, not the first two the backend returned.
		expect((await listTasks(t.ctx, { order: 'priority-then-oldest', limit: 2 })).map(row => row.id)).toEqual([
			oldUrgent,
			newUrgent,
		]);
	});

	it('breaks a tie of priority and instant by id, ascending', async () => {
		const same = '2026-03-03T00:00:00.000Z';
		const ids = [
			await add(t, 'a', { createdAt: same }),
			await add(t, 'b', { createdAt: same }),
			await add(t, 'c', { createdAt: same }),
		];

		expect((await listTasks(t.ctx, { order: 'priority-then-oldest' })).map(row => row.id)).toEqual([...ids].sort());
	});

	it('an unknown order lists the registered ones; a strategy plugin named as an order is a pointed error', async () => {
		const unknown = await listTasks(t.ctx, { order: 'newest' }).catch((error: unknown) => error);
		expect(unknown).toBeInstanceOf(InvalidListQueryError);
		expect((unknown as Error).message).toBe('unknown ordering plugin "newest"');
		expect((unknown as InvalidListQueryError).hint).toContain('priority-then-oldest (plugins.ordering.default)');

		const wrongKind = await listTasks(t.ctx, { order: 'local' }).catch((error: unknown) => error);
		expect((wrongKind as Error).message).toContain('is a strategy plugin, not an ordering one');
	});

	it('combines filters: the available urgent tasks of a status, ordered and cut', async () => {
		const a = await add(t, 'a', {
			priority: 'urgent',
			createdAt: '2026-01-01T00:00:00.000Z',
			status: 'in-progress',
		});
		await add(t, 'held', { priority: 'urgent', holder: 'w1', leaseEnd: minutes(5), status: 'in-progress' });
		await add(t, 'other status', { priority: 'urgent' });
		await add(t, 'other priority', { priority: 'low', status: 'in-progress' });

		const rows = await listTasks(t.ctx, {
			now: NOW,
			statuses: ['in-progress'],
			priorities: ['urgent'],
			available: true,
			order: 'priority-then-oldest',
			limit: 5,
		});

		expect(rows.map(row => row.id)).toEqual([a]);
	});

	it('keeps parent working with the new filters', async () => {
		const parent = await add(t, 'parent');
		const child = await t.ctx.store.create({ title: 'child', status: 'backlog', parentId: parent });
		await add(t, 'elsewhere');

		expect((await listTasks(t.ctx, { parent, unassigned: true })).map(row => row.id)).toEqual([child.id]);
	});

	it('a fresh list on a local project reads the same and needs no reopening', async () => {
		await add(t, 'a');
		expect(await listTasks(t.ctx, { fresh: true })).toEqual(await listTasks(t.ctx, {}));
	});

	it('false booleans and empty arrays count as absent: the historical answer, key for key', async () => {
		await add(t, 'plain');
		const historical = await listTasks(t.ctx, {});

		expect(await listTasks(t.ctx, { unassigned: false, available: false })).toEqual(historical);
		expect(await listTasks(t.ctx, { statuses: [], priorities: [] })).toEqual(historical);
		expect(Object.keys((await listTasks(t.ctx, { unassigned: false, available: false }))[0]!)).not.toContain(
			'priority'
		);
	});

	describe('a stored leaseUntil that is not a date', () => {
		function corruptLease(taskId: string): void {
			const file = path.join(t.rootDir, 'data', 'task-index.json');
			const visit = (node: unknown): void => {
				if (Array.isArray(node)) node.forEach(visit);
				else if (node !== null && typeof node === 'object') {
					const record = node as Record<string, unknown>;
					if (record['id'] === taskId) record['leaseUntil'] = 'next tuesday';
					Object.values(record).forEach(visit);
				}
			};
			const index = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
			visit(index);
			fs.writeFileSync(file, JSON.stringify(index));
		}

		it('is surfaced as leaseProblem, never treated as a live or expired lease, and the task is not available', async () => {
			const bad = await add(t, 'bad lease', { holder: 'w1', leaseEnd: minutes(10) });
			const free = await add(t, 'free');
			corruptLease(bad);

			const rows = (await listTasks(t.ctx, { now: NOW, order: 'priority-then-oldest' })) as ListedTask[];
			const row = rows.find(r => r.id === bad)!;

			expect(row.leaseProblem).toBe('leaseUntil next tuesday is not a valid date');
			expect(Object.keys(row)).not.toContain('leaseExpired');
			expect(rows.find(r => r.id === free)).not.toHaveProperty('leaseProblem');
			expect((await listTasks(t.ctx, { now: NOW, available: true })).map(r => r.id)).toEqual([free]);
		});
	});
});
