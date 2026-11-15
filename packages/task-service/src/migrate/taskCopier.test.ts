import type { TaskBackend, VersionedRecord } from '@wadeck-app/task-core';

import { PAIR_KINDS, FACTS } from '../plugins/migrating/testHelpers.js';
import type { Pair } from '../plugins/migrating/testHelpers.js';
import type { TaskCopier, TaskCopyInput } from '../plugins/kinds.js';
import { MigrationRefusedError } from './migrateErrors.js';
import { createTaskCopier } from './taskCopier.js';

const IDENTITY: ReadonlyArray<readonly [string, string]> = [
	['migrating.fromId', 'FROM'],
	['migrating.hash', '0123456789abcdef'],
	['migrating.authority', 'current'],
	['migrating.publicId', 'FROM'],
];
const WRITES = [
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
];

/** A task of `a` with a bit of everything a copy has to carry. */
async function richTask(a: TaskBackend): Promise<VersionedRecord> {
	const task = await a.create({ title: 'Fix the login', status: 'backlog', description: 'It fails on Safari.' });
	await a.setType(task.id, 'bug');
	await a.addLabel(task.id, 'web');
	await a.addLabel(task.id, 'urgent-fix');
	await a.setMeta(task.id, 'team', 'core');
	await a.setPriority!(task.id, 'high');
	await a.setAssignee!(task.id, 'w1');
	await a.updateStatus(task.id, 'in-progress');
	await a.addComment(task.id, 'First look: reproduced.', { author: 'ann' });
	return a.get(task.id);
}

