// The writes of the migrating strategy: every write of the port goes to the side that holds the truth of the task, as the routing index
// says, and while the task is moving it is also mirrored to its copy so the switch of authority finds the copy equal.
//
//   in-a (or no row)   written in current; one store, no transaction of ours (the store's own atomicity is the guarantee)
//   in-b               written in new, same
//   moving             a TRANSACTION in the write-ahead log: apply in current (authoritative) -> mirror the same operation to the copy.
//                      The mirror never fails the person's write: when it fails the copy is marked stale (index flag) and the next catch-up
//                      brings it equal. A write whose outcome is unknown (a lost answer) marks the copy stale too, and its transaction stays
//                      open, so a crash at any point leaves evidence that recovery settles (migrationRecovery.ts).
//
// A write is serialised per task inside this process (KeyedMutex), the state of the task is read INSIDE the lock, and the check that a
// side can hold every relation the write names happens before anything is written. Across processes the protection is the index
// (a stale flag set by whoever fails to mirror, a row version a switch refuses to overwrite), not a lock: a person's command and the
// background worker are two processes and each re-reads the index before it acts.
import { BackendRejectedError, PartialWriteError, StaleRevisionError, TaskNotFoundError } from '@wadeck-app/task-core';
import type { CreateTaskInput, TaskBackend, VersionedRecord, WriteOptions } from '@wadeck-app/task-core';

import {
	copyInputFor,
	hashOf,
	identityEntries,
	iso,
	markStale,
	maybeApplied,
	reach,
	requireIdentityCarrier,
} from './engineSupport.js';
import type { EngineDeps } from './engineSupport.js';
import { SIDE_NAME, Translator } from './idTranslation.js';
import type { Side } from './idTranslation.js';
import type { IndexRow, IndexSnapshot } from './routingIndex.js';

export interface WriteSpec<T> {
	/** The operation of the port, for the log and the errors (`updateStatus`). */
	operation: string;
	/** The public id of the task the write changes. */
	id: string;
	/** The public ids of the other tasks its arguments name (a parent, a link target). */
	related?: readonly string[];
	/** Runs the operation on a side; `ids` gives the id a side knows a task by, `mirror` is true for the copy (no expected revision). */
	apply: (backend: TaskBackend, ids: (publicId: string) => string, mirror: boolean) => Promise<T>;
	/** Puts the ids of the answer of a side in public form. */
	result: (translator: Translator, side: Side, value: T) => T;
	/** `sync`: the copy is brought equal to the task as a whole instead of replaying the operation (a comment carries a marker). */
	mirror?: 'op' | 'sync';
}

/** The write options of a mirror: the revision belongs to the side that was written, not to the copy. */
export function forMirror<T extends WriteOptions | undefined>(options: T, mirror: boolean): T {
	if (!mirror || options === undefined) return options;
	const { expectedRevision: _revision, ...rest } = options;
	void _revision;
	return rest as T;
}

function cannotHold(operation: string, holder: string, related: string, holderSide: Side): BackendRejectedError {
	const where = SIDE_NAME[holderSide];
	const other = SIDE_NAME[holderSide === 'a' ? 'b' : 'a'];
	return new BackendRejectedError(
		'migrating',
		operation,
		holderSide === 'a'
			? `Cannot ${operation} on task ${holder}: task ${related} was created after the migration started and exists only in "${other}", and task ${holder} is still in "${where}", which cannot hold a relation to it`
			: `Cannot ${operation} on task ${holder}: task ${related} has no copy in "${where}" yet, and task ${holder} lives in "${where}", which cannot hold a relation to a task it does not have`,
		holderSide === 'a'
			? `Once task ${holder} has been moved to "${other}" the relation can be set; until then set it from a task that already lives in "${other}".`
			: `Once task ${related} has been moved to "${where}" (the background move does it, in the order it chooses) the relation can be set; or set it from the other task.`
	);
}

/** The same error, naming the task by its public id (only the errors a person can act on and that carry the id as data). */
function withPublicId(error: unknown, publicId: string, sideId: string | undefined): unknown {
	if (sideId === undefined || sideId === publicId) return error;
	if (error instanceof StaleRevisionError && error.taskId === sideId) {
		return new StaleRevisionError(publicId, error.expectedRevision, error.actualRevision);
	}
	if (error instanceof TaskNotFoundError && error.taskId === sideId) return new TaskNotFoundError(publicId);
	return error;
}

