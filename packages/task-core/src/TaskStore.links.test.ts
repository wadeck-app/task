import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { LINK_TYPES, TaskStore } from './TaskStore';
import type { LinkType } from './TaskStore';

describe('TaskStore — task links', () => {
	let rootDir: string;
	let store: TaskStore;

	beforeEach(() => {
		rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-links-'));
		const tasksDir = path.join(rootDir, 'tasks');
		fs.mkdirSync(tasksDir, { recursive: true });
		store = new TaskStore(tasksDir);
	});

	afterEach(() => {
		fs.rmSync(rootDir, { recursive: true, force: true });
	});

	const make = (title: string, status = 'backlog') => store.create(title, status);
	const isTerminal = (status: string): boolean => status === 'done';
	const indexLinks = (id: string) => store.list().find(t => t.id === id)!.links;

	it('exposes the supported link types', () => {
		expect([...LINK_TYPES]).toEqual(['blockedBy', 'duplicateOf', 'causedBy']);
	});

	describe('addLink()', () => {
		it.each(LINK_TYPES)('stores a %s link on the record and mirrors it in the index', type => {
			const a = make('A');
			const b = make('B');

			const updated = store.addLink(a.id, type, b.id);

			expect(updated.links).toEqual([{ type, target: b.id }]);
			expect(store.get(a.id).links).toEqual([{ type, target: b.id }]);
			expect(indexLinks(a.id)).toEqual([{ type, target: b.id }]);
			expect(store.get(b.id).links).toBeUndefined();
		});

		it('bumps updatedAt', async () => {
			const a = make('A');
			const b = make('B');
			await new Promise(r => setTimeout(r, 5));

			expect(store.addLink(a.id, 'blockedBy', b.id).updatedAt > a.updatedAt).toBe(true);
		});

		it('allows several blockedBy and several causedBy targets', () => {
			const a = make('A');
			const b = make('B');
			const c = make('C');

			store.addLink(a.id, 'blockedBy', b.id);
			store.addLink(a.id, 'blockedBy', c.id);
			store.addLink(a.id, 'causedBy', b.id);
			store.addLink(a.id, 'causedBy', c.id);

			expect(store.get(a.id).links).toHaveLength(4);
		});

		it('allows the same target under different link types', () => {
			const a = make('A');
			const b = make('B');

			store.addLink(a.id, 'blockedBy', b.id);
			store.addLink(a.id, 'causedBy', b.id);

			expect(store.get(a.id).links).toHaveLength(2);
		});

		it('rejects an unknown link type and lists the valid ones', () => {
			const a = make('A');
			const b = make('B');

			expect(() => store.addLink(a.id, 'relatesTo' as LinkType, b.id)).toThrow(
				/Unknown link type "relatesTo".*blockedBy, duplicateOf, causedBy/
			);
		});

		it('throws when the source task does not exist', () => {
			const b = make('B');

			expect(() => store.addLink('nope1234', 'blockedBy', b.id)).toThrow(/Task not found: nope1234/);
		});

		it('throws when the target task does not exist, and writes nothing', () => {
			const a = make('A');

			expect(() => store.addLink(a.id, 'blockedBy', 'nope1234')).toThrow(/Target task not found: nope1234/);
			expect(store.get(a.id).links).toBeUndefined();
		});

		it.each(LINK_TYPES)('rejects a task linked to itself (%s)', type => {
			const a = make('A');

			expect(() => store.addLink(a.id, type, a.id)).toThrow(/cannot be linked to itself/);
		});

		it('rejects an exact duplicate link instead of silently ignoring it', () => {
			const a = make('A');
			const b = make('B');
			store.addLink(a.id, 'blockedBy', b.id);

			expect(() => store.addLink(a.id, 'blockedBy', b.id)).toThrow(/already blockedBy/);
			expect(store.get(a.id).links).toHaveLength(1);
		});

		it('allows only one duplicateOf target and tells how to change it', () => {
			const a = make('A');
			const b = make('B');
			const c = make('C');
			store.addLink(a.id, 'duplicateOf', b.id);

			expect(() => store.addLink(a.id, 'duplicateOf', c.id)).toThrow(/already a duplicateOf.*unlink/s);
			expect(store.get(a.id).links).toEqual([{ type: 'duplicateOf', target: b.id }]);
		});
	});

	describe.each(LINK_TYPES)('cycle detection over the full %s graph', type => {
		it('rejects a direct two-task cycle', () => {
			const a = make('A');
			const b = make('B');
			store.addLink(a.id, type, b.id);

			expect(() => store.addLink(b.id, type, a.id)).toThrow(/cycle/);
		});

		it('rejects closing a three-task chain: A => B => C then C => A', () => {
			const a = make('A');
			const b = make('B');
			const c = make('C');
			store.addLink(a.id, type, b.id);
			store.addLink(b.id, type, c.id);

			expect(() => store.addLink(c.id, type, a.id)).toThrow(/cycle/);
			expect(store.get(c.id).links).toBeUndefined();
			expect(indexLinks(c.id)).toBeUndefined();
		});

		it('names the whole cycle path in the error so it is actionable', () => {
			const a = make('A');
			const b = make('B');
			const c = make('C');
			store.addLink(a.id, type, b.id);
			store.addLink(b.id, type, c.id);

			expect(() => store.addLink(c.id, type, a.id)).toThrow(new RegExp(`${c.id} → ${a.id} → ${b.id} → ${c.id}`));
		});

		it('rejects closing a long chain (60 tasks) end to start', () => {
			const tasks = Array.from({ length: 60 }, (_, i) => make(`T${i}`));
			for (let i = 0; i < tasks.length - 1; i++) {
				store.addLink(tasks[i]!.id, type, tasks[i + 1]!.id);
			}

			expect(() => store.addLink(tasks[59]!.id, type, tasks[0]!.id)).toThrow(/cycle/);
			// A middle-to-earlier closure is a cycle too. Not applicable to the single-target type, where
			// tasks[30] already has its one target (that rule is covered in addLink()).
			if (type !== 'duplicateOf') {
				expect(() => store.addLink(tasks[30]!.id, type, tasks[10]!.id)).toThrow(/cycle/);
			}
		});

		it('accepts a diamond (A => B, A => C, B => D, C => D) but rejects D => A', () => {
			// duplicateOf is single-target per task, so the diamond is built on distinct sources only
			// for the multi-target types; for duplicateOf the equivalent shape is a plain chain.
			const a = make('A');
			const b = make('B');
			const c = make('C');
			const d = make('D');
			if (type === 'duplicateOf') {
				store.addLink(a.id, type, b.id);
				store.addLink(b.id, type, c.id);
				store.addLink(c.id, type, d.id);
			} else {
				store.addLink(a.id, type, b.id);
				store.addLink(a.id, type, c.id);
				store.addLink(b.id, type, d.id);
				store.addLink(c.id, type, d.id);
			}

			expect(() => store.addLink(d.id, type, a.id)).toThrow(/cycle/);
		});

		it('does not report a false cycle for converging paths', () => {
			const a = make('A');
			const b = make('B');
			const c = make('C');
			store.addLink(a.id, type, c.id);
			store.addLink(b.id, type, c.id);

			expect(() => store.addLink(a.id, 'causedBy' as LinkType, b.id)).not.toThrow();
		});

		it('allows the link again once the path that formed the cycle is removed', () => {
			const a = make('A');
			const b = make('B');
			const c = make('C');
			store.addLink(a.id, type, b.id);
			store.addLink(b.id, type, c.id);
			expect(() => store.addLink(c.id, type, a.id)).toThrow(/cycle/);

			store.removeLink(b.id, type, c.id);

			expect(() => store.addLink(c.id, type, a.id)).not.toThrow();
		});
	});

	describe('cycle detection is per link type', () => {
		it('treats links of other types as independent graphs', () => {
			const a = make('A');
			const b = make('B');
			store.addLink(a.id, 'blockedBy', b.id);

			expect(() => store.addLink(b.id, 'causedBy', a.id)).not.toThrow();
			expect(() => store.addLink(b.id, 'duplicateOf', a.id)).not.toThrow();
			expect(() => store.addLink(b.id, 'blockedBy', a.id)).toThrow(/cycle/);
		});

		it('is not confused by parent/child relations', () => {
			const parent = make('Parent');
			const child = store.create('Child', 'backlog', parent.id);

			expect(() => store.addLink(parent.id, 'blockedBy', child.id)).not.toThrow();
			expect(() => store.addLink(child.id, 'blockedBy', parent.id)).toThrow(/cycle/);
		});
	});

	describe('removeLink()', () => {
		it('removes the link from record and index, keeping the other links', () => {
			const a = make('A');
			const b = make('B');
			const c = make('C');
			store.addLink(a.id, 'blockedBy', b.id);
			store.addLink(a.id, 'blockedBy', c.id);

			const updated = store.removeLink(a.id, 'blockedBy', b.id);

			expect(updated.links).toEqual([{ type: 'blockedBy', target: c.id }]);
			expect(indexLinks(a.id)).toEqual([{ type: 'blockedBy', target: c.id }]);
		});

		it('drops the links field entirely when the last link is removed', () => {
			const a = make('A');
			const b = make('B');
			store.addLink(a.id, 'blockedBy', b.id);

			const updated = store.removeLink(a.id, 'blockedBy', b.id);

			expect(updated.links).toBeUndefined();
			expect(indexLinks(a.id)).toBeUndefined();
		});

		it('throws an actionable error when the link does not exist', () => {
			const a = make('A');
			const b = make('B');

			expect(() => store.removeLink(a.id, 'blockedBy', b.id)).toThrow(/is not blockedBy/);
		});

		it('only removes the matching type', () => {
			const a = make('A');
			const b = make('B');
			store.addLink(a.id, 'blockedBy', b.id);
			store.addLink(a.id, 'causedBy', b.id);

			store.removeLink(a.id, 'blockedBy', b.id);

			expect(store.get(a.id).links).toEqual([{ type: 'causedBy', target: b.id }]);
		});
	});

	describe('getLinks()', () => {
		it('returns outgoing links and the derived inverses', () => {
			const a = make('A');
			const b = make('B');
			const c = make('C');
			const d = make('D');
			store.addLink(a.id, 'blockedBy', b.id);
			store.addLink(c.id, 'blockedBy', a.id);
			store.addLink(a.id, 'duplicateOf', d.id);
			store.addLink(c.id, 'causedBy', a.id);

			const links = store.getLinks(a.id);

			expect(links.blockedBy.map(t => t.id)).toEqual([b.id]);
			expect(links.blocks.map(t => t.id)).toEqual([c.id]);
			expect(links.duplicateOf.map(t => t.id)).toEqual([d.id]);
			expect(links.duplicates).toEqual([]);
			expect(links.causedBy).toEqual([]);
			expect(links.causes.map(t => t.id)).toEqual([c.id]);
		});

		it('returns all six keys as empty arrays for an unlinked task', () => {
			const a = make('A');

			expect(store.getLinks(a.id)).toEqual({
				blockedBy: [],
				blocks: [],
				duplicateOf: [],
				duplicates: [],
				causedBy: [],
				causes: [],
			});
		});

		it('returns summaries (id, title, status)', () => {
			const a = make('A');
			const b = make('B title');
			store.addLink(a.id, 'blockedBy', b.id);

			expect(store.getLinks(a.id).blockedBy[0]).toMatchObject({ id: b.id, title: 'B title', status: 'backlog' });
		});

		it('throws for an unknown task', () => {
			expect(() => store.getLinks('nope1234')).toThrow(/Task not found: nope1234/);
		});
	});

	describe('getOpenBlockers()', () => {
		it('returns only blockers that are not in a terminal status', () => {
			const a = make('A');
			const open = make('Open blocker');
			const done = make('Done blocker', 'done');
			store.addLink(a.id, 'blockedBy', open.id);
			store.addLink(a.id, 'blockedBy', done.id);

			expect(store.getOpenBlockers(a.id, isTerminal).map(t => t.id)).toEqual([open.id]);
		});

		it('is not transitive: only direct blockers count', () => {
			const a = make('A');
			const b = make('B', 'done');
			const c = make('C');
			store.addLink(a.id, 'blockedBy', b.id);
			store.addLink(b.id, 'blockedBy', c.id);

			expect(store.getOpenBlockers(a.id, isTerminal)).toEqual([]);
		});

		it('ignores non-blocking link types', () => {
			const a = make('A');
			const b = make('B');
			store.addLink(a.id, 'causedBy', b.id);
			store.addLink(a.id, 'duplicateOf', b.id);

			expect(store.getOpenBlockers(a.id, isTerminal)).toEqual([]);
		});
	});

	describe('getUnblockedBy()', () => {
		it('returns open tasks whose every blocker is terminal, once the given blocker is done', () => {
			const blocker = make('Blocker', 'done');
			const blocked = make('Blocked');
			store.addLink(blocked.id, 'blockedBy', blocker.id);

			expect(store.getUnblockedBy(blocker.id, isTerminal).map(t => t.id)).toEqual([blocked.id]);
		});

		it('does not return a task that still has another open blocker', () => {
			const blocker = make('Blocker', 'done');
			const other = make('Other blocker');
			const blocked = make('Blocked');
			store.addLink(blocked.id, 'blockedBy', blocker.id);
			store.addLink(blocked.id, 'blockedBy', other.id);

			expect(store.getUnblockedBy(blocker.id, isTerminal)).toEqual([]);
		});

		it('does not return blocked tasks that are themselves already terminal', () => {
			const blocker = make('Blocker', 'done');
			const blocked = make('Blocked', 'done');
			store.addLink(blocked.id, 'blockedBy', blocker.id);

			expect(store.getUnblockedBy(blocker.id, isTerminal)).toEqual([]);
		});

		it('returns [] when the given task is not terminal (it still blocks)', () => {
			const blocker = make('Blocker');
			const blocked = make('Blocked');
			store.addLink(blocked.id, 'blockedBy', blocker.id);

			expect(store.getUnblockedBy(blocker.id, isTerminal)).toEqual([]);
		});

		it('ignores tasks linked by other link types', () => {
			const blocker = make('Blocker', 'done');
			const other = make('Other');
			store.addLink(other.id, 'causedBy', blocker.id);

			expect(store.getUnblockedBy(blocker.id, isTerminal)).toEqual([]);
		});

		it('returns every task unblocked at once', () => {
			const blocker = make('Blocker', 'done');
			const x = make('X');
			const y = make('Y');
			store.addLink(x.id, 'blockedBy', blocker.id);
			store.addLink(y.id, 'blockedBy', blocker.id);

			expect(
				store
					.getUnblockedBy(blocker.id, isTerminal)
					.map(t => t.id)
					.sort()
			).toEqual([x.id, y.id].sort());
		});
	});

	describe('deleteTask() and links', () => {
		it('removes inbound links pointing to the deleted task, keeping the other links', () => {
			const a = make('A');
			const gone = make('Gone');
			const keep = make('Keep');
			store.addLink(a.id, 'blockedBy', gone.id);
			store.addLink(a.id, 'blockedBy', keep.id);
			store.addLink(a.id, 'causedBy', gone.id);

			store.deleteTask(gone.id);

			expect(store.get(a.id).links).toEqual([{ type: 'blockedBy', target: keep.id }]);
			expect(indexLinks(a.id)).toEqual([{ type: 'blockedBy', target: keep.id }]);
		});

		it('drops the links field when the only link pointed to the deleted task', () => {
			const a = make('A');
			const gone = make('Gone');
			store.addLink(a.id, 'duplicateOf', gone.id);

			store.deleteTask(gone.id);

			expect(store.get(a.id).links).toBeUndefined();
			expect(indexLinks(a.id)).toBeUndefined();
		});

		it('leaves links between surviving tasks untouched', () => {
			const a = make('A');
			const b = make('B');
			const gone = make('Gone');
			store.addLink(a.id, 'blockedBy', b.id);

			store.deleteTask(gone.id);

			expect(store.get(a.id).links).toEqual([{ type: 'blockedBy', target: b.id }]);
		});
	});
});
