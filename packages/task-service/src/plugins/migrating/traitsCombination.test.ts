import { LOCAL_TRAITS, NO_TRAITS } from '@wadeck-app/task-core';
import type { BackendTraits } from '@wadeck-app/task-core';

import { combineTraits } from './traitsCombination.js';

// What the wrapper keeps and its limits: what both sides keep, within the tighter limit of the two. A trait of task-core without a
// rule here is a compile error (the table below), and a number or text limit is never invented for a side that declares none.
const EVERY_TRAIT = {
	keepsCreatedAt: 0,
	authoredComments: 0,
	commentTextMax: 0,
	commentAuthorMax: 0,
	descriptionMax: 0,
	labelProblem: 0,
	hierarchyDepth: 0,
	childrenPerParent: 0,
	cost: 0,
	foldsCreate: 0,
} satisfies Record<keyof BackendTraits, 0>;

describe('combineTraits', () => {
	it('covers every trait of task-core (the table above is checked by the compiler)', () => {
		expect(Object.keys(EVERY_TRAIT).sort()).toEqual(
			[
				'authoredComments',
				'childrenPerParent',
				'commentAuthorMax',
				'commentTextMax',
				'cost',
				'descriptionMax',
				'foldsCreate',
				'hierarchyDepth',
				'keepsCreatedAt',
				'labelProblem',
			].sort()
		);
	});

	it('the same traits on both sides give the same traits', () => {
		expect(combineTraits(LOCAL_TRAITS, LOCAL_TRAITS)).toEqual(LOCAL_TRAITS);
		expect(combineTraits(NO_TRAITS, NO_TRAITS)).toEqual(NO_TRAITS);
	});

	it('what a side does not keep is not kept: creation instant and comment authors need both', () => {
		const both = combineTraits(LOCAL_TRAITS, { keepsCreatedAt: false, authoredComments: true });
		expect(both.keepsCreatedAt).toBe(false);
		expect(both.authoredComments).toBe(true);
		expect(combineTraits(NO_TRAITS, LOCAL_TRAITS).authoredComments).toBe(false);
	});

	it('a limit is the tighter of the two; a side with no known limit does not loosen the other', () => {
		const a: BackendTraits = {
			...NO_TRAITS,
			commentTextMax: 100,
			descriptionMax: 50,
			hierarchyDepth: 8,
			childrenPerParent: 100,
		};
		const b: BackendTraits = { ...NO_TRAITS, commentTextMax: 10000, commentAuthorMax: 20, hierarchyDepth: 2 };
		const combined = combineTraits(a, b);

		expect(combined).toMatchObject({
			commentTextMax: 100,
			commentAuthorMax: 20,
			descriptionMax: 50,
			hierarchyDepth: 2,
			childrenPerParent: 100,
		});
		expect(combineTraits(NO_TRAITS, NO_TRAITS).hierarchyDepth).toBeUndefined();
		expect(combineTraits(NO_TRAITS, NO_TRAITS)).not.toHaveProperty('hierarchyDepth');
	});

	it('a label is refused when either side refuses it, with the reason of the first side that does', () => {
		const a: BackendTraits = {
			...NO_TRAITS,
			labelProblem: label => (label.startsWith('a:') ? 'a reserves a:' : undefined),
		};
		const b: BackendTraits = {
			...NO_TRAITS,
			labelProblem: label => (label.length > 3 ? 'b: too long' : undefined),
		};
		const combined = combineTraits(a, b);

		expect(combined.labelProblem?.('a:x')).toBe('a reserves a:');
		expect(combined.labelProblem?.('long-one')).toBe('b: too long');
		expect(combined.labelProblem?.('ok')).toBeUndefined();
		expect(combineTraits(a, NO_TRAITS).labelProblem?.('a:x')).toBe('a reserves a:');
		expect(combineTraits(NO_TRAITS, NO_TRAITS)).not.toHaveProperty('labelProblem');
	});

	describe('cost: pessimistic, and no per-run model of either side', () => {
		const slow: BackendTraits['cost'] = {
			requests: 4,
			seconds: 4,
			quotaPerHour: 5000,
			read: { requests: 2, seconds: 0.7 },
			resolve: { requests: 1, seconds: 0.35 },
			contentCap: { perHour: 500, perMinute: 80, source: 'documented by the slow side' },
			model: () => ({ writes: 1, requests: 1, verifyRequests: 0, notes: [] }),
		};
		const fast: BackendTraits['cost'] = {
			requests: 1,
			seconds: 0.1,
			quotaPerHour: 100000,
			contentCap: { perHour: 1000, source: 'fast' },
		};

		it('free on both sides stays free', () => {
			expect(combineTraits(LOCAL_TRAITS, LOCAL_TRAITS)).not.toHaveProperty('cost');
		});

		it('one side with a cost: its cost (a side with none is free), without its model', () => {
			const combined = combineTraits({ ...NO_TRAITS, cost: slow }, LOCAL_TRAITS).cost!;
			expect(combined).toMatchObject({
				requests: 4,
				seconds: 4,
				quotaPerHour: 5000,
				read: { requests: 2, seconds: 0.7 },
			});
			expect(combined.model).toBeUndefined();
			expect(combined.contentCap).toEqual({ perHour: 500, perMinute: 80, source: 'documented by the slow side' });
		});

		it('two sides: the larger cost per write and read, the smaller quota, the stricter cap with its own source', () => {
			const combined = combineTraits({ ...NO_TRAITS, cost: slow }, { ...NO_TRAITS, cost: fast }).cost!;
			expect(combined.requests).toBe(4);
			expect(combined.seconds).toBe(4);
			expect(combined.quotaPerHour).toBe(5000);
			expect(combined.contentCap).toEqual({ perHour: 500, perMinute: 80, source: 'documented by the slow side' });
			expect(combined.read).toEqual({ requests: 2, seconds: 0.7 });
			expect(combined.model).toBeUndefined();
		});

		it('is commutative', () => {
			expect(combineTraits({ ...NO_TRAITS, cost: fast }, { ...NO_TRAITS, cost: slow })).toEqual(
				combineTraits({ ...NO_TRAITS, cost: slow }, { ...NO_TRAITS, cost: fast })
			);
		});
	});

	it('the wrapper has no createMigrated of its own: foldsCreate is never set', () => {
		expect(
			combineTraits({ ...NO_TRAITS, foldsCreate: true }, { ...NO_TRAITS, foldsCreate: true })
		).not.toHaveProperty('foldsCreate');
	});
});
