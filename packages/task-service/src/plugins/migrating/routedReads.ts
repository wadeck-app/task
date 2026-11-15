// The reads of the migrating strategy: every question of the port answered from the side that holds the truth of each task, as the
// routing index says (`in-a` and `moving`: current; `in-b`: new; `deleted`: nobody), with public ids everywhere.
//
// While nothing is routed to `new` and nothing is hidden (the index is trivial) every read goes straight to `current`, as in phase P0,
// and `new` is not asked at all. Otherwise a listing is the union of what each side answers for the tasks it is authoritative for, and
// the hierarchy, the links and the labels are computed from those authoritative answers. A copy that is not authoritative (the copy in
// `new` of a task still `moving`, the copy in `current` of a task that is `in-b`) is never shown, whatever it says.
//
// An index that does not match the sides (a row for a task the side does not have, two tasks under one public id, a relation to a task
// of `new` nobody indexed) is a loud error naming the task and the fix, never a guess.
import {
	AmbiguousTaskPrefixError,
	BackendDataError,
	BackendRejectedError,
	INVERSE_LINK_NAMES,
	LINK_TYPES,
	TaskNotFoundError,
} from '@wadeck-app/task-core';
import type {
	LabelCount,
	ListQuery,
	Page,
	ResolvedTask,
	TaskBackend,
	TaskLink,
	TaskLinks,
	TaskStatus,
	TaskSummary,
	TaskTreeNode,
	VersionedRecord,
} from '@wadeck-app/task-core';

import { SIDE_NAME, Translator, authoritativeSide, otherSide } from './idTranslation.js';
import type { Side } from './idTranslation.js';
import type { IndexRow, IndexSnapshot, RoutingIndex } from './routingIndex.js';
import { ancestorsOf, childrenOf, descendantsOf, forestOf, fullTreeOf, treeOf } from './summaryGraph.js';

const CURSOR_PREFIX = 'migrating:';
const REBUILD_HINT =
	'The routing index does not match the tasks in the two strategies. Rebuild it from the identity blocks of the tasks in "new" (rebuildIndex), or restore the index file from a backup.';

interface Route {
	publicId: string;
	row: IndexRow | undefined;
	side: Side;
	/** The id of the task in the side that holds its truth. */
	id: string;
}

export interface RoutedReadsInput {
	current: TaskBackend;
	next: TaskBackend;
	index: RoutingIndex;
}

type LinksAnswer = { links: TaskLinks; dangling: TaskLink[] };

function emptyLinks(): TaskLinks {
	return { blockedBy: [], blocks: [], duplicateOf: [], duplicates: [], causedBy: [], causes: [] };
}

export class RoutedReads {
	private readonly sides: Record<Side, TaskBackend>;
	private readonly index: RoutingIndex;

	constructor(input: RoutedReadsInput) {
		this.sides = { a: input.current, b: input.next };
		this.index = input.index;
	}

	/** The rows as they are now. Every read starts here, so a change by another process is seen by the next read. */
	snapshot(): IndexSnapshot {
		return this.index.snapshot();
	}

	// ---- routes and errors ----

	private route(snapshot: IndexSnapshot, publicId: string): Route {
		const row = snapshot.byPublicId(publicId);
		if (row === undefined) return { publicId, row, side: 'a', id: publicId };
		if (row.state === 'deleted') throw new TaskNotFoundError(publicId);
		const side = authoritativeSide(row);
		const id = row[side];
		if (id === undefined) throw this.drift(publicId, side, '(no id in the row)');
		return { publicId, row, side, id };
	}

	private drift(publicId: string, side: Side, id: string): BackendDataError {
		return new BackendDataError(
			'migrating',
			publicId,
			`task ${publicId}: the routing index says it is "${id}" in "${SIDE_NAME[side]}", but that strategy has no such task`,
			REBUILD_HINT
		);
	}

	/** Runs a read of one task on its side; a "not found" for a task the index knows is a mismatch, not an absent task. */
	private async onSide<T>(route: Route, operation: (backend: TaskBackend, id: string) => Promise<T>): Promise<T> {
		try {
			return await operation(this.sides[route.side], route.id);
		} catch (error) {
			if (error instanceof TaskNotFoundError && route.row !== undefined && error.taskId === route.id) {
				throw this.drift(route.publicId, route.side, route.id);
			}
			throw error;
		}
	}

	// ---- listings ----

	private async fetch(backend: TaskBackend, query: ListQuery | undefined): Promise<TaskSummary[]> {
		if (query === undefined) return backend.list();
		return (await backend.listPage(query)).items;
	}

