import { InvalidDeleteFilterError } from './errors.js';
import { describeDeleteEffects, selectDeleteTargets } from './deleteSelection.js';
import type { DeletePlan } from './deleteTasks.js';

describe('selectDeleteTargets', () => {
	it('builds an ids selector', () => {
		expect(selectDeleteTargets({ ids: ['a1', 'b2'] })).toEqual({ selector: { kind: 'ids', ids: ['a1', 'b2'] } });
	});

	it('builds an all selector', () => {
		expect(selectDeleteTargets({ all: true })).toEqual({ selector: { kind: 'all' } });
	});

	it('parses a filter selector', () => {
		expect(selectDeleteTargets({ filter: 'status=done' })).toEqual({
			selector: { kind: 'filter', field: 'status', values: ['done'] },
		});
	});

	it('lets a malformed filter throw InvalidDeleteFilterError (the caller decides how to report it)', () => {
		expect(() => selectDeleteTargets({ filter: 'status' })).toThrow(InvalidDeleteFilterError);
	});

	it('reports "none" when nothing selects tasks (all: false counts as not given)', () => {
		expect(selectDeleteTargets({})).toEqual({ problem: 'none' });
		expect(selectDeleteTargets({ all: false })).toEqual({ problem: 'none' });
	});

	it('reports "all-and-filter" before any other conflict', () => {
		expect(selectDeleteTargets({ all: true, filter: 'status=done' })).toEqual({ problem: 'all-and-filter' });
		expect(selectDeleteTargets({ ids: ['a'], all: true, filter: 'status=done' })).toEqual({
			problem: 'all-and-filter',
		});
	});

	it('reports "ids-with-all-or-filter" when ids come with another selector', () => {
		expect(selectDeleteTargets({ ids: ['a'], all: true })).toEqual({ problem: 'ids-with-all-or-filter' });
		expect(selectDeleteTargets({ ids: ['a'], filter: 'status=done' })).toEqual({
			problem: 'ids-with-all-or-filter',
		});
		expect(selectDeleteTargets({ ids: [], all: true })).toEqual({ problem: 'ids-with-all-or-filter' });
	});

	it('reports "empty-ids" for ids that were given but hold nothing', () => {
		expect(selectDeleteTargets({ ids: [] })).toEqual({ problem: 'empty-ids' });
	});
});

describe('describeDeleteEffects', () => {
	const plan = (orphanCount: number, danglingLinkCount: number): DeletePlan => ({
		tasks: [],
		notFound: ['zz'],
		orphanCount,
		danglingLinkCount,
	});

	it("says nothing when the deletion has no side effect (not-found ids are the caller's to report)", () => {
		expect(describeDeleteEffects(plan(0, 0), 'would')).toEqual([]);
		expect(describeDeleteEffects(plan(0, 0), 'did')).toEqual([]);
	});

	it('uses the conditional for a preview', () => {
		expect(describeDeleteEffects(plan(2, 3), 'would')).toEqual([
			'2 child task(s) would become root tasks (their parent is deleted).',
			'3 link(s) pointing to deleted tasks would be removed.',
		]);
	});

	it('uses the past tense for an outcome', () => {
		expect(describeDeleteEffects(plan(2, 3), 'did')).toEqual([
			'2 child task(s) became root tasks (their parent was deleted).',
			'3 link(s) pointing to deleted tasks were removed.',
		]);
	});

	it('mentions only the effects that happen', () => {
		expect(describeDeleteEffects(plan(0, 1), 'did')).toEqual(['1 link(s) pointing to deleted tasks were removed.']);
	});
});
