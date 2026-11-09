// The backend contract suite (design 1.7): ONE set of cases every TaskBackend runs unchanged, so "almost no visible
// difference" between local, forge and remote stores is enforced, not hoped for.
//
//   runBackendContract('MyBackend', () => ({ backend, dispose }), MY_CAPABILITIES);
//
// Rules of the suite:
//  - A case that needs a capability (`needs`) runs its real assertions when the backend declares it. When the backend
//    declares it away, the case instead calls `attempt` and asserts the call rejects with UnsupportedByBackendError for
//    that capability, with a hint. "Unsupported" is therefore tested, never skipped; a backend that declares a capability
//    away but still answers, or declares it and refuses, fails.
//  - The declared capabilities must equal the expected ones the caller passes (a declaration nobody checks is a lie).
//  - History and activity depend on the declared value but are never gated: `stored` asserts the entries, `derived` /
//    `native` assert the shape, `none` asserts they are empty.
//
// Test helper: imports vitest, so it is not part of the package barrel. Another package imports it from the built
// folder (`@wadeck-app/task-core/dist/contract/backendContract.js`) until a subpath export is added (stage 0 progress notes).
import { describe, expect, it } from 'vitest';

import { StaleRevisionError, UnsupportedByBackendError } from '../backend/backendErrors.js';
import type { BackendCapabilities } from '../backend/capabilities.js';
import type { TaskBackend, VersionedRecord } from '../backend/TaskBackend.js';
import { AmbiguousTaskPrefixError, TaskConflictError, TaskNotFoundError } from '../errors.js';
import { CommentNotFoundError, InvalidCommentTextError } from '../taskComments.js';
import { ACTIVITY_PREVIEW_MAX, INVERSE_LINK_NAMES, LINK_TYPES } from '../TaskStore.js';
import type { ActivityEntry, LinkType, TaskSummary } from '../TaskStore.js';

export interface BackendFixture {
	backend: TaskBackend;
	/** Called after the case, pass or fail (remove the temp dir, stop the fake server). */
	dispose?: () => void | Promise<void>;
}

export interface ContractOptions {
	/** Statuses the backend accepts. Defaults: backlog -> in-progress -> done (terminal). */
	statuses?: { initial: string; next: string; terminal: string };
	/**
	 * Whether the caller can choose the author of a comment (default true). A forge writes the comment as the user of the token: with
	 * `false` the suite asserts that a given author is refused (UnsupportedByBackendError for comments) and that the comment still
	 * has an author, instead of asserting the author it sent.
	 */
	authoredComments?: boolean;
}

export interface Need {
	capability: keyof BackendCapabilities;
	/** For the test name only. */
	description: string;
	met: (capabilities: BackendCapabilities) => boolean;
}

export interface Harness {
	backend: TaskBackend;
	caps: BackendCapabilities;
	statuses: { initial: string; next: string; terminal: string };
	authoredComments: boolean;
	/** Creates a task in the initial status. */
	task: (title: string, extra?: { parentId?: string; description?: string }) => Promise<VersionedRecord>;
}

export interface ContractCase {
	/** One of the groups of design 1.7: crud, status, fields, graph, concurrency, delete, atomicity, search. */
	group: string;
	name: string;
	needs?: Need;
	/** The real assertions (the capability is declared). */
	run: (h: Harness) => Promise<void>;
	/** Required with `needs`: a call that must reject with UnsupportedByBackendError for `needs.capability`. */
	attempt?: (h: Harness) => Promise<unknown>;
}

const DEFAULT_STATUSES = { initial: 'backlog', next: 'in-progress', terminal: 'done' };

// ---- needs ----
const need = (capability: keyof BackendCapabilities, description: string, met: Need['met']): Need => ({
	capability,
	description,
	met,
});
const NEEDS = {
	labels: need('labels', 'labels', c => c.labels),
	meta: need('meta', 'meta', c => c.meta),
	comments: need('comments', 'comments', c => c.comments),
	hierarchy: need('hierarchy', 'hierarchy', c => c.hierarchy !== 'none'),
	delete: need('delete', 'delete', c => c.delete !== 'no'),
	search: need('search', 'search', c => c.search !== 'none'),
	concurrency: need('concurrency', 'revisions', c => c.concurrency !== 'none'),
	freeStatus: need('status', 'free statuses', c => c.status === 'free'),
	generatedIds: need('ids', 'generated ids', c => c.ids === 'generated'),
	linkType: (type: LinkType): Need =>
		need('linkTypes', `${type} links`, c => (c.linkTypes as readonly string[]).includes(type)),
};

// ---- helpers ----
async function rejection(promise: Promise<unknown>): Promise<Error> {
	let caught: unknown;
	try {
		await promise;
	} catch (error) {
		caught = error;
	}
	expect(caught, 'the call should have been refused').toBeInstanceOf(Error);
	return caught as Error;
}

async function rejectsWith<E extends Error>(promise: Promise<unknown>, type: new (...args: never[]) => E): Promise<E> {
	const error = await rejection(promise);
	expect(error, `expected ${type.name}, got ${error.name}: ${error.message}`).toBeInstanceOf(type);
	return error as E;
}

const ids = (tasks: readonly { id: string }[]): string[] => tasks.map(t => t.id);

/** Everything observable about some tasks: used to prove a refused write changed nothing. */
async function stateOf(backend: TaskBackend, taskIds: readonly string[]) {
	return { list: await backend.list(), records: await backend.getMany(taskIds) };
}

function activityOf(record: VersionedRecord): ActivityEntry[] {
	return record.activity ?? [];
}

/** The activity entries of one kind (a copy). */
function entries(record: VersionedRecord, kind: ActivityEntry['kind']): ActivityEntry[] {
	return activityOf(record).filter(e => e.kind === kind);
}

const isIso = (value: string): boolean => !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;

