// The move of ONE task from current to new: a state machine over the routing index, every step logged BEFORE it is applied.
//
//   in-a --copy--> (copy in new, identity block "current") --index--> moving --catch up--> (copy equal) --markers--> --index--> in-b
//
// - The copy is the per-task code of `task migrate` (the host's `copyTasks`): mapping, loss ledger, creation that carries its fields,
//   read-back. The losses must already be accepted (`acceptedLosses`); a task whose losses are not is left alone and reported.
// - `moving`: current stays the truth; every write of a person is mirrored to the copy (routedWrites.ts), and a mirror that failed
//   leaves the row `stale`. Authority switches only when a catch-up found the copy equal AND verified it by reading it back.
// - The switch is ONE index write (commit point). Just before it the copy's authority marker is set to "new" (and its hash to the
//   task's), so the index can be rebuilt from the stores alone; a crash between the two is rolled back by the recovery (marker back to
//   "current"). The copy in current is KEPT (decision D17).
// - A claimed task (a live lease) is not moved: `skipped-claimed`, not an error. A task whose relation targets have no copy yet is
//   copied without that relation and stays `moving` (`deferred`): the switch needs every relation writable in new.
// - Any failure leaves the transaction OPEN: its outcome is uncertain until the recovery has looked at the stores. The next call for the
//   same task (or the next opening) settles it first.
import { TaskNotFoundError } from '@wadeck-app/task-core';

import type { TaskCopyLoss } from '../kinds.js';
import {
	copyInputFor,
	hashOf,
	identityEntries,
	isLeased,
	iso,
	markStale,
	reach,
	requireIdentityCarrier,
} from './engineSupport.js';
import type { EngineDeps } from './engineSupport.js';
import { IDENTITY_KEYS } from './identityBlock.js';
import type { JournalTx } from './migrationJournal.js';
import type { Recovery } from './migrationRecovery.js';
import { IndexConflictError } from './routingIndex.js';
import type { IndexRow } from './routingIndex.js';

export interface MoveOptions {
	/** Loss kinds (or groups, or `all`) the person accepted for this move. */
	acceptedLosses: readonly string[];
}

export type MoveOutcome =
	/** The task now lives in new; its copy in current is kept as the backup. */
	| { outcome: 'moved'; b: string }
	| { outcome: 'already-moved' }
	/** A live lease: the task is left where it is (not an error). */
	| { outcome: 'skipped-claimed'; leaseUntil: string }
	/** What the copy would lose is not all accepted: nothing was written. */
	| { outcome: 'blocked-losses'; losses: TaskCopyLoss[] }
	/** The copy exists but cannot be complete until the tasks named here have a copy too. */
	| { outcome: 'deferred'; waitingFor: string[] }
	/** The copy, read back after the catch-up, still differs from the task: nothing switched. */
	| { outcome: 'verify-failed'; differences: string[] }
	/** Another process changed the row meanwhile: nothing switched, call again. */
	| { outcome: 'busy'; reason: string };

export type CatchUpOutcome =
	| { outcome: 'caught-up' }
	| { outcome: 'not-moving'; state: string }
	| Exclude<MoveOutcome, { outcome: 'moved' } | { outcome: 'already-moved' }>;

export class TaskMover {
	constructor(
		private readonly deps: EngineDeps,
		private readonly recovery: Recovery
	) {}

	/** Moves the task to new (copy, catch up, switch). Safe to call again after any failure or crash: it settles what was left first. */
	moveTask(publicId: string, options: MoveOptions): Promise<MoveOutcome> {
		return this.deps.mutex.run(publicId, () => this.moveLocked(publicId, options));
	}

	/** Brings the copy of a moving task equal to the task and clears its stale flag; does not switch authority. */
	catchUp(publicId: string, options: MoveOptions = { acceptedLosses: [] }): Promise<CatchUpOutcome> {
		return this.deps.mutex.run(publicId, () => this.catchUpLocked(publicId, options));
	}

	private async settle(publicId: string): Promise<void> {
		const report = await this.recovery.settleTask(publicId);
		const stuck = report.unsettled.find(item => item.task === publicId);
		if (stuck !== undefined) {
			throw new Error(`an earlier change of task ${publicId} is still unsettled (${stuck.reason})`);
		}
		for (const action of report.actions)
			this.deps.journal.info('warn', `before moving task ${publicId}: ${action}`, { task: publicId });
	}

