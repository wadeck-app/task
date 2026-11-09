import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { RateLimitedError } from '@wadeck-app/task-core';
import type { BackendTraits, TaskBackend, VersionedRecord } from '@wadeck-app/task-core';

import { checkAgainstSchema } from '../jsonSchemaCheck.js';
import { queueEventDeclarations } from '../queueEventDeclarations.js';
import { LOCK_FILE_NAME, journalFileName } from './migrateJournal.js';
import { MigrationRefusedError, MigrationStateError } from './migrateErrors.js';
import { listAll, readRecords } from './migratePlan.js';
import { runMigration } from './migrateRun.js';
import type { RunMigrationInput } from './migrateRun.js';
import type { MigrationResult } from './migrateTypes.js';
import { localSide, optionsWith, reading, seedSource, snapshotFolder, spied } from './migrate.testkit.js';
import type { LocalSide, SideOptions } from './migrate.testkit.js';

const sides: LocalSide[] = [];
function side(options: SideOptions): LocalSide {
	const made = localSide(options);
	sides.push(made);
	return made;
}
afterEach(() => {
	for (const made of sides.splice(0)) fs.rmSync(made.root, { recursive: true, force: true });
});

const SOURCE_ID = 'aaaa1111';
const TARGET_ID = 'bbbb2222';

function migrate(
	source: LocalSide,
	target: LocalSide,
	options = optionsWith(),
	extra: Partial<RunMigrationInput> = {}
): Promise<MigrationResult> {
	return runMigration({
		source: source.endpoint,
		target: target.endpoint,
		journalDir: target.dataDir,
		options,
		resumeCommand: 'task migrate --from a --to b --resume',
		...extra,
	});
}

/** Every record of a backend by title. */
async function byTitle(backend: TaskBackend): Promise<Map<string, VersionedRecord>> {
	const summaries = await listAll(backend);
	const records = await readRecords(
		backend,
		summaries.map(summary => summary.id)
	);
	return new Map(records.map(record => [record.title, record]));
}

function journalOf(target: LocalSide): string {
	return path.join(target.dataDir, journalFileName(SOURCE_ID, TARGET_ID));
}

/** A source with the varied project, and a fresh target. The seeding writes are forgotten (only the run's are logged). */
async function seeded(
	targetOptions: Partial<SideOptions> = {},
	sourceOptions: Partial<SideOptions> = {}
): Promise<{ source: LocalSide; target: LocalSide; ids: Record<string, string> }> {
	const source = side({ id: SOURCE_ID, name: 'old-project', ...sourceOptions });
	const ids = await seedSource(source.endpoint.backend);
	source.log.calls.length = 0;
	source.log.writes.length = 0;
	const target = side({ id: TARGET_ID, name: 'new-project', ...targetOptions });
	return { source, target, ids };
}

// A project whose tasks changed after creation has a history and an activity log the port cannot replay: that is the one loss
// a local-to-local migration has.
const ALLOW_HISTORY = optionsWith({ allowLoss: ['history'] });

describe('migrating a project between two local backends', () => {
	it('copies every field: tasks, parents, status, type, labels, meta, links, comments (authors and times kept)', async () => {
		const { source, target, ids } = await seeded();
		const before = snapshotFolder(source.root);

		const result = await migrate(source, target, ALLOW_HISTORY);

		expect(result.status).toBe('completed');
		expect(result.counts).toMatchObject({ source: 6, created: 6, resumed: 0, skipped: 0, failed: 0, remaining: 0 });
		expect(result.verification).toEqual({ checked: 6, mismatches: [] });
		expect(result.idMap).toHaveLength(6);

		const moved = await byTitle(target.endpoint.backend);
		const original = await byTitle(source.endpoint.backend);
		const targetIdOf = (title: string): string => moved.get(title)!.id;
		expect(moved.size).toBe(6);

		const epic = moved.get('Epic')!;
		expect(epic).toMatchObject({ type: 'feature', labels: ['planning', 'q4'], status: 'backlog' });
		expect(epic.meta).toEqual({ migratedFrom: `${SOURCE_ID}/${ids['Epic']}` });
		expect(epic.createdAt).toBe(original.get('Epic')!.createdAt);

		expect(moved.get('Child one')).toMatchObject({ parentId: targetIdOf('Epic') });
		expect(moved.get('Child one')!.meta).toMatchObject({ estimate: '3', owner: 'ann' });
		expect(moved.get('Child two')).toMatchObject({ parentId: targetIdOf('Epic'), status: 'in-progress' });
		expect(moved.get('Grandchild')).toMatchObject({ parentId: targetIdOf('Child one') });
		expect(moved.get('Shipped')!.status).toBe('done');
		expect(moved.get('Standalone')!.description).toBe('A longer description\nwith two lines');

		expect(moved.get('Child two')!.links).toEqual([{ type: 'blockedBy', target: targetIdOf('Child one') }]);
		expect(moved.get('Standalone')!.links).toEqual([{ type: 'duplicateOf', target: targetIdOf('Shipped') }]);
		expect(moved.get('Grandchild')!.links).toEqual([{ type: 'causedBy', target: targetIdOf('Standalone') }]);

		const notes = moved.get('Epic')!.comments!;
		expect(notes.map(note => note.author)).toEqual(['ann', 'bob']);
		const sourceNotes = original.get('Epic')!.comments!;
		expect(notes[0]!.text).toContain(`Originally posted ${sourceNotes[0]!.at}`);
		expect(notes[0]!.text).toContain(`[migrated from ${SOURCE_ID}/${ids['Epic']}#${sourceNotes[0]!.id}]`);
		expect(notes[0]!.text.endsWith('First note')).toBe(true);
		expect(notes[1]!.text.endsWith('Second note')).toBe(true);
		expect(moved.get('Child one')!.comments![0]!.author).toBeUndefined();

		// The source is only read.
		expect(snapshotFolder(source.root)).toEqual(before);
		expect(source.log.writes).toEqual([]);
	});

	it('leaves the journal complete, and no lock behind', async () => {
		const { source, target } = await seeded();

		await migrate(source, target, ALLOW_HISTORY);

		const journal = JSON.parse(fs.readFileSync(journalOf(target), 'utf8')) as {
			status: string;
			tasks: Record<string, { phase: string }>;
		};
		expect(journal.status).toBe('completed');
		expect(Object.values(journal.tasks).map(entry => entry.phase)).toEqual(Array(6).fill('done'));
		expect(fs.existsSync(path.join(target.dataDir, LOCK_FILE_NAME))).toBe(false);
	});

	it('never touches a task the target already holds', async () => {
		const { source, target } = await seeded();
		const mine = await target.endpoint.backend.create({ title: 'Mine', status: 'backlog' });
		await target.endpoint.backend.addLabel(mine.id, 'keep');
		const before = fs.readFileSync(path.join(target.dataDir, 'tasks', `${mine.id}.json`), 'utf8');

		const result = await migrate(source, target, ALLOW_HISTORY);

		expect(result.status).toBe('completed');
		expect(fs.readFileSync(path.join(target.dataDir, 'tasks', `${mine.id}.json`), 'utf8')).toBe(before);
		expect((await listAll(target.endpoint.backend)).length).toBe(7);
	});
});

