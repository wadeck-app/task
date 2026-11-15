import * as path from 'node:path';

import { BackendDataError, BackendRejectedError } from '@wadeck-app/task-core';
import { afterEach, describe, expect, it } from 'vitest';

import {
	abortMigration,
	abortStage,
	completeAbort,
	completeFinalize,
	finalizeMigration,
	finalizeStage,
} from './migrationFinish.js';
import type { ConfigSwitch } from './migrationFinish.js';
import type { ControlInput } from './migrationControl.js';
import { readMigrationStatus } from './migrationControl.js';
import { MigrationStateStore } from './migrationState.js';
import { runMigrationWorker } from './migrationWorker.js';
import type { MigrationToolkit } from './migrationToolkit.js';
import { startMigration } from './startMigration.js';
import { FakeClock, MIGRATING_DIR, PAIR_KINDS, copyToNew, seedCurrent, toolkitOf, wrap } from './testHelpers.js';
import type { MemoryWorkerFiles, Pair, Wrapped } from './testHelpers.js';
import { WorkerLock } from './workerLock.js';
import { createInNew } from './testHelpers.js';

const LOCK = path.join(MIGRATING_DIR, 'worker.lock');
const IDMAP = path.join(MIGRATING_DIR, 'idmap.json');
const STATE = path.join(MIGRATING_DIR, 'state.json');
const CONTROL = path.join(MIGRATING_DIR, 'control.json');

/** The project config as a test holds it: a text (or none), a backup, and faults at every step of the switch. */
class FakeConfig {
	text: string | undefined = 'strategy: migrating (original)';
	backup: string | undefined;
	writes = 0;
	/** Fails the write (the old config stays) / dies right after it (the new config is there, the caller never heard). */
	faults: { beforeBackup?: boolean; afterBackup?: boolean; write?: boolean; afterWrite?: boolean } = {};
	readonly fingerprint = (text: string | undefined): string => (text === undefined ? 'absent' : `fp:${text}`);

	switchTo(target: string): ConfigSwitch {
		const original = this.fingerprint(this.text);
		return {
			current: () => this.fingerprint(this.text),
			original,
			target: this.fingerprint(target),
			apply: markStarted => {
				if (this.faults.beforeBackup) throw new Error('injected fault: before the backup');
				if (this.text !== undefined && this.backup === undefined) this.backup = this.text;
				if (this.faults.afterBackup) throw new Error('injected fault: after the backup');
				markStarted(true);
				if (this.faults.write) {
					markStarted(false);
					throw new Error('injected fault: the config cannot be written');
				}
				this.text = target;
				this.writes++;
				if (this.faults.afterWrite) throw new Error('injected fault: the process died after the config write');
				return { config: '/project/config.yml', backup: '/project/config.yml.before-migration' };
			},
		};
	}
}