	private async moveLocked(publicId: string, options: MoveOptions): Promise<MoveOutcome> {
		const { deps } = this;
		await this.settle(publicId);
		const row = deps.index.snapshot().byPublicId(publicId);
		if (row?.state !== 'in-b' && row?.state !== 'deleted') requireIdentityCarrier(deps, 'moving a task');
		if (row?.state === 'deleted') throw new TaskNotFoundError(publicId);
		if (row?.state === 'in-b') return { outcome: 'already-moved' };

		const tx = deps.journal.begin('move', publicId, {
			from: row?.state ?? 'in-a',
			accepted: options.acceptedLosses.join(','),
		});
		try {
			let moving = row;
			if (moving === undefined || moving.state === 'in-a') {
				const copied = await this.copy(tx, publicId, moving, options);
				if ('outcome' in copied) return copied;
				moving = copied;
			}
			const equal = await this.equalize(tx, publicId, moving, options);
			if ('outcome' in equal) return equal;
			return await this.switchAuthority(tx, publicId, equal);
		} catch (error) {
			if (error instanceof IndexConflictError) {
				tx.endAfterApply('busy', error);
				return { outcome: 'busy', reason: error.message };
			}
			tx.stepAfterApply('move', 'current', 'failed', undefined, error);
			// The transaction stays open: what was applied is settled from the stores by the next recovery.
			throw error;
		}
	}

	/** Phase 1: the copy in new and the `moving` row. */
	private async copy(
		tx: JournalTx,
		publicId: string,
		row: IndexRow | undefined,
		options: MoveOptions
	): Promise<IndexRow | MoveOutcome> {
		const { deps } = this;
		await reach(deps, 'move:read');
		const record = await deps.current.get(publicId);
		if (isLeased(record, deps.now())) {
			return this.skippedClaimed(tx, publicId, record.leaseUntil!);
		}
		const hash = hashOf(record);
		const identity = identityEntries({ publicId, fromId: publicId, hash, authority: 'current' });
		const input = await copyInputFor(deps, deps.index.snapshot(), record, options.acceptedLosses, identity);
		const { blocking } = deps.copier.assess(input);
		if (blocking.length > 0) {
			tx.endAfterApply('blocked-losses');
			deps.journal.info(
				'warn',
				`task ${publicId} is not moved: ${blocking.map(loss => loss.text).join('; ')}. ${blocking.map(loss => `${loss.kind}: ${loss.fix}`).join('; ')}`,
				{ task: publicId, tx: tx.id, op: 'move', outcome: 'blocked-losses' }
			);
			return { outcome: 'blocked-losses', losses: blocking };
		}
		await reach(deps, 'move:copy');
		tx.step('copy', 'new', 'intent', { hash });
		const result = await deps.copier.copy(input);
		tx.stepAfterApply('copy', 'new', 'done', { b: result.id });

		await reach(deps, 'move:index-moving');
		tx.step('index', 'index', 'intent', { state: 'moving', b: result.id });
		// Authority has not moved, so a write that reached current while the copy was made is the one thing the copy may lack.
		const after = await deps.current.get(publicId);
		const stale = result.unresolved.length > 0 || hashOf(after) !== hash;
		const accepted = [...new Set(options.acceptedLosses)];
		const written = deps.index.mutateRow(publicId, {}, current => {
			if (current !== undefined && current.state !== 'in-a') {
				throw new IndexConflictError(
					'migrating',
					publicId,
					`the row of task ${publicId} is "${current.state}" now: another process moved it meanwhile`,
					'Run the command again; nothing was written for this attempt.'
				);
			}
			return {
				publicId,
				a: publicId,
				b: result.id,
				state: 'moving',
				since: iso(deps),
				version: current?.version ?? 0,
				...(stale ? { stale: true } : {}),
				...(accepted.length === 0 ? {} : { accepted }),
			};
		});
		tx.stepAfterApply('index', 'index', 'done', { state: 'moving' });
		return written.byPublicId(publicId)!;
	}