	/** What the sides answer, put together: only the copies that are authoritative, under public ids, each public id once. */
	private combine(
		snapshot: IndexSnapshot,
		answers: { a: readonly TaskSummary[]; b: readonly TaskSummary[] }
	): TaskSummary[] {
		const translator = new Translator(snapshot);
		const out: TaskSummary[] = [];
		const seen = new Set<string>();
		const add = (side: Side, summary: TaskSummary): void => {
			const translated = translator.summary(side, summary);
			if (seen.has(translated.id)) {
				throw new BackendDataError(
					'migrating',
					translated.id,
					`two tasks answer to the public id "${translated.id}" (one in each strategy, or one in "current" and a row of the index)`,
					REBUILD_HINT
				);
			}
			seen.add(translated.id);
			out.push(translated);
		};
		for (const summary of answers.a) {
			const row = snapshot.byA(summary.id);
			if (row?.state === 'in-b' || row?.state === 'deleted') continue;
			add('a', summary);
		}
		for (const summary of answers.b) {
			if (snapshot.byB(summary.id)?.state === 'in-b') add('b', summary);
		}
		return out;
	}

	/** Every task, as the whole project: the full list of each side that holds a task the index sends there. */
	private async merged(snapshot: IndexSnapshot): Promise<TaskSummary[]> {
		const a = await this.sides.a.list();
		const b = snapshot.hasInB ? await this.sides.b.list() : [];
		const aIds = new Set(a.map(summary => summary.id));
		const bIds = new Set(b.map(summary => summary.id));
		for (const row of snapshot.rows) {
			if (row.state === 'in-b' && !bIds.has(row.b!)) throw this.drift(row.publicId, 'b', row.b!);
			if ((row.state === 'in-a' || row.state === 'moving') && !aIds.has(row.a!)) {
				throw this.drift(row.publicId, 'a', row.a!);
			}
		}
		return this.combine(snapshot, { a, b });
	}

	async list(): Promise<TaskSummary[]> {
		const snapshot = this.snapshot();
		return snapshot.isTrivial ? this.sides.a.list() : this.merged(snapshot);
	}