export class RoutedWrites {
	constructor(private readonly deps: EngineDeps) {}

	/** One write of a person to one task. */
	run<T>(spec: WriteSpec<T>): Promise<T> {
		return this.deps.mutex.run(spec.id, () => this.locked(spec));
	}

	private backendOf(side: Side): TaskBackend {
		return side === 'a' ? this.deps.current : this.deps.next;
	}

	private async locked<T>(spec: WriteSpec<T>): Promise<T> {
		const { deps } = this;
		const snapshot = deps.index.snapshot();
		const row = snapshot.byPublicId(spec.id);
		if (row?.state === 'deleted') throw new TaskNotFoundError(spec.id);
		const unsettled = deps.unsettled.get(spec.id);
		if (unsettled !== undefined) {
			throw new BackendRejectedError(
				'migrating',
				spec.operation,
				`Cannot ${spec.operation} on task ${spec.id}: an earlier change of this task was interrupted and could not be settled (${unsettled})`,
				'Fix the problem named above (the strategy check shows it), then open the project again: the interrupted change is settled when it opens.'
			);
		}
		const state = row?.state ?? 'in-a';
		const primary: Side = state === 'in-b' ? 'b' : 'a';
		const translator = new Translator(snapshot);
		for (const related of spec.related ?? []) {
			if (snapshot.byPublicId(related)?.state === 'deleted') throw new TaskNotFoundError(related);
			if (translator.sideId(related, primary) === undefined)
				throw cannotHold(spec.operation, spec.id, related, primary);
		}
		const idsOn =
			(side: Side) =>
			(publicId: string): string => {
				const id = translator.sideId(publicId, side);
				if (id === undefined) {
					throw new Error(
						`internal error: task ${publicId} has no id in "${SIDE_NAME[side]}" (the relations were checked before)`
					);
				}
				return id;
			};
		if (row === undefined || state !== 'moving') {
			let value: T;
			try {
				value = await spec.apply(this.backendOf(primary), idsOn(primary), false);
			} catch (error) {
				// A refusal of the store names the task by ITS id: the person knows the public one.
				throw withPublicId(error, spec.id, translator.sideId(spec.id, primary));
			}
			return spec.result(translator, primary, value);
		}
		return this.whileMoving(spec, row, translator, idsOn);
	}

	private async whileMoving<T>(
		spec: WriteSpec<T>,
		row: IndexRow,
		translator: Translator,
		idsOn: (side: Side) => (publicId: string) => string
	): Promise<T> {
		const { deps } = this;
		const id = spec.id;
		const tx = deps.journal.begin('write', id, { operation: spec.operation });
		try {
			tx.step('apply', 'current', 'intent');
		} catch (error) {
			tx.endAfterApply('not-started', error);
			throw error;
		}
		await reach(deps, 'write:apply');
		let value: T;
		try {
			value = await spec.apply(deps.current, idsOn('a'), false);
		} catch (error) {
			tx.stepAfterApply('apply', 'current', 'failed', undefined, error);
			if (maybeApplied(error)) {
				// The outcome is unknown: the copy may be behind. The transaction stays open for the recovery.
				markStale(deps, id, `${spec.operation} failed with an unknown outcome`);
			} else {
				tx.endAfterApply('refused', error);
			}
			throw error;
		}
		tx.stepAfterApply('apply', 'current', 'done');
		const answer = spec.result(translator, 'a', value);

		const copyable =
			row.b !== undefined && (spec.related ?? []).every(related => translator.sideId(related, 'b') !== undefined);
		if (!copyable) {
			markStale(deps, id, 'a relation names a task with no copy in "new" yet');
			tx.stepAfterApply('mirror', 'new', 'failed', { reason: 'relation-without-copy' });
			deps.journal.info(
				'warn',
				`task ${id}: ${spec.operation} was written in "current" but the copy in "new" cannot follow yet (a task it names has no copy there); the copy is stale until that task is copied`,
				{ task: id, tx: tx.id, op: 'write', step: 'mirror', side: 'new', phase: 'failed' }
			);
			tx.endAfterApply('ok');
			return answer;
		}
		await reach(deps, 'write:mirror');
		tx.stepAfterApply('mirror', 'new', 'intent');
		try {
			if (spec.mirror === 'sync') await this.syncCopy(id, row);
			else await spec.apply(deps.next, idsOn('b'), true);
			tx.stepAfterApply('mirror', 'new', 'done');
		} catch (error) {
			markStale(deps, id, `the copy could not follow ${spec.operation}`);
			tx.stepAfterApply('mirror', 'new', 'failed', undefined, error);
			deps.journal.info(
				'warn',
				`task ${id}: ${spec.operation} was written in "current" but the copy in "new" could not follow (${error instanceof Error ? error.message : String(error)}); the copy is marked stale and the next catch-up brings it equal`,
				{ task: id, tx: tx.id, op: 'write', step: 'mirror', side: 'new', phase: 'failed' }
			);
		}
		tx.endAfterApply('ok');
		return answer;
	}

