// Phase 2 of `task migrate`: a SUBSET of the source (--only-open, --status, --ids, --limit), the relations that point outside the subset
// (links:excluded, hierarchy:excluded) and their restoration by a later run, and the in-place form that never switches on a subset.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { TaskBackend, VersionedRecord } from '@wadeck-app/task-core';

import { InvalidStatusError } from '../errors.js';
import { MigrationRefusedError } from './migrateErrors.js';
import { inPlaceJournalFileName, journalFileName } from './migrateJournal.js';
import { listAll, readRecords } from './migratePlan.js';
import { runMigration } from './migrateRun.js';
import type { InPlaceHooks, RunMigrationInput } from './migrateRun.js';
import type { MigrationOptions, MigrationResult } from './migrateTypes.js';
import { localSide, optionsWith, seedSource, snapshotFolder } from './migrate.testkit.js';
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
	options: MigrationOptions,
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

async function byTitle(backend: TaskBackend): Promise<Map<string, VersionedRecord>> {
	const summaries = await listAll(backend);
	const records = await readRecords(
		backend,
		summaries.map(summary => summary.id)
	);
	return new Map(records.map(record => [record.title, record]));
}

async function seeded(): Promise<{ source: LocalSide; target: LocalSide; ids: Record<string, string> }> {
	const source = side({ id: SOURCE_ID, name: 'old-project' });
	const ids = await seedSource(source.endpoint.backend);
	const target = side({ id: TARGET_ID, name: 'new-project' });
	return { source, target, ids };
}

// The seeded source has a status history (the one loss of a local copy) and a link from Standalone to the closed Shipped.
const HISTORY = ['history'];

describe('--only-open', () => {
	it('copies the tasks in a non-terminal status of the source and leaves the others, and says what it left', async () => {
		const { source, target } = await seeded();

		const result = await migrate(
			source,
			target,
			optionsWith({ allowLoss: [...HISTORY, 'links:excluded'], selection: { onlyOpen: true } })
		);

		expect(result.status).toBe('completed');
		expect([...(await byTitle(target.endpoint.backend)).keys()].sort()).toEqual(
			['Child one', 'Child two', 'Epic', 'Grandchild', 'Standalone'].sort()
		);
		expect(result.counts).toMatchObject({ source: 6, created: 5, remaining: 0 });
		expect(result.selection).toMatchObject({
			total: 6,
			selected: 5,
			alreadyMigrated: 0,
			excluded: 1,
			excludedBy: { status: 1, ids: 0, limit: 0 },
		});
	});

	it('a link to a task that was left out is a loss of its own, blocking, with the tasks named', async () => {
		const { source, target, ids } = await seeded();
		const before = snapshotFolder(target.root);

		const result = await migrate(
			source,
			target,
			optionsWith({ allowLoss: HISTORY, selection: { onlyOpen: true } })
		);

		expect(result.status).toBe('blocked');
		expect(result.blocking).toEqual(['links:excluded']);
		const row = result.losses.find(loss => loss.kind === 'links:excluded')!;
		expect(row.taskIds).toEqual([ids['Standalone']]);
		expect(row.text).toContain('outside the selection');
		expect(row.fix).toContain('--allow-loss links:excluded');
		expect(snapshotFolder(target.root)).toEqual(before);
	});

	it.each([['links'], ['all']])('--allow-loss %s covers links:excluded', async group => {
		const { source, target } = await seeded();

		const result = await migrate(
			source,
			target,
			optionsWith({ allowLoss: [...HISTORY, group], selection: { onlyOpen: true } })
		);

		expect(result.status).toBe('completed');
		expect(result.losses.find(loss => loss.kind === 'links:excluded')).toMatchObject({ allowed: true });
	});

	it('uses the terminal flags of the SOURCE project, not the target', async () => {
		const source = side({ id: SOURCE_ID, name: 'old-project' });
		await seedSource(source.endpoint.backend);

		// In the target `in-progress` ends a task; in the source it does not: the source decides.
		const other = side({
			id: TARGET_ID,
			statuses: [
				{ name: 'backlog', terminal: false, default: true, outcome: undefined },
				{ name: 'in-progress', terminal: true, default: false, outcome: 'positive' },
				{ name: 'done', terminal: true, default: false, outcome: 'positive' },
			],
		});
		const result = await migrate(
			source,
			other,
			optionsWith({
				allowLoss: [...HISTORY, 'links:excluded', 'status-outcome'],
				selection: { onlyOpen: true },
			})
		);

		expect(result.counts.created).toBe(5);
	});
});

