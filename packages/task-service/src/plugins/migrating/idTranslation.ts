// Ids across the two sides. Every task has ONE public id (the one the person sees); each side knows it under its own id. A record or a
// summary read from a side carries that side's ids (its own, its parent's, its links' targets); everything the wrapper answers carries
// public ids. The routing index is the only table between them.
//
// A task of current with no row is in current and its public id is its own id. A task of new with no row is UNKNOWN: a relation that
// points to one is an error naming it (a guess would show a task under an id that no read can find again).
import { BackendDataError } from '@wadeck-app/task-core';
import type { ActivityEntry, TaskLink, TaskSummary, VersionedRecord } from '@wadeck-app/task-core';

import type { IndexRow, IndexSnapshot } from './routingIndex.js';

export type Side = 'a' | 'b';

export const SIDE_NAME: Record<Side, string> = { a: 'current', b: 'new' };

const REBUILD_HINT =
	'The routing index does not match the tasks in "new". Rebuild it from the identity blocks of the tasks there (rebuildIndex), or restore the index file from a backup.';

/** The side that holds the truth of a task: new once it is `in-b`, current in every other state (and when it has no row). */
export function authoritativeSide(row: IndexRow | undefined): Side {
	return row?.state === 'in-b' ? 'b' : 'a';
}

export function otherSide(side: Side): Side {
	return side === 'a' ? 'b' : 'a';
}

/** The activity kinds whose fields hold task ids. */
const ID_IN_OLD_NEW = new Set(['parent']);
const ID_IN_TARGET = new Set(['link-added', 'link-removed', 'child-added', 'child-removed']);

export class Translator {
	constructor(private readonly snapshot: IndexSnapshot) {}

	/** The public id of a task known by `id` on `side`. `context` says where the id was read, for the error. */
	publicId(side: Side, id: string, context: string): string {
		const row = side === 'a' ? this.snapshot.byA(id) : this.snapshot.byB(id);
		if (row !== undefined) return row.publicId;
		if (side === 'a') return id;
		throw new BackendDataError(
			'migrating',
			id,
			`${context} refers to the task "${id}" in "new", which the routing index does not know`,
			REBUILD_HINT
		);
	}

	/** Like {@link publicId}, but an id nobody knows is kept as it is (history text, dangling links). */
	publicIdOrSame(side: Side, id: string): string {
		const row = side === 'a' ? this.snapshot.byA(id) : this.snapshot.byB(id);
		return row?.publicId ?? id;
	}

	/** The id of a task on a side, `undefined` when that side has no copy. */
	sideId(publicId: string, side: Side): string | undefined {
		const row = this.snapshot.byPublicId(publicId);
		if (row === undefined) return side === 'a' ? publicId : undefined;
		return row[side];
	}

	summary(side: Side, summary: TaskSummary): TaskSummary {
		const context = `task ${summary.id} in "${SIDE_NAME[side]}"`;
		const id = this.publicId(side, summary.id, context);
		const { parentId, links, ...rest } = summary;
		return {
			...rest,
			id,
			...(parentId === undefined ? {} : { parentId: this.publicId(side, parentId, `the parent of ${context}`) }),
			...(links === undefined ? {} : { links: links.map(link => this.link(side, link, context)) }),
		};
	}

	private link(side: Side, link: TaskLink, context: string): TaskLink {
		return { type: link.type, target: this.publicId(side, link.target, `a link of ${context}`) };
	}

	record(side: Side, record: VersionedRecord): VersionedRecord {
		const context = `task ${record.id} in "${SIDE_NAME[side]}"`;
		const { parentId, links, activity, ...rest } = record;
		return {
			...rest,
			id: this.publicId(side, record.id, context),
			...(parentId === undefined ? {} : { parentId: this.publicId(side, parentId, `the parent of ${context}`) }),
			...(links === undefined ? {} : { links: links.map(link => this.link(side, link, context)) }),
			...(activity === undefined ? {} : { activity: activity.map(entry => this.activityEntry(side, entry)) }),
		};
	}

	private activityEntry(side: Side, entry: ActivityEntry): ActivityEntry {
		const touchesIds =
			ID_IN_OLD_NEW.has(entry.kind) || (entry.target !== undefined && ID_IN_TARGET.has(entry.kind));
		if (!touchesIds) return entry;
		const same = (value: string | undefined): string | undefined =>
			value === undefined ? undefined : this.publicIdOrSame(side, value);
		const { oldValue, newValue, target, ...rest } = entry;
		const translated = ID_IN_OLD_NEW.has(entry.kind)
			? { oldValue: same(oldValue), newValue: same(newValue), target }
			: { oldValue, newValue, target: same(target) };
		return {
			...rest,
			...(translated.oldValue === undefined ? {} : { oldValue: translated.oldValue }),
			...(translated.newValue === undefined ? {} : { newValue: translated.newValue }),
			...(translated.target === undefined ? {} : { target: translated.target }),
		};
	}
}