	/** Brings the copy of a moving task equal to the task as a whole (the mirror of an operation whose result carries its own markers). */
	private async syncCopy(id: string, row: IndexRow): Promise<void> {
		const { deps } = this;
		const snapshot = deps.index.snapshot();
		const record = await deps.current.get(id);
		const input = await copyInputFor(deps, snapshot, record, row.accepted ?? []);
		const result = await deps.copier.copy({ ...input, existingId: row.b! });
		if (result.unresolved.length > 0) {
			throw new Error(
				`relations to ${result.unresolved.map(open => open.sourceId).join(', ')} cannot be written: those tasks have no copy in "new" yet`
			);
		}
	}

	// ---- delete ----

	async deleteTask(id: string, options: WriteOptions | undefined): Promise<boolean> {
		return this.deps.mutex.run(id, () => this.deleteLocked(id, options));
	}

	private async deleteLocked(id: string, options: WriteOptions | undefined): Promise<boolean> {
		const { deps } = this;
		const row = deps.index.snapshot().byPublicId(id);
		if (row?.state === 'deleted') return false;
		const unsettled = deps.unsettled.get(id);
		if (unsettled !== undefined) {
			throw new BackendRejectedError(
				'migrating',
				'deleteTask',
				`Cannot delete task ${id}: an earlier change of this task was interrupted and could not be settled (${unsettled})`,
				'Fix the problem named above (the strategy check shows it), then open the project again.'
			);
		}
		if (row === undefined || row.state === 'in-a') return deps.current.deleteTask(id, options);

		const tx = deps.journal.begin('delete', id, { state: row.state });
		const markDeleted = (): void => {
			tx.step('index', 'index', 'intent');
			deps.index.mutateRow(id, { mustExist: true }, current => {
				const { stale: _stale, accepted: _accepted, ...rest } = current!;
				void _stale;
				void _accepted;
				return { ...rest, state: 'deleted', since: iso(deps) };
			});
			tx.stepAfterApply('index', 'index', 'done');
		};
		try {
			if (row.state === 'in-b') {
				tx.step('delete', 'new', 'intent', { id: row.b! });
				await reach(deps, 'delete:apply');
				const done = await deps.next.deleteTask(row.b!, options);
				tx.stepAfterApply('delete', 'new', 'done', { id: row.b!, found: done });
				if (!done) {
					tx.endAfterApply('not-found');
					return false;
				}
				await reach(deps, 'delete:index');
				markDeleted();
				tx.endAfterApply('ok');
				return true;
			}
			// moving: current first (the truth), then the index (the task is gone for every read), then the copy (cleanup).
			tx.step('delete', 'current', 'intent', { id });
			await reach(deps, 'delete:apply');
			const done = await deps.current.deleteTask(id, options);
			tx.stepAfterApply('delete', 'current', 'done', { id, found: done });
			if (!done) {
				tx.endAfterApply('not-found');
				return false;
			}
			await reach(deps, 'delete:index');
			markDeleted();
		} catch (error) {
			tx.stepAfterApply('delete', row.state === 'in-b' ? 'new' : 'current', 'failed', undefined, error);
			// What was applied is unknown: the transaction stays open and the recovery settles it from the stores.
			throw error;
		}
		await reach(deps, 'delete:copy');
		try {
			tx.step('delete-copy', 'new', 'intent', { id: row.b! });
			await deps.next.deleteTask(row.b!);
			tx.stepAfterApply('delete-copy', 'new', 'done', { id: row.b! });
			tx.endAfterApply('ok');
		} catch (error) {
			tx.stepAfterApply('delete-copy', 'new', 'failed', undefined, error);
			deps.journal.info(
				'warn',
				`task ${id}: deleted, but its copy "${row.b!}" in "new" could not be deleted (${error instanceof Error ? error.message : String(error)}); the transaction stays open and the next opening of the project deletes the copy`,
				{ task: id, tx: tx.id, op: 'delete', step: 'delete-copy', side: 'new', phase: 'failed' }
			);
		}
		return true;
	}