describe('--status and --ids', () => {
	it('--status copies only the listed source statuses; the parent and the link outside become losses, the task becomes a root', async () => {
		const { source, target } = await seeded();

		const blocked = await migrate(
			source,
			target,
			optionsWith({ allowLoss: HISTORY, selection: { statuses: ['in-progress'] } })
		);
		expect(blocked.status).toBe('blocked');
		expect(blocked.blocking.sort()).toEqual(['hierarchy:excluded', 'links:excluded']);
		expect(blocked.losses.find(loss => loss.kind === 'hierarchy:excluded')!.text).toContain(
			'outside the selection'
		);

		const result = await migrate(
			source,
			target,
			optionsWith({
				allowLoss: [...HISTORY, 'hierarchy:excluded', 'links:excluded'],
				selection: { statuses: ['in-progress'] },
			})
		);

		expect(result.status).toBe('completed');
		const moved = await byTitle(target.endpoint.backend);
		expect([...moved.keys()]).toEqual(['Child two']);
		expect(moved.get('Child two')!.parentId).toBeUndefined();
		expect(moved.get('Child two')!.links ?? []).toEqual([]);
		expect(result.selection).toMatchObject({ selected: 1, excluded: 5, excludedBy: { status: 5 } });
	});

	it('--ids copies the listed tasks, and an id the source does not have is refused with the ids it has', async () => {
		const { source, target, ids } = await seeded();

		await expect(
			migrate(source, target, optionsWith({ selection: { ids: [ids['Epic']!, 'nope0000'] } }))
		).rejects.toThrow(/unknown task id.*nope0000/s);

		const result = await migrate(
			source,
			target,
			optionsWith({ allowLoss: HISTORY, selection: { ids: [ids['Epic']!] } })
		);
		expect([...(await byTitle(target.endpoint.backend)).keys()]).toEqual(['Epic']);
		expect(result.selection).toMatchObject({ selected: 1, excluded: 5, excludedBy: { ids: 5 } });
	});

	it('an unknown status is an InvalidStatusError that lists the statuses of the source project', async () => {
		const { source, target } = await seeded();

		const error = await migrate(source, target, optionsWith({ selection: { statuses: ['donee'] } })).catch(
			(thrown: unknown) => thrown
		);

		expect(error).toBeInstanceOf(InvalidStatusError);
		expect((error as InvalidStatusError).validStatuses).toEqual(['backlog', 'in-progress', 'done']);
		expect((error as InvalidStatusError).suggestions).toEqual(['done']);
	});

	it('--only-open and --status contradict each other: refused, nothing written', async () => {
		const { source, target } = await seeded();
		const before = snapshotFolder(target.root);

		await expect(
			migrate(source, target, optionsWith({ selection: { onlyOpen: true, statuses: ['done'] } }))
		).rejects.toThrow(MigrationRefusedError);
		expect(snapshotFolder(target.root)).toEqual(before);
	});

	it.each([[0], [1.5], [1001], [-1]])('--limit %s is refused', async limit => {
		const { source, target } = await seeded();

		await expect(migrate(source, target, optionsWith({ selection: { limit } }))).rejects.toThrow(
			/limit must be a whole number from 1 to 1000/
		);
	});
});