	/** Phase 2: the copy equal to the task, verified by reading it back. Returns the row to switch, or the outcome that stops here. */
	private async equalize(
		tx: JournalTx,
		publicId: string,
		row: IndexRow,
		options: MoveOptions
	): Promise<IndexRow | MoveOutcome> {
		const { deps } = this;
		await reach(deps, 'move:catch-up');
		const record = await deps.current.get(publicId);
		if (isLeased(record, deps.now())) return this.skippedClaimed(tx, publicId, record.leaseUntil!);
		const accepted = [...new Set([...(row.accepted ?? []), ...options.acceptedLosses])];
		const identity = identityEntries({ publicId, fromId: publicId, hash: hashOf(record), authority: 'current' });
		const input = await copyInputFor(deps, deps.index.snapshot(), record, accepted, identity);
		const { blocking } = deps.copier.assess(input);
		if (blocking.length > 0) {
			tx.endAfterApply('blocked-losses');
			deps.journal.info(
				'warn',
				`task ${publicId} stays moving: ${blocking.map(loss => `${loss.kind}: ${loss.fix}`).join('; ')}`,
				{
					task: publicId,
					tx: tx.id,
					op: 'move',
					outcome: 'blocked-losses',
				}
			);
			return { outcome: 'blocked-losses', losses: blocking };
		}
		tx.step('catch-up', 'new', 'intent');
		const result = await deps.copier.copy({ ...input, existingId: row.b! });
		tx.stepAfterApply('catch-up', 'new', 'done', { unresolved: result.unresolved.length });
		if (result.unresolved.length > 0) {
			markStale(deps, publicId, 'a relation cannot be written in "new" yet');
			const waitingFor = [...new Set(result.unresolved.map(open => open.sourceId))];
			tx.endAfterApply('deferred');
			deps.journal.info(
				'info',
				`task ${publicId} stays moving: it waits for ${waitingFor.join(', ')} to have a copy in "new" (relation written then)`,
				{ task: publicId, tx: tx.id, op: 'move', outcome: 'deferred' }
			);
			return { outcome: 'deferred', waitingFor };
		}
		tx.step('verify', 'new', 'intent');
		const differences = await deps.copier.verify({ ...input, id: row.b! });
		tx.stepAfterApply('verify', 'new', 'done', { differences: differences.length });
		if (differences.length > 0) {
			markStale(deps, publicId, 'the copy read back differs from the task');
			tx.endAfterApply('verify-failed');
			deps.journal.info(
				'warn',
				`task ${publicId} stays moving: the copy read back differs from the task: ${differences.join('; ')}`,
				{
					task: publicId,
					tx: tx.id,
					op: 'move',
					outcome: 'verify-failed',
				}
			);
			return { outcome: 'verify-failed', differences };
		}
		return deps.index.snapshot().byPublicId(publicId)!;
	}

	/** Phase 3: the markers, then the ONE index write that makes new the truth. */
	private async switchAuthority(tx: JournalTx, publicId: string, row: IndexRow): Promise<MoveOutcome> {
		const { deps } = this;
		const b = row.b!;
		const record = await deps.current.get(publicId);
		await reach(deps, 'move:marker');
		tx.step('marker', 'new', 'intent', { b });
		await deps.next.setMeta(b, IDENTITY_KEYS.hash, hashOf(record));
		await deps.next.setMeta(b, IDENTITY_KEYS.authority, 'new');
		tx.stepAfterApply('marker', 'new', 'done', { b });
		await reach(deps, 'move:switch');
		tx.step('switch', 'index', 'intent', { b });
		deps.index.mutateRow(publicId, { expectedVersion: row.version, mustExist: true }, current => {
			const { stale: _stale, accepted: _accepted, ...rest } = current!;
			void _stale;
			void _accepted;
			return { ...rest, state: 'in-b', since: iso(deps) };
		});
		tx.stepAfterApply('switch', 'index', 'done', { b });
		await reach(deps, 'move:end');
		tx.endAfterApply('moved');
		return { outcome: 'moved', b };
	}

	private skippedClaimed(tx: JournalTx, publicId: string, leaseUntil: string): MoveOutcome {
		tx.endAfterApply('skipped-claimed');
		this.deps.journal.info('info', `task ${publicId} is not moved now: it is claimed until ${leaseUntil}`, {
			task: publicId,
			tx: tx.id,
			op: 'move',
			outcome: 'skipped-claimed',
		});
		return { outcome: 'skipped-claimed', leaseUntil };
	}

	private async catchUpLocked(publicId: string, options: MoveOptions): Promise<CatchUpOutcome> {
		const { deps } = this;
		await this.settle(publicId);
		const row = deps.index.snapshot().byPublicId(publicId);
		if (row === undefined || row.state !== 'moving') return { outcome: 'not-moving', state: row?.state ?? 'in-a' };
		const tx = deps.journal.begin('catch-up', publicId, { accepted: options.acceptedLosses.join(',') });
		try {
			const equal = await this.equalize(tx, publicId, row, options);
			if ('outcome' in equal) return equal as CatchUpOutcome;
			if (equal.stale === true) {
				deps.index.mutateRow(publicId, { expectedVersion: equal.version, mustExist: true }, current => {
					const { stale: _stale, ...rest } = current!;
					void _stale;
					return rest;
				});
			}
			tx.endAfterApply('ok');
			return { outcome: 'caught-up' };
		} catch (error) {
			if (error instanceof IndexConflictError) {
				tx.endAfterApply('busy', error);
				return { outcome: 'busy', reason: error.message };
			}
			tx.stepAfterApply('catch-up', 'new', 'failed', undefined, error);
			throw error;
		}
	}
}