describe.each(PAIR_KINDS)('taskCopier: the per-task copy of task migrate: $name', kind => {
	let pair: Pair;
	let copier: TaskCopier;
	/** What each task of `a` is called in `b` (the index of the wrapper, by hand). */
	let copies: Map<string, string>;

	beforeEach(async () => {
		pair = await kind.open();
		copies = new Map();
		copier = createTaskCopier({
			project: { id: 'abcd1234', name: 'shop' },
			facts: FACTS,
			from: { backend: pair.a, traits: pair.aTraits },
			to: { backend: pair.bRaw, traits: pair.bTraits },
		});
	});

	afterEach(async () => {
		await pair.dispose();
	});

	async function input(record: VersionedRecord, change: Partial<TaskCopyInput> = {}): Promise<TaskCopyInput> {
		return {
			record,
			sourceIds: new Set((await pair.a.list()).map(summary => summary.id)),
			targetIdOf: id => copies.get(id),
			acceptedLosses: ['all'],
			identity: IDENTITY.map(([key, value]) => [key, value.replace('FROM', record.id)] as const),
			...change,
		};
	}

	it('creates a copy that holds the fields of the task, its comments and the identity block', async () => {
		const record = await richTask(pair.a);

		const result = await copier.copy(await input(record));

		expect(result.created).toBe(true);
		expect(result.unresolved).toEqual([]);
		const copy = await pair.bRaw.get(result.id);
		expect(copy).toMatchObject({
			title: 'Fix the login',
			status: 'in-progress',
			type: 'bug',
			priority: 'high',
			assignee: 'w1',
		});
		expect(copy.description).toBe('It fails on Safari.');
		expect([...(copy.labels ?? [])].sort()).toEqual(['urgent-fix', 'web']);
		expect(copy.meta).toMatchObject({
			team: 'core',
			'migrating.fromId': record.id,
			'migrating.hash': '0123456789abcdef',
			'migrating.authority': 'current',
			'migrating.publicId': record.id,
		});
		expect((copy.comments ?? []).map(comment => comment.text).join('\n')).toContain('First look: reproduced.');
		expect(await copier.verify({ ...(await input(record)), id: result.id })).toEqual([]);
	});

	it('is idempotent: a second copy of an unchanged task writes nothing', async () => {
		const record = await richTask(pair.a);
		const first = await copier.copy(await input(record));
		pair.bCalls.length = 0;

		const second = await copier.copy({ ...(await input(record)), existingId: first.id });

		expect(second.created).toBe(false);
		expect(second.id).toBe(first.id);
		expect(pair.bCalls.filter(call => WRITES.includes(call))).toEqual([]);
	});

	it('brings an existing copy equal to the task after the task changed', async () => {
		const record = await richTask(pair.a);
		const first = await copier.copy(await input(record));
		await pair.a.setTitle(record.id, 'Fix the login page');
		await pair.a.updateStatus(record.id, 'review');
		await pair.a.removeLabel(record.id, 'web');
		await pair.a.addLabel(record.id, 'mobile');
		await pair.a.setMeta(record.id, 'team', 'platform');
		await pair.a.removeMeta(record.id, 'team');
		await pair.a.setMeta(record.id, 'area', 'auth');
		await pair.a.clearType(record.id);
		await pair.a.setPriority!(record.id, 'low');
		await pair.a.clearAssignee!(record.id);
		await pair.a.setDescription(record.id, 'New description');

		const changed = await pair.a.get(record.id);
		await copier.copy({ ...(await input(changed)), existingId: first.id });

		const copy = await pair.bRaw.get(first.id);
		expect(copy).toMatchObject({ title: 'Fix the login page', status: 'review', priority: 'low' });
		expect(copy.description).toBe('New description');
		expect(copy.type).toBeUndefined();
		expect(copy.assignee).toBeUndefined();
		expect([...(copy.labels ?? [])].sort()).toEqual(['mobile', 'urgent-fix']);
		expect(copy.meta?.['team']).toBeUndefined();
		expect(copy.meta?.['area']).toBe('auth');
		// What the copy carries besides the task's own is not touched.
		expect(copy.meta?.['migrating.publicId']).toBe(record.id);
		expect(await copier.verify({ ...(await input(changed)), id: first.id })).toEqual([]);
	});

	it('copies comments once, follows an edit and a removal, and leaves the others alone', async () => {
		const record = await richTask(pair.a);
		const first = await copier.copy(await input(record));
		const second = (await pair.a.addComment(record.id, 'Second note', { author: 'bob' })).comment;
		await copier.copy({ ...(await input(await pair.a.get(record.id))), existingId: first.id });
		expect((await pair.bRaw.get(first.id)).comments).toHaveLength(2);

		await pair.a.editComment(record.id, second.id, 'Second note, edited');
		await copier.copy({ ...(await input(await pair.a.get(record.id))), existingId: first.id });
		const texts = ((await pair.bRaw.get(first.id)).comments ?? []).map(comment => comment.text);
		expect(texts.some(text => text.includes('Second note, edited'))).toBe(true);
		expect(texts.some(text => text.includes('Second note\n') || text.endsWith('Second note'))).toBe(false);

		await pair.a.removeComment(record.id, second.id);
		await copier.copy({ ...(await input(await pair.a.get(record.id))), existingId: first.id });
		expect((await pair.bRaw.get(first.id)).comments).toHaveLength(1);
	});

	describe('relations: a relation to a task that has no copy yet is left out, reported, and written once it has one', () => {
		it('the parent', async () => {
			const parent = await pair.a.create({ title: 'Parent', status: 'backlog' });
			const child = await pair.a.create({ title: 'Child', status: 'backlog', parentId: parent.id });

			const first = await copier.copy(await input(await pair.a.get(child.id)));

			expect(first.unresolved).toEqual([{ relation: 'parent', sourceId: parent.id }]);
			expect((await pair.bRaw.get(first.id)).parentId).toBeUndefined();

			const parentCopy = await copier.copy(await input(await pair.a.get(parent.id)));
			copies.set(parent.id, parentCopy.id);
			const second = await copier.copy({ ...(await input(await pair.a.get(child.id))), existingId: first.id });

			expect(second.unresolved).toEqual([]);
			expect((await pair.bRaw.get(first.id)).parentId).toBe(parentCopy.id);
		});

		it('a creation under a parent that has a copy attaches it at once', async () => {
			const parent = await pair.a.create({ title: 'Parent', status: 'backlog' });
			copies.set(parent.id, (await copier.copy(await input(await pair.a.get(parent.id)))).id);
			const child = await pair.a.create({ title: 'Child', status: 'backlog', parentId: parent.id });

			const result = await copier.copy(await input(await pair.a.get(child.id)));

			expect(result.unresolved).toEqual([]);
			expect((await pair.bRaw.get(result.id)).parentId).toBe(copies.get(parent.id));
		});

		it('a link, and its removal', async () => {
			const blocker = await pair.a.create({ title: 'Blocker', status: 'backlog' });
			const task = await pair.a.create({ title: 'Task', status: 'backlog' });
			await pair.a.addLink(task.id, 'blockedBy', blocker.id);

			const first = await copier.copy(await input(await pair.a.get(task.id)));
			expect(first.unresolved).toEqual([{ relation: 'blockedBy', sourceId: blocker.id }]);

			copies.set(blocker.id, (await copier.copy(await input(await pair.a.get(blocker.id)))).id);
			const second = await copier.copy({ ...(await input(await pair.a.get(task.id))), existingId: first.id });
			expect(second.unresolved).toEqual([]);
			expect((await pair.bRaw.getLinks(first.id)).blockedBy.map(link => link.id)).toEqual([
				copies.get(blocker.id),
			]);

			await pair.a.removeLink(task.id, 'blockedBy', blocker.id);
			await copier.copy({ ...(await input(await pair.a.get(task.id))), existingId: first.id });
			expect((await pair.bRaw.getLinks(first.id)).blockedBy).toEqual([]);
		});
	});

	describe('losses', () => {
		it('lists what the copy loses, and says which ones nobody accepted', async () => {
			const record = await richTask(pair.a);

			const assessment = copier.assess(await input(record, { acceptedLosses: [] }));

			// The local side keeps everything; the API side cannot keep the creation instant or the history.
			const kinds = assessment.losses.map(loss => loss.kind).sort();
			if (pair.bTraits.keepsCreatedAt) expect(kinds).not.toContain('created-at');
			else expect(kinds).toEqual(expect.arrayContaining(['created-at', 'history']));
			expect(assessment.blocking.map(loss => loss.kind).sort()).toEqual(kinds);
			for (const loss of assessment.losses) {
				expect(loss.text.length).toBeGreaterThan(10);
				expect(loss.fix.length).toBeGreaterThan(10);
			}
		});

		it('a loss that is accepted is not blocking', async () => {
			const record = await richTask(pair.a);

			const assessment = copier.assess(await input(record, { acceptedLosses: ['created-at', 'history'] }));

			expect(assessment.blocking).toEqual([]);
		});

		it('refuses to copy a task whose losses nobody accepted, naming them, before writing anything', async () => {
			if (pair.bTraits.keepsCreatedAt) return;
			const record = await richTask(pair.a);
			pair.bCalls.length = 0;

			let thrown: unknown;
			try {
				await copier.copy(await input(record, { acceptedLosses: [] }));
			} catch (error) {
				thrown = error;
			}

			expect(thrown).toBeInstanceOf(MigrationRefusedError);
			expect((thrown as MigrationRefusedError).message).toContain('creation instant');
			expect((thrown as MigrationRefusedError).hint).toContain('created-at');
			expect(pair.bCalls.filter(call => WRITES.includes(call))).toEqual([]);
		});

		it('a tree deeper than the side allows is a loss of its own, found before the move', async () => {
			const parent = await pair.a.create({ title: 'Parent', status: 'backlog' });
			const child = await pair.a.create({ title: 'Child', status: 'backlog', parentId: parent.id });
			const record = await pair.a.get(child.id);
			const shallow = createTaskCopier({
				project: { id: 'abcd1234', name: 'shop' },
				facts: FACTS,
				from: { backend: pair.a, traits: pair.aTraits },
				to: { backend: pair.bRaw, traits: { ...pair.bTraits, hierarchyDepth: 2 } },
			});

			const assessment = shallow.assess(
				await input(record, { hierarchy: { depth: 3, siblings: 1 }, acceptedLosses: [] })
			);

			expect(assessment.blocking.map(loss => loss.kind)).toContain('hierarchy:depth');
		});
	});

	describe('verify', () => {
		it('names what differs between the copy and the task, one sentence each', async () => {
			const record = await richTask(pair.a);
			const result = await copier.copy(await input(record));
			await pair.bRaw.setTitle(result.id, 'Edited in the copy');

			const differences = await copier.verify({ ...(await input(record)), id: result.id });

			expect(differences).toHaveLength(1);
			expect(differences[0]).toContain('title');
			expect(differences[0]).toContain('Edited in the copy');
		});
	});
});