describe('--limit', () => {
	it('takes the first n of the plan order (parents first) and a later run continues with the next ones, never copying twice', async () => {
		const { source, target } = await seeded();
		const options = (resume = false): MigrationOptions =>
			optionsWith({
				allowLoss: [...HISTORY, 'links:excluded', 'hierarchy:excluded'],
				selection: { limit: 2 },
				resume,
			});

		const first = await migrate(source, target, options());
		expect([...(await byTitle(target.endpoint.backend)).keys()].sort()).toEqual(['Epic', 'Standalone']);
		expect(first.selection).toMatchObject({ selected: 2, excluded: 4, excludedBy: { limit: 4 } });
		expect(first.status).toBe('completed');

		target.log.writes.length = 0;
		const second = await migrate(source, target, options());
		expect([...(await byTitle(target.endpoint.backend)).keys()].sort()).toEqual(
			['Child one', 'Epic', 'Shipped', 'Standalone'].sort()
		);
		expect(second.selection).toMatchObject({
			selected: 2,
			alreadyMigrated: 2,
			excluded: 2,
			excludedBy: { limit: 2 },
		});
		expect(target.log.writes.filter(write => write.startsWith('create '))).toEqual([
			'create Shipped',
			'create Child one',
		]);

		const third = await migrate(source, target, options());
		expect(third.selection).toMatchObject({ selected: 2, alreadyMigrated: 4, excluded: 0 });
		expect([...(await byTitle(target.endpoint.backend)).keys()]).toHaveLength(6);

		target.log.writes.length = 0;
		const fourth = await migrate(source, target, options());
		expect(target.log.writes).toEqual([]);
		expect(fourth.selection).toMatchObject({ selected: 0, alreadyMigrated: 6, excluded: 0 });
		expect(fourth.counts).toMatchObject({ created: 0, skipped: 6 });
	});

	it('a task a stopped run left unfinished is finished first and counts against the limit', async () => {
		const source = side({ id: SOURCE_ID, name: 'old-project' });
		const ids = await seedSource(source.endpoint.backend);
		let failOnce = true;
		const target = side({
			id: TARGET_ID,
			name: 'new-project',
			before: method => {
				if (method === 'addComment' && failOnce) {
					failOnce = false;
					throw new Error('network down');
				}
			},
		});
		const allowLoss = [...HISTORY, 'links:excluded', 'hierarchy:excluded'];

		const stopped = await migrate(source, target, optionsWith({ allowLoss, selection: { ids: [ids['Epic']!] } }));
		expect(stopped.status).toBe('failed');

		const resumed = await migrate(
			source,
			target,
			optionsWith({ allowLoss, resume: true, selection: { limit: 2 } })
		);

		expect(resumed.status).toBe('completed');
		// Epic (unfinished) is one of the two; one more task is created.
		expect(resumed.counts).toMatchObject({ created: 1, resumed: 1 });
		expect(resumed.selection).toMatchObject({ selected: 2, excluded: 4 });
		expect([...(await byTitle(target.endpoint.backend)).keys()].sort()).toEqual(['Epic', 'Standalone']);
	});
});

describe('relations restored when the other end is migrated by a later run', () => {
	it('a link and a parent dropped because the other end was left out are written by the run that selects it, once', async () => {
		const { source, target, ids } = await seeded();
		const allow = [...HISTORY, 'links:excluded', 'hierarchy:excluded'];

		// Run 1: only Child two. Its parent (Epic) and its blocker (Child one) are outside the selection.
		await migrate(source, target, optionsWith({ allowLoss: allow, selection: { ids: [ids['Child two']!] } }));
		let moved = await byTitle(target.endpoint.backend);
		expect(moved.get('Child two')!.parentId).toBeUndefined();
		expect(moved.get('Child two')!.links ?? []).toEqual([]);

		// Run 2: Epic and Child one. Child two (done in the journal) gets its parent and its link now.
		target.log.writes.length = 0;
		const second = await migrate(
			source,
			target,
			optionsWith({ allowLoss: allow, selection: { ids: [ids['Epic']!, ids['Child one']!] } })
		);
		moved = await byTitle(target.endpoint.backend);
		expect(moved.get('Child two')!.parentId).toBe(moved.get('Epic')!.id);
		expect(moved.get('Child two')!.links).toEqual([{ type: 'blockedBy', target: moved.get('Child one')!.id }]);
		expect(second.verification!.mismatches).toEqual([]);
		expect(
			target.log.writes.filter(write => write.startsWith('setParent') || write.startsWith('addLink'))
		).toHaveLength(2);

		// Run 3 (everything): nothing left to write for it, no second link, no second parent.
		target.log.writes.length = 0;
		await migrate(source, target, optionsWith({ allowLoss: allow }));
		// Child two is done and holds all it should: it is not touched again.
		expect(target.log.writes.filter(write => write.includes(moved.get('Child two')!.id))).toEqual([]);
		const final = await byTitle(target.endpoint.backend);
		expect(final.get('Child two')!.links).toHaveLength(1);
		expect(final.size).toBe(6);
	});

	it('a link whose other end was migrated by a previous run is created with the holder (no loss at all)', async () => {
		const { source, target, ids } = await seeded();

		// Run 1: Child one alone (Epic is its parent: outside). Run 2: Child two, whose blocker Child one already is on the target.
		const allow = [...HISTORY, 'hierarchy:excluded', 'links:excluded'];
		await migrate(source, target, optionsWith({ allowLoss: allow, selection: { ids: [ids['Child one']!] } }));
		const second = await migrate(
			source,
			target,
			optionsWith({ allowLoss: allow, selection: { ids: [ids['Child two']!] } })
		);

		const moved = await byTitle(target.endpoint.backend);
		expect(moved.get('Child two')!.links).toEqual([{ type: 'blockedBy', target: moved.get('Child one')!.id }]);
		expect(second.losses.map(loss => loss.kind)).not.toContain('links:excluded');
	});

	it('the deferred relations are kept in the journal until the other end is there', async () => {
		const { source, target, ids } = await seeded();
		const allow = [...HISTORY, 'links:excluded', 'hierarchy:excluded'];

		await migrate(source, target, optionsWith({ allowLoss: allow, selection: { ids: [ids['Child two']!] } }));

		const journal = JSON.parse(
			fs.readFileSync(path.join(target.dataDir, journalFileName(SOURCE_ID, TARGET_ID)), 'utf8')
		) as {
			tasks: Record<string, { deferred?: { parent?: string; links?: Array<{ type: string; target: string }> } }>;
		};
		expect(journal.tasks[ids['Child two']!]!.deferred).toEqual({
			parent: ids['Epic'],
			links: [{ type: 'blockedBy', target: ids['Child one'] }],
		});
	});
});

