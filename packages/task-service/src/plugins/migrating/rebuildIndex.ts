// Rebuilds the routing index from the stores alone: the identity block every copy in "new" carries (identityBlock.ts) says which task of
// the project it is. Reads only: "current" is listed, "new" is listed and each of its tasks resolved (one request each on a side behind
// an API); nothing is written to either side. Only `adoptIndex` writes, and only the index file.
//
// What the stores cannot say, said loudly rather than guessed:
//  - which side is authoritative for a task that has a copy in both: the block holds no such fact. A copy of a task still in "current" is
//    rebuilt as `moving` (current is read, the safe side: it is never deleted before the end). When the copy differs from what was
//    copied it may have been edited in "new" since, and the report says so, task by task;
//  - a deleted task: it leaves no trace in a store, so a `deleted` row is not rebuilt (its copy in "current", if it still exists, is
//    listed again);
//  - a task of "new" with no identity block: it is not a task of the project as far as the index goes; it is reported as `unindexed`.
import { BackendDataError } from '@wadeck-app/task-core';
import type { TaskBackend } from '@wadeck-app/task-core';

import { contentHash, readIdentity } from './identityBlock.js';
import type { IndexRow, RoutingIndex } from './routingIndex.js';

export interface RebuildInput {
	current: TaskBackend;
	next: TaskBackend;
	/** The clock (ISO instant): `since` of every row. */
	now?: () => string;
}

export interface RebuildReport {
	/** Sorted by public id. */
	rows: IndexRow[];
	/** Tasks of "new" that carry no identity block (the index does not route to them). */
	unindexed: Array<{ id: string; title: string }>;
	/** What the person should know, one sentence each. */
	notes: string[];
}

const FIX =
	'Fix the metadata of that task in "new" (the entries whose key starts with "migrating."), or remove them to make it a plain task of "new" that the migrating strategy does not know.';

function inconsistent(subject: string, message: string): BackendDataError {
	return new BackendDataError('migrating', subject, message, FIX);
}

export async function rebuildIndex(input: RebuildInput): Promise<RebuildReport> {
	const since = (input.now ?? (() => new Date().toISOString()))();
	const currentIds = new Set((await input.current.list()).map(summary => summary.id));
	const rows: IndexRow[] = [];
	const unindexed: RebuildReport['unindexed'] = [];
	const notes: string[] = [];
	const claimedBy = new Map<string, string>();

	for (const summary of await input.next.list()) {
		const task = await input.next.resolve(summary.id);
		const subject = `task ${summary.id} in "new"`;
		const identity = readIdentity(task.meta, subject);
		if (identity === undefined) {
			unindexed.push({ id: summary.id, title: task.title });
			continue;
		}
		const other = claimedBy.get(identity.publicId);
		if (other !== undefined) {
			throw inconsistent(
				identity.publicId,
				`tasks "${other}" and "${summary.id}" in "new" both carry the public id "${identity.publicId}"`
			);
		}
		claimedBy.set(identity.publicId, summary.id);

		const { fromId } = identity;
		if (fromId !== undefined && currentIds.has(fromId)) {
			if (identity.publicId !== fromId) {
				throw inconsistent(
					subject,
					`${subject} says it is the public id "${identity.publicId}" but was copied from the task "${fromId}" of "current", whose public id is "${fromId}"`
				);
			}
			rows.push({ publicId: fromId, a: fromId, b: summary.id, state: 'moving', since, version: 1 });
			if (contentHash(task) !== identity.hash) {
				notes.push(
					`task ${fromId}: its copy "${summary.id}" in "new" differs from what was copied (it may have been edited in "new" since); it is rebuilt as moving, so the version in "current" is read. Compare the two before going on.`
				);
			}
			continue;
		}
		if (fromId === undefined && currentIds.has(identity.publicId)) {
			throw inconsistent(
				subject,
				`${subject} was made in "new" under the public id "${identity.publicId}", which is also the id of another task of "current"`
			);
		}
		rows.push({ publicId: identity.publicId, b: summary.id, state: 'in-b', since, version: 1 });
		if (fromId !== undefined) {
			notes.push(
				`task ${identity.publicId}: its copy "${summary.id}" in "new" is kept as the task, because the task "${fromId}" it was copied from no longer exists in "current".`
			);
		}
	}
	rows.sort((a, b) => (a.publicId < b.publicId ? -1 : a.publicId > b.publicId ? 1 : 0));
	return { rows, unindexed, notes };
}

/**
 * Rebuilds the index and writes it (the only write of this phase besides the index itself being read). A damaged index file is kept
 * beside the new one; the rows of a healthy old index that the stores cannot reproduce are listed in the notes.
 */
export async function adoptIndex(index: RoutingIndex, input: RebuildInput): Promise<RebuildReport> {
	const clock = input.now ?? (() => new Date().toISOString());
	const stamp = clock();
	const report = await rebuildIndex({ ...input, now: () => stamp });
	let old: readonly IndexRow[] = [];
	let damaged = false;
	try {
		old = index.snapshot().rows;
	} catch (error) {
		if (!(error instanceof BackendDataError)) throw error;
		damaged = true;
	}
	const rebuilt = new Set(report.rows.map(row => row.publicId));
	const notes = [...report.notes];
	for (const row of old) {
		if (rebuilt.has(row.publicId)) continue;
		notes.push(
			row.state === 'deleted'
				? `task ${row.publicId} was marked deleted in the old index; a deleted task leaves no trace in the stores, so the row is not rebuilt.`
				: `the row of task ${row.publicId} (${row.state}) in the old index is not rebuilt: no task of "new" carries its identity block.`
		);
	}
	const { setAside } = index.replaceFromRebuild(report.rows, stamp);
	if (damaged && setAside !== undefined) {
		notes.push(`the previous index file was damaged; it is kept as ${setAside}.`);
	}
	return { ...report, notes };
}
