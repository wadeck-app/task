// What `finalize` checks in the STORES, not in the routing index: the index is a cache of what the stores say, and finalize is the one
// moment the project stops using it. Reads only. Every refusal names the tasks and the fix; a store that cannot be read is the error of
// that store (nothing has been written yet, so the person fixes the access and runs finalize again).
//   - every task the index says is in "new" has its copy there, and the copy says it holds the truth (identity block, authority "new"),
//   - "new" holds no task of the project that the index does not know (an index lost rows),
//   - "current" holds no task the index does not know (a task created there while the migration ran would be lost from the project),
//   - the strategy of "new" keeps no task files in its own folder (the plain strategy would not look there).
// The hash of the identity block is NOT compared with the content: a task of "new" is edited after its move, and the block keeps the
// hash of the moment of the copy.
import * as path from 'node:path';

import { rebuildIndex } from './rebuildIndex.js';
import type { Blocker } from './migrationFinish.js';
import type { MigrationToolkit } from './migrationToolkit.js';

export interface Verification {
	blockers: Blocker[];
	/** Tasks that were copied out of "current", and tasks made in "new": by what the stores say. */
	moved: number;
	madeInNew: number;
	/** What an old id becomes: the public id the task had in "current" -> its id in "new". Sorted by `from`. */
	map: Array<{ from: string; to: string }>;
	notes: string[];
}

const SHOWN = 10;

/** The first ids, then "and N more". */
export function listIds(ids: readonly string[]): string {
	const shown = ids.slice(0, SHOWN).join(', ');
	return ids.length > SHOWN ? `${shown} and ${ids.length - SHOWN} more` : shown;
}

export async function verifyStores(toolkit: MigrationToolkit): Promise<Verification> {
	const blockers: Blocker[] = [];
	const notes: string[] = [];
	const rows = toolkit.index.snapshot().rows;

	const folder = path.join(toolkit.dir, 'new', 'tasks');
	const kept = toolkit.files.entries(folder) ?? [];
	if (kept.length > 0) {
		blockers.push({
			text: `the strategy in "new" keeps its task files in ${folder} (${kept.length} entr${kept.length === 1 ? 'y' : 'ies'}): once the project switches to it alone it reads its tasks from its own data folder and would not find them`,
			fix: 'Finalize does not move those files. Use `task migrate --in-place --to-config <file>` for a move into this kind of strategy, or keep the migration as it is (it works) and do not finalize.',
		});
	}

	// Both sides are read as they are now; a failure is the error of that side.
	const rebuilt = await rebuildIndex({ current: toolkit.current, next: toolkit.next });
	notes.push(...rebuilt.notes);
	if (rebuilt.unindexed.length > 0) {
		notes.push(
			`${rebuilt.unindexed.length} task(s) in "new" carry no identity block (${listIds(rebuilt.unindexed.map(task => task.id))}): they were not made by this migration and become ordinary tasks of the project`
		);
	}
	const byPublicId = new Map(rebuilt.rows.map(row => [row.publicId, row] as const));

	const missing: string[] = [];
	const notAuthoritative: string[] = [];
	const otherCopy: string[] = [];
	for (const row of rows) {
		if (row.state !== 'in-b') continue;
		const found = byPublicId.get(row.publicId);
		if (found === undefined) missing.push(row.publicId);
		else if (found.state !== 'in-b') notAuthoritative.push(row.publicId);
		else if (found.b !== row.b) otherCopy.push(`${row.publicId} (index ${row.b}, store ${found.b})`);
	}
	if (missing.length > 0) {
		blockers.push({
			text: `no copy in "new" for ${missing.length} task(s) the index says are there: ${listIds(missing)}`,
			fix: 'The copy was deleted or never written. Restore it, or rebuild the routing index from the identity blocks of the tasks in "new" (see `task strategy migrate log`), then run finalize again. Nothing was changed.',
		});
	}
	if (notAuthoritative.length > 0) {
		blockers.push({
			text: `the copy in "new" of ${notAuthoritative.length} task(s) does not say it holds the truth (identity authority is not "new"): ${listIds(notAuthoritative)}`,
			fix: 'A move was interrupted or the metadata of the copy was edited. Run `task strategy check` (it settles interrupted moves), then `task strategy migrate resume`, then finalize again.',
		});
	}
	if (otherCopy.length > 0) {
		blockers.push({
			text: `the index and the store of "new" disagree on which copy is the task: ${listIds(otherCopy)}`,
			fix: 'Rebuild the routing index from the identity blocks of the tasks in "new", then run finalize again. Nothing was changed.',
		});
	}

	const indexed = new Set(rows.filter(row => row.state === 'in-b').map(row => row.publicId));
	const unknown = rebuilt.rows.filter(row => row.state === 'in-b' && !indexed.has(row.publicId));
	if (unknown.length > 0) {
		blockers.push({
			text: `"new" holds ${unknown.length} task(s) of this project that the index does not know: ${listIds(unknown.map(row => row.b ?? row.publicId))}`,
			fix: 'The routing index lost rows (or a copy of a deleted task was left behind). Rebuild the index from the identity blocks of "new", or remove the stray copies by hand, then run finalize again. Nothing was changed.',
		});
	}

	const knownInCurrent = new Set(rows.flatMap(row => (row.a === undefined ? [] : [row.a])));
	const created = (await toolkit.current.list()).map(task => task.id).filter(id => !knownInCurrent.has(id));
	if (created.length > 0) {
		blockers.push({
			text: `${created.length} task(s) were created in "current" after the migration started and the index does not know them: ${listIds(created)}. Switching now would drop them from the project`,
			fix: 'Recreate each one in the project (it goes to "new"), or delete it in "current" if it is not needed, then run finalize again. Nothing was changed.',
		});
	}

	const moved = rebuilt.rows.filter(row => row.state === 'in-b' && row.a !== undefined);
	return {
		blockers,
		moved: moved.length,
		madeInNew: rebuilt.rows.filter(row => row.state === 'in-b' && row.a === undefined).length,
		map: moved
			.map(row => ({ from: row.publicId, to: row.b! }))
			.sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0)),
		notes,
	};
}