describe('the plan and the dry run', () => {
	it('count only the selected tasks: the writes, the selection, the same numbers as a real run', async () => {
		const { source, target } = await seeded();
		const options = optionsWith({ allowLoss: [...HISTORY, 'links:excluded'] });

		const full = await migrate(source, target, { ...options, dryRun: true });
		const subset = await migrate(source, target, { ...options, dryRun: true, selection: { onlyOpen: true } });

		expect(subset.status).toBe('dry-run');
		expect(subset.counts).toMatchObject({ source: 6, created: 5 });
		expect(subset.estimate.writes).toBeLessThan(full.estimate.writes);
		expect(subset.selection).toMatchObject({ selected: 5, excluded: 1 });
		const real = await migrate(source, target, { ...options, selection: { onlyOpen: true } });
		expect(real.counts.created).toBe(subset.counts.created);
	});

	it('without a selection there is no selection report and every task is planned, as before', async () => {
		const { source, target } = await seeded();

		const result = await migrate(source, target, optionsWith({ allowLoss: HISTORY, dryRun: true }));

		expect(result.selection).toBeUndefined();
		expect(result.counts).toMatchObject({ source: 6, created: 6 });
	});
});

describe('in place with a subset', () => {
	const PROJECT_ID = 'cccc3333';

	function hooks(target: LocalSide, switchConfig: InPlaceHooks['switchConfig']): InPlaceHooks {
		return {
			target: { hash: 'hash-1', parts: { type: 'a' }, location: 'kind:local' },
			source: { kind: 'local', location: 'kind:local' },
			idMapFile: path.join(target.dataDir, 'idmap.json'),
			switchConfig,
		};
	}

	it('never switches the config while tasks are left out: status partial, the journal stays resumable; the switch comes with the run that covers everything', async () => {
		const source = side({ id: PROJECT_ID });
		await seedSource(source.endpoint.backend);
		const target = side({ id: PROJECT_ID });
		const switchConfig = vi.fn();
		const run = (change: Partial<MigrationOptions>): Promise<MigrationResult> =>
			runMigration({
				source: source.endpoint,
				target: target.endpoint,
				journalDir: target.dataDir,
				options: optionsWith({ allowLoss: [...HISTORY, 'links:excluded', 'hierarchy:excluded'], ...change }),
				resumeCommand: 'task migrate --in-place --to-config d.yml --limit 2 --resume',
				inPlace: hooks(target, switchConfig),
			});

		const first = await run({ selection: { limit: 2 } });
		expect(first.status).toBe('partial');
		expect(first.inPlace).toMatchObject({ switched: false });
		expect(first.resumeCommand).toContain('--resume');
		expect(first.selection).toMatchObject({ selected: 2, excluded: 4 });
		expect(first.events.find(event => event.name === 'onTasksMigrated')!.payload).toMatchObject({
			complete: false,
		});
		expect(switchConfig).not.toHaveBeenCalled();
		const journalFile = path.join(target.dataDir, inPlaceJournalFileName(PROJECT_ID));
		const afterFirst = JSON.parse(fs.readFileSync(journalFile, 'utf8')) as { status: string; tasks: object };
		expect(afterFirst.status).toBe('stopped');
		expect(Object.keys(afterFirst.tasks)).toHaveLength(2);

		const second = await run({ selection: { limit: 2 }, resume: true });
		expect(second.status).toBe('partial');
		expect(second.selection).toMatchObject({ selected: 2, alreadyMigrated: 2, excluded: 2 });
		expect(switchConfig).not.toHaveBeenCalled();

		// The last run selects what is left (here: everything, the tasks already copied are kept): every task is read back, then the switch.
		const last = await run({ resume: true });
		expect(last.status).toBe('completed');
		expect(last.counts).toMatchObject({ created: 2, skipped: 4 });
		expect(last.verification).toMatchObject({ checked: 6, mismatches: [] });
		expect(last.inPlace).toMatchObject({ switched: true });
		expect(switchConfig).toHaveBeenCalledTimes(1);
		const moved = await byTitle(target.endpoint.backend);
		expect(moved.size).toBe(6);
		// The links and parents deferred by the partial runs are all there.
		expect(moved.get('Child two')!.parentId).toBe(moved.get('Epic')!.id);
		expect(moved.get('Standalone')!.links).toEqual([{ type: 'duplicateOf', target: moved.get('Shipped')!.id }]);
		const journal = JSON.parse(fs.readFileSync(journalFile, 'utf8')) as { status: string };
		expect(journal.status).toBe('completed');
	});

	it('a selection that covers every source task (--only-open when nothing is closed) is a full run: it switches', async () => {
		const source = side({ id: PROJECT_ID });
		const record = await source.endpoint.backend.create({ title: 'only task', status: 'backlog' });
		void record;
		const target = side({ id: PROJECT_ID });
		const switchConfig = vi.fn();

		const result = await runMigration({
			source: source.endpoint,
			target: target.endpoint,
			journalDir: target.dataDir,
			options: optionsWith({ selection: { onlyOpen: true } }),
			resumeCommand: 'resume',
			inPlace: hooks(target, switchConfig),
		});

		expect(result.status).toBe('completed');
		expect(switchConfig).toHaveBeenCalledTimes(1);
	});
});

