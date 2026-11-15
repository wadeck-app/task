// Recovery after a crash (or after a failure that left the state of a task uncertain): the transactions the write-ahead log shows as
// begun and never ended are settled one by one, each from what the STORES and the index say now, with idempotent steps.
//
// A transaction is left open on purpose whenever its outcome is uncertain (a lost answer, a crash): a transaction that has an `end` is
// one whose consequences are known. So this module decides, per kind of transaction:
//   move     the copy is adopted (it exists in "new", the index lacks it: moving + stale), or the half-done switch is rolled back to
//            `moving` (markers back to "current"), or a finished switch is completed;
//   write    the copy of a moving task is marked stale (the mirror may not have happened);
//   create   the task created in "new" is given its identity block and its row (rolled FORWARD: the person was told it was created);
//   delete   rolled FORWARD from the logged intent (the person asked for it): the index says deleted, the copy is deleted;
//   others   nothing to settle.
// What a recovery did is told: one line of the migration log per action, and the report that the owner prints at warn level.
// A transaction that cannot be settled (a side is unreachable...) stays open, the task is listed in `unsettled`, and a write to it is
// refused with the reason until the next opening settles it.
import type { ResolvedTask } from '@wadeck-app/task-core';

import { hashOf, identityEntries, iso, markStale } from './engineSupport.js';
import type { EngineDeps } from './engineSupport.js';
import { IDENTITY_KEYS, isIdentityKey, readIdentity } from './identityBlock.js';
import type { OpenTx } from './migrationJournal.js';
import type { IndexRow } from './routingIndex.js';

export interface RecoveryReport {
	/** One sentence per thing recovery did (empty: nothing to do). */
	actions: string[];
	/** Transactions that could not be settled: public id (or the transaction for a creation) -> why. */
	unsettled: Array<{ task: string; tx: string; reason: string }>;
}

