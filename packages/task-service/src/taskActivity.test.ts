import * as fs from 'node:fs';
import * as path from 'node:path';

import { linkTasks, unlinkTasks } from './links.js';
import { removeParent, setParent } from './hierarchy.js';
import { setStatus } from './setStatus.js';
import { addLabel, removeLabel, setMeta, setType, unsetMeta, unsetType } from './taskFields.js';
import { getTaskActivity } from './taskActivity.js';
import { setTaskText } from './setTaskText.js';
import { createTestContext, type TestContext } from './testHelpers.js';

describe('getTaskActivity', () => {
	let t: TestContext;
	let id: string;
	beforeEach(async () => {
		t = createTestContext();
		id = (await t.ctx.store.create({ title: 'Fix login', status: 'backlog' })).id;
	});
	afterEach(() => t.cleanup());

	const texts = async (taskId = id): Promise<string[]> =>
		(await getTaskActivity(t.ctx, { id: taskId })).rows.map(row => row.text);

	it('a new task shows its creation only', async () => {
		const { rows } = await getTaskActivity(t.ctx, { id });

		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ kind: 'created', text: 'Created with status backlog', source: 'history' });
	});

	it('resolves a prefix and returns the full id', async () => {
		expect((await getTaskActivity(t.ctx, { id: id.slice(0, 4) })).id).toBe(id);
	});

	it('merges status changes and other changes, newest first', async () => {
		await setStatus(t.ctx, { id, status: 'in-progress' });
		await new Promise(resolve => setTimeout(resolve, 5));
		await setType(t.ctx, { id, type: 'bug' });
		await new Promise(resolve => setTimeout(resolve, 5));
		await setType(t.ctx, { id, type: 'feature' });
		await new Promise(resolve => setTimeout(resolve, 5));
		await setStatus(t.ctx, { id, status: 'done' });

		expect(await texts()).toEqual([
			'Status changed from in-progress to done',
			'Type changed from bug to feature',
			'Type set to bug',
			'Status changed from backlog to in-progress',
			'Created with status backlog',
		]);
	});

	it('orders by instant even when the activity was stored before the history in the file', async () => {
		const file = path.join(t.rootDir, 'data', 'tasks', `${id}.json`);
		const record = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
		record['history'] = [
			{ status: 'backlog', timestamp: '2026-01-01T10:00:00.000Z' },
			{ status: 'done', timestamp: '2026-01-03T10:00:00.000Z' },
		];
		record['activity'] = [{ at: '2026-01-02T10:00:00.000Z', kind: 'label-added', newValue: 'billing' }];
		fs.writeFileSync(file, JSON.stringify(record));

		expect(await texts()).toEqual([
			'Status changed from backlog to done',
			'Label billing added',
			'Created with status backlog',
		]);
	});

	it('equal instants keep the recorded order, the activity read as newer than the history', async () => {
		const file = path.join(t.rootDir, 'data', 'tasks', `${id}.json`);
		const record = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
		record['history'] = [{ status: 'backlog', timestamp: '2026-01-01T10:00:00.000Z' }];
		record['activity'] = [{ at: '2026-01-01T10:00:00.000Z', kind: 'label-added', newValue: 'x' }];
		fs.writeFileSync(file, JSON.stringify(record));

		expect(await texts()).toEqual(['Label x added', 'Created with status backlog']);
	});

	it('an old task without activity shows its status history only', async () => {
		await setStatus(t.ctx, { id, status: 'done' });

		const rows = (await getTaskActivity(t.ctx, { id })).rows;
		expect(rows.map(row => row.source)).toEqual(['history', 'history']);
	});

	it('words every kind as a plain sentence', async () => {
		const other = (await t.ctx.store.create({ title: 'Other task', status: 'backlog' })).id;
		const parent = (await t.ctx.store.create({ title: 'Parent task', status: 'backlog' })).id;
		await setType(t.ctx, { id, type: 'bug' });
		await unsetType(t.ctx, { id });
		await setType(t.ctx, { id, type: 'bug' });
		await addLabel(t.ctx, { id, label: 'billing' });
		await removeLabel(t.ctx, { id, label: 'billing' });
		await setMeta(t.ctx, { id, key: 'owner', value: 'ann' });
		await setMeta(t.ctx, { id, key: 'owner', value: 'bob' });
		await unsetMeta(t.ctx, { id, key: 'owner' });
		await setParent(t.ctx, { id, parent });
		await removeParent(t.ctx, { id });
		await linkTasks(t.ctx, { id, type: 'blockedBy', target: other });
		await unlinkTasks(t.ctx, { id, type: 'blockedBy', target: other });
		await setTaskText(t.ctx, { id, title: 'Fix the login' });
		await setTaskText(t.ctx, { id, description: 'More words' });

		expect((await texts()).reverse()).toEqual([
			'Created with status backlog',
			'Type set to bug',
			'Type cleared (was bug)',
			'Type set to bug',
			'Label billing added',
			'Label billing removed',
			'Metadata owner set to ann',
			'Metadata owner changed from ann to bob',
			'Metadata owner removed (was bob)',
			`Parent set to ${parent} Parent task`,
			`Parent removed (was ${parent} Parent task)`,
			`Linked: blocked by ${other} Other task`,
			`Unlinked: blocked by ${other} Other task`,
			'Title edited',
			'Description edited',
		]);
	});

	it('gives each row an icon, a tone, no actor, and the preview of an edit as details', async () => {
		await setTaskText(t.ctx, { id, description: 'More words' });

		const row = (await getTaskActivity(t.ctx, { id })).rows[0]!;
		expect(row).toMatchObject({
			kind: 'description',
			icon: 'file-text',
			tone: 'neutral',
			details: { oldValue: 'Fix login', newValue: 'More words' },
		});
		expect(row).not.toHaveProperty('actor');
		expect((await getTaskActivity(t.ctx, { id })).rows.every(r => r.icon.length > 0)).toBe(true);
	});

	it('uses the status tones of the project', async () => {
		await setStatus(t.ctx, { id, status: 'in-progress' });
		await setStatus(t.ctx, { id, status: 'done' });

		const tones = (await getTaskActivity(t.ctx, { id })).rows.map(row => row.tone);
		expect(tones).toEqual(['success', 'info', 'neutral']);
	});

	it('shows a negative terminal status in the danger tone', async () => {
		t.cleanup();
		t = createTestContext({
			statuses: ['backlog', 'done', 'rejected'],
			terminalStatuses: ['done', 'rejected'],
			negativeStatuses: ['rejected'],
		});
		id = (await t.ctx.store.create({ title: 'Fix login', status: 'backlog' })).id;
		await setStatus(t.ctx, { id, status: 'rejected' });

		expect((await getTaskActivity(t.ctx, { id })).rows[0]).toMatchObject({ kind: 'status', tone: 'danger' });
	});

	describe('sub-tasks on the parent side', () => {
		it('reads a parent change from both tasks: the child says "Parent", each parent says "Sub-task"', async () => {
			const a = (await t.ctx.store.create({ title: 'Parent A', status: 'backlog' })).id;
			const b = (await t.ctx.store.create({ title: 'Parent B', status: 'backlog' })).id;
			await setParent(t.ctx, { id, parent: a });
			await setParent(t.ctx, { id, parent: b });
			await removeParent(t.ctx, { id });

			expect((await texts(a)).slice(0, 2)).toEqual([
				`Sub-task ${id} Fix login detached`,
				`Sub-task ${id} Fix login added`,
			]);
			expect((await texts(b)).slice(0, 2)).toEqual([
				`Sub-task ${id} Fix login detached`,
				`Sub-task ${id} Fix login added`,
			]);
			const row = (await getTaskActivity(t.ctx, { id: a })).rows[0]!;
			expect(row).toMatchObject({
				kind: 'child-removed',
				source: 'activity',
				inverse: true,
				icon: 'git-branch',
				tone: 'neutral',
			});
			expect((await getTaskActivity(t.ctx, { id: a })).rows[1]).toMatchObject({
				kind: 'child-added',
				icon: 'git-branch',
			});
		});

		it('a deleted parent leaves the child with its own parent entry only', async () => {
			const parent = (await t.ctx.store.create({ title: 'Parent A', status: 'backlog' })).id;
			await setParent(t.ctx, { id, parent });
			await t.ctx.store.deleteTask(parent);

			expect((await texts(id))[0]).toBe(`Parent removed (was ${parent})`);
		});
	});

	describe('links', () => {
		it('reads a link from both sides: the holder says "blocked by", the target says "blocks"', async () => {
			const blocker = (await t.ctx.store.create({ title: 'Blocker task', status: 'backlog' })).id;
			await linkTasks(t.ctx, { id, type: 'blockedBy', target: blocker });

			expect((await texts(id))[0]).toBe(`Linked: blocked by ${blocker} Blocker task`);
			const mirrored = (await getTaskActivity(t.ctx, { id: blocker })).rows[0]!;
			expect(mirrored.text).toBe(`Linked: blocks ${id} Fix login`);
			expect(mirrored.inverse).toBe(true);
			expect(mirrored.icon).toBe('link');
			expect(mirrored.tone).toBe('purple');
		});

		it('the inverse name given to linkTasks is recorded on the right holder', async () => {
			const blocked = (await t.ctx.store.create({ title: 'Blocked task', status: 'backlog' })).id;
			await linkTasks(t.ctx, { id, type: 'blocks', target: blocked });

			expect((await texts(blocked))[0]).toBe(`Linked: blocked by ${id} Fix login`);
			expect((await texts(id))[0]).toBe(`Linked: blocks ${blocked} Blocked task`);
		});

		it('reads the id alone when the other task is gone', async () => {
			const gone = (await t.ctx.store.create({ title: 'Gone', status: 'backlog' })).id;
			await linkTasks(t.ctx, { id, type: 'causedBy', target: gone });
			await t.ctx.store.deleteTask(gone);

			expect((await texts())[0]).toBe(`Linked: caused by ${gone}`);
		});

		it('cuts a long title of the other task to its headline', async () => {
			const long = (await t.ctx.store.create({ title: `${'word '.repeat(60)}end`, status: 'backlog' })).id;
			await linkTasks(t.ctx, { id, type: 'duplicateOf', target: long });

			const text = (await texts())[0]!;
			expect(text.startsWith(`Linked: duplicate of ${long} word`)).toBe(true);
			expect(text.length).toBeLessThanOrEqual('Linked: duplicate of '.length + long.length + 1 + 90);
		});
	});

	it('shows a kind written by a newer version instead of dropping it', async () => {
		const file = path.join(t.rootDir, 'data', 'tasks', `${id}.json`);
		const record = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
		record['activity'] = [{ at: new Date().toISOString(), kind: 'priority-changed' }];
		fs.writeFileSync(file, JSON.stringify(record));

		expect((await texts())[0]).toBe('Change recorded: priority-changed');
	});

	it('shows an event of the remote system that has no task equivalent by its name, with its detail', async () => {
		const file = path.join(t.rootDir, 'data', 'tasks', `${id}.json`);
		const record = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
		record['activity'] = [
			{ at: new Date().toISOString(), kind: 'other', field: 'assigned', newValue: 'octocat' },
			{ at: new Date().toISOString(), kind: 'other', field: 'locked' },
		];
		fs.writeFileSync(file, JSON.stringify(record));

		const { rows } = await getTaskActivity(t.ctx, { id });
		const others = rows.filter(row => row.kind === 'other');
		expect(others.map(row => row.text).sort()).toEqual([
			'Remote event: assigned (octocat)',
			'Remote event: locked',
		]);
		expect(others[0]!.icon).toBe('circle-dot');
	});

	it('emits no event and writes nothing (a read)', async () => {
		const file = path.join(t.rootDir, 'data', 'tasks', `${id}.json`);
		const before = fs.readFileSync(file, 'utf8');
		await getTaskActivity(t.ctx, { id });

		expect(fs.readFileSync(file, 'utf8')).toBe(before);
	});
});