	// ---- create ----

	/** A new task is born in new: created there, given its identity block, routed as `in-b`. */
	async create(input: CreateTaskInput): Promise<VersionedRecord> {
		const { deps } = this;
		requireIdentityCarrier(deps, 'creating a task');
		const snapshot = deps.index.snapshot();
		const translator = new Translator(snapshot);
		let parentB: string | undefined;
		if (input.parentId !== undefined) {
			if (snapshot.byPublicId(input.parentId)?.state === 'deleted') throw new TaskNotFoundError(input.parentId);
			parentB = translator.sideId(input.parentId, 'b');
			if (parentB === undefined) {
				throw new BackendRejectedError(
					'migrating',
					'create',
					`Cannot create a task under task ${input.parentId}: it has no copy in "new" yet, and a new task is created in "new", which cannot hold a parent it does not have`,
					`Once task ${input.parentId} has been moved to "new" (the background move does it) the task can be created under it; or create it without a parent now and set the parent after the move.`
				);
			}
		}
		const tx = deps.journal.begin('create', '', { title: input.title });
		let record: VersionedRecord;
		try {
			tx.step('create', 'new', 'intent');
			await reach(deps, 'create:apply');
			const base = { ...input, ...(parentB === undefined ? {} : { parentId: parentB }) };
			const hash = hashOf({
				title: input.title,
				status: input.status,
				...(input.description === undefined ? {} : { description: input.description }),
			});
			if (deps.nextTraits.foldsCreate === true && typeof deps.next.createMigrated === 'function') {
				record = await deps.next.createMigrated({
					...base,
					meta: { 'migrating.hash': hash, 'migrating.authority': 'new' },
				});
			} else {
				record = await deps.next.create(base);
			}
			tx.setTask(record.id);
			tx.stepAfterApply('create', 'new', 'done', { b: record.id, hash });
		} catch (error) {
			tx.stepAfterApply('create', 'new', 'failed', undefined, error);
			// The outcome is unknown (a lost answer may hide a task that exists): the transaction stays open.
			if (!maybeApplied(error)) tx.endAfterApply('refused', error);
			throw error;
		}
		const created = record;
		try {
			const hash = hashOf({ ...created, title: input.title });
			await reach(deps, 'create:identity');
			for (const [key, value] of identityEntries({ publicId: created.id, hash, authority: 'new' })) {
				if (created.meta !== undefined && Object.hasOwn(created.meta, key)) continue;
				tx.step('identity', 'new', 'intent', { key });
				await deps.next.setMeta(created.id, key, value);
			}
			tx.stepAfterApply('identity', 'new', 'done');
			await reach(deps, 'create:index');
			tx.step('index', 'index', 'intent');
			deps.index.mutateRow(created.id, {}, current => {
				if (current !== undefined) {
					throw new Error(
						`task ${created.id} already has a row in the routing index (${current.state}): the id of a new task must be new`
					);
				}
				return { publicId: created.id, b: created.id, state: 'in-b', since: iso(deps), version: 1 };
			});
			tx.stepAfterApply('index', 'index', 'done');
		} catch (error) {
			throw new PartialWriteError({
				backendKind: 'migrating',
				operation: 'create',
				taskId: created.id,
				applied: [`the task was created in "new" as ${created.id}`],
				notApplied: ['its identity block and its entry in the routing index'],
				hint: 'Nothing is lost: the transaction is in the write-ahead log and is finished the next time the project is opened (any task command does it). If it is not, run `task strategy check`.',
				cause: error,
			});
		}
		await reach(deps, 'create:done');
		tx.endAfterApply('ok');
		const final = await deps.next.get(created.id);
		return new Translator(deps.index.snapshot()).record('b', final);
	}

	/** The snapshot the write started from, for callers that need the row. */
	snapshot(): IndexSnapshot {
		return this.deps.index.snapshot();
	}
}
