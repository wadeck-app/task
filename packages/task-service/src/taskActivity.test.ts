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
	beforeEach(() => {
		t = createTestContext();
		id = t.ctx.store.create('Fix login', 'backlog').id;
	});
	afterEach(() => t.cleanup());

	const texts = (taskId = id): string[] => getTaskActivity(t.ctx, { id: taskId }).rows.map(row => row.text);

	it('a new task shows its creation only', () => {
		const { rows } = getTaskActivity(t.ctx, { id });

		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ kind: 'created', text: 'Created with status backlog', source: 'history' });
	});

	it('resolves a prefix and returns the full id', () => {
		expect(getTaskActivity(t.ctx, { id: id.slice(0, 4) }).id).toBe(id);
	});

	it('merges status changes and other changes, newest first', async () => {
		setStatus(t.ctx, { id, status: 'in-progress' });
		await new Promise(resolve => setTimeout(resolve, 5));
		setType(t.ctx, { id, type: 'bug' });
		await new Promise(resolve => setTimeout(resolve, 5));
		setType(t.ctx, { id, type: 'feature' });
		await new Promise(resolve => setTimeout(resolve, 5));
		setStatus(t.ctx, { id, status: 'done' });

		expect(texts()).toEqual([
			'Status changed from in-progress to done',
			'Type changed from bug to feature',
			'Type set to bug',
			'Status changed from backlog to in-progress',
			'Created with status backlog',
		]);
	});

	it('orders by instant even when the activity was stored before the history in the file', () => {
		const file = path.join(t.rootDir, 'data', 'tasks', `${id}.json`);
		const record = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
		record['history'] = [
			{ status: 'backlog', timestamp: '2026-01-01T10:00:00.000Z' },
			{ status: 'done', timestamp: '2026-01-03T10:00:00.000Z' },
		];
		record['activity'] = [{ at: '2026-01-02T10:00:00.000Z', kind: 'label-added', newValue: 'billing' }];
		fs.writeFileSync(file, JSON.stringify(record));

		expect(texts()).toEqual([
			'Status changed from backlog to done',
			'Label billing added',
			'Created with status backlog',
		]);
	});

	it('equal instants keep the recorded order, the activity read as newer than the history', () => {
		const file = path.join(t.rootDir, 'data', 'tasks', `${id}.json`);
		const record = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
		record['history'] = [{ status: 'backlog', timestamp: '2026-01-01T10:00:00.000Z' }];
		record['activity'] = [{ at: '2026-01-01T10:00:00.000Z', kind: 'label-added', newValue: 'x' }];
		fs.writeFileSync(file, JSON.stringify(record));

		expect(texts()).toEqual(['Label x added', 'Created with status backlog']);
	});

	it('an old task without activity shows its status history only', () => {
		setStatus(t.ctx, { id, status: 'done' });

		const rows = getTaskActivity(t.ctx, { id }).rows;
		expect(rows.map(row => row.source)).toEqual(['history', 'history']);
	});

	it('words every kind as a plain sentence', () => {
		const other = t.ctx.store.create('Other task', 'backlog').id;
		const parent = t.ctx.store.create('Parent task', 'backlog').id;
		setType(t.ctx, { id, type: 'bug' });
		unsetType(t.ctx, { id });
		setType(t.ctx, { id, type: 'bug' });
		addLabel(t.ctx, { id, label: 'billing' });
		removeLabel(t.ctx, { id, label: 'billing' });
		setMeta(t.ctx, { id, key: 'owner', value: 'ann' });
		setMeta(t.ctx, { id, key: 'owner', value: 'bob' });
		unsetMeta(t.ctx, { id, key: 'owner' });
		setParent(t.ctx, { id, parent });
		removeParent(t.ctx, { id });
		linkTasks(t.ctx, { id, type: 'blockedBy', target: other });
		unlinkTasks(t.ctx, { id, type: 'blockedBy', target: other });
		setTaskText(t.ctx, { id, title: 'Fix the login' });
		setTaskText(t.ctx, { id, description: 'More words' });

		expect(texts().reverse()).toEqual([
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

	it('gives each row an icon, a tone, no actor, and the preview of an edit as details', () => {
		setTaskText(t.ctx, { id, description: 'More words' });

		const row = getTaskActivity(t.ctx, { id }).rows[0]!;
		expect(row).toMatchObject({
			kind: 'description',
			icon: 'file-text',
			tone: 'neutral',
			details: { oldValue: 'Fix login', newValue: 'More words' },
		});
		expect(row).not.toHaveProperty('actor');
		expect(getTaskActivity(t.ctx, { id }).rows.every(r => r.icon.length > 0)).toBe(true);
	});

	it('uses the status tones of the project', () => {
		setStatus(t.ctx, { id, status: 'in-progress' });
		setStatus(t.ctx, { id, status: 'done' });

		const tones = getTaskActivity(t.ctx, { id }).rows.map(row => row.tone);
		expect(tones).toEqual(['success', 'info', 'neutral']);
	});

	describe('links', () => {
		it('reads a link from both sides: the holder says "blocked by", the target says "blocks"', () => {
			const blocker = t.ctx.store.create('Blocker task', 'backlog').id;
			linkTasks(t.ctx, { id, type: 'blockedBy', target: blocker });

			expect(texts(id)[0]).toBe(`Linked: blocked by ${blocker} Blocker task`);
			const mirrored = getTaskActivity(t.ctx, { id: blocker }).rows[0]!;
			expect(mirrored.text).toBe(`Linked: blocks ${id} Fix login`);
			expect(mirrored.inverse).toBe(true);
			expect(mirrored.icon).toBe('link');
			expect(mirrored.tone).toBe('purple');
		});

		it('the inverse name given to linkTasks is recorded on the right holder', () => {
			const blocked = t.ctx.store.create('Blocked task', 'backlog').id;
			linkTasks(t.ctx, { id, type: 'blocks', target: blocked });

			expect(texts(blocked)[0]).toBe(`Linked: blocked by ${id} Fix login`);
			expect(texts(id)[0]).toBe(`Linked: blocks ${blocked} Blocked task`);
		});

		it('reads the id alone when the other task is gone', () => {
			const gone = t.ctx.store.create('Gone', 'backlog').id;
			linkTasks(t.ctx, { id, type: 'causedBy', target: gone });
			t.ctx.store.deleteTask(gone);

			expect(texts()[0]).toBe(`Linked: caused by ${gone}`);
		});

		it('cuts a long title of the other task to its headline', () => {
			const long = t.ctx.store.create(`${'word '.repeat(60)}end`, 'backlog').id;
			linkTasks(t.ctx, { id, type: 'duplicateOf', target: long });

			const text = texts()[0]!;
			expect(text.startsWith(`Linked: duplicate of ${long} word`)).toBe(true);
			expect(text.length).toBeLessThanOrEqual('Linked: duplicate of '.length + long.length + 1 + 90);
		});
	});

	it('shows a kind written by a newer version instead of dropping it', () => {
		const file = path.join(t.rootDir, 'data', 'tasks', `${id}.json`);
		const record = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
		record['activity'] = [{ at: new Date().toISOString(), kind: 'priority-changed' }];
		fs.writeFileSync(file, JSON.stringify(record));

		expect(texts()[0]).toBe('Change recorded: priority-changed');
	});

	it('emits no event and writes nothing (a read)', () => {
		const file = path.join(t.rootDir, 'data', 'tasks', `${id}.json`);
		const before = fs.readFileSync(file, 'utf8');
		getTaskActivity(t.ctx, { id });

		expect(fs.readFileSync(file, 'utf8')).toBe(before);
	});
});