// ---- cases ----
export const BACKEND_CONTRACT_CASES: readonly ContractCase[] = [
	// ======== crud ========
	{
		group: 'crud',
		name: 'create then get round-trips the record, with a revision',
		async run({ backend, task, statuses }) {
			const created = await task('Write the docs');

			expect(created.id).toBeTypeOf('string');
			expect(created.id).not.toBe('');
			expect(created.title).toBe('Write the docs');
			expect(created.status).toBe(statuses.initial);
			expect(isIso(created.createdAt)).toBe(true);
			expect(created.updatedAt).toBe(created.createdAt);
			expect(created.revision).toBeTypeOf('string');
			expect(created.revision).not.toBe('');
			expect(created.parentId).toBeUndefined();

			expect(await backend.get(created.id)).toEqual(created);
			const summary = (await backend.list()).find(t => t.id === created.id);
			expect(summary).toMatchObject({
				id: created.id,
				title: 'Write the docs',
				status: statuses.initial,
				createdAt: created.createdAt,
			});
		},
	},
	{
		group: 'crud',
		name: 'a description is stored only when it differs from the title',
		async run({ backend, task }) {
			const same = await task('Same', { description: 'Same' });
			expect(same.description).toBeUndefined();

			const body = await task('Headline', { description: 'The body' });
			expect(body.description).toBe('The body');

			expect((await backend.setDescription(body.id, '')).description).toBeUndefined();
			expect((await backend.setDescription(body.id, 'Another body')).description).toBe('Another body');
			// A title that becomes the description makes the stored body redundant.
			expect((await backend.setTitle(body.id, 'Another body')).description).toBeUndefined();
		},
	},
	{
		group: 'crud',
		name: 'the revision is stable between reads and changes with every stored change',
		async run({ backend, task }) {
			const created = await task('Revisions');
			const read = await backend.get(created.id);
			const [many] = await backend.getMany([created.id]);
			expect(read.revision).toBe(created.revision);
			expect(many!.revision).toBe(created.revision);

			const renamed = await backend.setTitle(created.id, 'Revisions, renamed');
			expect(renamed.revision).not.toBe(created.revision);
			expect((await backend.get(created.id)).revision).toBe(renamed.revision);
		},
	},
	{
		group: 'crud',
		name: 'getMany keeps the order of the ids and rejects a missing one with TaskNotFoundError',
		async run({ backend, task }) {
			const a = await task('A');
			const b = await task('B');

			expect(ids(await backend.getMany([b.id, a.id]))).toEqual([b.id, a.id]);
			expect(await backend.getMany([])).toEqual([]);
			const error = await rejectsWith(backend.getMany([a.id, 'nope0000']), TaskNotFoundError);
			expect(error.taskId).toBe('nope0000');
		},
	},
	{
		group: 'crud',
		name: 'an exact id resolves, an unknown one is TaskNotFoundError carrying the id',
		async run({ backend, task }) {
			const a = await task('A');

			expect((await backend.findByPrefix(a.id)).id).toBe(a.id);
			const error = await rejectsWith(backend.findByPrefix('zzzzzzzz'), TaskNotFoundError);
			expect(error.taskId).toBe('zzzzzzzz');
		},
	},
	{
		group: 'crud',
		name: 'a prefix resolves, whatever its case (generated ids); with assigned ids the exact id does',
		async run({ backend, task, caps }) {
			const a = await task('A');

			if (caps.ids === 'generated') {
				expect((await backend.findByPrefix(a.id.slice(0, 3))).id).toBe(a.id);
				expect((await backend.findByPrefix(a.id.toUpperCase())).id).toBe(a.id);
			} else {
				expect((await backend.findByPrefix(a.id)).id).toBe(a.id);
				await rejectsWith(backend.findByPrefix(`${a.id}0`), TaskNotFoundError);
			}
		},
	},
	{
		group: 'crud',
		name: 'a prefix shared by several tasks is AmbiguousTaskPrefixError listing them (generated ids only)',
		async run({ backend, task, caps }) {
			// Assigned ids are exact: there is no prefix to share, the exact-id cases above cover them.
			if (caps.ids !== 'generated') return;
			// Pigeonhole: ids start with one of 36 characters, so 37 tasks share a first character.
			const byFirst = new Map<string, string[]>();
			let shared: string | undefined;
			for (let i = 0; i < 37 && shared === undefined; i++) {
				const created = await task(`Task ${i}`);
				const first = created.id.slice(0, 1).toLowerCase();
				byFirst.set(first, [...(byFirst.get(first) ?? []), created.id]);
				if ((byFirst.get(first) ?? []).length > 1) shared = first;
			}
			expect(shared, 'two of 37 generated ids must share a first character').toBeDefined();

			const error = await rejectsWith(backend.findByPrefix(shared!), AmbiguousTaskPrefixError);
			expect(error.prefix).toBe(shared);
			expect(error.matches).toEqual(expect.arrayContaining(byFirst.get(shared!)!));
		},
	},
	{
		group: 'crud',
		name: 'a write or read on an unknown task is TaskNotFoundError and creates nothing',
		async run({ backend, task }) {
			const keep = await task('Keep');
			const before = await stateOf(backend, [keep.id]);
			const missing = 'nope0000';

			const calls: Array<[string, () => Promise<unknown>]> = [
				['get', () => backend.get(missing)],
				['updateStatus', () => backend.updateStatus(missing, 'done')],
				['setTitle', () => backend.setTitle(missing, 'x')],
				['setDescription', () => backend.setDescription(missing, 'x')],
				['setType', () => backend.setType(missing, 'bug')],
				['clearType', () => backend.clearType(missing)],
				['getLinks', () => backend.getLinks(missing)],
				['getLinksLenient', () => backend.getLinksLenient(missing)],
			];
			for (const [name, call] of calls) {
				const error = await rejectsWith(call(), TaskNotFoundError);
				expect(error.taskId, name).toBe(missing);
			}
			expect(await stateOf(backend, [keep.id])).toEqual(before);
		},
	},
	{
		group: 'crud',
		name: 'listPage walks every task with limit and cursor, and filters on status',
		async run({ backend, task, statuses }) {
			const created: VersionedRecord[] = [];
			for (const title of ['One', 'Two', 'Three', 'Four', 'Five']) created.push(await task(title));
			await backend.updateStatus(created[1]!.id, statuses.next);
			await backend.updateStatus(created[3]!.id, statuses.next);

			const everything = await backend.listPage();
			expect(ids(everything.items)).toEqual(ids(created));
			expect(everything.nextCursor).toBeUndefined();

			const seen: string[] = [];
			let cursor: string | undefined;
			let pages = 0;
			do {
				const page = await backend.listPage({ limit: 2, cursor });
				expect(page.items.length).toBeLessThanOrEqual(2);
				seen.push(...ids(page.items));
				cursor = page.nextCursor;
				pages += 1;
			} while (cursor !== undefined && pages < 10);
			expect(seen).toEqual(ids(created));
			expect(pages).toBe(3);

			const moving = await backend.listPage({ statusIn: [statuses.next] });
			expect(ids(moving.items)).toEqual([created[1]!.id, created[3]!.id]);
		},
	},

	// ======== status ========
	{
		group: 'status',
		name: 'updateStatus records the change in the record and the list, and refuses the current status',
		async run({ backend, task, statuses, caps }) {
			const created = await task('Moving');

			const moved = await backend.updateStatus(created.id, statuses.next);
			expect(moved.status).toBe(statuses.next);
			expect(moved.revision).not.toBe(created.revision);
			expect(moved.updatedAt >= created.updatedAt).toBe(true);
			expect((await backend.list()).find(t => t.id === created.id)?.status).toBe(statuses.next);

			if (caps.history === 'stored') {
				expect(moved.history.map(h => h.status)).toEqual([statuses.initial, statuses.next]);
				expect(moved.history.every(h => isIso(h.timestamp))).toBe(true);
			} else if (caps.history === 'derived') {
				expect(moved.history.at(-1)?.status).toBe(statuses.next);
			} else {
				expect(moved.history).toEqual([]);
			}

			const before = await backend.get(created.id);
			await rejectsWith(backend.updateStatus(created.id, statuses.next), TaskConflictError);
			expect(await backend.get(created.id)).toEqual(before);
		},
	},
	{
		group: 'status',
		name: 'any status name is accepted',
		needs: NEEDS.freeStatus,
		async run({ backend, task }) {
			const created = await task('Free');
			const moved = await backend.updateStatus(created.id, 'waiting-for-review');
			expect(moved.status).toBe('waiting-for-review');
		},
		async attempt({ backend, task }) {
			const created = await task('Mapped');
			return backend.updateStatus(created.id, 'waiting-for-review');
		},
	},

	// ======== fields ========
	{
		group: 'fields',
		name: 'type: set, same value, change, clear, with activity entries of the current shape',
		async run({ backend, task, caps }) {
			const created = await task('Typed');

			const bug = await backend.setType(created.id, 'bug');
			expect(bug.type).toBe('bug');
			const same = await backend.setType(created.id, 'bug');
			expect(same.type).toBe('bug');
			const feature = await backend.setType(created.id, 'feature');
			expect(feature.type).toBe('feature');
			const cleared = await backend.clearType(created.id);
			expect(cleared.type).toBeUndefined();

			if (caps.activity === 'stored') {
				// Only the keys that apply are stored; an unchanged type adds nothing.
				expect(entries(cleared, 'type')).toEqual([
					{ at: expect.any(String), kind: 'type', newValue: 'bug' },
					{ at: expect.any(String), kind: 'type', oldValue: 'bug', newValue: 'feature' },
					{ at: expect.any(String), kind: 'type', oldValue: 'feature' },
				]);
				expect(activityOf(cleared).every(e => isIso(e.at))).toBe(true);
			} else if (caps.activity === 'none') {
				expect(activityOf(cleared)).toEqual([]);
			}
		},
	},
	{
		group: 'fields',
		name: 'title and description edits reach the record and the list, and are logged with a bounded preview',
		async run({ backend, task, caps }) {
			const created = await task('Before');

			const renamed = await backend.setTitle(created.id, 'After');
			expect(renamed.title).toBe('After');
			expect((await backend.list()).find(t => t.id === created.id)?.title).toBe('After');
			await backend.setTitle(created.id, 'After');

			const long = 'x'.repeat(ACTIVITY_PREVIEW_MAX + 50);
			const described = await backend.setDescription(created.id, long);
			expect(described.description).toBe(long);

			if (caps.activity === 'stored') {
				expect(entries(described, 'title')).toEqual([
					{ at: expect.any(String), kind: 'title', oldValue: 'Before', newValue: 'After' },
				]);
				const [description] = entries(described, 'description');
				expect(description?.oldValue).toBe('After');
				expect(description?.newValue).toHaveLength(ACTIVITY_PREVIEW_MAX);
				expect(description?.newValue?.endsWith('...')).toBe(true);
			}
		},
	},
	{
		group: 'fields',
		name: 'labels: adding twice keeps one, removing an absent one changes nothing, counts per label',
		needs: NEEDS.labels,
		async run({ backend, task, caps }) {
			const a = await task('A');
			const b = await task('B');

			await backend.addLabel(a.id, 'urgent');
			const twice = await backend.addLabel(a.id, 'urgent');
			expect(twice.labels).toEqual(['urgent']);
			await backend.addLabel(a.id, 'backend');
			await backend.addLabel(b.id, 'urgent');
			expect(await backend.listLabels()).toEqual([
				{ label: 'urgent', count: 2 },
				{ label: 'backend', count: 1 },
			]);

			const absent = await backend.removeLabel(a.id, 'absent');
			expect(absent.labels ?? []).toEqual(['urgent', 'backend']);
			const removed = await backend.removeLabel(a.id, 'urgent');
			expect(removed.labels).toEqual(['backend']);

			if (caps.activity === 'stored') {
				expect(entries(removed, 'label-added').map(e => e.newValue)).toEqual(['urgent', 'backend']);
				expect(entries(removed, 'label-removed').map(e => e.oldValue)).toEqual(['urgent']);
			}
		},
		async attempt({ backend, task }) {
			const a = await task('A');
			return backend.addLabel(a.id, 'urgent');
		},
	},
	{
		group: 'fields',
		name: 'listLabels is empty without labels',
		needs: NEEDS.labels,
		async run({ backend, task }) {
			await task('No label');
			expect(await backend.listLabels()).toEqual([]);
		},
		async attempt({ backend }) {
			return backend.listLabels();
		},
	},
	{
		group: 'fields',
		name: 'meta: set, same value, change, remove; the object goes with its last key',
		needs: NEEDS.meta,
		async run({ backend, task, caps }) {
			const a = await task('A');

			const first = await backend.setMeta(a.id, 'owner', 'ann');
			expect(first.meta).toEqual({ owner: 'ann' });
			await backend.setMeta(a.id, 'owner', 'ann');
			const changed = await backend.setMeta(a.id, 'owner', 'bob');
			expect(changed.meta).toEqual({ owner: 'bob' });
			// An inherited property name is a key like any other.
			const odd = await backend.setMeta(a.id, 'constructor', 'x');
			expect(odd.meta).toEqual({ owner: 'bob', constructor: 'x' });

			const absent = await backend.removeMeta(a.id, 'absent');
			expect(absent.meta).toEqual({ owner: 'bob', constructor: 'x' });
			await backend.removeMeta(a.id, 'owner');
			const last = await backend.removeMeta(a.id, 'constructor');
			expect(last.meta).toBeUndefined();

			if (caps.activity === 'stored') {
				expect(entries(last, 'meta-set').map(e => [e.field, e.oldValue, e.newValue])).toEqual([
					['owner', undefined, 'ann'],
					['owner', 'ann', 'bob'],
					['constructor', undefined, 'x'],
				]);
				expect(entries(last, 'meta-removed').map(e => [e.field, e.oldValue])).toEqual([
					['owner', 'bob'],
					['constructor', 'x'],
				]);
			}
		},
		async attempt({ backend, task }) {
			const a = await task('A');
			return backend.setMeta(a.id, 'owner', 'ann');
		},
	},
	{
		group: 'fields',
		name: 'comments: add (trimmed, optional author), edit, remove, with typed errors',
		needs: NEEDS.comments,
		async run({ backend, task, caps, authoredComments }) {
			const a = await task('A');

			const added = authoredComments
				? await backend.addComment(a.id, '  first note  ', { author: ' ann ' })
				: await backend.addComment(a.id, '  first note  ');
			expect(added.comment).toMatchObject(
				authoredComments ? { text: 'first note', author: 'ann' } : { text: 'first note' }
			);
			expect(added.comment.id).toBeTypeOf('string');
			expect(isIso(added.comment.at)).toBe(true);
			expect(added.task.comments).toEqual([added.comment]);
			const anonymous = await backend.addComment(a.id, 'second note');
			if (authoredComments) expect(anonymous.comment.author).toBeUndefined();
			else {
				// The system writes the comment as its own user; choosing another author is refused, loudly.
				expect(anonymous.comment.author).toBeTypeOf('string');
				const refused = await rejectsWith(
					backend.addComment(a.id, 'by someone else', { author: 'ann' }),
					UnsupportedByBackendError
				);
				expect(refused.capability).toBe('comments');
			}

			await rejectsWith(backend.addComment(a.id, '   '), InvalidCommentTextError);

			const edited = await backend.editComment(a.id, added.comment.id, 'first note, edited');
			expect(edited).toMatchObject({ changed: true, oldText: 'first note' });
			expect(edited.comment.text).toBe('first note, edited');
			expect(isIso(edited.comment.editedAt!)).toBe(true);
			const unchanged = await backend.editComment(a.id, added.comment.id, 'first note, edited');
			expect(unchanged.changed).toBe(false);

			const missing = await rejectsWith(backend.editComment(a.id, 'zzzzzz', 'x'), CommentNotFoundError);
			expect(missing.validIds).toEqual([added.comment.id, anonymous.comment.id]);
			await rejectsWith(backend.removeComment(a.id, 'zzzzzz'), CommentNotFoundError);

			const removedFirst = await backend.removeComment(a.id, added.comment.id);
			expect(removedFirst.comment.id).toBe(added.comment.id);
			const removedLast = await backend.removeComment(a.id, anonymous.comment.id);
			expect(removedLast.task.comments).toBeUndefined();

			if (caps.activity === 'stored') {
				// An added comment is the record itself, not an activity entry.
				expect(entries(removedLast.task, 'comment-edited')).toHaveLength(1);
				expect(entries(removedLast.task, 'comment-edited')[0]).toMatchObject({ field: added.comment.id });
				expect(entries(removedLast.task, 'comment-removed').map(e => e.field)).toEqual([
					added.comment.id,
					anonymous.comment.id,
				]);
			}
		},
		async attempt({ backend, task }) {
			const a = await task('A');
			return backend.addComment(a.id, 'a note');
		},
	},

	// ======== graph ========
	{
		group: 'graph',
		name: 'parent and children: create under a parent, set, remove, and read the tree from every side',
		needs: NEEDS.hierarchy,
		async run({ backend, task, caps }) {
			const root = await task('Root');
			const child = await task('Child', { parentId: root.id });
			const grand = await task('Grand', { parentId: child.id });
			const sibling = await task('Sibling');
			expect(child.parentId).toBe(root.id);
			await backend.setParent(sibling.id, root.id);

			expect(ids(await backend.getChildren(root.id))).toEqual([child.id, sibling.id]);
			expect(ids(await backend.getAncestors(grand.id))).toEqual([child.id, root.id]);
			const tree = await backend.getTree(root.id);
			expect(tree.id).toBe(root.id);
			expect(ids(tree.children)).toEqual([child.id, sibling.id]);
			expect(ids(tree.children[0]!.children)).toEqual([grand.id]);
			const descendants = ids(await backend.getDescendants(root.id));
			expect([...descendants].sort()).toEqual([child.id, grand.id, sibling.id].sort());
			expect(descendants.indexOf(child.id)).toBeLessThan(descendants.indexOf(grand.id));
			const full = await backend.getFullTree(grand.id);
			expect(full.id).toBe(root.id);
			const selected: string[] = [];
			const walk = (node: typeof full): void => {
				if (node.selected) selected.push(node.id);
				node.children.forEach(walk);
			};
			walk(full);
			expect(selected).toEqual([grand.id]);
			expect(ids(await backend.getForest({ parentId: root.id }))).toEqual([child.id, sibling.id]);
			expect(ids(await backend.getForest())).toContain(root.id);
			expect(ids((await backend.listPage({ parentId: root.id })).items)).toEqual([child.id, sibling.id]);
			const roots = ids((await backend.listPage({ parentId: null })).items);
			expect(roots).toContain(root.id);
			expect(roots).not.toContain(child.id);
			const summary: TaskSummary | undefined = (await backend.list()).find(t => t.id === grand.id);
			expect(summary?.parentId).toBe(child.id);

			const detached = await backend.removeParent(child.id);
			expect(detached.parentId).toBeUndefined();
			expect((await backend.list()).find(t => t.id === child.id)?.parentId).toBeUndefined();
			await rejectsWith(backend.removeParent(child.id), TaskConflictError);
			const reattached = await backend.setParent(child.id, root.id);
			expect(reattached.parentId).toBe(root.id);

			if (caps.activity === 'stored') {
				// Creating under a parent logs nothing; detaching and re-attaching are two entries.
				expect(entries(reattached, 'parent').map(e => [e.oldValue, e.newValue])).toEqual([
					[root.id, undefined],
					[undefined, root.id],
				]);
				// The parent shows the child coming and going (mirror, written on the parent).
				const parent = await backend.get(root.id);
				expect(entries(parent, 'child-added').every(e => e.inverse === true)).toBe(true);
				expect(entries(parent, 'child-added').map(e => e.target)).toContain(child.id);
				expect(entries(parent, 'child-removed').map(e => e.target)).toContain(child.id);
			}
		},
		async attempt({ backend, task }) {
			const a = await task('A');
			const b = await task('B');
			return backend.setParent(a.id, b.id);
		},
	},
	{
		group: 'graph',
		name: 'parent refusals: itself, a descendant (cycle), an unknown task; nothing changes',
		needs: NEEDS.hierarchy,
		async run({ backend, task }) {
			const root = await task('Root');
			const child = await task('Child', { parentId: root.id });
			const grand = await task('Grand', { parentId: child.id });
			const before = await stateOf(backend, [root.id, child.id, grand.id]);

			await rejectsWith(backend.setParent(root.id, root.id), TaskConflictError);
			const cycle = await rejectsWith(backend.setParent(root.id, grand.id), TaskConflictError);
			expect(cycle.message).toContain('cycle');
			await rejectsWith(backend.setParent(child.id, 'nope0000'), Error);
			await rejectsWith(backend.create({ title: 'Orphan', status: 'backlog', parentId: 'nope0000' }), Error);

			expect(await stateOf(backend, [root.id, child.id, grand.id])).toEqual(before);
		},
		async attempt({ backend, task }) {
			const a = await task('A');
			return backend.setParent(a.id, a.id);
		},
	},

	...LINK_TYPES.flatMap((type): ContractCase[] => [
		{
			group: 'graph',
			name: `${type} link: add, read both directions with the inverse name, remove`,
			needs: NEEDS.linkType(type),
			async run({ backend, task, caps }) {
				const a = await task('A');
				const b = await task('B');

				const linked = await backend.addLink(a.id, type, b.id);
				expect(linked.links).toEqual([{ type, target: b.id }]);
				const fromA = await backend.getLinks(a.id);
				expect(ids(fromA[type])).toEqual([b.id]);
				const fromB = await backend.getLinks(b.id);
				expect(ids(fromB[INVERSE_LINK_NAMES[type]])).toEqual([a.id]);
				expect(fromB[type]).toEqual([]);
				const lenient = await backend.getLinksLenient(a.id);
				expect(lenient.dangling).toEqual([]);
				expect(ids(lenient.links[type])).toEqual([b.id]);
				if (caps.indexedGraph) {
					expect((await backend.list()).find(t => t.id === a.id)?.links).toEqual([{ type, target: b.id }]);
				}

				if (caps.activity === 'stored') {
					expect(entries(linked, 'link-added')).toEqual([
						{ at: expect.any(String), kind: 'link-added', field: type, target: b.id },
					]);
					// The target sees the link from its side (mirror entry, its own updatedAt untouched).
					const target = await backend.get(b.id);
					expect(entries(target, 'link-added')).toEqual([
						{ at: expect.any(String), kind: 'link-added', field: type, target: a.id, inverse: true },
					]);
				}

				const unlinked = await backend.removeLink(a.id, type, b.id);
				expect(unlinked.links).toBeUndefined();
				expect((await backend.getLinks(b.id))[INVERSE_LINK_NAMES[type]]).toEqual([]);
				if (caps.indexedGraph) expect((await backend.list()).find(t => t.id === a.id)?.links).toBeUndefined();
				await rejectsWith(backend.removeLink(a.id, type, b.id), TaskConflictError);
				if (caps.activity === 'stored') {
					expect(entries(unlinked, 'link-removed')).toHaveLength(1);
					expect(entries(await backend.get(b.id), 'link-removed')).toHaveLength(1);
				}
			},
			async attempt({ backend, task }) {
				const a = await task('A');
				const b = await task('B');
				return backend.addLink(a.id, type, b.id);
			},
		},
		{
			group: 'graph',
			name: `${type} link refusals: duplicate, itself, unknown target, cycle${type === 'duplicateOf' ? ', second target' : ', several targets allowed'}`,
			needs: NEEDS.linkType(type),
			async run({ backend, task }) {
				const a = await task('A');
				const b = await task('B');
				const c = await task('C');
				await backend.addLink(a.id, type, b.id);

				await rejectsWith(backend.addLink(a.id, type, b.id), TaskConflictError);
				await rejectsWith(backend.addLink(a.id, type, a.id), TaskConflictError);
				await rejectsWith(backend.addLink(a.id, type, 'nope0000'), Error);
				const direct = await rejectsWith(backend.addLink(b.id, type, a.id), TaskConflictError);
				expect(direct.message).toContain('cycle');
				await backend.addLink(b.id, type, c.id);
				const transitive = await rejectsWith(backend.addLink(c.id, type, a.id), TaskConflictError);
				expect(transitive.message).toContain('cycle');

				if (type === 'duplicateOf') {
					// A task duplicates at most one canonical task.
					const second = await rejectsWith(backend.addLink(a.id, type, c.id), TaskConflictError);
					expect(second.message).toContain('already a duplicateOf');
					expect((await backend.get(a.id)).links).toEqual([{ type, target: b.id }]);
				} else {
					const several = await backend.addLink(a.id, type, c.id);
					expect(several.links).toEqual([
						{ type, target: b.id },
						{ type, target: c.id },
					]);
				}
				// Only the targets of accepted links changed: `c` holds no link of its own.
				expect((await backend.get(c.id)).links).toBeUndefined();
			},
			async attempt({ backend, task }) {
				const a = await task('A');
				const b = await task('B');
				return backend.addLink(a.id, type, b.id);
			},
		},
	]),
	{
		group: 'graph',
		name: 'an unknown link type is refused and names the type',
		async run({ backend, task }) {
			const a = await task('A');
			const b = await task('B');
			const error = await rejection(backend.addLink(a.id, 'nope' as LinkType, b.id));
			expect(error.message).toContain('nope');
		},
	},
	{
		group: 'graph',
		name: 'blockers: open ones of a task, and the tasks a closing blocker unblocks',
		needs: NEEDS.linkType('blockedBy'),
		async run({ backend, task, statuses }) {
			const blocked = await task('Blocked');
			const first = await task('First blocker');
			const second = await task('Second blocker');
			await backend.addLink(blocked.id, 'blockedBy', first.id);
			await backend.addLink(blocked.id, 'blockedBy', second.id);
			const isTerminal = (status: string): boolean => status === statuses.terminal;

			expect(ids(await backend.getOpenBlockers(blocked.id, isTerminal))).toEqual([first.id, second.id]);
			expect(await backend.getUnblockedBy(first.id, isTerminal)).toEqual([]);

			await backend.updateStatus(first.id, statuses.terminal);
			expect(ids(await backend.getOpenBlockers(blocked.id, isTerminal))).toEqual([second.id]);
			// First is terminal but second still blocks: nothing is unblocked yet.
			expect(await backend.getUnblockedBy(first.id, isTerminal)).toEqual([]);

			await backend.updateStatus(second.id, statuses.terminal);
			expect(await backend.getOpenBlockers(blocked.id, isTerminal)).toEqual([]);
			expect(ids(await backend.getUnblockedBy(second.id, isTerminal))).toEqual([blocked.id]);
		},
		async attempt({ backend, task }) {
			const a = await task('A');
			const b = await task('B');
			return backend.addLink(a.id, 'blockedBy', b.id);
		},
	},

	// ======== concurrency ========
	{
		group: 'concurrency',
		name: 'a write with an outdated revision is a stale TaskConflictError and writes nothing',
		needs: NEEDS.concurrency,
		async run({ backend, task }) {
			const created = await task('Shared');
			const second = await backend.setTitle(created.id, 'Renamed by someone else');

			const accepted = await backend.setTitle(created.id, 'Mine', { expectedRevision: second.revision });
			expect(accepted.title).toBe('Mine');
			expect(accepted.revision).not.toBe(second.revision);

			const before = await backend.get(created.id);
			const stale = await rejectsWith(
				backend.setTitle(created.id, 'Too late', { expectedRevision: created.revision }),
				StaleRevisionError
			);
			expect(stale).toBeInstanceOf(TaskConflictError);
			expect(stale.kind).toBe('stale');
			expect(stale.taskId).toBe(created.id);
			expect(stale.hint).toBeTypeOf('string');
			expect(await backend.get(created.id)).toEqual(before);

			// Without a revision the last write wins, as it always did.
			const forced = await backend.setTitle(created.id, 'Forced');
			expect(forced.title).toBe('Forced');
		},
		async attempt({ backend, task }) {
			const created = await task('Shared');
			return backend.setTitle(created.id, 'Mine', { expectedRevision: created.revision });
		},
	},
	{
		group: 'concurrency',
		name: 'every kind of write honours expectedRevision',
		needs: NEEDS.concurrency,
		async run({ backend, task, statuses, caps }) {
			const created = await task('Shared');
			const stale = { expectedRevision: 'definitely-not-the-revision' };
			const calls: Array<[string, () => Promise<unknown>]> = [
				['updateStatus', () => backend.updateStatus(created.id, statuses.next, stale)],
				['setDescription', () => backend.setDescription(created.id, 'd', stale)],
				['setType', () => backend.setType(created.id, 'bug', stale)],
				['clearType', () => backend.clearType(created.id, stale)],
			];
			if (caps.labels) calls.push(['addLabel', () => backend.addLabel(created.id, 'l', stale)]);
			if (caps.meta) calls.push(['setMeta', () => backend.setMeta(created.id, 'k', 'v', stale)]);
			if (caps.comments) calls.push(['addComment', () => backend.addComment(created.id, 'note', stale)]);
			if (caps.delete === 'yes') calls.push(['deleteTask', () => backend.deleteTask(created.id, stale)]);
			for (const [name, call] of calls) {
				await rejectsWith(call(), StaleRevisionError).catch((error: unknown) => {
					throw new Error(`${name} did not refuse a stale revision: ${String(error)}`, { cause: error });
				});
			}
			expect(await backend.get(created.id)).toEqual(created);
		},
		async attempt({ backend, task }) {
			const created = await task('Shared');
			return backend.updateStatus(created.id, 'in-progress', { expectedRevision: created.revision });
		},
	},

	// ======== delete ========
	{
		group: 'delete',
		name: 'deleteTask removes the task and answers false for one that is gone',
		needs: NEEDS.delete,
		async run({ backend, task, caps }) {
			const keep = await task('Keep');
			const gone = await task('Gone');

			expect(await backend.deleteTask(gone.id)).toBe(true);
			if (caps.delete === 'yes') {
				await rejectsWith(backend.get(gone.id), TaskNotFoundError);
				expect(ids(await backend.list())).toEqual([keep.id]);
				expect(await backend.deleteTask(gone.id)).toBe(false);
			} else {
				// close-only: the task is kept, closed by the backend.
				expect((await backend.get(gone.id)).id).toBe(gone.id);
			}
			expect(await backend.deleteTask('nope0000')).toBe(false);
		},
		async attempt({ backend, task }) {
			const gone = await task('Gone');
			return backend.deleteTask(gone.id);
		},
	},
	{
		group: 'delete',
		name: 'deleting a parent orphans its children; deleting a link target drops the links held towards it',
		needs: NEEDS.delete,
		async run({ backend, task, caps }) {
			const parent = await task('Parent');
			if (caps.delete !== 'yes') {
				expect(await backend.deleteTask(parent.id)).toBe(true);
				return;
			}
			const child = caps.hierarchy === 'none' ? undefined : await task('Child', { parentId: parent.id });
			const grand = child && (await task('Grand', { parentId: child.id }));
			const holder = await task('Holder');
			const canLink = (caps.linkTypes as readonly string[]).includes('blockedBy');
			if (canLink) await backend.addLink(holder.id, 'blockedBy', parent.id);

			expect(await backend.deleteTask(parent.id)).toBe(true);

			if (child && grand) {
				// The child becomes a root; its own subtree stays attached to it.
				expect((await backend.get(child.id)).parentId).toBeUndefined();
				expect((await backend.list()).find(t => t.id === child.id)?.parentId).toBeUndefined();
				expect((await backend.get(grand.id)).parentId).toBe(child.id);
			}
			if (canLink) {
				expect((await backend.get(holder.id)).links).toBeUndefined();
				expect((await backend.list()).find(t => t.id === holder.id)?.links).toBeUndefined();
				expect((await backend.getLinks(holder.id)).blockedBy).toEqual([]);
			}
			expect(ids(await backend.list()).includes(parent.id)).toBe(false);
		},
		async attempt({ backend, task }) {
			const parent = await task('Parent');
			return backend.deleteTask(parent.id);
		},
	},

	// ======== atomicity ========
	{
		group: 'atomicity',
		name: 'a refused write leaves every task and the list exactly as they were',
		async run({ backend, task, statuses }) {
			const a = await task('A');
			const b = await task('B');
			const moved = await backend.updateStatus(b.id, statuses.next);
			const before = await stateOf(backend, [a.id, b.id]);

			await rejectsWith(backend.updateStatus(b.id, statuses.next), TaskConflictError);
			await rejectsWith(backend.setTitle('nope0000', 'x'), TaskNotFoundError);
			await rejectsWith(backend.getMany([a.id, 'nope0000']), TaskNotFoundError);

			expect(await stateOf(backend, [a.id, b.id])).toEqual(before);
			expect((await backend.get(b.id)).revision).toBe(moved.revision);
		},
	},
	{
		group: 'atomicity',
		name: 'a refused link (duplicate, itself, cycle) leaves both tasks and the list untouched',
		needs: NEEDS.linkType('blockedBy'),
		async run({ backend, task }) {
			const a = await task('A');
			const b = await task('B');
			await backend.addLink(a.id, 'blockedBy', b.id);
			const before = await stateOf(backend, [a.id, b.id]);

			await rejectsWith(backend.addLink(a.id, 'blockedBy', b.id), TaskConflictError);
			await rejectsWith(backend.addLink(a.id, 'blockedBy', a.id), TaskConflictError);
			await rejectsWith(backend.addLink(b.id, 'blockedBy', a.id), TaskConflictError);
			await rejectsWith(backend.removeLink(b.id, 'blockedBy', a.id), TaskConflictError);

			expect(await stateOf(backend, [a.id, b.id])).toEqual(before);
		},
		async attempt({ backend, task }) {
			const a = await task('A');
			const b = await task('B');
			return backend.addLink(a.id, 'blockedBy', b.id);
		},
	},
	{
		group: 'atomicity',
		name: 'the list mirrors the records after a mix of changes (title, status, parent, links)',
		async run({ backend, task, statuses, caps }) {
			const a = await task('A');
			const b = await task('B');
			const c = await task('C');
			await backend.updateStatus(a.id, statuses.next);
			await backend.setTitle(b.id, 'B renamed');
			await backend.setDescription(c.id, 'Body of C');
			if (caps.hierarchy !== 'none') await backend.setParent(b.id, a.id);
			if ((caps.linkTypes as readonly string[]).includes('blockedBy')) {
				await backend.addLink(c.id, 'blockedBy', a.id);
			}

			const summaries = await backend.list();
			expect(ids(summaries)).toEqual([a.id, b.id, c.id]);
			for (const summary of summaries) {
				const record = await backend.get(summary.id);
				expect(summary.title).toBe(record.title);
				expect(summary.status).toBe(record.status);
				expect(summary.createdAt).toBe(record.createdAt);
				if (caps.indexedGraph) {
					expect(summary.parentId).toBe(record.parentId);
					expect(summary.links).toEqual(record.links);
				}
			}
		},
	},

	// ======== search ========
	{
		group: 'search',
		name: 'text search over titles: case-insensitive substring, combined with the other filters',
		needs: NEEDS.search,
		async run({ backend, task, statuses, caps }) {
			const alpha = await task('Alpha release');
			await task('Beta');
			const second = await task('ALPHA follow-up');
			await backend.updateStatus(second.id, statuses.next);

			expect(ids((await backend.listPage({ text: 'alpha' })).items)).toEqual([alpha.id, second.id]);
			expect(ids((await backend.listPage({ text: 'alpha', statusIn: [statuses.next] })).items)).toEqual([
				second.id,
			]);
			expect((await backend.listPage({ text: 'no such title' })).items).toEqual([]);
			// A substring of a word is a match for an index over the titles, not for a system that searches whole words.
			if (caps.search === 'index') {
				expect(ids((await backend.listPage({ text: 'a', limit: 2 })).items)).toHaveLength(2);
			}
		},
		async attempt({ backend, task }) {
			await task('Alpha');
			return backend.listPage({ text: 'alpha' });
		},
	},
];

