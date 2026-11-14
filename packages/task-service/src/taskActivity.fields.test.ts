import type { ActivityEntry } from '@wadeck-app/task-core';

import { describeTaskActivity } from './taskActivity.js';
import type { ActivityRow } from './taskActivity.js';
import { setTaskAssignee } from './taskAssignee.js';
import { claimTask, releaseTask } from './taskClaim.js';
import { clearTaskPriority, setTaskPriority } from './taskPriority.js';
import { createTestContext, type TestContext } from './testHelpers.js';

describe('activity rows of priority, assignee, claim and release', () => {
	let t: TestContext;
	let id: string;
	beforeEach(async () => {
		t = createTestContext();
		id = (await t.ctx.store.create({ title: 'Fix login', status: 'backlog' })).id;
	});
	afterEach(() => t.cleanup());

	/** The rows of one hand-written activity entry (the file formats are those of the local store). */
	async function rowOf(entry: Omit<ActivityEntry, 'at'>): Promise<ActivityRow> {
		const record = await t.ctx.store.get(id);
		const rows = await describeTaskActivity(t.ctx, {
			...record,
			activity: [{ at: '2999-01-01T00:00:00.000Z', ...entry }],
		});
		return rows[0]!;
	}

	it.each([
		[{ kind: 'priority', oldValue: 'high', newValue: 'low' }, 'Priority changed from high to low', 'flag'],
		[{ kind: 'priority', newValue: 'high' }, 'Priority set to high', 'flag'],
		[{ kind: 'priority', oldValue: 'high' }, 'Priority cleared', 'flag'],
		[{ kind: 'assignee', newValue: 'bob' }, 'Assigned to bob', 'user'],
		[{ kind: 'assignee', oldValue: 'a', newValue: 'b' }, 'Assignee changed from a to b', 'user'],
		[{ kind: 'assignee', oldValue: 'bob' }, 'Unassigned', 'user-minus'],
		[
			{ kind: 'claim', field: '2026-11-14T10:30:00.000Z', newValue: 'bob' },
			'Claimed by bob until 2026-11-14T10:30:00.000Z',
			'user-check',
		],
		[
			{ kind: 'claim', field: '2026-11-14T10:30:00.000Z', oldValue: 'alice', newValue: 'bob' },
			'Taken over from alice by bob until 2026-11-14T10:30:00.000Z',
			'user-check',
		],
		[
			{ kind: 'claim', field: '2026-11-14T10:30:00.000Z', oldValue: 'bob', newValue: 'bob' },
			'Lease renewed by bob until 2026-11-14T10:30:00.000Z',
			'user-check',
		],
		[{ kind: 'release', oldValue: 'bob' }, 'Released by bob', 'user-minus'],
	] as const)('%j reads "%s" with the icon %s', async (entry, text, icon) => {
		const row = await rowOf(entry);

		expect(row).toMatchObject({ kind: entry.kind, text, icon, source: 'activity', tone: 'neutral' });
	});

	it('a claim without an end or a holder is still described, never dropped or thrown', async () => {
		expect((await rowOf({ kind: 'claim', newValue: 'bob' })).text).toBe('Claimed by bob');
		expect((await rowOf({ kind: 'release' })).text).toBe('Released');
		expect((await rowOf({ kind: 'assignee' })).text).toBe('Unassigned');
	});

	it('the entries the local store writes read back as sentences, newest first', async () => {
		await setTaskPriority(t.ctx, { id, priority: 'high' });
		await clearTaskPriority(t.ctx, { id });
		await setTaskAssignee(t.ctx, { id, assignee: 'bob' });
		await claimTask(t.ctx, { id, assignee: 'w1', force: true, now: new Date('2026-11-14T10:00:00.000Z') });
		await releaseTask(t.ctx, { id });

		const rows = await describeTaskActivity(t.ctx, await t.ctx.store.get(id));

		const texts = rows.map(row => row.text);
		expect(texts[0]).toBe('Released by w1');
		expect(texts).toContain('Taken over from bob by w1 until 2026-11-14T10:30:00.000Z');
		expect(texts).toContain('Assigned to bob');
		expect(texts).toContain('Priority cleared');
		expect(texts).toContain('Priority set to high');
	});
});