describe('the dry run', () => {
	it('writes nothing: no call that changes either backend, no file in the target folder, no journal, no lock', async () => {
		const { source, target } = await seeded();
		const targetBefore = snapshotFolder(target.root);
		const sourceBefore = snapshotFolder(source.root);

		const result = await migrate(source, target, optionsWith({ dryRun: true, allowLoss: ['history'] }));

		expect(result.status).toBe('dry-run');
		expect(source.log.writes).toEqual([]);
		expect(target.log.writes).toEqual([]);
		expect(snapshotFolder(target.root)).toEqual(targetBefore);
		expect(snapshotFolder(source.root)).toEqual(sourceBefore);
		expect(fs.existsSync(journalOf(target))).toBe(false);
		expect(result.events).toEqual([]);
	});

	it('says what a run would do: counts, loss table, nothing hidden when a kind is not allowed', async () => {
		const { source, target } = await seeded();

		const result = await migrate(source, target, optionsWith({ dryRun: true }));

		expect(result.counts).toMatchObject({ source: 6, created: 6, resumed: 0, skipped: 0 });
		expect(result.losses.map(row => row.kind)).toEqual(['history']);
		expect(result.blocking).toEqual(['history']);
		expect(result.losses[0]).toMatchObject({ allowed: false });
		expect(result.losses[0]!.fix).toMatch(/--history-comment/);
		expect(result.losses[0]!.taskIds.length).toBeGreaterThan(0);
	});

	it('reads the target too: a finished migration shows its tasks as skipped', async () => {
		const { source, target } = await seeded();
		await migrate(source, target, ALLOW_HISTORY);

		const result = await migrate(source, target, optionsWith({ dryRun: true, allowLoss: ['history'] }));

		expect(result.counts).toMatchObject({ created: 0, skipped: 6 });
	});

	it('estimates the writes, and the requests and time when the target declares a cost', async () => {
		const { source, target } = await seeded({ traits: { cost: { requests: 4, seconds: 3, quotaPerHour: 20 } } });

		const result = await migrate(source, target, optionsWith({ dryRun: true, allowLoss: ['history'] }));

		expect(result.estimate.writes).toBeGreaterThan(6);
		expect(result.estimate.requests).toBe(result.estimate.writes * 4);
		expect(result.estimate.seconds).toBe(result.estimate.writes * 3);
		expect(result.estimate.quotaPerHour).toBe(20);
		expect(result.warnings.join('\n')).toMatch(/hourly quota/);
	});

	it('counts the reads too: the source, the read-back of what is written', async () => {
		const { source, target } = await seeded(
			{ traits: { cost: { requests: 4, seconds: 3, read: { requests: 1, seconds: 0.5 } } } },
			{ traits: { cost: { requests: 0, seconds: 0, read: { requests: 2, seconds: 1 } } } }
		);

		const result = await migrate(source, target, optionsWith({ dryRun: true, allowLoss: ['history'] }));

		// 6 source reads x 2, 6 read-backs x 1, the writes x 4.
		expect(result.estimate.requests).toBe(6 * 2 + 6 * 1 + result.estimate.writes * 4);
		expect(result.estimate.seconds).toBe(Math.round(6 * 1 + 6 * 0.5 + result.estimate.writes * 3));
	});

	it('a local target is free: no requests, no time', async () => {
		const { source, target } = await seeded();

		const result = await migrate(source, target, optionsWith({ dryRun: true, allowLoss: ['history'] }));

		expect(result.estimate).toMatchObject({ requests: 0, seconds: 0 });
		expect(result.estimate.writes).toBeGreaterThan(6);
	});
});