describe.each(PAIR_KINDS)('finalize over $name', kind => {
	let pair: Pair;
	let wrapped: Wrapped;
	let clock: FakeClock;
	let toolkit: MigrationToolkit & { files: MemoryWorkerFiles };
	let store: MigrationStateStore;
	let seed: Awaited<ReturnType<typeof seedCurrent>>;
	let config: FakeConfig;
	let input: ControlInput;
	let baseline = 0;
	/** How many tasks "new" must hold at least: none before a task moved, the whole project once the worker is done. */
	let minInNew = 0;
	/** The commands read the index as a FILE; the wrapped index of these fixtures lives in memory: show it to them. */
	const syncIndex = (): void => {
		toolkit.files.texts.set(path.join(MIGRATING_DIR, 'index.json'), wrapped.files.text ?? '');
	};

	/** A started migration, no task moved yet (status running, every task in "current"). */
	const begin = async (): Promise<void> => {
		clock = new FakeClock();
		pair = await kind.open();
		wrapped = wrap(pair, { clock: clock.now });
		seed = await seedCurrent(pair.a);
		toolkit = toolkitOf(wrapped, pair, { clock, isAlive: () => false });
		store = new MigrationStateStore({ dir: MIGRATING_DIR, files: toolkit.files, now: clock.now });
		await startMigration(toolkit, { acceptedLosses: ['all'] });
		config = new FakeConfig();
		syncIndex();
		baseline = (await pair.a.list()).length;
		minInNew = 0;
		input = {
			dir: MIGRATING_DIR,
			files: toolkit.files,
			now: clock.now,
			isAlive: () => false,
			host: 'box',
			pid: 4242,
		};
	};
	/** A migration whose worker moved every task: status ready-to-finalize. */
	const ready = async (): Promise<void> => {
		await begin();
		const result = await runMigrationWorker(toolkit, { sleep: clock.sleep });
		expect(result.status).toBe('ready-to-finalize');
		syncIndex();
		minInNew = baseline;
	};
	afterEach(async () => {
		await pair.dispose();
	});

	const target = 'strategy: <the new one>';
	const finalize = () => finalizeMigration(toolkit, config.switchTo(target));
	const refusal = async (action: () => unknown): Promise<BackendRejectedError> => {
		try {
			await action();
		} catch (error) {
			expect(error).toBeInstanceOf(BackendRejectedError);
			return error as BackendRejectedError;
		}
		throw new Error('expected a refusal, nothing was thrown');
	};
	const deleteCalls = (): string[] => wrapped.faults.calls.filter(call => /delete/i.test(call));
	const logLines = (): Array<Record<string, unknown>> =>
		(toolkit.files.read(path.join(MIGRATING_DIR, 'log.ndjson')) ?? '')
			.split('\n')
			.filter(line => line !== '')
			.map(line => JSON.parse(line) as Record<string, unknown>);
	/** What must hold whatever happened: the config is the old one or the new one whole, no task is lost, nothing was deleted. */
	const invariants = async (extraInCurrent = 0): Promise<void> => {
		expect([
			config.fingerprint('strategy: migrating (original)'),
			config.fingerprint(target),
			config.fingerprint('strategy: <the current one>'),
		]).toContain(config.fingerprint(config.text));
		expect((await pair.a.list()).length).toBe(baseline + extraInCurrent);
		expect((await pair.bRaw.list()).length).toBeGreaterThanOrEqual(minInNew);
		expect(deleteCalls()).toEqual([]);
		expect(toolkit.files.texts.has(LOCK)).toBe(false);
	};

	it('verifies the stores, writes the id map, switches the config with a backup, and ends finished with its summary event due', async () => {
		await ready();
		expect(finalizeStage(input, config.fingerprint(config.text))).toEqual({ kind: 'verify' });

		const outcome = await finalize();

		expect(outcome).toMatchObject({
			outcome: 'finished',
			moved: 4,
			madeInNew: 0,
			eventDue: true,
			config: '/project/config.yml',
			backup: '/project/config.yml.before-migration',
		});
		expect(config.text).toBe(target);
		expect(config.backup).toBe('strategy: migrating (original)');
		const state = store.readState()!;
		expect(state.status).toBe('finished');
		expect(state.finalize).toMatchObject({ switchStarted: true, moved: 4, madeInNew: 0, summaryEventRaised: true });
		const idMap = JSON.parse(toolkit.files.read(IDMAP)!) as Array<{ from: string; to: string }>;
		expect(idMap.map(entry => entry.from).sort()).toEqual(
			[seed.parent.id, seed.child1.id, seed.child2.id, seed.loose.id].sort()
		);
		// every `to` is the id of the copy in "new": the task is there under it
		for (const entry of idMap) expect((await pair.bRaw.get(entry.to)).id).toBe(entry.to);
		expect(outcome.idMap).toMatchObject({ file: IDMAP, entries: 4 });
		await invariants();
		// nothing of "current" was touched: every task is still there
		expect((await pair.a.get(seed.parent.id)).title).toBe('Parent');
	});

	it('its own lock is not a worker: it finalizes when the process table says its pid is alive (as on a real machine)', async () => {
		await ready();
		toolkit.isAlive = pid => pid === 4242;

		const outcome = await finalize();

		expect(outcome.outcome).toBe('finished');
		expect(toolkit.files.texts.has(LOCK)).toBe(false);
	});

	it('logs every step in the migration log, ending with the outcome', async () => {
		await ready();

		await finalize();

		const steps = logLines()
			.filter(line => line['step'] === 'finalize')
			.map(line => line['outcome']);
		expect(steps).toEqual(['verifying', 'verified', 'recorded', 'switched', 'finished']);
	});

	it('is idempotent: finalizing a finished migration changes nothing and does not raise the event again', async () => {
		await ready();
		await finalize();
		const writes = config.writes;

		const stage = finalizeStage(input, config.fingerprint(config.text));

		expect(stage.kind).toBe('already-finished');
		if (stage.kind !== 'already-finished') throw new Error('unreachable');
		expect(stage.outcome).toMatchObject({ outcome: 'already-finished', moved: 4, eventDue: false });
		expect(config.writes).toBe(writes);
	});

	it('counts the tasks created in "new" while it ran, and gives them no id map entry', async () => {
		await ready();
		const made = await createInNew(pair, { title: 'Made later' });
		wrapped.index.mutate(rows => [...rows, made]);
		syncIndex();

		const outcome = await finalize();

		expect(outcome).toMatchObject({ moved: 4, madeInNew: 1 });
		expect((JSON.parse(toolkit.files.read(IDMAP)!) as unknown[]).length).toBe(4);
	});

	describe('refuses, naming the blocker and the fix, and writes nothing', () => {
		const expectUntouched = (): void => {
			expect(config.text).toBe('strategy: migrating (original)');
			expect(config.writes).toBe(0);
			expect(toolkit.files.texts.has(IDMAP)).toBe(false);
			expect(store.readState()!.finalize).toBeUndefined();
			expect(toolkit.files.texts.has(LOCK)).toBe(false);
		};

		it('while the migration is still running', async () => {
			await ready();
			store.updateState(state => ({ ...state, status: 'running' }));

			const error = await refusal(() => finalizeStage(input, config.fingerprint(config.text)));

			expect(error.message).toMatch(/still running/);
			expect(error.hint).toContain('task strategy migrate status');
			expectUntouched();
		});

		it.each(['paused', 'stopped'] as const)('when the migration is %s, pointing at resume', async status => {
			await ready();
			store.updateState(state => ({ ...state, status }));

			const error = await refusal(() => finalizeStage(input, config.fingerprint(config.text)));

			expect(error.message).toContain(status);
			expect(error.hint).toContain('task strategy migrate resume');
			expectUntouched();
		});

		it('while a worker is alive, naming its pid', async () => {
			await ready();
			new WorkerLock({
				file: LOCK,
				files: toolkit.files,
				pid: 777,
				host: 'box',
				now: clock.now,
				isAlive: () => true,
			}).acquire();
			input = { ...input, isAlive: pid => pid === 777 };

			const error = await refusal(() => finalizeStage(input, config.fingerprint(config.text)));

			expect(error.message).toContain('777');
			expect(error.hint).toContain('task strategy migrate pause');
			expect(store.readState()!.finalize).toBeUndefined();
		});

		it('when a transaction is open in the write-ahead log, saying how to settle it', async () => {
			await ready();
			wrapped.journal.begin('move', seed.parent.id);

			const error = await refusal(() => finalizeStage(input, config.fingerprint(config.text)));

			expect(error.message).toMatch(/unfinished transaction/);
			expect(error.message).toContain(seed.parent.id);
			expect(error.hint).toContain('task strategy check');
			expectUntouched();
		});

		it('when the index still holds tasks in "current" or being moved, listing their ids', async () => {
			await ready();
			wrapped.index.mutate(rows =>
				rows.map(row =>
					row.publicId === seed.loose.id ? { ...row, state: 'in-a' as const, b: undefined } : row
				)
			);
			syncIndex();

			const error = await refusal(() => finalizeStage(input, config.fingerprint(config.text)));

			expect(error.message).toContain(seed.loose.id);
			expect(error.hint).toContain('task strategy migrate resume');
			expectUntouched();
		});

		it('when a task was created in "current" after the move (it would be lost), listing its id', async () => {
			await ready();
			const late = await pair.a.create({ title: 'Created in current meanwhile', status: 'backlog' });

			const error = await refusal(() => finalize());

			expect(error.message).toContain(late.id);
			expect(error.message).toMatch(/created in "current"/);
			expect(error.hint).toMatch(/move it|delete it|task strategy migrate/);
			expectUntouched();
			await invariants(1);
		});

		it('when a copy is missing from "new" (the index says a task is there, the store does not have it)', async () => {
			await ready();
			const row = wrapped.index.snapshot().byPublicId(seed.child2.id)!;
			await pair.bRaw.deleteTask(row.b!);
			wrapped.faults.calls.length = 0;

			const error = await refusal(() => finalize());

			expect(error.message).toContain(seed.child2.id);
			expect(error.message).toMatch(/no copy/);
			expect(error.hint).toContain('rebuild');
			expectUntouched();
		});

		it('when a copy does not say that "new" holds the truth (authority "current")', async () => {
			await ready();
			const row = wrapped.index.snapshot().byPublicId(seed.child1.id)!;
			await pair.bRaw.setMeta(row.b!, 'migrating.authority', 'current');

			const error = await refusal(() => finalize());

			expect(error.message).toContain(seed.child1.id);
			expect(error.message).toMatch(/authority/);
			expectUntouched();
		});

		it('when "new" holds a task of the project that the index does not know', async () => {
			await ready();
			const stray = await createInNew(pair, { title: 'Index lost this' });

			const error = await refusal(() => finalize());

			expect(error.message).toContain(stray.b!);
			expect(error.message).toMatch(/index does not know/);
			expectUntouched();
		});

		it('when the strategy of "new" keeps its task files in its folder (the plain strategy would not find them)', async () => {
			await ready();
			toolkit.files.texts.set(path.join(MIGRATING_DIR, 'new', 'tasks', 'x.json'), '{}');

			const error = await refusal(() => finalize());

			expect(error.message).toContain(path.join(MIGRATING_DIR, 'new', 'tasks'));
			expect(error.hint).toMatch(/task migrate --in-place/);
			expectUntouched();
		});

		it('when the project config changed since it was read for the switch', async () => {
			await ready();
			const sw = config.switchTo(target);
			config.text = 'strategy: somebody edited it';

			const error = await refusal(() => finalizeMigration(toolkit, sw));

			expect(error.message).toMatch(/changed/);
			expect(config.writes).toBe(0);
			expect(config.text).toBe('strategy: somebody edited it');
		});

		it('a migration that was never started', async () => {
			await ready();
			toolkit.files.texts.delete(STATE);

			const error = await refusal(() => finalizeStage(input, config.fingerprint(config.text)));

			expect(error.hint).toContain('task strategy migrate start');
		});
	});

	describe('fault matrix: a failure at every step leaves the config old or new, loses nothing, and a rerun finishes', () => {
		const rerunFinishes = async (): Promise<void> => {
			config.faults = {};
			const stage = finalizeStage(input, config.fingerprint(config.text));
			if (stage.kind === 'interrupted') {
				expect(completeFinalize(input, config.fingerprint(config.text))).toMatchObject({
					outcome: 'bookkeeping-completed',
					eventDue: true,
				});
			} else {
				expect(stage.kind).toBe('verify');
				expect(await finalize()).toMatchObject({ outcome: 'finished' });
			}
			expect(store.readState()!.status).toBe('finished');
			expect(config.text).toBe(target);
			expect(config.writes).toBe(1);
			await invariants();
			// and once more: nothing happens
			expect(finalizeStage(input, config.fingerprint(config.text)).kind).toBe('already-finished');
		};

		it('a store read refused during the verification: nothing is written, the rerun works', async () => {
			await ready();
			wrapped.faults.failOn('b', 'list');

			await expect(finalize()).rejects.toThrow(/injected fault/);

			expect(config.text).toBe('strategy: migrating (original)');
			expect(store.readState()!.finalize).toBeUndefined();
			expect(toolkit.files.texts.has(IDMAP)).toBe(false);
			await invariants();
			await rerunFinishes();
		});

		it('a store read of "current" lost during the verification', async () => {
			await ready();
			wrapped.faults.failOn('a', 'list', { applied: true });

			await expect(finalize()).rejects.toThrow(/injected fault/);

			expect(store.readState()!.finalize).toBeUndefined();
			await invariants();
			await rerunFinishes();
		});

		it('the id map cannot be written (after the verification): the config is untouched', async () => {
			await ready();
			toolkit.files.failReplace.set('idmap.json', 1);

			await expect(finalize()).rejects.toThrow(/idmap/);

			expect(config.text).toBe('strategy: migrating (original)');
			expect(store.readState()!.finalize).toBeUndefined();
			await invariants();
			await rerunFinishes();
		});

		it('the record of what is about to happen cannot be written: the config is untouched', async () => {
			await ready();
			toolkit.files.failReplace.set('state.json', 1);

			await expect(finalize()).rejects.toThrow(/state\.json/);

			expect(config.text).toBe('strategy: migrating (original)');
			expect(config.writes).toBe(0);
			await invariants();
			await rerunFinishes();
		});

		it.each([['beforeBackup'], ['afterBackup']] as const)(
			'a failure at %s: the config is the old one',
			async point => {
				await ready();
				config.faults = { [point]: true };

				await expect(finalize()).rejects.toThrow(/injected fault/);

				expect(config.text).toBe('strategy: migrating (original)');
				expect(store.readState()!.finalize).toMatchObject({ switchStarted: false });
				await invariants();
				await rerunFinishes();
			}
		);

		it('the mark "the switch begins" cannot be saved: the config is NOT written', async () => {
			await ready();
			// 1st replacement = the record of the intent, 2nd = markStarted(true)
			const replace = toolkit.files.replace.bind(toolkit.files);
			let seen = 0;
			toolkit.files.replace = (file, text) => {
				if (file === STATE && ++seen === 2) throw new Error('injected fault: the state cannot be written');
				replace(file, text);
			};

			await expect(finalize()).rejects.toThrow(/injected fault/);

			expect(config.writes).toBe(0);
			expect(config.text).toBe('strategy: migrating (original)');
			toolkit.files.replace = replace;
			await invariants();
			await rerunFinishes();
		});

		it('the config write fails: the old config stays and the state says the switch did not begin', async () => {
			await ready();
			config.faults = { write: true };

			await expect(finalize()).rejects.toThrow(/cannot be written/);

			expect(config.text).toBe('strategy: migrating (original)');
			expect(store.readState()!.finalize).toMatchObject({ switchStarted: false });
			await invariants();
			await rerunFinishes();
		});

		it('the process dies right after the config write: the rerun only completes the bookkeeping, opens no store', async () => {
			await ready();
			config.faults = { afterWrite: true };

			await expect(finalize()).rejects.toThrow(/died after/);

			expect(config.text).toBe(target);
			expect(store.readState()!).toMatchObject({
				status: 'ready-to-finalize',
				finalize: { switchStarted: true },
			});
			expect(finalizeStage(input, config.fingerprint(config.text)).kind).toBe('interrupted');
			// the status says what happened and what to run
			const report = readMigrationStatus(input);
			expect(report.problems.join(' ')).toMatch(/finalize was interrupted/);
			expect(report.next).toContain('task strategy migrate finalize');
			wrapped.faults.calls.length = 0;
			await rerunFinishes();
			expect(wrapped.faults.calls).toEqual([]);
		});

		it('the state cannot be updated after the config write: said loudly with the command that completes it', async () => {
			await ready();
			const replace = toolkit.files.replace.bind(toolkit.files);
			let writesOfState = 0;
			toolkit.files.replace = (file, text) => {
				// intent, markStarted(true), then the final update fails
				if (file === STATE && ++writesOfState === 3) throw new Error('injected fault: the disk is full');
				replace(file, text);
			};

			const error = await finalize().then(
				() => undefined,
				(caught: unknown) => caught
			);

			expect(error).toBeInstanceOf(BackendDataError);
			expect((error as BackendDataError).message).toMatch(/config was switched/);
			expect((error as BackendDataError).hint).toContain('task strategy migrate finalize');
			expect(config.text).toBe(target);
			toolkit.files.replace = replace;
			await rerunFinishes();
		});

		it('two finalize in a row after a success never switch twice', async () => {
			await ready();
			await finalize();

			await expect(finalize()).rejects.toThrow();

			expect(config.writes).toBe(1);
		});
	});

	describe('abort', () => {
		const CURRENT_CONFIG = 'strategy: <the current one>';
		const abortWith = (keepMoved: boolean, extra: Partial<Parameters<typeof abortMigration>[1]> = {}) =>
			abortMigration(input, {
				keepMoved,
				switch: config.switchTo(CURRENT_CONFIG),
				sleep: clock.sleep,
				waitMs: 5_000,
				...extra,
			});
		const moveOne = async (id: string): Promise<void> => {
			expect(await toolkit.moves.moveTask(id, { acceptedLosses: ['all'] })).toMatchObject({ outcome: 'moved' });
			syncIndex();
		};
		const holdWorker = (pid = 777, host = 'box'): void => {
			new WorkerLock({
				file: LOCK,
				files: toolkit.files,
				pid,
				host,
				now: clock.now,
				isAlive: () => true,
			}).acquire();
		};
		const untouched = (): void => {
			expect(config.text).toBe('strategy: migrating (original)');
			expect(config.writes).toBe(0);
			expect(store.readState()!.status).toBe('running');
			expect(store.readState()!.abort).toBeUndefined();
			expect(toolkit.files.texts.has(LOCK) || toolkit.files.texts.has(CONTROL)).toBe(
				toolkit.files.texts.has(LOCK)
			);
		};

		it('with nothing moved: switches the project back to "current", keeps the backup, ends aborted, deletes nothing', async () => {
			await begin();

			const outcome = await abortWith(false);

			expect(outcome).toMatchObject({
				outcome: 'aborted',
				keepMoved: false,
				leftovers: [],
				moved: [],
				config: '/project/config.yml',
				backup: '/project/config.yml.before-migration',
			});
			expect(config.text).toBe(CURRENT_CONFIG);
			expect(config.backup).toBe('strategy: migrating (original)');
			const state = store.readState()!;
			expect(state.status).toBe('aborted');
			expect(state.abort).toMatchObject({ switchStarted: true, keepMoved: false });
			expect(state.stop).toBeUndefined();
			await invariants();
			expect(
				logLines()
					.filter(line => line['step'] === 'abort')
					.map(line => line['outcome'])
			).toEqual(['recorded', 'switched', 'aborted']);
		});

		it('lists the copies of tasks that were being moved as leftovers, in the outcome and in the state, and deletes none', async () => {
			await begin();
			const row = await copyToNew(pair, seed.child1, { state: 'moving', authority: 'current' });
			wrapped.index.mutate(rows => rows.map(r => (r.publicId === seed.child1.id ? row : r)));
			syncIndex();

			const outcome = await abortWith(false);

			expect(outcome.leftovers).toEqual([{ task: seed.child1.id, copy: row.b! }]);
			expect(outcome.warnings.join(' ')).toMatch(/NOT deleted/i);
			expect(outcome.warnings.join(' ')).toContain(row.b!);
			expect(store.readState()!.abort!.leftovers).toEqual([{ task: seed.child1.id, copy: row.b! }]);
			// the copy is still in "new" and "current" is as it was
			expect((await pair.bRaw.get(row.b!)).title).toBe('Child one');
			await invariants();
		});

		it('names the open transactions: a copy may exist that the index does not list', async () => {
			await begin();
			wrapped.journal.begin('move', seed.loose.id);

			const outcome = await abortWith(false);

			expect(outcome.unsettled).toEqual([{ task: seed.loose.id, op: 'move' }]);
			expect(outcome.warnings.join(' ')).toMatch(/unfinished transaction/);
			expect(outcome.warnings.join(' ')).toContain(seed.loose.id);
		});

		describe('refused while a task already lives in "new"', () => {
			it('without --keep-moved: names the tasks and both ways out, and changes nothing (the worker is not even stopped)', async () => {
				await begin();
				await moveOne(seed.parent.id);

				const error = await refusal(() => abortWith(false));

				expect(error.message).toContain(seed.parent.id);
				expect(error.message).toMatch(/in "new"/);
				expect(error.hint).toContain('--keep-moved');
				expect(error.hint).toContain('task strategy migrate finalize');
				untouched();
				expect(toolkit.files.texts.has(CONTROL) && toolkit.files.read(CONTROL)?.includes('stop')).toBeFalsy();
			});

			it('a task created in "new" while the migration ran counts as well', async () => {
				await begin();
				const made = await createInNew(pair, { title: 'Made in new' });
				wrapped.index.mutate(rows => [...rows, made]);
				syncIndex();

				const error = await refusal(() => abortWith(false));

				expect(error.message).toContain(made.b!);
				untouched();
			});
		});

		describe('--keep-moved', () => {
			it('goes back to "current", leaves the moved tasks in "new" listed with their ids, and warns loudly', async () => {
				await begin();
				await moveOne(seed.parent.id);
				const made = await createInNew(pair, { title: 'Made in new' });
				wrapped.index.mutate(rows => [...rows, made]);
				syncIndex();
				const parentCopy = wrapped.index.snapshot().byPublicId(seed.parent.id)!.b!;

				const outcome = await abortWith(true);

				expect(outcome).toMatchObject({ outcome: 'aborted', keepMoved: true });
				expect(outcome.moved).toEqual(
					expect.arrayContaining([
						{ task: seed.parent.id, copy: parentCopy, madeInNew: false },
						{ task: made.publicId, copy: made.b!, madeInNew: true },
					])
				);
				const text = outcome.warnings.join(' ');
				expect(text).toMatch(/no longer part of this project/);
				expect(text).toContain(made.b!);
				// the moved task shows its OLDER copy of "current": said, not hidden
				expect(text).toMatch(/older copy/i);
				expect(config.text).toBe(CURRENT_CONFIG);
				expect(store.readState()!.abort!.moved.length).toBe(2);
				// nothing was deleted: the copies are in "new", the tasks in "current"
				expect((await pair.bRaw.get(parentCopy)).title).toBe('Parent');
				await invariants();
			});

			it('re-reads the index once the worker is gone: a task it finished moving meanwhile is refused without --keep-moved', async () => {
				await begin();
				holdWorker();
				input = { ...input, isAlive: pid => pid === 777 };
				clock.onSleep = async () => {
					// the worker ends its move, then exits
					await moveOne(seed.parent.id);
					toolkit.files.remove(LOCK);
				};

				const error = await refusal(() => abortWith(false));

				expect(error.message).toContain(seed.parent.id);
				expect(config.writes).toBe(0);
			});
		});

		describe('a worker that is running', () => {
			it('is asked to stop through the control file, waited for, and the abort goes on once it is gone', async () => {
				await begin();
				holdWorker();
				input = { ...input, isAlive: pid => pid === 777 };
				clock.onSleep = () => {
					expect(JSON.parse(toolkit.files.read(CONTROL)!)).toMatchObject({ command: 'stop' });
					toolkit.files.remove(LOCK);
				};

				const outcome = await abortWith(false);

				expect(outcome.outcome).toBe('aborted');
				expect(store.readState()!.status).toBe('aborted');
				expect(logLines().some(line => line['step'] === 'abort' && line['outcome'] === 'stop-requested')).toBe(
					true
				);
			});

			it('that does not stop in time: refused naming its pid, the stop request stays, nothing else changed', async () => {
				await begin();
				holdWorker();
				input = { ...input, isAlive: pid => pid === 777 };

				const error = await refusal(() => abortWith(false, { waitMs: 3_000 }));

				expect(error.message).toContain('777');
				expect(error.message).toMatch(/did not stop/);
				expect(error.hint).toContain('task strategy migrate abort');
				expect(JSON.parse(toolkit.files.read(CONTROL)!)).toMatchObject({ command: 'stop' });
				expect(config.writes).toBe(0);
				expect(store.readState()!.abort).toBeUndefined();
			});

			it('on another computer: refused, task cannot stop it', async () => {
				await begin();
				holdWorker(900, 'other-box');

				const error = await refusal(() => abortWith(false));

				expect(error.message).toContain('other-box');
				expect(config.writes).toBe(0);
			});
		});

		describe('states that cannot be aborted, and repeating it', () => {
			it('a finished migration: refused, pointing at the backup of the project config', async () => {
				await ready();
				await finalize();

				const error = await refusal(() => abortStage(input, config.fingerprint(config.text)));

				expect(error.message).toMatch(/finished/);
				expect(error.hint).toMatch(/before-migration/);
			});

			it('a finalize that was interrupted after the config switch: refused, pointing at finalize', async () => {
				await ready();
				config.faults = { afterWrite: true };
				await expect(finalize()).rejects.toThrow(/died after/);

				const error = await refusal(() => abortStage(input, config.fingerprint(config.text)));

				expect(error.message).toMatch(/finalize was interrupted/);
				expect(error.hint).toContain('task strategy migrate finalize');
			});

			it('an aborted migration is aborted: the stage says so, with the same outcome, and nothing is written again', async () => {
				await begin();
				const first = await abortWith(false);
				const writes = config.writes;

				const stage = abortStage(input, config.fingerprint(config.text));

				expect(stage.kind).toBe('already-aborted');
				if (stage.kind !== 'already-aborted') throw new Error('unreachable');
				expect(stage.outcome).toMatchObject({
					outcome: 'already-aborted',
					keepMoved: false,
					leftovers: first.leftovers,
				});
				expect(config.writes).toBe(writes);
			});

			it('no migration started: refused with the command that starts one', async () => {
				await begin();
				toolkit.files.texts.delete(STATE);

				const error = await refusal(() => abortStage(input, config.fingerprint(config.text)));

				expect(error.hint).toContain('task strategy migrate start');
			});

			it('a config changed under it is refused, the config untouched', async () => {
				await begin();
				const sw = config.switchTo(CURRENT_CONFIG);
				config.text = 'strategy: somebody edited it';

				const error = await refusal(() => abortWith(false, { switch: sw }));

				expect(error.message).toMatch(/changed/);
				expect(config.text).toBe('strategy: somebody edited it');
			});
		});

		describe('fault matrix: a failure at every step leaves the config old or new, loses nothing, deletes nothing, and a rerun finishes', () => {
			const rerunFinishes = async (extraInCurrent = 0): Promise<void> => {
				config.faults = {};
				const stage = abortStage(input, config.fingerprint(config.text));
				if (stage.kind === 'interrupted') {
					expect(completeAbort(input, config.fingerprint(config.text))).toMatchObject({
						outcome: 'bookkeeping-completed',
					});
				} else {
					expect(stage.kind).toBe('run');
					expect(await abortWith(false)).toMatchObject({ outcome: 'aborted' });
				}
				expect(store.readState()!.status).toBe('aborted');
				expect(config.text).toBe(CURRENT_CONFIG);
				expect(config.writes).toBe(1);
				await invariants(extraInCurrent);
				expect(abortStage(input, config.fingerprint(config.text)).kind).toBe('already-aborted');
			};
			const beforeAnything = async (): Promise<void> => {
				await begin();
				const row = await copyToNew(pair, seed.child1, { state: 'moving', authority: 'current' });
				wrapped.index.mutate(rows => rows.map(r => (r.publicId === seed.child1.id ? row : r)));
				syncIndex();
			};

			it('the record of what is about to happen cannot be written: the config is untouched', async () => {
				await beforeAnything();
				toolkit.files.failReplace.set('state.json', 1);

				await expect(abortWith(false)).rejects.toThrow(/state\.json/);

				expect(config.text).toBe('strategy: migrating (original)');
				expect(config.writes).toBe(0);
				await invariants();
				await rerunFinishes();
			});

			it.each([['beforeBackup'], ['afterBackup']] as const)('a failure at %s', async point => {
				await beforeAnything();
				config.faults = { [point]: true };

				await expect(abortWith(false)).rejects.toThrow(/injected fault/);

				expect(config.text).toBe('strategy: migrating (original)');
				expect(store.readState()!.abort).toMatchObject({ switchStarted: false });
				await invariants();
				await rerunFinishes();
			});

			it('the mark "the switch begins" cannot be saved: the config is NOT written', async () => {
				await beforeAnything();
				const replace = toolkit.files.replace.bind(toolkit.files);
				let seen = 0;
				toolkit.files.replace = (file, text) => {
					if (file === STATE && ++seen === 2) throw new Error('injected fault: the state cannot be written');
					replace(file, text);
				};

				await expect(abortWith(false)).rejects.toThrow(/injected fault/);

				expect(config.writes).toBe(0);
				toolkit.files.replace = replace;
				await invariants();
				await rerunFinishes();
			});

			it('the config write fails: old config, state says the switch did not begin', async () => {
				await beforeAnything();
				config.faults = { write: true };

				await expect(abortWith(false)).rejects.toThrow(/cannot be written/);

				expect(config.text).toBe('strategy: migrating (original)');
				expect(store.readState()!.abort).toMatchObject({ switchStarted: false });
				await invariants();
				await rerunFinishes();
			});

			it('the process dies right after the config write: the rerun completes the bookkeeping only', async () => {
				await beforeAnything();
				config.faults = { afterWrite: true };

				await expect(abortWith(false)).rejects.toThrow(/died after/);

				expect(config.text).toBe(CURRENT_CONFIG);
				expect(store.readState()!).toMatchObject({ status: 'running', abort: { switchStarted: true } });
				expect(abortStage(input, config.fingerprint(config.text)).kind).toBe('interrupted');
				expect(readMigrationStatus(input).next).toContain('task strategy migrate abort');
				await rerunFinishes();
				// the leftovers recorded before the switch are still in the state
				expect(store.readState()!.abort!.leftovers.length).toBe(1);
			});

			it('the state cannot be updated after the config write: said loudly with the command that completes it', async () => {
				await beforeAnything();
				const replace = toolkit.files.replace.bind(toolkit.files);
				let writesOfState = 0;
				toolkit.files.replace = (file, text) => {
					if (file === STATE && ++writesOfState === 3) throw new Error('injected fault: the disk is full');
					replace(file, text);
				};

				const error = await abortWith(false).then(
					() => undefined,
					(caught: unknown) => caught
				);

				expect(error).toBeInstanceOf(BackendDataError);
				expect((error as BackendDataError).message).toMatch(/config was switched/);
				expect((error as BackendDataError).hint).toContain('task strategy migrate abort');
				toolkit.files.replace = replace;
				await rerunFinishes();
			});
		});
	});
});