	async listPage(query: ListQuery = {}): Promise<Page<TaskSummary>> {
		const snapshot = this.snapshot();
		if (snapshot.isTrivial) return this.sides.a.listPage(query);
		const { limit, cursor, parentId, ...filters } = query;
		if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
			throw new BackendRejectedError(
				'migrating',
				'listing tasks',
				`Invalid page request: limit ${String(limit)} is not a positive whole number`,
				'Give a positive whole number as the limit, or none for everything.'
			);
		}
		let offset = 0;
		if (cursor !== undefined) {
			const parsed = cursor.startsWith(CURSOR_PREFIX) ? Number(cursor.slice(CURSOR_PREFIX.length)) : Number.NaN;
			if (!Number.isInteger(parsed) || parsed < 0) {
				throw new BackendRejectedError(
					'migrating',
					'listing tasks',
					`Invalid page request: cursor "${cursor}" is not one this strategy gave`,
					'Start again without a cursor and follow the nextCursor of each page.'
				);
			}
			offset = parsed;
		}
		const translator = new Translator(snapshot);
		// The parent is asked by the id each side knows it by; a side that has no copy of it has no children of it.
		const queryFor = (side: Side): ListQuery | undefined => {
			if (typeof parentId !== 'string') return { ...filters, ...(parentId === null ? { parentId: null } : {}) };
			const sideParent = translator.sideId(parentId, side);
			return sideParent === undefined ? undefined : { ...filters, parentId: sideParent };
		};
		const aQuery = queryFor('a');
		const bQuery = snapshot.hasInB ? queryFor('b') : undefined;
		const a = aQuery === undefined ? [] : await this.fetch(this.sides.a, aQuery);
		const b = bQuery === undefined ? [] : await this.fetch(this.sides.b, bQuery);
		const all = this.combine(snapshot, { a, b });
		const end = limit === undefined ? all.length : offset + limit;
		return {
			items: all.slice(offset, end),
			...(end < all.length ? { nextCursor: `${CURSOR_PREFIX}${end}` } : {}),
		};
	}

	// ---- one task ----

	async get(id: string): Promise<VersionedRecord> {
		const snapshot = this.snapshot();
		if (snapshot.isTrivial) return this.sides.a.get(id);
		const route = this.route(snapshot, id);
		const record = await this.onSide(route, (backend, sideId) => backend.get(sideId));
		return new Translator(snapshot).record(route.side, record);
	}

	async getMany(ids: readonly string[]): Promise<VersionedRecord[]> {
		const snapshot = this.snapshot();
		if (snapshot.isTrivial) return this.sides.a.getMany(ids);
		const routes = ids.map(id => this.route(snapshot, id));
		const translator = new Translator(snapshot);
		const side = routes[0]?.side;
		if (routes.length > 0 && routes.every(route => route.side === side)) {
			// One side holds them all: one call, as a remote side wants.
			try {
				const records = await this.sides[side!].getMany(routes.map(route => route.id));
				return records.map(record => translator.record(side!, record));
			} catch (error) {
				if (error instanceof TaskNotFoundError) {
					const route = routes.find(candidate => candidate.id === error.taskId);
					if (route?.row !== undefined) throw this.drift(route.publicId, route.side, route.id);
				}
				throw error;
			}
		}
		const records: VersionedRecord[] = [];
		for (const route of routes) {
			const record = await this.onSide(route, (backend, sideId) => backend.get(sideId));
			records.push(translator.record(route.side, record));
		}
		return records;
	}

	/**
	 * Finds the task a prefix names: an exact public id first, else the unique task whose public id starts with it (current answers for
	 * its tasks, the index for the tasks only `new` has). `exact` fetches by an id the side knows; `viaCurrent` asks current the way the
	 * caller did.
	 */
	private async locate<T extends { id: string }>(
		snapshot: IndexSnapshot,
		prefix: string,
		how: {
			exact: (backend: TaskBackend, id: string) => Promise<T>;
			prefixInCurrent: (backend: TaskBackend, prefix: string) => Promise<T>;
			translate: (translator: Translator, side: Side, found: T) => T;
		}
	): Promise<T> {
		const translator = new Translator(snapshot);
		const exactRow = snapshot.byPublicId(prefix);
		if (exactRow !== undefined) {
			const route = this.route(snapshot, prefix);
			return how.translate(translator, route.side, await this.onSide(route, how.exact));
		}
		const lower = prefix.toLowerCase();
		// The tasks only `new` has are known to the index alone.
		const candidates = new Set<string>(
			snapshot.rows
				.filter(
					row =>
						row.a === undefined && row.state !== 'deleted' && row.publicId.toLowerCase().startsWith(lower)
				)
				.map(row => row.publicId)
		);
		let inCurrent: T | undefined;
		try {
			const found = await how.prefixInCurrent(this.sides.a, prefix);
			const row = snapshot.byA(found.id);
			if (row === undefined || (row.state !== 'deleted' && row.state !== 'in-b')) {
				inCurrent = found;
				candidates.add(found.id);
			} else if (row.state === 'in-b') {
				candidates.add(row.publicId);
			}
		} catch (error) {
			if (error instanceof AmbiguousTaskPrefixError) {
				for (const id of error.matches) {
					if (snapshot.byA(id)?.state !== 'deleted') candidates.add(snapshot.byA(id)?.publicId ?? id);
				}
			} else if (!(error instanceof TaskNotFoundError)) {
				throw error;
			}
		}
		if (candidates.size === 0) throw new TaskNotFoundError(prefix);
		if (candidates.size > 1) throw new AmbiguousTaskPrefixError(prefix, [...candidates].sort());
		const only = [...candidates][0]!;
		if (inCurrent !== undefined && inCurrent.id === only) return inCurrent;
		const route = this.route(snapshot, only);
		return how.translate(translator, route.side, await this.onSide(route, how.exact));
	}

	async findByPrefix(prefix: string): Promise<VersionedRecord> {
		const snapshot = this.snapshot();
		if (snapshot.isTrivial) return this.sides.a.findByPrefix(prefix);
		return this.locate<VersionedRecord>(snapshot, prefix, {
			exact: (backend, id) => backend.get(id),
			prefixInCurrent: (backend, text) => backend.findByPrefix(text),
			translate: (translator, side, found) => translator.record(side, found),
		});
	}

	async resolve(prefix: string): Promise<ResolvedTask> {
		const snapshot = this.snapshot();
		if (snapshot.isTrivial) return this.sides.a.resolve(prefix);
		return this.locate<ResolvedTask>(snapshot, prefix, {
			exact: (backend, id) => backend.resolve(id),
			prefixInCurrent: (backend, text) => backend.resolve(text),
			translate: (translator, side, found) => translateResolved(translator, side, found),
		});
	}

	// ---- labels ----

	async listLabels(): Promise<LabelCount[]> {
		const snapshot = this.snapshot();
		if (snapshot.isTrivial) return this.sides.a.listLabels();
		const counts = new Map<string, number>();
		const count = (label: string, by: number): void => {
			counts.set(label, (counts.get(label) ?? 0) + by);
		};
		for (const entry of await this.sides.a.listLabels()) count(entry.label, entry.count);
		await this.subtractCopies(
			'a',
			snapshot.rows.filter(row => row.a !== undefined && (row.state === 'in-b' || row.state === 'deleted')),
			count
		);
		if (snapshot.hasInB) {
			for (const entry of await this.sides.b.listLabels()) count(entry.label, entry.count);
			await this.subtractCopies(
				'b',
				snapshot.rows.filter(row => row.b !== undefined && (row.state === 'moving' || row.state === 'deleted')),
				count
			);
		}
		return [...counts.entries()]
			.filter(([, total]) => total > 0)
			.map(([label, total]) => ({ label, count: total }))
			.sort((x, y) => y.count - x.count || (x.label < y.label ? -1 : x.label > y.label ? 1 : 0));
	}

	/** Takes the labels of copies that are not authoritative out of a side's own count. */
	private async subtractCopies(
		side: Side,
		rows: readonly IndexRow[],
		count: (label: string, by: number) => void
	): Promise<void> {
		if (rows.length === 0) return;
		let records: VersionedRecord[];
		try {
			records = await this.sides[side].getMany(rows.map(row => row[side]!));
		} catch (error) {
			if (error instanceof TaskNotFoundError) {
				const row = rows.find(candidate => candidate[side] === error.taskId);
				if (row !== undefined) throw this.drift(row.publicId, side, error.taskId);
			}
			throw error;
		}
		for (const record of records) {
			for (const label of record.labels ?? []) count(label, -1);
		}
	}

	// ---- links ----

	/** The authoritative summary of every task, by public id. */
	private async summaryMap(snapshot: IndexSnapshot): Promise<Map<string, TaskSummary>> {
		return new Map((await this.merged(snapshot)).map(summary => [summary.id, summary]));
	}

	private async linksOn(snapshot: IndexSnapshot, route: Route, side: Side): Promise<LinksAnswer> {
		const id = side === route.side ? route.id : route.row?.[side];
		if (id === undefined) return { links: emptyLinks(), dangling: [] };
		return this.onSideAt(route, side, id, (backend, sideId) => backend.getLinksLenient(sideId));
	}

	private async onSideAt<T>(
		route: Route,
		side: Side,
		id: string,
		operation: (backend: TaskBackend, id: string) => Promise<T>
	): Promise<T> {
		try {
			return await operation(this.sides[side], id);
		} catch (error) {
			if (error instanceof TaskNotFoundError && error.taskId === id) throw this.drift(route.publicId, side, id);
			throw error;
		}
	}

	private async mergedLinks(
		snapshot: IndexSnapshot,
		publicId: string,
		summaries: Map<string, TaskSummary>
	): Promise<LinksAnswer> {
		const route = this.route(snapshot, publicId);
		const translator = new Translator(snapshot);
		const own = await this.linksOn(snapshot, route, route.side);
		const links = emptyLinks();
		const dangling: TaskLink[] = [];
		const context = `the links of task ${publicId} in "${SIDE_NAME[route.side]}"`;
		// What the task itself links to is said by its authoritative copy; the targets are shown as they are where they are authoritative.
		for (const type of LINK_TYPES) {
			for (const target of own.links[type]) {
				const targetId = translator.publicId(route.side, target.id, context);
				const found = summaries.get(targetId);
				if (found === undefined) dangling.push({ type, target: targetId });
				else links[type].push(found);
			}
		}
		for (const link of own.dangling) {
			dangling.push({ type: link.type, target: translator.publicIdOrSame(route.side, link.target) });
		}
		// Who links to it: asked of both sides, each answer kept only for the tasks that side is authoritative for.
		for (const side of [route.side, otherSide(route.side)]) {
			const answer = side === route.side ? own : await this.linksOn(snapshot, route, side);
			for (const type of LINK_TYPES) {
				const inverse = INVERSE_LINK_NAMES[type];
				for (const from of answer.links[inverse]) {
					const fromId = translator.publicId(side, from.id, context);
					if (authoritativeSide(snapshot.byPublicId(fromId)) !== side) continue;
					const found = summaries.get(fromId);
					if (found !== undefined && !links[inverse].some(known => known.id === fromId))
						links[inverse].push(found);
				}
			}
		}
		return { links, dangling };
	}

	async getLinksLenient(id: string): Promise<LinksAnswer> {
		const snapshot = this.snapshot();
		if (snapshot.isTrivial) return this.sides.a.getLinksLenient(id);
		return this.mergedLinks(snapshot, id, await this.summaryMap(snapshot));
	}

	async getLinks(id: string): Promise<TaskLinks> {
		const snapshot = this.snapshot();
		if (snapshot.isTrivial) return this.sides.a.getLinks(id);
		const { links, dangling } = await this.getLinksLenient(id);
		const first = dangling[0];
		if (first) throw new Error(`Task index is corrupted: link target "${first.target}" of "${id}" not found`);
		return links;
	}

	async getOpenBlockers(id: string, isTerminal: (status: TaskStatus) => boolean): Promise<TaskSummary[]> {
		const snapshot = this.snapshot();
		if (snapshot.isTrivial) return this.sides.a.getOpenBlockers(id, isTerminal);
		return (await this.getLinksLenient(id)).links.blockedBy.filter(task => !isTerminal(task.status));
	}

	async getUnblockedBy(blockerId: string, isTerminal: (status: TaskStatus) => boolean): Promise<TaskSummary[]> {
		const snapshot = this.snapshot();
		if (snapshot.isTrivial) return this.sides.a.getUnblockedBy(blockerId, isTerminal);
		const summaries = await this.summaryMap(snapshot);
		const blocker = summaries.get(blockerId);
		if (blocker === undefined) throw new TaskNotFoundError(blockerId);
		if (!isTerminal(blocker.status)) return [];
		const unblocked: TaskSummary[] = [];
		for (const candidate of (await this.mergedLinks(snapshot, blockerId, summaries)).links.blocks) {
			if (isTerminal(candidate.status)) continue;
			const own = await this.mergedLinks(snapshot, candidate.id, summaries);
			// A blocker that is gone blocks for good, as in current.
			if (own.dangling.some(link => link.type === 'blockedBy')) continue;
			if (own.links.blockedBy.every(other => isTerminal(other.status))) unblocked.push(candidate);
		}
		return unblocked;
	}

	// ---- hierarchy ----

	async getChildren(id: string): Promise<TaskSummary[]> {
		const snapshot = this.snapshot();
		return snapshot.isTrivial ? this.sides.a.getChildren(id) : childrenOf(await this.merged(snapshot), id);
	}

	async getTree(id: string): Promise<TaskTreeNode> {
		const snapshot = this.snapshot();
		return snapshot.isTrivial ? this.sides.a.getTree(id) : treeOf(await this.merged(snapshot), id);
	}

	async getForest(options?: {
		parentId?: string;
		predicate?: (task: TaskSummary) => boolean;
	}): Promise<TaskTreeNode[]> {
		const snapshot = this.snapshot();
		return snapshot.isTrivial ? this.sides.a.getForest(options) : forestOf(await this.merged(snapshot), options);
	}

	async getDescendants(id: string): Promise<TaskSummary[]> {
		const snapshot = this.snapshot();
		return snapshot.isTrivial ? this.sides.a.getDescendants(id) : descendantsOf(await this.merged(snapshot), id);
	}

	async getFullTree(id: string): Promise<TaskTreeNode> {
		const snapshot = this.snapshot();
		return snapshot.isTrivial ? this.sides.a.getFullTree(id) : fullTreeOf(await this.merged(snapshot), id);
	}

	async getAncestors(id: string): Promise<TaskSummary[]> {
		const snapshot = this.snapshot();
		return snapshot.isTrivial ? this.sides.a.getAncestors(id) : ancestorsOf(await this.merged(snapshot), id);
	}

	// ---- for the writes: a task the index keeps out of reach of a write ----

	/** The state of a task for a write: `undefined` when it is plainly in current (no row, or `in-a`), else its row. Deleted = not found. */
	writeBlocker(publicId: string): IndexRow | undefined {
		const row = this.snapshot().byPublicId(publicId);
		if (row === undefined || row.state === 'in-a') return undefined;
		if (row.state === 'deleted') throw new TaskNotFoundError(publicId);
		return row;
	}
}

function translateResolved(translator: Translator, side: Side, found: ResolvedTask): ResolvedTask {
	const { parentId, ...rest } = found;
	const context = `task ${found.id} in "${SIDE_NAME[side]}"`;
	return {
		...rest,
		id: translator.publicId(side, found.id, context),
		...(parentId === undefined
			? {}
			: { parentId: translator.publicId(side, parentId, `the parent of ${context}`) }),
	};
}
