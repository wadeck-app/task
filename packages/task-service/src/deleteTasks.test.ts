import { AmbiguousDeletePrefixError, InvalidDeleteFilterError } from './errors.js';
import { DELETE_FILTER_FIELDS, executeDelete, parseDeleteFilter, planDelete } from './deleteTasks.js';
import { createTestContext, type TestContext } from './testHelpers.js';

describe('parseDeleteFilter', () => {
	it('splits field=value and comma-separated values, dropping empty ones', () => {
		expect(parseDeleteFilter('status=done,backlog,')).toEqual({
			kind: 'filter',
			field: 'status',
			values: ['done', 'backlog'],
		});
		expect(parseDeleteFilter('title=fix*=x')).toEqual({ kind: 'filter', field: 'title', values: ['fix*=x'] });
	});

	it('throws InvalidDeleteFilterError when "=" is missing', () => {
		let caught: unknown;
		try {
			parseDeleteFilter('status');
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(InvalidDeleteFilterError);
		expect((caught as Error).message).toBe('invalid filter: "status" (expected field=value)');
		expect((caught as InvalidDeleteFilterError).hint).toBe(`Valid fields: ${DELETE_FILTER_FIELDS.join(', ')}`);
	});

	it('throws InvalidDeleteFilterError for an unknown field', () => {
		expect(() => parseDeleteFilter('color=red')).toThrow('unknown filter field: "color"');
		expect(DELETE_FILTER_FIELDS).toEqual(['id', 'title', 'status', 'parentId']);
	});
});

describe('planDelete / executeDelete', () => {
	let t: TestContext;
	beforeEach(() => {
		t = createTestContext();
	});
	afterEach(() => t.cleanup());

	it('selects tasks by id prefix and reports unknown prefixes in notFound without failing', () => {
		const a = t.ctx.store.create('a', 'backlog');
		t.ctx.store.create('b', 'backlog');

		const plan = planDelete(t.ctx, { selector: { kind: 'ids', ids: [a.id.slice(0, 5), 'zzzz'] } });

		expect(plan.tasks.map(x => x.id)).toEqual([a.id]);
		expect(plan.notFound).toEqual(['zzzz']);
	});

	it('plans a task once when several selectors (prefixes, repeated ids) resolve to it, keeping first-occurrence order', () => {
		const a = t.ctx.store.create('a', 'backlog');
		const b = t.ctx.store.create('b', 'backlog');

		const plan = planDelete(t.ctx, {
			selector: { kind: 'ids', ids: [a.id.slice(0, 5), b.id, a.id, b.id.slice(0, 6), a.id] },
		});

		expect(plan.tasks.map(x => x.id)).toEqual([a.id, b.id]);
	});

	it('throws AmbiguousDeletePrefixError when a prefix matches several tasks', () => {
		t.ctx.store.create('a', 'backlog');
		t.ctx.store.create('b', 'backlog');

		let caught: unknown;
		try {
			// The empty prefix matches every task.
			planDelete(t.ctx, { selector: { kind: 'ids', ids: [''] } });
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(AmbiguousDeletePrefixError);
		expect((caught as Error).message).toMatch(/^ambiguous prefix ".*" matches: /);
	});

	it('selects everything with kind=all', () => {
		t.ctx.store.create('a', 'backlog');
		t.ctx.store.create('b', 'done');

		expect(planDelete(t.ctx, { selector: { kind: 'all' } }).tasks).toHaveLength(2);
	});

	it('selects by glob filter; a root task never matches a parentId pattern', () => {
		const parent = t.ctx.store.create('fix login', 'backlog');
		t.ctx.store.create('fix logout', 'backlog', parent.id);
		t.ctx.store.create('other', 'done');

		const byTitle = planDelete(t.ctx, { selector: parseDeleteFilter('title=fix*') });
		expect(byTitle.tasks.map(x => x.title).sort()).toEqual(['fix login', 'fix logout']);

		const byParent = planDelete(t.ctx, { selector: parseDeleteFilter('parentId=*') });
		expect(byParent.tasks.map(x => x.title)).toEqual(['fix logout']);

		const byStatus = planDelete(t.ctx, { selector: parseDeleteFilter('status=done,backlog') });
		expect(byStatus.tasks).toHaveLength(3);
	});

	it('returns an empty plan with zero counts when nothing matches', () => {
		const plan = planDelete(t.ctx, { selector: parseDeleteFilter('title=nothing') });
		expect(plan).toEqual({ tasks: [], notFound: [], orphanCount: 0, danglingLinkCount: 0 });
	});

	it('counts children that would become root tasks, and links that would dangle', () => {
		const parent = t.ctx.store.create('parent', 'backlog');
		t.ctx.store.create('child', 'backlog', parent.id);
		const other = t.ctx.store.create('other', 'backlog');
		t.ctx.store.addLink(other.id, 'blockedBy', parent.id);

		const plan = planDelete(t.ctx, { selector: { kind: 'ids', ids: [parent.id] } });

		expect(plan.orphanCount).toBe(1);
		expect(plan.danglingLinkCount).toBe(1);
	});

	it('cascade adds every descendant to the plan and leaves no orphans', () => {
		const root = t.ctx.store.create('root', 'backlog');
		const child = t.ctx.store.create('child', 'backlog', root.id);
		const grandchild = t.ctx.store.create('grandchild', 'backlog', child.id);

		const plan = planDelete(t.ctx, { selector: { kind: 'ids', ids: [root.id] }, cascade: true });

		expect(plan.tasks.map(x => x.id).sort()).toEqual([root.id, child.id, grandchild.id].sort());
		expect(plan.orphanCount).toBe(0);
	});

	it('planning never deletes; executeDelete deletes the planned tasks and returns the count', () => {
		const a = t.ctx.store.create('a', 'backlog');
		t.ctx.store.create('b', 'backlog');

		const plan = planDelete(t.ctx, { selector: { kind: 'ids', ids: [a.id] } });
		expect(t.ctx.store.list()).toHaveLength(2);

		expect(executeDelete(t.ctx, plan)).toEqual({ deletedCount: 1 });
		expect(t.ctx.store.list().map(x => x.id)).not.toContain(a.id);
		expect(t.ctx.store.list()).toHaveLength(1);
	});
});