export function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== 'ESRCH';
	}
}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export class Recovery {
	constructor(
		private readonly deps: EngineDeps,
		private readonly alive: (pid: number) => boolean = processAlive
	) {}

	/** Settles every open transaction (the opening of the project). */
	async recoverAll(): Promise<RecoveryReport> {
		const report: RecoveryReport = { actions: [], unsettled: [] };
		for (const open of this.deps.journal.openTransactions()) {
			if (open.task === '') await this.settleOne(open, report);
			else await this.deps.mutex.run(open.task, () => this.settleOne(open, report));
		}
		if (report.unsettled.length === 0) this.deps.journal.compact();
		return report;
	}

	/** Settles what is open for one task (before a move starts: an earlier attempt of this process may have left something open). */
	async settleTask(publicId: string): Promise<RecoveryReport> {
		const report: RecoveryReport = { actions: [], unsettled: [] };
		for (const open of this.deps.journal.openTransactions()) {
			if (open.task === publicId) await this.settleOne(open, report);
		}
		return report;
	}

	private async settleOne(open: OpenTx, report: RecoveryReport): Promise<void> {
		const { deps } = this;
		const pid = open.begin.data?.['pid'];
		if (typeof pid === 'number' && pid !== process.pid && this.alive(pid)) {
			// Another live process of this machine is in the middle of it: it is not ours to settle.
			return;
		}
		try {
			const outcome =
				open.op === 'move'
					? await this.move(open)
					: open.op === 'write'
						? this.write(open)
						: open.op === 'create'
							? await this.create(open)
							: open.op === 'delete'
								? await this.delete(open)
								: `nothing to settle for ${open.op}`;
			deps.unsettled.delete(open.task);
			this.close(open, outcome.startsWith('nothing') ? 'settled' : 'recovered');
			if (!outcome.startsWith('nothing')) {
				report.actions.push(outcome);
				deps.journal.info('warn', `recovery: ${outcome}`, {
					task: open.task,
					tx: open.tx,
					op: open.op,
					outcome: 'recovered',
				});
			}
		} catch (error) {
			const reason = errorText(error);
			const key = open.task === '' ? `new task (${open.tx})` : open.task;
			deps.unsettled.set(open.task === '' ? key : open.task, reason);
			report.unsettled.push({ task: open.task, tx: open.tx, reason });
			deps.journal.info(
				'error',
				`recovery of ${open.op} ${key} could not finish: ${reason}; it stays open and is tried again the next time the project opens`,
				{
					task: open.task,
					tx: open.tx,
					op: open.op,
					outcome: 'unsettled',
				}
			);
		}
	}

	private close(open: OpenTx, outcome: string): void {
		this.deps.journal.write({ tx: open.tx, task: open.task, op: open.op, event: 'end', outcome });
	}

	// ---- move ----

	private async move(open: OpenTx): Promise<string> {
		const { deps } = this;
		const publicId = open.task;
		const row = deps.index.snapshot().byPublicId(publicId);
		if (row?.state === 'deleted')
			return `move of task ${publicId}: the task was deleted meanwhile; nothing to settle for the copy (its deletion settles it)`;
		if (row?.state === 'in-b') {
			// The switch was written; the markers come first, so they are there. Make sure.
			await this.markers(row.b!, publicId, 'new');
			return `move of task ${publicId}: the switch to "new" had been written; completed (its copy "${row.b!}" is the task)`;
		}
		const copied = open.done('copy')?.data?.['b'];
		let b = typeof copied === 'string' ? copied : row?.b;
		if (b === undefined && open.attempted('copy')) b = await this.findCopyOf(publicId);
		if (row?.state === 'moving') {
			if (open.attempted('marker') || open.attempted('switch')) {
				// A switch that did not reach the index: back to "current" being the truth, until a catch-up redoes it.
				await this.markers(row.b!, publicId, 'current');
			}
			markStale(deps, publicId, 'a move of this task was interrupted');
			return `move of task ${publicId}: interrupted while moving; its copy "${row.b!}" is marked stale and the next catch-up compares it with "current" before authority can switch`;
		}
		if (b !== undefined) await this.completeIdentity(b, publicId);
		if (b === undefined) {
			return open.attempted('copy')
				? `move of task ${publicId}: interrupted before the copy existed in "new" (none was found); nothing was moved, the task is still only in "current"`
				: `nothing to settle: the move of task ${publicId} had not started`;
		}
		const accepted = String(open.begin.data?.['accepted'] ?? '')
			.split(',')
			.filter(kind => kind !== '');
		const adopted: IndexRow = {
			publicId,
			a: publicId,
			b,
			state: 'moving',
			stale: true,
			...(accepted.length === 0 ? {} : { accepted }),
			since: iso(deps),
			version: 1,
		};
		deps.index.mutateRow(publicId, {}, current => {
			if (current !== undefined && current.state !== 'in-a') return current;
			return current === undefined ? adopted : { ...adopted, version: current.version };
		});
		return `move of task ${publicId}: interrupted after its copy "${b}" was made in "new"; the copy is adopted as moving and stale, and the next catch-up completes it`;
	}

	/**
	 * A copy that a crash left without (or with half of) its identity block: the entries still missing are written, in the order that
	 * makes the block readable only at the end (the public id last), so the copy can be routed and found by a rebuild.
	 */
	private async completeIdentity(b: string, publicId: string): Promise<void> {
		const { deps } = this;
		const copy = await deps.next.resolve(b);
		const record = await deps.current.get(publicId);
		for (const [key, value] of identityEntries({
			publicId,
			fromId: publicId,
			hash: hashOf(record),
			authority: 'current',
		})) {
			if (copy.meta !== undefined && Object.hasOwn(copy.meta, key)) continue;
			await deps.next.setMeta(b, key, value);
		}
	}

	/**
	 * The copy of `publicId` the index does not know: a task of "new" naming it as its origin. A creation whose answer was lost, or that
	 * died before its first identity entry, left a copy that names nothing: the one unrouted task of "new" with no identity entry at all
	 * and the title of the task is taken for it (several of them: the recovery refuses to guess).
	 */
	private async findCopyOf(publicId: string): Promise<string | undefined> {
		const snapshot = this.deps.index.snapshot();
		const found: string[] = [];
		const bare: string[] = [];
		const title = (await this.deps.current.get(publicId).catch(() => undefined))?.title;
		for (const summary of await this.deps.next.list()) {
			if (snapshot.byB(summary.id) !== undefined) continue;
			const task = await this.deps.next.resolve(summary.id);
			if (this.originOf(task) === publicId) found.push(summary.id);
			else if (title !== undefined && task.title === title && !Object.keys(task.meta ?? {}).some(isIdentityKey))
				bare.push(summary.id);
		}
		if (found.length === 0 && bare.length > 1) {
			throw new Error(
				`the copy of task ${publicId} was interrupted and ${bare.length} tasks of "new" with its title carry no identity block (${bare.join(', ')}); delete the extra ones in "new", then open the project again`
			);
		}
		if (found.length === 0 && bare.length === 1) found.push(bare[0]!);
		if (found.length > 1) {
			this.deps.journal.info(
				'error',
				`task ${publicId}: ${found.length} copies in "new" name it as their origin (${found.join(', ')}); the first is adopted, the others are left alone and are not routed`,
				{ task: publicId, outcome: 'duplicate-copies' }
			);
		}
		return found[0];
	}

	private originOf(task: ResolvedTask): string | undefined {
		return task.meta?.[IDENTITY_KEYS.fromId];
	}

	/** Puts the authority marker (and, going to "new", the hash of the task as it is) back where the index says it should be. */
	private async markers(b: string, publicId: string, authority: 'current' | 'new'): Promise<void> {
		const { deps } = this;
		const copy = await deps.next.resolve(b);
		if (authority === 'new') {
			const record = await deps.current.get(publicId).catch(() => undefined);
			if (record !== undefined && copy.meta?.[IDENTITY_KEYS.hash] !== hashOf(record)) {
				await deps.next.setMeta(b, IDENTITY_KEYS.hash, hashOf(record));
			}
		}
		if (copy.meta?.[IDENTITY_KEYS.authority] !== authority)
			await deps.next.setMeta(b, IDENTITY_KEYS.authority, authority);
	}

	// ---- write ----

	private write(open: OpenTx): string {
		const row = this.deps.index.snapshot().byPublicId(open.task);
		if (row?.state !== 'moving')
			return `nothing to settle: the write to task ${open.task} was made when it was not moving`;
		markStale(this.deps, open.task, 'a write to this task was interrupted');
		return `write to task ${open.task} (${String(open.begin.data?.['operation'] ?? 'an operation')}): interrupted; its copy "${row.b!}" is marked stale (it may not have followed)`;
	}

	// ---- create ----

	private async create(open: OpenTx): Promise<string> {
		const { deps } = this;
		const known = open.done('create')?.data?.['b'];
		let b = typeof known === 'string' ? known : undefined;
		if (b === undefined) {
			const snapshot = deps.index.snapshot();
			const title = String(open.begin.data?.['title'] ?? '');
			const candidates: string[] = [];
			for (const summary of await deps.next.list()) {
				if (snapshot.byB(summary.id) !== undefined || summary.title !== title) continue;
				const task = await deps.next.resolve(summary.id);
				const block = (() => {
					try {
						return readIdentity(task.meta, `task ${summary.id} in "new"`);
					} catch {
						return undefined;
					}
				})();
				if (block?.fromId === undefined && this.originOf(task) === undefined) candidates.push(summary.id);
			}
			if (candidates.length === 0)
				return `nothing to settle: no task created in "new" was found for the creation of "${title}"`;
			if (candidates.length > 1) {
				throw new Error(
					`the creation of "${title}" was interrupted and ${candidates.length} tasks of "new" with that title are not in the routing index (${candidates.join(', ')}); delete the extra ones in "new" or add the row by hand, then open the project again`
				);
			}
			b = candidates[0]!;
		}
		const row = deps.index.snapshot().byPublicId(b);
		if (row !== undefined) return `nothing to settle: the task ${b} created in "new" is already routed`;
		const copy = await deps.next.get(b);
		const hash =
			typeof open.done('create')?.data?.['hash'] === 'string'
				? String(open.done('create')?.data?.['hash'])
				: hashOf(copy);
		for (const [key, value] of identityEntries({ publicId: b, hash, authority: 'new' })) {
			if (copy.meta !== undefined && Object.hasOwn(copy.meta, key)) continue;
			await deps.next.setMeta(b, key, value);
		}
		deps.index.mutateRow(
			b,
			{},
			current => current ?? { publicId: b!, b: b!, state: 'in-b', since: iso(deps), version: 1 }
		);
		return `creation of a task in "new": interrupted; the task "${b}" was finished (identity block and routing entry)`;
	}

	// ---- delete ----

	private async delete(open: OpenTx): Promise<string> {
		const { deps } = this;
		const publicId = open.task;
		const row = deps.index.snapshot().byPublicId(publicId);
		if (row === undefined) return `nothing to settle: task ${publicId} has no row`;
		const state = String(open.begin.data?.['state'] ?? row.state);
		if (row.state !== 'deleted') {
			if (state === 'moving') {
				if (open.attempted('delete')) await deps.current.deleteTask(publicId);
				else return `nothing to settle: the deletion of task ${publicId} had not started`;
			} else if (row.b !== undefined && open.attempted('delete')) {
				await deps.next.deleteTask(row.b);
			} else {
				return `nothing to settle: the deletion of task ${publicId} had not started`;
			}
			deps.index.mutateRow(publicId, { mustExist: true }, current => {
				const { stale: _stale, accepted: _accepted, ...rest } = current!;
				void _stale;
				void _accepted;
				return { ...rest, state: 'deleted', since: iso(deps) };
			});
		}
		if (state === 'moving' && row.b !== undefined) await deps.next.deleteTask(row.b);
		return `deletion of task ${publicId}: interrupted; finished (the task is deleted${state === 'moving' ? ' and so is its copy in "new"' : ''})`;
	}
}
