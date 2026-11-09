import { describe, expect, it } from 'vitest';

import { planHierarchy } from './hierarchyPlan.js';
import { LossLedger, checkAllowLoss, isLossAllowed } from './lossLedger.js';
import { LOSS_KINDS } from './migrateTypes.js';
import { cutText } from './mapTask.js';

describe('planHierarchy', () => {
	it('puts parents before children whatever the order of the source', () => {
		const ledger = new LossLedger();

		const plan = planHierarchy(
			[
				{ id: 'grandchild', parentId: 'child' },
				{ id: 'child', parentId: 'root' },
				{ id: 'root' },
				{ id: 'other' },
			],
			{ hierarchy: 'unlimited' },
			ledger
		);

		expect(plan.order).toEqual(['root', 'other', 'child', 'grandchild']);
		expect([...plan.parentOf]).toEqual([
			['grandchild', 'child'],
			['child', 'root'],
		]);
		expect(ledger.rows(() => false)).toEqual([]);
	});

	it('orders a long chain given in reverse in linear time', () => {
		const tasks = Array.from({ length: 20_000 }, (_, index) => ({
			id: `t${index}`,
			...(index === 0 ? {} : { parentId: `t${index - 1}` }),
		})).reverse();

		const started = Date.now();
		const plan = planHierarchy(tasks, { hierarchy: 'unlimited' }, new LossLedger());

		expect(plan.order[0]).toBe('t0');
		expect(plan.order[19_999]).toBe('t19999');
		expect(Date.now() - started).toBeLessThan(2000);
	});

	it('breaks a cycle once, at its first task in source order, and keeps the tasks below it', () => {
		const ledger = new LossLedger();

		const plan = planHierarchy(
			[
				{ id: 'a', parentId: 'b' },
				{ id: 'b', parentId: 'a' },
				{ id: 'below', parentId: 'b' },
			],
			{ hierarchy: 'unlimited' },
			ledger
		);

		expect(plan.order).toEqual(['a', 'b', 'below']);
		expect(plan.parentOf.get('a')).toBeUndefined();
		expect(plan.parentOf.get('b')).toBe('a');
		expect(plan.parentOf.get('below')).toBe('b');
		expect(ledger.rows(() => false).map(row => [row.kind, row.count])).toEqual([['hierarchy:cycle', 1]]);
	});

	it('a task that is its own parent is a cycle of one', () => {
		const ledger = new LossLedger();

		const plan = planHierarchy([{ id: 'a', parentId: 'a' }], { hierarchy: 'unlimited' }, ledger);

		expect(plan.order).toEqual(['a']);
		expect(plan.parentOf.size).toBe(0);
		expect(ledger.rows(() => false).map(row => row.kind)).toEqual(['hierarchy:cycle']);
	});

	it('drops every parent when the target has no hierarchy', () => {
		const ledger = new LossLedger();

		const plan = planHierarchy([{ id: 'a' }, { id: 'b', parentId: 'a' }], { hierarchy: 'none' }, ledger);

		expect(plan.parentOf.size).toBe(0);
		expect(ledger.rows(() => false).map(row => [row.kind, row.count])).toEqual([['hierarchy:unsupported', 1]]);
	});
});

describe('the loss kinds', () => {
	it('allowing a group allows its kinds, allowing all allows everything, a kind alone allows itself only', () => {
		expect(isLossAllowed('links:causedBy', ['links'])).toBe(true);
		expect(isLossAllowed('links:causedBy', ['links:causedBy'])).toBe(true);
		expect(isLossAllowed('links:causedBy', ['links:dangling'])).toBe(false);
		expect(isLossAllowed('hierarchy:cycle', ['links'])).toBe(false);
		expect(isLossAllowed('history', ['all'])).toBe(true);
		expect(isLossAllowed('history', ['hierarchy'])).toBe(false);
	});

	it('tells the names it does not know', () => {
		expect(checkAllowLoss(['history', 'links', 'all', 'hisotry'])).toEqual({
			accepted: ['history', 'links', 'all'],
			unknown: ['hisotry'],
		});
	});

	it('every kind has a row text and a fix', () => {
		for (const kind of LOSS_KINDS) {
			const ledger = new LossLedger();
			ledger.add(kind, 't1', 'detail');
			const [row] = ledger.rows(() => false);
			expect(row!.text.trim(), kind).not.toBe('');
			expect(row!.fix.trim(), kind).not.toBe('');
			expect(row!.text, kind).toMatch(/^[\x20-\x7e]+$/);
		}
	});

	it('lists at most 20 task ids per row, but counts them all', () => {
		const ledger = new LossLedger();
		for (let index = 0; index < 30; index++) ledger.add('history', `t${index}`);

		const [row] = ledger.rows(() => false);

		expect(row!.count).toBe(30);
		expect(row!.taskIds).toHaveLength(20);
	});
});

describe('cutText', () => {
	it('leaves a text that fits, cuts one that does not and says how long it was', () => {
		expect(cutText('short', 10)).toEqual({ text: 'short', cut: false });
		expect(cutText('anything', undefined)).toEqual({ text: 'anything', cut: false });
		const cut = cutText('x'.repeat(200), 100);
		expect(cut.cut).toBe(true);
		expect(cut.text.length).toBeLessThanOrEqual(100);
		expect(cut.text).toMatch(/\[cut by task migrate: the original has 200 characters\]$/);
	});
});