// ---- running ----
function harnessFor(fixture: BackendFixture, options: ContractOptions): Harness {
	const statuses = options.statuses ?? DEFAULT_STATUSES;
	const { backend } = fixture;
	return {
		backend,
		caps: backend.capabilities,
		statuses,
		authoredComments: options.authoredComments !== false,
		task: (title, extra = {}) => backend.create({ title, status: statuses.initial, ...extra }),
	};
}

/** True when the case runs its real assertions on a backend with these capabilities. */
export function isSupported(contractCase: ContractCase, capabilities: BackendCapabilities): boolean {
	return contractCase.needs === undefined || contractCase.needs.met(capabilities);
}

/**
 * Runs one case against a fixture: the real assertions when supported, else `attempt` must reject with an
 * UnsupportedByBackendError for the capability, naming the backend and carrying a hint. Rejects on any deviation.
 */
export async function runContractCase(
	contractCase: ContractCase,
	fixture: BackendFixture,
	options: ContractOptions
): Promise<void> {
	const harness = harnessFor(fixture, options);
	if (isSupported(contractCase, harness.caps)) {
		await contractCase.run(harness);
		return;
	}
	const { needs, attempt } = contractCase;
	if (needs === undefined || attempt === undefined) {
		throw new Error(
			`Contract case "${contractCase.group}: ${contractCase.name}" has no \`attempt\`: add what must be refused`
		);
	}
	const error = await rejection(attempt(harness));
	expect(error, `expected UnsupportedByBackendError, got ${error.name}: ${error.message}`).toBeInstanceOf(
		UnsupportedByBackendError
	);
	const refusal = error as UnsupportedByBackendError;
	expect(refusal.capability).toBe(needs.capability);
	expect(refusal.backendKind).toBe(fixture.backend.kind);
	expect(refusal.hint.trim()).not.toBe('');
}