describe('edge cases of the relations left for later', () => {
	const allow = [...HISTORY, 'links:excluded', 'hierarchy:excluded'];

	it('a task that waits for two relations gets the one whose other end arrives, and keeps waiting for the other', async () => {
		const { source, target, ids } = await seeded();
		// Child two: parent Epic, blockedBy Child one. Run 1 copies it alone; run 2 brings Child one only.
		await migrate(source, target, optionsWith({ allowLoss: allow, selection: { ids: [ids['Child two']!] } }));
		await migrate(source, target, optionsWith({ allowLoss: allow, selection: { ids: [ids['Child one']!] } }));

		let moved = await byTitle(target.endpoint.backend);
		expect(moved.get('Child two')!.links).toEqual([{ type: 'blockedBy', target: moved.get('Child one')!.id }]);
		expect(moved.get('Child two')!.parentId).toBeUndefined();
		const journalFile = path.join(target.dataDir, journalFileName(SOURCE_ID, TARGET_ID));
		const journal = JSON.parse(fs.readFileSync(journalFile, 'utf8')) as {
			tasks: Record<string, { deferred?: { parent?: string; links?: unknown[] } }>;
		};
		// Child one, copied by run 2 without its parent, waits for Epic too; Child two only waits for its parent now.
		expect(journal.tasks[ids['Child two']!]!.deferred).toEqual({ parent: ids['Epic'] });
		expect(journal.tasks[ids['Child one']!]!.deferred).toEqual({ parent: ids['Epic'] });

		await migrate(source, target, optionsWith({ allowLoss: allow, selection: { ids: [ids['Epic']!] } }));
		moved = await byTitle(target.endpoint.backend);
		expect(moved.get('Child two')!.parentId).toBe(moved.get('Epic')!.id);
		expect(moved.get('Child one')!.parentId).toBe(moved.get('Epic')!.id);
		const after = JSON.parse(fs.readFileSync(journalFile, 'utf8')) as {
			tasks: Record<string, { deferred?: unknown }>;
		};
		expect(after.tasks[ids['Child two']!]!.deferred).toBeUndefined();
		expect(after.tasks[ids['Child one']!]!.deferred).toBeUndefined();
	});

	it('--emit-events raises the events of the relations written later, like any other write', async () => {
		const { source, target, ids } = await seeded();
		await migrate(source, target, optionsWith({ allowLoss: allow, selection: { ids: [ids['Child two']!] } }));

		const second = await migrate(
			source,
			target,
			optionsWith({ allowLoss: allow, emitEvents: true, selection: { ids: [ids['Epic']!, ids['Child one']!] } })
		);

		const names = second.events.map(event => event.name);
		expect(names).toContain('onTaskParentChanged');
		expect(names).toContain('onTaskLinked');
		const parentEvent = second.events.find(event => event.name === 'onTaskParentChanged')!;
		expect(parentEvent.payload).toMatchObject({ oldParentId: undefined });
	});

	it('a relation to a task that was never selected stays a loss on every run, and stays in the journal', async () => {
		const { source, target, ids } = await seeded();
		const options = optionsWith({ allowLoss: allow, selection: { ids: [ids['Child two']!] } });
		await migrate(source, target, options);

		const again = await migrate(source, target, options);

		expect(again.losses.map(loss => loss.kind)).toEqual(
			expect.arrayContaining(['links:excluded', 'hierarchy:excluded'])
		);
		expect(again.counts).toMatchObject({ created: 0, skipped: 1 });
		const moved = await byTitle(target.endpoint.backend);
		expect(moved.size).toBe(1);
	});

	it('the creation a stopped run left pending is part of the next run whatever the selection says', async () => {
		const source = side({ id: SOURCE_ID, name: 'old-project' });
		const ids = await seedSource(source.endpoint.backend);
		let armed = true;
		const target = side({
			id: TARGET_ID,
			name: 'new-project',
			wrap: inner =>
				new Proxy(inner, {
					get(real, property, receiver) {
						const value = Reflect.get(real, property, receiver) as unknown;
						if (property !== 'create' || typeof value !== 'function') return value;
						return async (...args: unknown[]): Promise<unknown> => {
							const record = await (value as (...a: unknown[]) => Promise<unknown>).apply(real, args);
							if (armed) {
								armed = false;
								throw new Error('connection reset');
							}
							return record;
						};
					},
				}),
		});

		const stopped = await migrate(
			source,
			target,
			optionsWith({ allowLoss: allow, selection: { ids: [ids['Epic']!] } })
		);
		expect(stopped.status).toBe('failed');

		// Another selection: it does not name Epic, yet Epic (on the target, answer lost) is taken back, not created again.
		const resumed = await migrate(
			source,
			target,
			optionsWith({ allowLoss: allow, resume: true, selection: { ids: [ids['Shipped']!] } })
		);

		expect(resumed.status).toBe('completed');
		const moved = await byTitle(target.endpoint.backend);
		expect([...moved.keys()].sort()).toEqual(['Epic', 'Shipped']);
		expect(resumed.counts).toMatchObject({ created: 1, resumed: 1 });
	});
});