describe('the loss table', () => {
	it('blocks while a loss is not allowed, listing every kind, and writes nothing', async () => {
		const { source, target } = await seeded({ restricted: true });

		const result = await migrate(source, target);

		expect(result.status).toBe('blocked');
		expect(result.blocking).toEqual([
			'labels',
			'meta',
			'comments',
			'history',
			'marker',
			'hierarchy:unsupported',
			'links:duplicateOf',
			'links:causedBy',
		]);
		expect(target.log.writes).toEqual([]);
		expect(fs.existsSync(journalOf(target))).toBe(false);
		expect(result.counts).toMatchObject({ created: 0, remaining: 6 });
	});

	it('names the tasks and the fix of each row', async () => {
		const { source, target, ids } = await seeded({ restricted: true });

		const result = await migrate(source, target);

		const causedBy = result.losses.find(row => row.kind === 'links:causedBy')!;
		expect(causedBy.taskIds).toEqual([ids['Grandchild']]);
		expect(causedBy.count).toBe(1);
		expect(causedBy.fix).toMatch(/nothing is invented/);
		const labels = result.losses.find(row => row.kind === 'labels')!;
		expect(labels.count).toBe(2);
		expect(labels.taskIds).toEqual([ids['Epic']]);
	});

	it('allows by kind, by group or with all, and runs once nothing is left blocking', async () => {
		const { source, target } = await seeded({ restricted: true });

		const groups = await migrate(source, target, optionsWith({ dryRun: true, allowLoss: ['links', 'hierarchy'] }));
		expect(groups.blocking).toEqual(['labels', 'meta', 'comments', 'history', 'marker']);
		expect(groups.losses.filter(row => row.allowed).map(row => row.kind)).toEqual([
			'hierarchy:unsupported',
			'links:duplicateOf',
			'links:causedBy',
		]);

		const all = await migrate(source, target, optionsWith({ allowLoss: ['all'] }));
		expect(all.status).toBe('completed');
		const moved = await byTitle(target.endpoint.backend);
		expect(moved.size).toBe(6);
		expect(moved.get('Epic')!.labels).toBeUndefined();
		expect(moved.get('Child one')!.parentId).toBeUndefined();
		expect(moved.get('Child two')!.links).toEqual([{ type: 'blockedBy', target: moved.get('Child one')!.id }]);
		expect(moved.get('Standalone')!.links).toBeUndefined();
	});

	it('refuses a kind it does not know, listing the valid ones', async () => {
		const { source, target } = await seeded();

		const error = await migrate(source, target, optionsWith({ allowLoss: ['bogus'] })).catch(
			(caught: unknown) => caught
		);

		expect(error).toBeInstanceOf(MigrationRefusedError);
		expect((error as Error).message).toMatch(/bogus/);
		expect((error as MigrationRefusedError).hint).toMatch(/hierarchy:cycle/);
		expect((error as MigrationRefusedError).hint).toMatch(/links:causedBy/);
	});

	it('a status the target lacks is a loss; allowed, the task gets the target default status', async () => {
		const { source, target } = await seeded({
			statuses: [
				{ name: 'backlog', terminal: false, default: true, outcome: undefined },
				{ name: 'done', terminal: true, default: false, outcome: 'positive' },
			],
		});

		const blocked = await migrate(source, target, optionsWith({ allowLoss: ['history'] }));
		expect(blocked.status).toBe('blocked');
		expect(blocked.blocking).toEqual(['status']);
		expect(blocked.losses[0]!.text).toMatch(/in-progress/);

		const done = await migrate(source, target, optionsWith({ allowLoss: ['history', 'status'] }));
		expect(done.status).toBe('completed');
		expect((await byTitle(target.endpoint.backend)).get('Child two')!.status).toBe('backlog');
	});

	it('a status that ends a task differently is a loss of its own', async () => {
		const { source, target } = await seeded({
			statuses: [
				{ name: 'backlog', terminal: false, default: true, outcome: undefined },
				{ name: 'in-progress', terminal: false, default: false, outcome: undefined },
				{ name: 'done', terminal: false, default: false, outcome: undefined },
			],
		});

		const result = await migrate(source, target, optionsWith({ dryRun: true, allowLoss: ['history'] }));

		expect(result.blocking).toEqual(['status-outcome']);
		expect(result.losses[0]!.text).toMatch(/done: ends the task \(positive\) in the source, open in the target/);
	});

	it('a type the target does not list is a loss; allowed, the task has no type', async () => {
		const { source, target } = await seeded({ types: ['bug'] });

		const result = await migrate(source, target, optionsWith({ allowLoss: ['history', 'type'] }));

		expect(result.status).toBe('completed');
		expect((await byTitle(target.endpoint.backend)).get('Epic')!.type).toBeUndefined();
		expect(result.losses.find(row => row.kind === 'type')!.text).toMatch(/feature/);
	});

	it('a label the target refuses, a hierarchy deeper than it allows and too many children are losses of their own', async () => {
		const traits: Partial<BackendTraits> = {
			hierarchyDepth: 2,
			childrenPerParent: 1,
			labelProblem: label => (label.length > 4 ? `"${label}" is too long` : undefined),
		};
		const { source, target } = await seeded({ traits });

		const blocked = await migrate(source, target, optionsWith({ dryRun: true, allowLoss: ['history'] }));
		expect(blocked.blocking).toEqual(['labels', 'hierarchy:depth', 'hierarchy:children']);

		const result = await migrate(source, target, optionsWith({ allowLoss: ['history', 'labels', 'hierarchy'] }));
		expect(result.status).toBe('completed');
		const moved = await byTitle(target.endpoint.backend);
		expect(moved.get('Epic')!.labels).toEqual(['q4']);
		expect(moved.get('Child one')!.parentId).toBe(moved.get('Epic')!.id);
		expect(moved.get('Child two')!.parentId).toBeUndefined();
		expect(moved.get('Grandchild')!.parentId).toBeUndefined();
	});

	it('a text longer than the target accepts is cut with a note, as a loss', async () => {
		const { source, target } = await seeded({ traits: { commentTextMax: 160 } });
		const epic = [...(await byTitle(source.endpoint.backend)).values()].find(task => task.title === 'Epic')!;
		await source.endpoint.backend.addComment(epic.id, 'x'.repeat(500));

		const blocked = await migrate(source, target, optionsWith({ dryRun: true, allowLoss: ['history'] }));
		expect(blocked.blocking).toEqual(['text-length']);

		await migrate(source, target, optionsWith({ allowLoss: ['history', 'text-length'] }));
		const comments = (await byTitle(target.endpoint.backend)).get('Epic')!.comments!;
		const cut = comments[comments.length - 1]!.text;
		expect(cut.length).toBeLessThanOrEqual(160);
		expect(cut).toMatch(/\[cut by task migrate: the original has \d+ characters\]$/);
		expect(cut).toContain('[migrated from');
	});

	it('a target that assigns the creation instant loses it, unless the history goes in a note', async () => {
		const { source, target } = await seeded({ traits: { keepsCreatedAt: false } });

		const blocked = await migrate(source, target, optionsWith({ dryRun: true }));
		expect(blocked.blocking).toEqual(['history', 'created-at']);

		const result = await migrate(source, target, optionsWith({ historyComment: true }));
		expect(result.status).toBe('completed');
		expect(result.losses).toEqual([]);
		const moved = await byTitle(target.endpoint.backend);
		const note = moved.get('Shipped')!.comments!.find(comment => comment.text.includes('#history]'))!;
		expect(note.text).toMatch(/^Migrated from aaaa1111\/\w+ by task migrate\./);
		expect(note.text).toMatch(/Created \d{4}-\d{2}-\d{2}T/);
		expect(note.text).toMatch(/Status history: backlog \(.*\) -> done \(/);
	});

	it('a target that cannot store authors writes them in the first line of the comment', async () => {
		const { source, target } = await seeded({ traits: { authoredComments: false } });

		await migrate(source, target, ALLOW_HISTORY);

		const comments = (await byTitle(target.endpoint.backend)).get('Epic')!.comments!;
		expect(comments.map(comment => comment.author)).toEqual([undefined, undefined]);
		expect(comments[0]!.text).toMatch(/^Originally posted \S+ by ann \[migrated from /);
		expect(comments[1]!.text).toMatch(/^Originally posted \S+ by bob \[migrated from /);
	});
});

describe('a source that is not a clean forest', () => {
	it('breaks a parent cycle, drops a parent that is not there and a link to a missing task, and lists each', async () => {
		const clean = side({ id: SOURCE_ID });
		const backend = clean.endpoint.backend;
		const a = (await backend.create({ title: 'A', status: 'backlog' })).id;
		const b = (await backend.create({ title: 'B', status: 'backlog' })).id;
		const c = (await backend.create({ title: 'C', status: 'backlog' })).id;
		const d = (await backend.create({ title: 'D', status: 'backlog' })).id;
		const tampered = reading(backend, record => {
			if (record.id === a) return { ...record, parentId: b };
			if (record.id === b) return { ...record, parentId: a };
			if (record.id === c) return { ...record, parentId: 'ghost' };
			if (record.id === d) return { ...record, links: [{ type: 'blockedBy', target: 'ghost' }] };
			return record;
		});
		// The same folder, read through the tampering backend.
		const source = { ...clean, endpoint: { ...clean.endpoint, backend: tampered } };
		const target = side({ id: TARGET_ID });

		const blocked = await migrate(source, target, optionsWith({ dryRun: true }));
		expect(blocked.blocking).toEqual(['hierarchy:orphan', 'hierarchy:cycle', 'links:dangling']);
		expect(blocked.losses.find(row => row.kind === 'hierarchy:cycle')!.count).toBe(1);

		const result = await migrate(source, target, optionsWith({ allowLoss: ['hierarchy', 'links'] }));

		expect(result.status).toBe('completed');
		const moved = await byTitle(target.endpoint.backend);
		expect(moved.size).toBe(4);
		const parents = ['A', 'B', 'C', 'D'].map(title => moved.get(title)!.parentId);
		// One task of the cycle keeps its parent (the other), the orphan and the rest are roots.
		expect(parents.filter(parent => parent !== undefined)).toHaveLength(1);
		expect(moved.get('D')!.links).toBeUndefined();
		expect(result.verification!.mismatches).toEqual([]);
	});
});

describe('order and timing of the writes', () => {
	it('creates parents before children, then sets the links, then writes the comments', async () => {
		const { source, target } = await seeded();

		await migrate(source, target, ALLOW_HISTORY);

		const writes = target.log.writes;
		const lastCreate = writes.map(write => write.split(' ')[0]).lastIndexOf('create');
		const firstLink = writes.findIndex(write => write.startsWith('addLink'));
		const lastLink = writes.map(write => write.split(' ')[0]).lastIndexOf('addLink');
		const firstComment = writes.findIndex(write => write.startsWith('addComment'));
		expect(lastCreate).toBeLessThan(firstLink);
		expect(lastLink).toBeLessThan(firstComment);
		const created = writes.filter(write => write.startsWith('create')).map(write => write.slice('create '.length));
		expect(created.indexOf('Epic')).toBeLessThan(created.indexOf('Child one'));
		expect(created.indexOf('Epic')).toBeLessThan(created.indexOf('Child two'));
		expect(created.indexOf('Child one')).toBeLessThan(created.indexOf('Grandchild'));
	});

	it('writes the comments of a task in the order they were made', async () => {
		const { source, target } = await seeded();

		await migrate(source, target, ALLOW_HISTORY);

		const comments = (await byTitle(target.endpoint.backend)).get('Epic')!.comments!;
		expect(comments.map(comment => comment.text.split('\n\n')[1])).toEqual(['First note', 'Second note']);
	});

	it('handles a project of 300 tasks in a bounded time', async () => {
		const source = side({ id: SOURCE_ID });
		const target = side({ id: TARGET_ID });
		const ids: string[] = [];
		for (let n = 0; n < 300; n++) {
			const record = await source.endpoint.backend.create({
				title: `Task ${n}`,
				status: n % 7 === 0 ? 'done' : 'backlog',
				...(n % 10 === 9 ? { parentId: ids[n - 1]! } : {}),
			});
			ids.push(record.id);
			if (n % 5 === 0) await source.endpoint.backend.addLabel(record.id, 'common');
			if (n % 25 === 24) await source.endpoint.backend.addLink(record.id, 'blockedBy', ids[n - 3]!);
		}

		const started = Date.now();
		const result = await migrate(source, target, ALLOW_HISTORY);
		const elapsed = Date.now() - started;

		expect(result.status).toBe('completed');
		expect(result.counts.created).toBe(300);
		expect(result.verification!.mismatches).toEqual([]);
		expect(elapsed).toBeLessThan(60_000);
	}, 120_000);
});

describe('idempotence: a second run creates nothing', () => {
	it('recognises the migrated tasks by the journal: no write on the target', async () => {
		const { source, target } = await seeded();
		await migrate(source, target, ALLOW_HISTORY);
		target.log.writes.length = 0;

		const again = await migrate(source, target, ALLOW_HISTORY);

		expect(again.status).toBe('completed');
		expect(again.counts).toMatchObject({ created: 0, resumed: 0, skipped: 6, remaining: 0 });
		expect(target.log.writes).toEqual([]);
		expect(again.events).toEqual([]);
		expect((await listAll(target.endpoint.backend)).length).toBe(6);
	});

	it('migrates only the tasks that are new in the source', async () => {
		const { source, target } = await seeded();
		await migrate(source, target, ALLOW_HISTORY);
		await source.endpoint.backend.create({ title: 'Added later', status: 'backlog' });

		const again = await migrate(source, target, ALLOW_HISTORY);

		expect(again.counts).toMatchObject({ source: 7, created: 1, skipped: 6 });
		expect((await listAll(target.endpoint.backend)).length).toBe(7);
	});

	it('recognises them by the marker when the journal is lost: no duplicate task, no duplicate comment', async () => {
		const { source, target } = await seeded();
		await migrate(source, target, optionsWith({ allowLoss: ['history'], historyComment: true }));
		const commentsBefore = [...(await byTitle(target.endpoint.backend)).values()].map(
			task => task.comments?.length ?? 0
		);
		fs.rmSync(journalOf(target));

		const again = await migrate(source, target, optionsWith({ allowLoss: ['history'], historyComment: true }));

		expect(again.status).toBe('completed');
		expect(again.counts.created).toBe(0);
		expect(again.notes.join('\n')).toMatch(/looking for the marker migratedFrom of an earlier run: 6 found/);
		const after = await byTitle(target.endpoint.backend);
		expect(after.size).toBe(6);
		expect([...after.values()].map(task => task.comments?.length ?? 0)).toEqual(commentsBefore);
		expect(JSON.parse(fs.readFileSync(journalOf(target), 'utf8')).status).toBe('completed');
	});

	it('creates a task again when the journal names one that is no longer on the target, and says so', async () => {
		const { source, target } = await seeded();
		await migrate(source, target, ALLOW_HISTORY);
		const gone = (await byTitle(target.endpoint.backend)).get('Standalone')!;
		await target.endpoint.backend.deleteTask(gone.id);

		const again = await migrate(source, target, ALLOW_HISTORY);

		expect(again.counts.created).toBe(1);
		expect(again.warnings.join('\n')).toMatch(/no longer on the target/);
		expect((await listAll(target.endpoint.backend)).length).toBe(6);
	});
});

describe('stopping and resuming', () => {
	it('stops at the first failure with the journal saved, refuses a plain rerun, and --resume finishes without duplicates', async () => {
		let failAt = 4;
		const { source, target } = await seeded({
			before: (method, _args, log) => {
				if (method === 'create' && log.writes.filter(write => write.startsWith('create')).length === failAt) {
					throw new Error('disk full');
				}
			},
		});

		const stopped = await migrate(source, target, ALLOW_HISTORY);

		expect(stopped.status).toBe('failed');
		expect(stopped.failure).toMatchObject({ step: 'create', message: 'disk full' });
		expect(stopped.failure!.sourceId).toBeDefined();
		expect(stopped.counts).toMatchObject({ created: 3, failed: 1, remaining: 6 });
		expect(stopped.resumeCommand).toBe('task migrate --from a --to b --resume');
		const journal = JSON.parse(fs.readFileSync(journalOf(target), 'utf8')) as {
			status: string;
			tasks: Record<string, unknown>;
			lastError: { message: string };
		};
		expect(journal.status).toBe('stopped');
		expect(Object.keys(journal.tasks)).toHaveLength(3);
		expect(journal.lastError.message).toBe('disk full');
		expect(fs.existsSync(path.join(target.dataDir, LOCK_FILE_NAME))).toBe(false);

		const plain = await migrate(source, target, ALLOW_HISTORY).catch((caught: unknown) => caught);
		expect(plain).toBeInstanceOf(MigrationRefusedError);
		expect((plain as Error).message).toMatch(/did not finish/);
		expect((plain as MigrationRefusedError).hint).toMatch(/--resume/);

		failAt = -1;
		const resumed = await migrate(source, target, optionsWith({ allowLoss: ['history'], resume: true }));

		expect(resumed.status).toBe('completed');
		expect(resumed.counts).toMatchObject({ created: 3, resumed: 3, skipped: 0, remaining: 0 });
		expect(resumed.verification!.mismatches).toEqual([]);
		const moved = await byTitle(target.endpoint.backend);
		expect(moved.size).toBe(6);
		expect(moved.get('Child one')!.parentId).toBe(moved.get('Epic')!.id);
	});

	it('stops cleanly on a rate limit: when it lifts, the exact command, nothing counted as failed', async () => {
		const retryAt = new Date('2026-11-09T12:00:00.000Z');
		let limited = true;
		const { source, target } = await seeded({
			before: (method, _args, log) => {
				if (
					limited &&
					method === 'create' &&
					log.writes.filter(write => write.startsWith('create')).length === 3
				) {
					throw new RateLimitedError('github', 'primary', retryAt);
				}
			},
		});

		const stopped = await migrate(source, target, ALLOW_HISTORY);

		expect(stopped.status).toBe('rate-limited');
		expect(stopped.retryAt).toBe('2026-11-09T12:00:00.000Z');
		expect(stopped.resumeCommand).toContain('--resume');
		expect(stopped.counts).toMatchObject({ created: 2, failed: 0 });
		expect(stopped.failure!.hint).toMatch(/Retry after 2026-11-09T12:00:00.000Z/);

		limited = false;
		const resumed = await migrate(source, target, optionsWith({ allowLoss: ['history'], resume: true }));
		expect(resumed.status).toBe('completed');
		expect((await listAll(target.endpoint.backend)).length).toBe(6);
	});

	/** Creates the task on the inner backend, then fails: the request reached the target, the answer was lost. */
	function losingTheAnswer(nth: { create: number; armed: boolean }): (backend: TaskBackend) => TaskBackend {
		return backend => {
			let creates = 0;
			return new Proxy(backend, {
				get(target, property, receiver) {
					const value = Reflect.get(target, property, receiver) as unknown;
					if (property !== 'create' || typeof value !== 'function') return value;
					return async (...args: unknown[]): Promise<unknown> => {
						const record = await (value as (...a: unknown[]) => Promise<unknown>).apply(target, args);
						creates++;
						if (nth.armed && creates === nth.create) throw new Error('connection reset');
						return record;
					};
				},
			});
		};
	}

	it('a creation whose answer was lost is found again by its title, not created twice', async () => {
		const nth = { create: 4, armed: true };
		const { source, target } = await seeded({ wrap: losingTheAnswer(nth) });

		const stopped = await migrate(source, target, ALLOW_HISTORY);

		expect(stopped.status).toBe('failed');
		expect(stopped.failure!.message).toBe('connection reset');
		const journal = JSON.parse(fs.readFileSync(journalOf(target), 'utf8')) as {
			pending: { sourceId: string; title: string };
			tasks: Record<string, unknown>;
		};
		expect(Object.keys(journal.tasks)).toHaveLength(3);
		expect(journal.pending).toMatchObject({ title: 'Child one' });
		// The task is on the target all the same.
		expect((await listAll(target.endpoint.backend)).length).toBe(4);

		nth.armed = false;
		const dry = await migrate(source, target, optionsWith({ dryRun: true, resume: true, allowLoss: ['history'] }));
		expect(dry.notes.join('\n')).toMatch(/stopped while creating "Child one".*found on the target/);

		const resumed = await migrate(source, target, optionsWith({ allowLoss: ['history'], resume: true }));

		expect(resumed.status).toBe('completed');
		expect(resumed.counts).toMatchObject({ created: 2, resumed: 4, remaining: 0 });
		const moved = await byTitle(target.endpoint.backend);
		expect(moved.size).toBe(6);
		// It got what the lost answer left out: the marker, and the fields.
		expect(moved.get('Child one')!.meta).toMatchObject({ migratedFrom: expect.stringContaining(SOURCE_ID) });
		expect(moved.get('Child one')!.meta).toMatchObject({ estimate: '3', owner: 'ann' });
		expect(resumed.verification!.mismatches).toEqual([]);
		expect(JSON.parse(fs.readFileSync(journalOf(target), 'utf8')).pending).toBeUndefined();
	});

	it('when nothing on the target matches the creation that was lost, the task is created', async () => {
		let failing = true;
		const { source, target } = await seeded({
			before: (method, _args, log) => {
				if (
					failing &&
					method === 'create' &&
					log.writes.filter(write => write.startsWith('create')).length === 4
				) {
					throw new Error('refused before it reached the target');
				}
			},
		});
		await migrate(source, target, ALLOW_HISTORY);

		failing = false;
		const dry = await migrate(source, target, optionsWith({ dryRun: true, resume: true, allowLoss: ['history'] }));
		expect(dry.notes.join('\n')).toMatch(/stopped while creating "Child one".*no such task.*created again/);
		const resumed = await migrate(source, target, optionsWith({ allowLoss: ['history'], resume: true }));

		expect(resumed.status).toBe('completed');
		expect((await listAll(target.endpoint.backend)).length).toBe(6);
	});

	it('several tasks that could be the lost creation: it stops and asks, it does not guess', async () => {
		const nth = { create: 4, armed: true };
		const { source, target } = await seeded({ wrap: losingTheAnswer(nth) });
		await migrate(source, target, ALLOW_HISTORY);
		nth.armed = false;
		// A second task with the same title and the same instant (a person copied it).
		const twin = (await byTitle(target.endpoint.backend)).get('Child one')!;
		await target.endpoint.backend.create({ title: 'Child one', status: 'backlog', createdAt: twin.createdAt });

		const error = await migrate(source, target, optionsWith({ allowLoss: ['history'], resume: true })).catch(
			(caught: unknown) => caught
		);

		expect(error).toBeInstanceOf(MigrationRefusedError);
		expect((error as Error).message).toMatch(/stopped while creating "Child one"/);
		expect((error as Error).message).toMatch(/2 tasks of the target could be it/);
		expect((error as MigrationRefusedError).hint).toMatch(/Delete the one that is not/);
		expect((await listAll(target.endpoint.backend)).length).toBe(5);
	});

	it('a target that assigns the creation instant is searched by time: an older task with the same title is not taken', async () => {
		const nth = { create: 4, armed: true };
		const { source, target } = await seeded({ wrap: losingTheAnswer(nth), traits: { keepsCreatedAt: false } });
		await target.endpoint.backend.create({
			title: 'Child one',
			status: 'backlog',
			createdAt: '2020-01-01T00:00:00.000Z',
		});
		await migrate(source, target, optionsWith({ allowLoss: ['history', 'created-at'] }));
		nth.armed = false;

		const resumed = await migrate(
			source,
			target,
			optionsWith({ allowLoss: ['history', 'created-at'], resume: true })
		);

		expect(resumed.status).toBe('completed');
		// The old task, the lost creation (taken back) and the five others: seven, not eight.
		expect((await listAll(target.endpoint.backend)).length).toBe(7);
	});

	it('finishes the fields of a task an earlier run left half done, without replacing what a person set', async () => {
		let failing = true;
		const { source, target } = await seeded({
			before: (method, args) => {
				if (failing && method === 'addLabel' && args[1] === 'q4') throw new Error('network reset');
			},
		});
		const stopped = await migrate(source, target, ALLOW_HISTORY);
		expect(stopped.failure).toMatchObject({ step: 'create', message: 'network reset' });
		const epic = (await byTitle(target.endpoint.backend)).get('Epic')!;
		expect(epic).toMatchObject({ type: 'feature', labels: ['planning'] });
		// A person changes the type of the half-migrated task.
		await target.endpoint.backend.setType(epic.id, 'chore');

		failing = false;
		const resumed = await migrate(source, target, optionsWith({ allowLoss: ['history'], resume: true }));

		const after = (await byTitle(target.endpoint.backend)).get('Epic')!;
		expect(after.labels).toEqual(['planning', 'q4']);
		expect(after.type).toBe('chore');
		// The difference is reported, not repaired.
		expect(resumed.status).toBe('failed');
		expect(resumed.failure!.step).toBe('verify');
		expect(resumed.verification!.mismatches).toEqual([
			{ sourceId: expect.any(String), targetId: epic.id, field: 'type', expected: 'feature', actual: 'chore' },
		]);
		expect(resumed.resumeCommand).toBeUndefined();
	});

	it('refuses --resume when there is nothing to resume', async () => {
		const { source, target } = await seeded();

		const error = await migrate(source, target, optionsWith({ resume: true })).catch((caught: unknown) => caught);

		expect(error).toBeInstanceOf(MigrationRefusedError);
		expect((error as Error).message).toMatch(/nothing to resume/);
	});
});

describe('the journal and the lock', () => {
	it.each([
		['is not JSON', '{not json'],
		['has another version', JSON.stringify({ version: 7 })],
		[
			'is for other projects',
			JSON.stringify({
				version: 1,
				from: { id: 'zzzz', name: 'x' },
				to: { id: TARGET_ID, name: 'y' },
				status: 'completed',
				startedAt: 'a',
				updatedAt: 'b',
				tasks: {},
			}),
		],
		[
			'holds a task without target',
			JSON.stringify({
				version: 1,
				from: { id: SOURCE_ID, name: 'x' },
				to: { id: TARGET_ID, name: 'y' },
				status: 'completed',
				startedAt: 'a',
				updatedAt: 'b',
				tasks: { t1: { phase: 'done' } },
			}),
		],
	])('a journal that %s is a loud error naming the file; nothing is written', async (_name, content) => {
		const { source, target } = await seeded();
		fs.mkdirSync(target.dataDir, { recursive: true });
		fs.writeFileSync(journalOf(target), content);

		const error = await migrate(source, target, ALLOW_HISTORY).catch((caught: unknown) => caught);

		expect(error).toBeInstanceOf(MigrationStateError);
		expect((error as Error).message).toContain(journalOf(target));
		expect((error as MigrationStateError).hint).toMatch(/only record/);
		expect(target.log.writes).toEqual([]);
		expect(fs.readFileSync(journalOf(target), 'utf8')).toBe(content);
	});

	it('refuses to run while another migration holds the lock', async () => {
		const { source, target } = await seeded();
		fs.mkdirSync(target.dataDir, { recursive: true });
		const lock = path.join(target.dataDir, LOCK_FILE_NAME);
		fs.writeFileSync(lock, JSON.stringify({ pid: 4242, startedAt: 'x', from: SOURCE_ID, to: TARGET_ID }));

		const error = await migrate(source, target, ALLOW_HISTORY, { isAlive: pid => pid === 4242 }).catch(
			(caught: unknown) => caught
		);

		expect(error).toBeInstanceOf(MigrationStateError);
		expect((error as Error).message).toMatch(/another migration is writing this target \(process 4242/);
		expect(target.log.writes).toEqual([]);
		expect(fs.existsSync(lock)).toBe(true);
	});

	it('takes over the lock of a process that is gone, and says so', async () => {
		const { source, target } = await seeded();
		fs.mkdirSync(target.dataDir, { recursive: true });
		fs.writeFileSync(
			path.join(target.dataDir, LOCK_FILE_NAME),
			JSON.stringify({ pid: 4242, startedAt: 'x', from: SOURCE_ID, to: TARGET_ID })
		);

		const result = await migrate(source, target, ALLOW_HISTORY, { isAlive: () => false });

		expect(result.status).toBe('completed');
		expect(result.warnings.join('\n')).toMatch(/took over the lock of process 4242, which is gone/);
		expect(fs.existsSync(path.join(target.dataDir, LOCK_FILE_NAME))).toBe(false);
	});

	it('refuses a lock file it cannot read rather than guessing', async () => {
		const { source, target } = await seeded();
		fs.mkdirSync(target.dataDir, { recursive: true });
		fs.writeFileSync(path.join(target.dataDir, LOCK_FILE_NAME), 'garbage');

		const error = await migrate(source, target, ALLOW_HISTORY).catch((caught: unknown) => caught);

		expect(error).toBeInstanceOf(MigrationStateError);
		expect((error as Error).message).toMatch(/cannot be read/);
	});

	it('the dry run takes no lock, so it can run beside a migration', async () => {
		const { source, target } = await seeded();
		fs.mkdirSync(target.dataDir, { recursive: true });
		fs.writeFileSync(
			path.join(target.dataDir, LOCK_FILE_NAME),
			JSON.stringify({ pid: process.pid, startedAt: 'x', from: SOURCE_ID, to: TARGET_ID })
		);

		const result = await migrate(source, target, optionsWith({ dryRun: true, allowLoss: ['history'] }));

		expect(result.status).toBe('dry-run');
	});
});

describe('what it refuses', () => {
	it('the same project on both sides', async () => {
		const { source } = await seeded();

		const error = await migrate(source, source, ALLOW_HISTORY).catch((caught: unknown) => caught);

		expect(error).toBeInstanceOf(MigrationRefusedError);
		expect((error as Error).message).toMatch(/same project/);
		expect((error as MigrationRefusedError).hint).toMatch(/project add/);
	});

	it('a source that was read from a cache', async () => {
		const { source, target } = await seeded();
		source.endpoint.takeNotices = () => [
			{ kind: 'stale', text: 'github could not be reached (cached 2026-11-09)' },
		];

		const error = await migrate(source, target, ALLOW_HISTORY).catch((caught: unknown) => caught);

		expect(error).toBeInstanceOf(MigrationRefusedError);
		expect((error as Error).message).toMatch(/read from a cache/);
		expect(target.log.writes).toEqual([]);
	});
});

describe('the read-back', () => {
	it('reports a task that differs from the plan, and fails the run without a resume command', async () => {
		const { source, target } = await seeded({
			wrap: backend =>
				reading(backend, record =>
					record.title === 'Standalone' ? { ...record, title: 'standalone!' } : record
				),
		});

		const result = await migrate(source, target, ALLOW_HISTORY);

		expect(result.status).toBe('failed');
		expect(result.failure).toMatchObject({ step: 'verify' });
		expect(
			result.verification!.mismatches.map(mismatch => [mismatch.field, mismatch.expected, mismatch.actual])
		).toContainEqual(['title', 'Standalone', 'standalone!']);
		expect(result.resumeCommand).toBeUndefined();
	});
});

describe('events', () => {
	it('raises one summary event after the last write, none for a dry run, a blocked plan or a run that did nothing', async () => {
		const { source, target } = await seeded();

		expect((await migrate(source, target, optionsWith({ dryRun: true, allowLoss: ['history'] }))).events).toEqual(
			[]
		);
		expect((await migrate(source, target)).events).toEqual([]);
		const run = await migrate(source, target, ALLOW_HISTORY);
		expect(run.events.map(event => event.name)).toEqual(['onTasksMigrated']);
		expect(run.events[0]!.payload).toEqual({
			fromProjectId: SOURCE_ID,
			fromProjectName: 'old-project',
			toProjectId: TARGET_ID,
			toProjectName: 'new-project',
			created: 6,
			resumed: 0,
			skipped: 0,
			failed: 0,
			remaining: 0,
			complete: true,
			taskProjectId: TARGET_ID,
			taskProjectName: 'new-project',
		});
		expect((await migrate(source, target, ALLOW_HISTORY)).events).toEqual([]);
	});

	it('the summary event fits its declaration', async () => {
		const { source, target } = await seeded();

		const run = await migrate(source, target, ALLOW_HISTORY);

		const declaration = queueEventDeclarations.find(entry => entry.name === 'onTasksMigrated')!;
		// The declaration requires the project path; this fixture has none, the rest of the payload must fit.
		const payload = {
			...(run.events[0]!.payload as unknown as Record<string, unknown>),
			taskProjectPath: '/work/new-project',
		};
		expect(checkAgainstSchema(declaration.schema, JSON.parse(JSON.stringify(payload)))).toEqual([]);
	});

	it('--emit-events adds the events the same writes raise in an ordinary session, parents first, the summary last', async () => {
		const { source, target } = await seeded();

		const run = await migrate(source, target, optionsWith({ allowLoss: ['history'], emitEvents: true }));

		const names = run.events.map(event => event.name);
		const count = (name: string): number => names.filter(candidate => candidate === name).length;
		expect(count('onTaskCreated')).toBe(6);
		expect(count('onTaskTypeChanged')).toBe(1);
		expect(count('onTaskLabelAdded')).toBe(2);
		expect(count('onTaskMetaChanged')).toBe(2);
		expect(count('onTaskLinked')).toBe(3);
		expect(count('onTaskCommentAdded')).toBe(3);
		expect(names[names.length - 1]).toBe('onTasksMigrated');
		const created = run.events.filter(event => event.name === 'onTaskCreated');
		const payloads = created.map(
			event => event.payload as { taskId: string; description: string; parentId?: string }
		);
		const epic = payloads.find(payload => payload.description === 'Epic')!;
		const childOne = payloads.find(payload => payload.description === 'Child one')!;
		expect(epic).toMatchObject({ labels: [], taskProjectId: TARGET_ID });
		expect(childOne.parentId).toBe(epic.taskId);
		expect(created.indexOf(created.find(event => event.payload === childOne)!)).toBeGreaterThan(
			created.indexOf(created.find(event => event.payload === epic)!)
		);
		const migratedMeta = run.events.filter(
			event => event.name === 'onTaskMetaChanged' && (event.payload as { key: string }).key === 'migratedFrom'
		);
		expect(migratedMeta).toEqual([]);
	});
});

describe('spied backends', () => {
	it('the spy sees reads and writes separately (the tests above rely on it)', async () => {
		const side1 = side({ id: SOURCE_ID });
		const { backend, log } = spied(side1.endpoint.backend);

		await backend.create({ title: 'x', status: 'backlog' });
		await backend.list();

		expect(log.calls).toEqual(['create x', 'list']);
		expect(log.writes).toEqual(['create x']);
	});
});