/** Throws, naming every differing capability, when the backend declares something else than expected. */
export function assertDeclaredCapabilities(backend: TaskBackend, expected: BackendCapabilities): void {
	const declared = backend.capabilities as unknown as Record<string, unknown>;
	const wanted = expected as unknown as Record<string, unknown>;
	const differing = Object.keys({ ...wanted, ...declared }).filter(
		key => JSON.stringify(declared[key]) !== JSON.stringify(wanted[key])
	);
	if (differing.length > 0) {
		throw new Error(
			`The backend declares other capabilities than expected: ${differing
				.map(
					key => `${key}: declared ${JSON.stringify(declared[key])}, expected ${JSON.stringify(wanted[key])}`
				)
				.join('; ')}. Fix the declaration or the expectation.`
		);
	}
}

/**
 * Registers the contract as a vitest `describe` for one backend. `factory` runs once per case (a fresh, empty backend);
 * `expectedCapabilities` is what the backend must declare, and decides which cases assert refusals.
 */
export function runBackendContract(
	name: string,
	factory: () => BackendFixture | Promise<BackendFixture>,
	expectedCapabilities: BackendCapabilities,
	options: ContractOptions = {}
): void {
	describe(`backend contract: ${name}`, () => {
		it('declares the expected capabilities', async () => {
			const fixture = await factory();
			try {
				assertDeclaredCapabilities(fixture.backend, expectedCapabilities);
			} finally {
				await fixture.dispose?.();
			}
		});

		for (const contractCase of BACKEND_CONTRACT_CASES) {
			const refused = !isSupported(contractCase, expectedCapabilities);
			const suffix = refused ? ` [${contractCase.needs?.description} unsupported: must refuse]` : '';
			it(`${contractCase.group}: ${contractCase.name}${suffix}`, async () => {
				const fixture = await factory();
				try {
					await runContractCase(contractCase, fixture, options);
				} finally {
					await fixture.dispose?.();
				}
			});
		}
	});
}