describe('in place: the journal of a partial run', () => {
	const PROJECT_ID = 'cccc3333';
	const hooks = (target: LocalSide): InPlaceHooks => ({
		target: { hash: 'hash-1', parts: { type: 'a' }, location: 'kind:local' },
		source: { kind: 'local', location: 'kind:local' },
		idMapFile: path.join(target.dataDir, 'idmap.json'),
		switchConfig: () => undefined,
	});

	it('is not finished: a run without --resume is refused with the fix, and a dry run reports the selection without a journal', async () => {
		const source = side({ id: PROJECT_ID });
		await seedSource(source.endpoint.backend);
		const target = side({ id: PROJECT_ID });
		const run = (change: Partial<MigrationOptions>): Promise<MigrationResult> =>
			runMigration({
				source: source.endpoint,
				target: target.endpoint,
				journalDir: target.dataDir,
				options: optionsWith({ allowLoss: [...HISTORY, 'links:excluded', 'hierarchy:excluded'], ...change }),
				resumeCommand: 'resume',
				inPlace: hooks(target),
			});
		const dry = await run({ dryRun: true, selection: { limit: 2 } });
		expect(dry.status).toBe('dry-run');
		expect(dry.selection).toMatchObject({ selected: 2, excluded: 4 });
		expect(fs.existsSync(path.join(target.dataDir, inPlaceJournalFileName(PROJECT_ID)))).toBe(false);

		await run({ selection: { limit: 2 } });

		const refused = await run({ selection: { limit: 2 } }).catch((thrown: unknown) => thrown);
		expect(refused).toBeInstanceOf(MigrationRefusedError);
		expect((refused as MigrationRefusedError).message).toContain('did not finish');
		expect((refused as MigrationRefusedError).hint).toContain('--resume');
	});
});
